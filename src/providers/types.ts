// Dogear — metadata provider interface.
//
// Why this exists: Open Library is free, key-less and the obvious first
// choice, but during development it returned 429 for ordinary single searches.
// That is a known problem on their side — their own tracker carries an open
// issue about rate limits firing far too eagerly, and other book tools have
// hit the same wall.
//
// A reading tracker whose "add a book" button depends on one donation-funded
// service being healthy is not a reliable tool. So metadata lookup is a CHAIN:
// several independent providers, tried in order, each able to answer on its
// own. One being throttled or down degrades the result rather than breaking
// the feature.
//
// DOM-free and dependency-free.

/** A single search result, normalised across providers. */
export interface SearchHit {
    /** Which provider produced this. */
    providerId: string;
    /** Provider-native identifier. */
    id: string;
    title: string;
    subtitle?: string;
    authors: string[];
    year?: number;
    coverUrl?: string;
    /** Page count, where the provider gives one at search time. */
    pages?: number;
    isbn10?: string;
    isbn13?: string;
    publisher?: string;
    published?: string;
    tags: string[];
    /**
     * True when the hit already carries everything Dogear stores, so
     * `resolve()` needs no further request.
     */
    complete: boolean;
    /** Provider-specific payload, passed back to resolve(). */
    raw?: unknown;
}

/** The metadata Dogear stores for a book. */
export interface BookMetadata {
    title: string;
    authors: string[];
    cover?: string;
    isbn10?: string;
    isbn13?: string;
    publisher?: string;
    published?: string;
    pages?: number;
    tags: string[];
    /** Open Library keys, when that is where the record came from. */
    olWork?: string;
    olEdition?: string;
    /** Google Books volume id, when that is the source. */
    googleId?: string;
    /** Which provider supplied this, for display and diagnostics. */
    source: string;
}

export interface BookProvider {
    /** Stable id, used in settings and frontmatter. */
    readonly id: string;
    /** Name shown in the interface. */
    readonly label: string;
    /** Credit line, shown in settings. */
    readonly attribution: string;

    search(query: string, limit: number): Promise<SearchHit[]>;
    /** Fill in anything search could not supply. */
    resolve(hit: SearchHit): Promise<BookMetadata>;
    /** Milliseconds until this provider will accept requests again, or 0. */
    cooldownRemaining?(): number;
    /**
     * Why this provider cannot be used at all, or null if it is usable.
     *
     * Distinct from a cooldown: a cooldown ends by itself, this does not.
     * Used to skip sources that need setting up, so the chain never spends a
     * request on one that is guaranteed to fail.
     */
    unavailableReason?(): string | null;
}

/** Raised when every provider in the chain failed. */
export class AllProvidersFailedError extends Error {
    constructor(
        readonly failures: Array<{ provider: string; reason: string }>,
        /** The underlying errors, so a fixable problem can still be spotted. */
        readonly errors: Error[] = [],
    ) {
        const detail = failures.map((f) => `${f.provider}: ${f.reason}`).join('; ');
        super(`No book source could answer. ${detail}`);
        this.name = 'AllProvidersFailedError';
    }
}

/** Normalise an ISBN for comparison: digits and X only, upper case. */
export function normaliseIsbn(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    const clean = raw.replace(/[^0-9Xx]/g, '').toUpperCase();
    return clean === '' ? undefined : clean;
}

/** Loose key for spotting the same book from two different providers. */
export function dedupeKey(hit: SearchHit): string {
    const isbn = normaliseIsbn(hit.isbn13) ?? normaliseIsbn(hit.isbn10);
    if (isbn) return `isbn:${isbn}`;
    const title = hit.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const author = (hit.authors[0] ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return `t:${title}|a:${author}`;
}
