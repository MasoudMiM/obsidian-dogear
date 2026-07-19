// Dogear — Open Library integration (pure logic).
//
// Open Library is free and needs no API key, which is the whole reason it was
// chosen: Google Books now effectively requires every user to create their own
// Google Cloud project, which is exactly the setup friction Dogear exists to
// avoid.
//
// Open Library asks clients to identify themselves with a descriptive
// User-Agent, to cache results, and not to hammer search. We honour all three.
//
// The important modelling wrinkle: Open Library separates WORKS (the abstract
// book) from EDITIONS (a specific printing). Page counts, ISBNs and covers
// live on editions. Since Dogear tracks page-based progress, resolving to a
// sensible edition matters — a work alone cannot tell you how long the book is.
//
// This module contains no network calls so it can be unit tested; the caller
// supplies fetched JSON.

export const OL_BASE = 'https://openlibrary.org';
export const OL_COVERS = 'https://covers.openlibrary.org';

/** Sent on every request so Open Library can identify the traffic. */
export const USER_AGENT = 'Dogear/0.1.0 (Obsidian reading tracker; +https://github.com/MasoudMiM/dogear)';

export type CoverSize = 'S' | 'M' | 'L';

// --- search -----------------------------------------------------------------

/** Fields requested explicitly — keeps responses small and predictable. */
export const SEARCH_FIELDS = [
    'key',
    'title',
    'subtitle',
    'author_name',
    'first_publish_year',
    'cover_i',
    'edition_count',
    'number_of_pages_median',
    'isbn',
    'publisher',
    'subject',
].join(',');

export function buildSearchUrl(query: string, limit = 20): string {
    const q = encodeURIComponent(query.trim());
    return `${OL_BASE}/search.json?q=${q}&fields=${encodeURIComponent(SEARCH_FIELDS)}&limit=${limit}`;
}

/** Search by ISBN — used by barcode scanning later, and by import enrichment. */
export function buildIsbnSearchUrl(isbn: string): string {
    const clean = isbn.replace(/[^0-9Xx]/g, '');
    return `${OL_BASE}/search.json?isbn=${encodeURIComponent(clean)}&fields=${encodeURIComponent(SEARCH_FIELDS)}&limit=5`;
}

export interface WorkResult {
    /** Work key, e.g. "/works/OL27448W". */
    workKey: string;
    title: string;
    subtitle?: string;
    authors: string[];
    firstPublishYear?: number;
    coverId?: number;
    editionCount?: number;
    /** Median across editions — a decent fallback when we can't pick one. */
    medianPages?: number;
    isbns: string[];
    publishers: string[];
    subjects: string[];
}

function asArray(v: unknown): string[] {
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
    return [];
}

/** Map a /search.json response into work results. Tolerates missing fields. */
export function mapSearchResponse(json: unknown): WorkResult[] {
    const docs = (json as { docs?: unknown[] })?.docs;
    if (!Array.isArray(docs)) return [];
    const out: WorkResult[] = [];
    for (const raw of docs) {
        const d = raw as Record<string, unknown>;
        const key = typeof d.key === 'string' ? d.key : undefined;
        const title = typeof d.title === 'string' ? d.title : undefined;
        if (!key || !title) continue;
        out.push({
            workKey: key,
            title,
            subtitle: typeof d.subtitle === 'string' ? d.subtitle : undefined,
            authors: asArray(d.author_name),
            firstPublishYear:
                typeof d.first_publish_year === 'number' ? d.first_publish_year : undefined,
            coverId: typeof d.cover_i === 'number' ? d.cover_i : undefined,
            editionCount: typeof d.edition_count === 'number' ? d.edition_count : undefined,
            medianPages:
                typeof d.number_of_pages_median === 'number'
                    ? d.number_of_pages_median
                    : undefined,
            isbns: asArray(d.isbn),
            publishers: asArray(d.publisher),
            subjects: asArray(d.subject).slice(0, 12),
        });
    }
    return out;
}

// --- editions ---------------------------------------------------------------

/**
 * Whether a second round trip to /editions.json is actually needed.
 *
 * Open Library's own guidance: when a work has exactly one edition, that
 * edition's `number_of_pages` is necessarily the same as the work-level
 * `number_of_pages_median`, so the extra call can be skipped. Skipping it
 * is both faster on mobile and politer to a free, donation-funded service
 * that asks clients not to hammer search.
 */
export function needsEditionLookup(work: WorkResult): boolean {
    if (work.editionCount === 1 && work.medianPages && work.medianPages > 0) return false;
    return true;
}

export function buildEditionsUrl(workKey: string, limit = 50): string {
    // workKey already looks like "/works/OL27448W".
    const key = workKey.startsWith('/') ? workKey : `/works/${workKey}`;
    return `${OL_BASE}${key}/editions.json?limit=${limit}`;
}

export interface Edition {
    /** Edition key, e.g. "/books/OL7353617M". */
    editionKey: string;
    title?: string;
    pages?: number;
    publishers: string[];
    publishDate?: string;
    isbn10?: string;
    isbn13?: string;
    coverId?: number;
    /** Language codes, e.g. ["eng"]. */
    languages: string[];
    physicalFormat?: string;
}

function firstString(v: unknown): string | undefined {
    const arr = asArray(v);
    return arr.length > 0 ? arr[0] : undefined;
}

export function mapEditionsResponse(json: unknown): Edition[] {
    const entries = (json as { entries?: unknown[] })?.entries;
    if (!Array.isArray(entries)) return [];
    const out: Edition[] = [];
    for (const raw of entries) {
        const e = raw as Record<string, unknown>;
        const key = typeof e.key === 'string' ? e.key : undefined;
        if (!key) continue;

        const languages: string[] = [];
        if (Array.isArray(e.languages)) {
            for (const l of e.languages) {
                const lk = (l as { key?: unknown })?.key;
                if (typeof lk === 'string') languages.push(lk.replace('/languages/', ''));
            }
        }
        const covers = Array.isArray(e.covers)
            ? e.covers.filter((c): c is number => typeof c === 'number' && c > 0)
            : [];

        out.push({
            editionKey: key,
            title: typeof e.title === 'string' ? e.title : undefined,
            pages: typeof e.number_of_pages === 'number' ? e.number_of_pages : undefined,
            publishers: asArray(e.publishers),
            publishDate: typeof e.publish_date === 'string' ? e.publish_date : undefined,
            isbn10: firstString(e.isbn_10),
            isbn13: firstString(e.isbn_13),
            coverId: covers.length > 0 ? covers[0] : undefined,
            languages,
            physicalFormat:
                typeof e.physical_format === 'string' ? e.physical_format : undefined,
        });
    }
    return out;
}

export interface EditionPreference {
    /** Preferred language code, default "eng". */
    language?: string;
    /** Prefer an edition matching this ISBN, if present. */
    isbn?: string;
}

/**
 * Score an edition for suitability as the canonical record.
 *
 * A page count is weighted heaviest because page-based progress is unusable
 * without it — an edition with no page count is close to useless to us even
 * if it is otherwise well populated.
 */
export function scoreEdition(edition: Edition, prefs: EditionPreference = {}): number {
    const language = prefs.language ?? 'eng';
    let score = 0;

    if (prefs.isbn) {
        const want = prefs.isbn.replace(/[^0-9Xx]/g, '');
        if (edition.isbn13 === want || edition.isbn10 === want) score += 100;
    }
    if (edition.pages && edition.pages > 0) score += 40;
    if (edition.languages.includes(language)) score += 20;
    if (edition.coverId) score += 10;
    if (edition.isbn13) score += 5;
    if (edition.publishers.length > 0) score += 3;
    if (edition.publishDate) score += 2;

    // Audio editions carry runtimes, not page counts; they are a poor default
    // for a book record even though the reader may listen to one.
    if (edition.physicalFormat && /audio|cd|cassette/i.test(edition.physicalFormat)) {
        score -= 30;
    }
    return score;
}

/** Choose the most useful edition, or null when there are none. */
export function pickBestEdition(
    editions: Edition[],
    prefs: EditionPreference = {},
): Edition | null {
    if (editions.length === 0) return null;
    let best = editions[0];
    let bestScore = scoreEdition(best, prefs);
    for (let i = 1; i < editions.length; i++) {
        const s = scoreEdition(editions[i], prefs);
        if (s > bestScore) {
            best = editions[i];
            bestScore = s;
        }
    }
    return best;
}

// --- covers -----------------------------------------------------------------

export function coverUrlFromId(coverId: number, size: CoverSize = 'L'): string {
    return `${OL_COVERS}/b/id/${coverId}-${size}.jpg`;
}

/**
 * A cover image address built from an ISBN.
 *
 * `default=false` is not optional. Without it, Open Library answers a missing
 * cover with a 1×1 transparent GIF and a 200 status — which loads
 * successfully, so no error handler fires, and the interface stretches a
 * single pixel across the card instead of showing a placeholder. With it, a
 * missing cover is an honest 404.
 */
export function coverUrlFromIsbn(isbn: string, size: CoverSize = 'L'): string {
    const clean = isbn.replace(/[^0-9Xx]/g, '');
    return `${OL_COVERS}/b/isbn/${clean}-${size}.jpg?default=false`;
}

/** Best available cover for a work/edition pair, or undefined. */
export function resolveCoverUrl(
    work: Pick<WorkResult, 'coverId' | 'isbns'>,
    edition?: Edition | null,
    size: CoverSize = 'L',
): string | undefined {
    if (edition?.coverId) return coverUrlFromId(edition.coverId, size);
    if (work.coverId) return coverUrlFromId(work.coverId, size);
    const isbn = edition?.isbn13 ?? edition?.isbn10 ?? work.isbns[0];
    if (isbn) return coverUrlFromIsbn(isbn, size);
    return undefined;
}

// --- combined metadata ------------------------------------------------------

export interface ResolvedBookMetadata {
    title: string;
    authors: string[];
    cover?: string;
    isbn10?: string;
    isbn13?: string;
    publisher?: string;
    published?: string;
    pages?: number;
    tags: string[];
    olWork: string;
    olEdition?: string;
}

/**
 * Merge a work result with a chosen edition into the fields Dogear stores.
 *
 * Edition data wins where present (it is specific); work data fills gaps.
 * Page count falls back to the cross-edition median so page tracking is
 * usable even when no single edition reports one.
 */
export function resolveMetadata(
    work: WorkResult,
    edition?: Edition | null,
): ResolvedBookMetadata {
    const title = edition?.title || work.title;
    const pages = edition?.pages ?? work.medianPages;
    return {
        title: work.subtitle && title === work.title ? `${title}: ${work.subtitle}` : title,
        authors: work.authors,
        cover: resolveCoverUrl(work, edition),
        isbn10: edition?.isbn10,
        isbn13: edition?.isbn13 ?? work.isbns[0],
        publisher: edition?.publishers[0] ?? work.publishers[0],
        published: edition?.publishDate ?? (work.firstPublishYear?.toString() || undefined),
        pages: pages && pages > 0 ? Math.round(pages) : undefined,
        tags: work.subjects.slice(0, 8),
        olWork: work.workKey,
        olEdition: edition?.editionKey,
    };
}
