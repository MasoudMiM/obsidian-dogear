// Dogear — Open Library network client.
//
// Open Library is free, key-less and funded by donations. In exchange it asks
// clients to identify themselves, cache aggressively, and not hammer search.
// This module does all three:
//
//   - every request carries a descriptive User-Agent
//   - responses are cached in memory with a TTL (catalogue data changes slowly)
//   - requests are spaced by a minimum interval
//   - 429 and 5xx responses back off exponentially rather than retrying hot
//
// The HTTP call itself is injected, so the plugin can supply Obsidian's
// `requestUrl` (which sidesteps CORS) while tests supply a stub. That keeps
// this module DOM-free and fully testable.

import { TokenBucket } from './ratelimit';
import {
    type Edition,
    type EditionPreference,
    type ResolvedBookMetadata,
    type WorkResult,
    USER_AGENT,
    buildEditionsUrl,
    buildIsbnSearchUrl,
    buildSearchUrl,
    mapEditionsResponse,
    mapSearchResponse,
    needsEditionLookup,
    pickBestEdition,
    resolveMetadata,
} from './openlibrary';

export interface HttpResponse {
    status: number;
    json: unknown;
    /** First part of the raw body, kept so failures can say what came back. */
    bodySnippet?: string;
    /** Lower-cased response headers, for Retry-After. */
    headers?: Record<string, string>;
}

/**
 * Thrown when Open Library is refusing requests.
 *
 * Distinct from a generic failure because the remedy is completely different:
 * waiting helps, retrying immediately actively hurts.
 */
export class RateLimitError extends Error {
    constructor(
        public readonly retryAfterMs: number,
        /** Which service is throttling. Never hardcode this — the same error
         *  class is raised by every provider, and mislabelling it sends people
         *  investigating the wrong service entirely. */
        providerLabel = 'The book source',
        /** What the server actually said. Never discard this: a summary that
         *  drops the underlying detail costs a full round trip to diagnose. */
        readonly detail?: string,
    ) {
        const secs = Math.ceil(retryAfterMs / 1000);
        const suffix = detail ? ` (${detail})` : '';
        super(`${providerLabel} is rate limiting requests. Try again in about ${secs}s.${suffix}`);
        this.name = 'RateLimitError';
    }
}

/**
 * A problem the reader can actually fix, as opposed to one they must wait out.
 * Kept distinct so the interface can offer an action instead of a stopwatch.
 */
export class ProviderConfigError extends Error {
    constructor(
        message: string,
        /** What to do about it. */
        readonly remedy: string,
    ) {
        super(message);
        this.name = 'ProviderConfigError';
    }
}

/** Parse a Retry-After header, which may be seconds or an HTTP date. */
export function parseRetryAfter(value: string | undefined, now: number): number | null {
    if (!value) return null;
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
    const date = Date.parse(trimmed);
    if (Number.isFinite(date)) return Math.max(0, date - now);
    return null;
}

/** Injected HTTP layer. Obsidian supplies `requestUrl`; tests supply a stub. */
export type Requester = (url: string, headers: Record<string, string>) => Promise<HttpResponse>;

export interface ClientOptions {
    /** Cache lifetime in ms. Catalogue data is stable, so this can be long. */
    ttlMs?: number;
    /** Maximum cached entries before the oldest are evicted. */
    maxEntries?: number;
    /** Minimum gap between outbound requests, in ms. */
    minIntervalMs?: number;
    /** Attempts per request, including the first. */
    maxAttempts?: number;
    /** Base backoff in ms; doubles per attempt. */
    backoffMs?: number;
    /** How long to stand down after a 429 that gives no Retry-After. */
    defaultCooldownMs?: number;
    /** Injected clock, for deterministic tests. */
    now?: () => number;
    /** Injected sleep, for deterministic tests. */
    sleep?: (ms: number) => Promise<void>;
    /** Outgoing request limiter, to stay under the service's tolerance. */
    bucket?: TokenBucket;
}

interface CacheEntry {
    value: unknown;
    expires: number;
}

export class OpenLibraryClient {
    private cache = new Map<string, CacheEntry>();
    private lastRequestAt = 0;
    private readonly ttlMs: number;
    private readonly maxEntries: number;
    private readonly minIntervalMs: number;
    private readonly maxAttempts: number;
    private readonly backoffMs: number;
    private readonly defaultCooldownMs: number;
    private readonly bucket?: TokenBucket;
    /** Epoch ms before which no request should be attempted. */
    private rateLimitedUntil = 0;
    private readonly now: () => number;
    private readonly sleep: (ms: number) => Promise<void>;

    /** Counters for diagnostics and tests. */
    stats = { requests: 0, cacheHits: 0, retries: 0, rateLimited: 0 };

    /** Milliseconds until requests are allowed again, or 0 if not limited. */
    get cooldownRemaining(): number {
        return Math.max(0, this.rateLimitedUntil - this.now());
    }

    constructor(
        private readonly request: Requester,
        options: ClientOptions = {},
    ) {
        this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
        this.maxEntries = options.maxEntries ?? 200;
        this.minIntervalMs = options.minIntervalMs ?? 250;
        this.maxAttempts = options.maxAttempts ?? 3;
        this.backoffMs = options.backoffMs ?? 2000;
        this.defaultCooldownMs = options.defaultCooldownMs ?? 60_000;
        this.bucket = options.bucket;
        this.now = options.now ?? (() => Date.now());
        this.sleep = options.sleep ?? ((ms) => new Promise((r) => window.setTimeout(r, ms)));
    }

    clearCache(): void {
        this.cache.clear();
    }

    private readCache(url: string): unknown {
        const hit = this.cache.get(url);
        if (!hit) return undefined;
        if (hit.expires <= this.now()) {
            this.cache.delete(url);
            return undefined;
        }
        this.stats.cacheHits++;
        return hit.value;
    }

    private writeCache(url: string, value: unknown): void {
        if (this.cache.size >= this.maxEntries) {
            // Map preserves insertion order, so the first key is the oldest.
            const oldest = this.cache.keys().next();
            if (!oldest.done) this.cache.delete(oldest.value);
        }
        this.cache.set(url, { value, expires: this.now() + this.ttlMs });
    }

    /** Fetch JSON with caching, spacing, cooldown and backoff. */
    async getJson(url: string): Promise<unknown> {
        const cached = this.readCache(url);
        if (cached !== undefined) return cached;

        // Standing down. Firing anyway extends the block and is exactly what
        // turns a soft rate limit into a hard one.
        const remaining = this.cooldownRemaining;
        if (remaining > 0) throw new RateLimitError(remaining, 'Open Library');

        let attempt = 0;
        let lastError: Error | null = null;

        while (attempt < this.maxAttempts) {
            attempt++;

            const since = this.now() - this.lastRequestAt;
            if (since < this.minIntervalMs) {
                await this.sleep(this.minIntervalMs - since);
            }
            // Self-imposed limit. Open Library's own 429 message points at
            // their data dumps, which is a polite way of saying "stop asking".
            if (this.bucket) await this.bucket.take();

            this.lastRequestAt = this.now();
            this.stats.requests++;

            let res: HttpResponse;
            try {
                res = await this.request(url, {
                    'User-Agent': USER_AGENT,
                    Accept: 'application/json',
                });
            } catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
                if (attempt < this.maxAttempts) {
                    this.stats.retries++;
                    await this.sleep(this.backoffWithJitter(attempt));
                    continue;
                }
                break;
            }

            if (res.status >= 200 && res.status < 300) {
                this.writeCache(url, res.json);
                return res.json;
            }

            // Rate limiting is handled separately: honour Retry-After, enter a
            // cooldown, and do NOT keep hammering.
            if (res.status === 429) {
                this.stats.rateLimited++;
                const advertised = parseRetryAfter(res.headers?.['retry-after'], this.now());
                const cooldown = advertised ?? this.defaultCooldownMs;
                this.rateLimitedUntil = this.now() + cooldown;
                throw new RateLimitError(cooldown, 'Open Library', res.bodySnippet);
            }

            // 5xx is worth one more try; other 4xx are not.
            const detail = res.bodySnippet ? `: ${res.bodySnippet}` : '';
            lastError = new Error(`Open Library returned ${res.status}${detail}`);
            if (res.status >= 500 && attempt < this.maxAttempts) {
                this.stats.retries++;
                await this.sleep(this.backoffWithJitter(attempt));
                continue;
            }
            break;
        }

        throw lastError ?? new Error('Open Library request failed');
    }

    /**
     * Exponential backoff with jitter.
     *
     * Jitter matters even for a single user: without it, a retry storm from
     * many clients re-synchronises on every wave.
     */
    private backoffWithJitter(attempt: number): number {
        const base = this.backoffMs * 2 ** (attempt - 1);
        return Math.round(base * (0.5 + Math.random() * 0.5));
    }

    /** Search for works by free text. */
    async search(query: string, limit = 20): Promise<WorkResult[]> {
        const trimmed = query.trim();
        if (trimmed === '') return [];
        const json = await this.getJson(buildSearchUrl(trimmed, limit));
        return mapSearchResponse(json);
    }

    /** Search by ISBN — used by import enrichment and, later, barcode scanning. */
    async searchIsbn(isbn: string): Promise<WorkResult[]> {
        const clean = isbn.replace(/[^0-9Xx]/g, '');
        if (clean === '') return [];
        const json = await this.getJson(buildIsbnSearchUrl(clean));
        return mapSearchResponse(json);
    }

    /** Fetch the editions of a work. */
    async editions(workKey: string, limit = 50): Promise<Edition[]> {
        const json = await this.getJson(buildEditionsUrl(workKey, limit));
        return mapEditionsResponse(json);
    }

    /**
     * Resolve a search result into the metadata Dogear stores.
     *
     * Skips the editions call entirely when the work has a single edition,
     * since the work-level median page count is then that edition's count.
     * Falls back to work-level data if the editions call fails — a missing
     * edition should degrade the result, not block adding the book.
     */
    async resolve(
        work: WorkResult,
        prefs: EditionPreference = {},
    ): Promise<ResolvedBookMetadata> {
        if (!needsEditionLookup(work)) {
            return resolveMetadata(work, null);
        }
        try {
            const editions = await this.editions(work.workKey);
            const best = pickBestEdition(editions, prefs);
            return resolveMetadata(work, best);
        } catch {
            return resolveMetadata(work, null);
        }
    }
}
