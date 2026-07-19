// Dogear — Internet Archive provider.
//
// A third key-free source, and deliberately a different kind of one: the
// Archive indexes scanned and digitised books, so its coverage overlaps
// imperfectly with both Open Library and Google Books. Older, out-of-print and
// public-domain titles that the commercial catalogues have thinned out are
// often here.
//
// The Archive asks callers to cache results, noting they do not have unlimited
// resources behind the service. Dogear caches and rate limits itself.
//
// Caveats worth being honest about:
//   - Metadata quality is uneven; these are library and volunteer records.
//   - `imagecount` counts scanned images, not printed pages. It is close
//     enough to be useful and is clearly not authoritative, so it is used only
//     when nothing better exists.

import type { BookMetadata, BookProvider, SearchHit } from './types';
import { RateLimitError, type HttpResponse, type Requester } from '../olclient';
import { TokenBucket } from '../ratelimit';

export const IA_PROVIDER_ID = 'internetarchive';
const IA_SEARCH = 'https://archive.org/advancedsearch.php';
const IA_IMG = 'https://archive.org/services/img';

/** Fields requested explicitly, to keep responses small. */
export const IA_FIELDS = [
    'identifier',
    'title',
    'creator',
    'date',
    'year',
    'publisher',
    'language',
    'subject',
    'imagecount',
    'isbn',
];

/**
 * Escape characters that carry meaning in the Archive's Lucene query syntax,
 * so a title containing a colon or a hyphen is searched for rather than
 * interpreted as an operator.
 */
export function escapeLucene(input: string): string {
    return input.replace(/([+\-!(){}[\]^"~*?:\\/])/g, '\\$1');
}

export function buildIaSearchUrl(query: string, limit = 20): string {
    const escaped = escapeLucene(query.trim());
    // Search TITLES and CREATORS specifically. A bare query searches every
    // indexed field including full text, which buries the book you asked for
    // under scanned government memos that happen to contain the words.
    // Restrict to texts too; the Archive also holds film, audio and software.
    const q = `(title:(${escaped}) OR creator:(${escaped})) AND mediatype:texts`;
    const params = new URLSearchParams();
    params.set('q', q);
    for (const f of IA_FIELDS) params.append('fl[]', f);
    params.set('rows', String(Math.min(Math.max(limit, 1), 50)));
    params.set('page', '1');
    params.set('output', 'json');
    return `${IA_SEARCH}?${params.toString()}`;
}

export function iaCoverUrl(identifier: string): string {
    return `${IA_IMG}/${encodeURIComponent(identifier)}`;
}

/** The Archive returns some fields as either a string or a list of strings. */
function firstOf(v: unknown): string | undefined {
    if (typeof v === 'string') return v.trim() || undefined;
    if (Array.isArray(v)) {
        const found = v.find(
            (x): x is string => typeof x === 'string' && x.trim() !== '',
        );
        return found?.trim();
    }
    return undefined;
}

function allOf(v: unknown): string[] {
    if (typeof v === 'string') return v.trim() === '' ? [] : [v.trim()];
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
    return [];
}

export function mapIaResponse(json: unknown): SearchHit[] {
    const docs = (json as { response?: { docs?: unknown[] } })?.response?.docs;
    if (!Array.isArray(docs)) return [];

    const out: SearchHit[] = [];
    for (const raw of docs) {
        const d = raw as Record<string, unknown>;
        const identifier = typeof d.identifier === 'string' ? d.identifier : undefined;
        const title = firstOf(d.title);
        if (!identifier || !title) continue;

        const yearRaw = d.year ?? d.date;
        const yearText = firstOf(yearRaw) ?? (typeof yearRaw === 'number' ? String(yearRaw) : undefined);
        const yearMatch = yearText ? /(\d{4})/.exec(yearText) : null;

        // imagecount counts scan images rather than printed pages, so it is a
        // rough figure. Better than nothing, and clearly marked as a fallback.
        const imageCount = typeof d.imagecount === 'number' ? d.imagecount : Number(firstOf(d.imagecount));
        const pages = Number.isFinite(imageCount) && imageCount > 0 ? Math.round(imageCount) : undefined;

        const isbn = firstOf(d.isbn);

        out.push({
            providerId: IA_PROVIDER_ID,
            id: identifier,
            title,
            authors: allOf(d.creator).slice(0, 4),
            year: yearMatch ? Number(yearMatch[1]) : undefined,
            coverUrl: iaCoverUrl(identifier),
            pages,
            isbn13: isbn && isbn.replace(/[^0-9Xx]/g, '').length === 13 ? isbn : undefined,
            isbn10: isbn && isbn.replace(/[^0-9Xx]/g, '').length === 10 ? isbn : undefined,
            publisher: firstOf(d.publisher),
            published: yearMatch ? yearMatch[1] : undefined,
            tags: allOf(d.subject).slice(0, 8),
            complete: true,
        });
    }
    return out;
}

export function iaHitToMetadata(hit: SearchHit): BookMetadata {
    return {
        title: hit.title,
        authors: hit.authors,
        cover: hit.coverUrl,
        isbn10: hit.isbn10,
        isbn13: hit.isbn13,
        publisher: hit.publisher,
        published: hit.published,
        pages: hit.pages,
        tags: hit.tags,
        source: IA_PROVIDER_ID,
    };
}

export interface IaOptions {
    ttlMs?: number;
    maxEntries?: number;
    defaultCooldownMs?: number;
    bucket?: TokenBucket;
    now?: () => number;
}

export class InternetArchiveProvider implements BookProvider {
    readonly id = IA_PROVIDER_ID;
    readonly label = 'Internet Archive';
    readonly attribution = 'Internet Archive';

    private cache = new Map<string, { value: unknown; expires: number }>();
    private cooldownUntil = 0;
    private readonly now: () => number;

    constructor(
        private readonly request: Requester,
        private readonly options: IaOptions = {},
    ) {
        this.now = options.now ?? (() => Date.now());
    }

    cooldownRemaining(): number {
        return Math.max(0, this.cooldownUntil - this.now());
    }

    async search(query: string, limit = 20): Promise<SearchHit[]> {
        const trimmed = query.trim();
        if (trimmed === '') return [];

        const url = buildIaSearchUrl(trimmed, limit);
        const cached = this.cache.get(url);
        if (cached && cached.expires > this.now()) return mapIaResponse(cached.value);

        const remaining = this.cooldownRemaining();
        if (remaining > 0) throw new RateLimitError(remaining, 'Internet Archive');

        if (this.options.bucket) await this.options.bucket.take();
        const res: HttpResponse = await this.request(url, { Accept: 'application/json' });

        if (res.status === 429 || res.status === 503) {
            const cooldown = this.options.defaultCooldownMs ?? 60_000;
            this.cooldownUntil = this.now() + cooldown;
            throw new RateLimitError(cooldown, 'Internet Archive', res.bodySnippet);
        }
        if (res.status < 200 || res.status >= 300) {
            const detail = res.bodySnippet ? `: ${res.bodySnippet}` : '';
            throw new Error(`Internet Archive returned ${res.status}${detail}`);
        }

        const max = this.options.maxEntries ?? 200;
        if (this.cache.size >= max) {
            const oldest = this.cache.keys().next();
            if (!oldest.done) this.cache.delete(oldest.value);
        }
        this.cache.set(url, {
            value: res.json,
            expires: this.now() + (this.options.ttlMs ?? 24 * 60 * 60 * 1000),
        });
        return mapIaResponse(res.json);
    }

    async resolve(hit: SearchHit): Promise<BookMetadata> {
        return iaHitToMetadata(hit);
    }

    clearCache(): void {
        this.cache.clear();
    }
}
