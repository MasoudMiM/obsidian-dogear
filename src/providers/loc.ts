// Dogear — Library of Congress provider.
//
// A third key-free source, and the most authoritative of them for
// US-published books: these are catalogue records made by librarians rather
// than scraped, uploaded or crowd-sourced.
//
// It is also the most delicate to call, for three reasons the Library
// documents plainly:
//
//   1. The published limit is 20 requests per minute, and exceeding it blocks
//      you for a FULL HOUR. Every other source here forgives in minutes. So
//      the bucket is set far below the limit rather than near it.
//
//   2. Under load, the API may return 429s *or HTML pages with CAPTCHAs* even
//      when you are within the limits. The Library's own example code checks
//      the content type rather than trusting a 200 status. A response that is
//      not JSON is therefore treated as throttling, not as a parse failure.
//
//   3. The Library warns that its data is "incredibly heterogenous" and that
//      "there is no such thing as a standard API response". Every field is
//      read defensively; nothing is assumed to be present or to have a
//      particular shape.
//
// A note on coverage: search results rarely carry page counts, so books added
// from here usually need a page count filled in by hand before page-based
// progress works. Percentage tracking works regardless.
//
// The Library also migrated to a new catalogue platform in mid-2025 and has
// said data is being restored to this API incrementally, so coverage may be
// patchier than the catalogue website suggests.

import type { BookMetadata, BookProvider, SearchHit } from './types';
import { RateLimitError, type HttpResponse, type Requester } from '../olclient';
import { TokenBucket } from '../ratelimit';

export const LOC_PROVIDER_ID = 'loc';
const LOC_BASE = 'https://www.loc.gov/books/';

/** Documented limit is 20/minute; the penalty for exceeding it is an hour. */
export const LOC_BLOCK_MS = 60 * 60 * 1000;

export function buildLocSearchUrl(query: string, limit = 20): string {
    const params = new URLSearchParams();
    params.set('q', query.trim());
    params.set('fo', 'json');
    params.set('c', String(Math.min(Math.max(limit, 1), 50)));
    // Ask only for the results list. The full response carries facets,
    // breadcrumbs and site furniture that we would only throw away.
    params.set('at', 'results');
    return `${LOC_BASE}?${params.toString()}`;
}

function asList(v: unknown): string[] {
    if (typeof v === 'string') return v.trim() === '' ? [] : [v.trim()];
    if (Array.isArray(v)) {
        return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
    }
    return [];
}

function firstOf(v: unknown): string | undefined {
    const list = asList(v);
    return list.length > 0 ? list[0] : undefined;
}

/** LoC image URLs are often protocol-relative ("//cdn.loc.gov/..."). */
export function normaliseLocImage(url: string): string {
    if (url.startsWith('//')) return `https:${url}`;
    if (url.startsWith('http://')) return url.replace(/^http:/, 'https:');
    return url;
}

/**
 * Contributors come back lower-cased and inverted: "caro, robert a.".
 * Title-case them so notes do not look shouted at or mangled.
 */
export function tidyContributor(raw: string): string {
    return raw
        .trim()
        .replace(/,\s*$/, '')
        .split(/\s+/)
        .map((word) =>
            word.length === 0
                ? word
                : word[0].toUpperCase() + word.slice(1),
        )
        .join(' ');
}

/** Results that are not books at all. */
function isNotABook(formats: string[]): boolean {
    return formats.some((f) => /collection|web page|web site/i.test(f));
}

export function mapLocResponse(json: unknown): SearchHit[] {
    const results = (json as { results?: unknown[] })?.results;
    if (!Array.isArray(results)) return [];

    const out: SearchHit[] = [];
    for (const raw of results) {
        const r = raw as Record<string, unknown>;
        const title = firstOf(r.title);
        const id = typeof r.id === 'string' ? r.id : firstOf(r.id);
        if (!title || !id) continue;

        // The Library's own example code filters these out of book searches.
        if (isNotABook(asList(r.original_format))) continue;

        const dateText = firstOf(r.date) ?? (typeof r.date === 'number' ? String(r.date) : undefined);
        const yearMatch = dateText ? /(\d{4})/.exec(dateText) : null;

        const image = firstOf(r.image_url);
        const authors = asList(r.contributor).slice(0, 4).map(tidyContributor);

        out.push({
            providerId: LOC_PROVIDER_ID,
            id,
            title,
            authors,
            year: yearMatch ? Number(yearMatch[1]) : undefined,
            coverUrl: image ? normaliseLocImage(image) : undefined,
            // Search results almost never carry a page count. Left undefined
            // rather than guessed at; the reader can add one.
            pages: undefined,
            publisher: undefined,
            published: yearMatch ? yearMatch[1] : undefined,
            tags: asList(r.subject).slice(0, 8),
            complete: true,
        });
    }
    return out;
}

export function locHitToMetadata(hit: SearchHit): BookMetadata {
    return {
        title: hit.title,
        authors: hit.authors,
        cover: hit.coverUrl,
        published: hit.published,
        pages: hit.pages,
        tags: hit.tags,
        source: LOC_PROVIDER_ID,
    };
}

/**
 * Does this response actually contain JSON search results?
 *
 * The Library may serve an HTML CAPTCHA page with a 200 status when it is
 * under load. Treating that as "no results" would be wrong twice over: it
 * hides a throttling problem, and it keeps us hammering a service that has
 * just asked us to stop.
 */
export function looksLikeJsonResults(json: unknown): boolean {
    if (json === null || typeof json !== 'object') return false;
    return Array.isArray((json as { results?: unknown }).results);
}

export interface LocOptions {
    ttlMs?: number;
    maxEntries?: number;
    bucket?: TokenBucket;
    now?: () => number;
    /** How long to stand down once blocked. Defaults to the documented hour. */
    blockMs?: number;
}

export class LibraryOfCongressProvider implements BookProvider {
    readonly id = LOC_PROVIDER_ID;
    readonly label = 'Library of Congress';
    readonly attribution = 'the Library of Congress';

    private cache = new Map<string, { value: unknown; expires: number }>();
    private cooldownUntil = 0;
    private readonly now: () => number;

    constructor(
        private readonly request: Requester,
        private readonly options: LocOptions = {},
    ) {
        this.now = options.now ?? (() => Date.now());
    }

    cooldownRemaining(): number {
        return Math.max(0, this.cooldownUntil - this.now());
    }

    private block(): number {
        const ms = this.options.blockMs ?? LOC_BLOCK_MS;
        this.cooldownUntil = this.now() + ms;
        return ms;
    }

    async search(query: string, limit = 20): Promise<SearchHit[]> {
        const trimmed = query.trim();
        if (trimmed === '') return [];

        const url = buildLocSearchUrl(trimmed, limit);
        const cached = this.cache.get(url);
        if (cached && cached.expires > this.now()) return mapLocResponse(cached.value);

        const remaining = this.cooldownRemaining();
        if (remaining > 0) throw new RateLimitError(remaining, 'Library of Congress');

        if (this.options.bucket) await this.options.bucket.take();
        const res: HttpResponse = await this.request(url, { Accept: 'application/json' });

        if (res.status === 429 || res.status === 503) {
            const ms = this.block();
            throw new RateLimitError(ms, 'Library of Congress', res.bodySnippet);
        }
        if (res.status < 200 || res.status >= 300) {
            const detail = res.bodySnippet ? `: ${res.bodySnippet}` : '';
            throw new Error(`Library of Congress returned ${res.status}${detail}`);
        }

        // A 200 that is not JSON means a CAPTCHA or interstitial, which is
        // throttling wearing a disguise.
        if (!looksLikeJsonResults(res.json)) {
            const ms = this.block();
            throw new RateLimitError(
                ms,
                'Library of Congress',
                'responded with a page rather than data, which usually means the service is under load',
            );
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
        return mapLocResponse(res.json);
    }

    async resolve(hit: SearchHit): Promise<BookMetadata> {
        return locHitToMetadata(hit);
    }

    clearCache(): void {
        this.cache.clear();
    }
}
