// Dogear — Google Books provider.
//
// The fallback for when Open Library is throttled or down.
//
// Google's documentation is explicit that searching does not require
// authentication and that the volume list and get methods expose public volume
// data without it. Keyless requests are rate limited and Google describes them
// as unsuitable for production, so an optional API key can be supplied in
// settings — but Dogear works with no setup at all, which is the whole point.
//
// Google Books is a good complement to Open Library rather than a duplicate:
// its page counts and publisher data are more consistently populated, while
// Open Library has better coverage of older and non-English editions. Between
// them the gaps rarely overlap.
//
// The mapping functions are pure and take parsed JSON, so they can be tested
// without a network.

import type { BookMetadata, BookProvider, SearchHit } from './types';
import { TokenBucket } from '../ratelimit';
import {
    ProviderConfigError,
    RateLimitError,
    type HttpResponse,
    type Requester,
} from '../olclient';

export const GOOGLE_BOOKS_BASE = 'https://www.googleapis.com/books/v1/volumes';
export const GOOGLE_PROVIDER_ID = 'googlebooks';

export function buildGoogleSearchUrl(
    query: string,
    limit = 20,
    apiKey?: string,
    country?: string,
): string {
    const params = new URLSearchParams();
    params.set('q', query.trim());
    // 40 is the documented maximum.
    params.set('maxResults', String(Math.min(Math.max(limit, 1), 40)));
    params.set('printType', 'books');
    // Without a country, Google refuses the request outright whenever it
    // cannot geolocate the caller's address — it does not hold display rights
    // for every book in every country. See classifyGoogleError below.
    if (country) params.set('country', country);
    if (apiKey) params.set('key', apiKey);
    return `${GOOGLE_BOOKS_BASE}?${params.toString()}`;
}

/**
 * Work out a country code from a browser locale.
 *
 * "en-GB" -> "GB". A bare language such as "en" carries no region, so it
 * returns undefined rather than guessing wrong.
 */
export function countryFromLocale(locale: string | undefined): string | undefined {
    if (!locale) return undefined;
    const match = /^[A-Za-z]{2,3}[-_]([A-Za-z]{2})\b/.exec(locale.trim());
    return match ? match[1].toUpperCase() : undefined;
}

export type GoogleErrorKind =
    | 'rate-limit'
    | 'daily-quota'
    | 'unknown-location'
    | 'other';

/**
 * Work out what a Google Books failure actually means.
 *
 * A 403 from this API is ambiguous: it can mean the quota is spent, or that
 * Google could not geolocate the request. Those need opposite responses —
 * one is waited out, the other is a setting away from being fixed — so they
 * must not be collapsed into a single "rate limited" message.
 */
export function classifyGoogleError(
    status: number,
    json: unknown,
    bodySnippet?: string,
): { kind: GoogleErrorKind; message: string } {
    const error = (json as { error?: { message?: unknown; errors?: unknown[] } })?.error;
    const reasons = Array.isArray(error?.errors)
        ? (error.errors as Array<{ reason?: unknown }>)
              .map((e) => (typeof e?.reason === 'string' ? e.reason : ''))
              .filter(Boolean)
        : [];
    const message =
        typeof error?.message === 'string' ? error.message : (bodySnippet ?? `HTTP ${status}`);

    if (reasons.includes('unknownLocation') || /determine user location/i.test(message)) {
        return { kind: 'unknown-location', message };
    }
    // A DAILY quota, which waiting minutes cannot fix. Keyless callers share
    // one anonymous Google Cloud project, so this pool is routinely exhausted
    // by other people entirely — the remedy is a key, not patience.
    if (
        reasons.includes('dailyLimitExceeded') ||
        /queries per day|quota metric|daily limit/i.test(message)
    ) {
        return { kind: 'daily-quota', message };
    }
    if (status === 429 || reasons.includes('rateLimitExceeded') || reasons.includes('userRateLimitExceeded')) {
        return { kind: 'rate-limit', message };
    }
    if (status === 403 && /quota|rate limit|exceeded/i.test(message)) {
        // Quota exhaustion also arrives as 403, and behaves like throttling.
        return { kind: 'rate-limit', message };
    }
    // A 403 we cannot explain is NOT assumed to be a quota problem. Guessing
    // here is what hid a geolocation failure behind a five-minute cooldown.
    return { kind: 'other', message };
}

/** Search by ISBN using Google's field-qualified syntax. */
export function buildGoogleIsbnUrl(
    isbn: string,
    apiKey?: string,
    country?: string,
): string {
    const clean = isbn.replace(/[^0-9Xx]/g, '');
    const params = new URLSearchParams();
    params.set('q', `isbn:${clean}`);
    if (country) params.set('country', country);
    if (apiKey) params.set('key', apiKey);
    return `${GOOGLE_BOOKS_BASE}?${params.toString()}`;
}

function asStringArray(v: unknown): string[] {
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Google serves cover thumbnails over http in some responses and adds
 * `edge=curl`, which draws a fake page-curl over the artwork. Both are worth
 * cleaning up before the URL is written into someone's note for good.
 */
export function cleanGoogleThumbnail(url: string): string {
    return url
        .replace(/^http:/, 'https:')
        .replace(/&?edge=curl/g, '')
        .replace(/([?&])&+/g, '$1')
        .replace(/[?&]$/, '');
}

interface IndustryIdentifier {
    type?: unknown;
    identifier?: unknown;
}

function pickIsbns(v: unknown): { isbn10?: string; isbn13?: string } {
    if (!Array.isArray(v)) return {};
    let isbn10: string | undefined;
    let isbn13: string | undefined;
    for (const entry of v as IndustryIdentifier[]) {
        if (typeof entry?.identifier !== 'string') continue;
        if (entry.type === 'ISBN_13' && !isbn13) isbn13 = entry.identifier;
        if (entry.type === 'ISBN_10' && !isbn10) isbn10 = entry.identifier;
    }
    return { isbn10, isbn13 };
}

/** Map a /volumes response into search hits. Tolerates missing fields. */
export function mapGoogleResponse(json: unknown): SearchHit[] {
    const items = (json as { items?: unknown[] })?.items;
    if (!Array.isArray(items)) return [];

    const out: SearchHit[] = [];
    for (const raw of items) {
        const item = raw as Record<string, unknown>;
        const id = typeof item.id === 'string' ? item.id : undefined;
        const info = item.volumeInfo as Record<string, unknown> | undefined;
        const title = typeof info?.title === 'string' ? info.title : undefined;
        if (!id || !info || !title) continue;

        const { isbn10, isbn13 } = pickIsbns(info.industryIdentifiers);
        const links = info.imageLinks as Record<string, unknown> | undefined;
        const thumb =
            typeof links?.thumbnail === 'string'
                ? links.thumbnail
                : typeof links?.smallThumbnail === 'string'
                  ? links.smallThumbnail
                  : undefined;

        const published =
            typeof info.publishedDate === 'string' ? info.publishedDate : undefined;
        const yearMatch = published ? /(\d{4})/.exec(published) : null;

        const pages =
            typeof info.pageCount === 'number' && info.pageCount > 0
                ? info.pageCount
                : undefined;

        out.push({
            providerId: GOOGLE_PROVIDER_ID,
            id,
            title,
            subtitle: typeof info.subtitle === 'string' ? info.subtitle : undefined,
            authors: asStringArray(info.authors),
            year: yearMatch ? Number(yearMatch[1]) : undefined,
            coverUrl: thumb ? cleanGoogleThumbnail(thumb) : undefined,
            pages,
            isbn10,
            isbn13,
            publisher: typeof info.publisher === 'string' ? info.publisher : undefined,
            published,
            tags: asStringArray(info.categories).slice(0, 8),
            // Google returns everything in one call; there is nothing to fetch.
            complete: true,
        });
    }
    return out;
}

/** Convert a hit into stored metadata. */
export function googleHitToMetadata(hit: SearchHit): BookMetadata {
    const title =
        hit.subtitle && hit.subtitle.trim() !== ''
            ? `${hit.title}: ${hit.subtitle}`
            : hit.title;
    return {
        title,
        authors: hit.authors,
        cover: hit.coverUrl,
        isbn10: hit.isbn10,
        isbn13: hit.isbn13,
        publisher: hit.publisher,
        published: hit.published,
        pages: hit.pages,
        tags: hit.tags,
        googleId: hit.id,
        source: GOOGLE_PROVIDER_ID,
    };
}

export interface GoogleBooksOptions {
    apiKey?: string;
    /** Outgoing request limiter. Supplied by the caller so it can be shared. */
    bucket?: TokenBucket;
    /** ISO 3166-1 alpha-2 code, e.g. "US". Required by Google in practice. */
    country?: string;
    ttlMs?: number;
    maxEntries?: number;
    defaultCooldownMs?: number;
    now?: () => number;
}

export class GoogleBooksProvider implements BookProvider {
    readonly id = GOOGLE_PROVIDER_ID;
    readonly label = 'Google Books';
    readonly attribution = 'Google Books';

    private cache = new Map<string, { value: unknown; expires: number }>();
    private cooldownUntil = 0;
    private readonly now: () => number;

    constructor(
        private readonly request: Requester,
        private readonly options: GoogleBooksOptions = {},
    ) {
        this.now = options.now ?? (() => Date.now());
    }

    cooldownRemaining(): number {
        return Math.max(0, this.cooldownUntil - this.now());
    }

    /**
     * Without a key, every keyless caller worldwide shares one anonymous
     * Google Cloud project whose daily quota is, in practice, permanently
     * spent. Attempting it wastes a round trip and produces an error that
     * looks like the user's fault. Better to declare it unusable and say why.
     */
    unavailableReason(): string | null {
        if (this.options.apiKey) return null;
        return 'needs a free API key — the key-free quota is shared with every other application and is usually exhausted';
    }

    private async getJson(url: string): Promise<unknown> {
        const hit = this.cache.get(url);
        if (hit && hit.expires > this.now()) return hit.value;

        const remaining = this.cooldownRemaining();
        if (remaining > 0) throw new RateLimitError(remaining, 'Google Books');

        // Wait for a token before going out. Policing ourselves is cheaper
        // than being policed: a 429 costs minutes, a token costs milliseconds.
        if (this.options.bucket) await this.options.bucket.take();

        const res: HttpResponse = await this.request(url, { Accept: 'application/json' });

        if (res.status < 200 || res.status >= 300) {
            const { kind, message } = classifyGoogleError(res.status, res.json, res.bodySnippet);

            if (kind === 'unknown-location') {
                // Not a quota problem and not worth a cooldown: retrying
                // changes nothing until a country is supplied.
                throw new ProviderConfigError(
                    `Google Books could not determine your country: ${message}`,
                    'Set a country code in Dogear settings under Book data.',
                );
            }
            if (kind === 'daily-quota') {
                // Stand down for the rest of the day rather than retrying every
                // few minutes against a limit that resets at midnight.
                this.cooldownUntil = this.now() + 6 * 60 * 60_000;
                throw new ProviderConfigError(
                    this.options.apiKey
                        ? `Google Books daily quota reached: ${message}`
                        : `Google Books refused the request because its shared, key-free quota is used up. This pool is shared with every other application that calls Google Books without a key, so it is often exhausted by other people's usage. Details: ${message}`,
                    this.options.apiKey
                        ? 'The quota resets daily. Open Library will be used in the meantime.'
                        : 'Add a free Google Books API key in Dogear settings to get your own quota, or rely on Open Library.',
                );
            }
            if (kind === 'rate-limit') {
                const cooldown = this.options.defaultCooldownMs ?? 5 * 60_000;
                this.cooldownUntil = this.now() + cooldown;
                throw new RateLimitError(cooldown, 'Google Books', message);
            }
            throw new Error(`Google Books returned ${res.status}: ${message}`);
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
        return res.json;
    }

    async search(query: string, limit = 20): Promise<SearchHit[]> {
        const trimmed = query.trim();
        if (trimmed === '') return [];
        const json = await this.getJson(
            buildGoogleSearchUrl(trimmed, limit, this.options.apiKey, this.options.country),
        );
        return mapGoogleResponse(json);
    }

    async searchIsbn(isbn: string): Promise<SearchHit[]> {
        const json = await this.getJson(
            buildGoogleIsbnUrl(isbn, this.options.apiKey, this.options.country),
        );
        return mapGoogleResponse(json);
    }

    /** Google search returns full records, so there is nothing more to fetch. */
    async resolve(hit: SearchHit): Promise<BookMetadata> {
        return googleHitToMetadata(hit);
    }

    clearCache(): void {
        this.cache.clear();
    }
}
