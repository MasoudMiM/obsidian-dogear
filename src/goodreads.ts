// Dogear — Goodreads CSV import.
//
// The Goodreads API was retired in December 2020 and no new keys are issued,
// so the CSV export (My Books -> Import and export -> Export Library) is the
// only sanctioned migration path.
//
// Known quirks this module handles deliberately:
//   - ISBN columns are Excel-escaped as ="0439023483" to stop spreadsheets
//     eating the leading zero.
//   - "My Rating" is 0 when unrated, not blank.
//   - Status lives in "Exclusive Shelf"; custom shelves live in "Bookshelves".
//     Both are needed; Goodreads' own importer misreads shelves without both.
//   - There is exactly ONE "Date Read" per book, so reread history is lost.
//     "Read Count" tells us how many reads there actually were, so we can at
//     least warn instead of silently flattening.
//   - "Date Read" is sporadically blank for large spans of a library. This is
//     a long-standing Goodreads bug, not a parsing failure on our side, so we
//     surface it as a warning rather than guessing.
//
// DOM-free and dependency-free.

import type { Book, Format, ReadingSession, ReadingStatus } from './model';
import { SCHEMA_VERSION, normaliseRating } from './model';
import { coverUrlFromIsbn } from './openlibrary';

// --- RFC 4180 CSV parsing ---------------------------------------------------

/**
 * Parse CSV into rows of raw strings.
 *
 * Hand-rolled because review text routinely contains commas, quotes and
 * embedded newlines, and because bundling a CSV library would bloat a plugin
 * that has to load on mobile.
 */
export function parseCsv(input: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let inQuotes = false;
    let i = 0;

    // Strip a UTF-8 BOM if present.
    const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

    while (i < text.length) {
        const ch = text[i];

        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i += 2;
                    continue;
                }
                inQuotes = false;
                i++;
                continue;
            }
            field += ch;
            i++;
            continue;
        }

        if (ch === '"') {
            inQuotes = true;
            i++;
            continue;
        }
        if (ch === ',') {
            row.push(field);
            field = '';
            i++;
            continue;
        }
        if (ch === '\r') {
            // Handle CRLF and lone CR.
            if (text[i + 1] === '\n') i++;
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
            i++;
            continue;
        }
        if (ch === '\n') {
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
            i++;
            continue;
        }
        field += ch;
        i++;
    }

    // Flush trailing field/row unless the file ended on a clean newline.
    if (field !== '' || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}

/** Parse CSV into header-keyed records. Missing columns are simply absent. */
export function parseCsvRecords(input: string): Record<string, string>[] {
    const rows = parseCsv(input);
    if (rows.length === 0) return [];
    const headers = rows[0].map((h) => h.trim());
    const out: Record<string, string>[] = [];
    for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        // Skip entirely blank lines.
        if (row.length === 1 && row[0].trim() === '') continue;
        const rec: Record<string, string> = {};
        for (let c = 0; c < headers.length; c++) {
            rec[headers[c]] = (row[c] ?? '').trim();
        }
        out.push(rec);
    }
    return out;
}

// --- field cleaning ---------------------------------------------------------

/** Strip Goodreads' Excel armour: `="0439023483"` -> `0439023483`. */
export function cleanIsbn(raw: string): string | undefined {
    if (!raw) return undefined;
    let v = raw.trim();
    const m = /^="?(.*?)"?$/.exec(v);
    if (m) v = m[1];
    v = v.replace(/^"|"$/g, '').trim();
    if (v === '' || v === '=') return undefined;
    return v;
}

/** Goodreads dates are YYYY/MM/DD. Convert to ISO, or undefined if absent. */
export function parseGoodreadsDate(raw: string): string | undefined {
    if (!raw) return undefined;
    const v = raw.trim();
    if (v === '') return undefined;
    const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(v);
    if (!m) return undefined;
    const [, y, mo, d] = m;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/** Split the space-separated "Bookshelves" column into tags. */
export function parseShelves(raw: string): string[] {
    if (!raw) return [];
    return raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '');
}

/**
 * Map "Exclusive Shelf" to a Dogear status.
 *
 * Goodreads has three built-in exclusive shelves, but users can create their
 * own — a DNF shelf being by far the most common, since Goodreads has never
 * shipped DNF as a real status.
 */
export function mapExclusiveShelf(raw: string): ReadingStatus {
    const v = (raw || '').trim().toLowerCase();
    if (v === 'read') return 'finished';
    if (v === 'currently-reading') return 'reading';
    if (v === 'to-read') return 'want-to-read';
    if (/dnf|abandon|did-not-finish|unfinished|gave-up/.test(v)) return 'dnf';
    // Unknown custom exclusive shelf: safest default is the TBR pile.
    return 'want-to-read';
}

// --- mapped output ----------------------------------------------------------

export type ImportWarningKind =
    | 'missing-read-date'
    | 'reread-history-lost'
    | 'no-page-count'
    | 'missing-title';

export interface ImportWarning {
    kind: ImportWarningKind;
    message: string;
}

export interface GoodreadsBook {
    title: string;
    authors: string[];
    isbn10?: string;
    isbn13?: string;
    publisher?: string;
    published?: string;
    pages?: number;
    rating?: number;
    review?: string;
    privateNotes?: string;
    status: ReadingStatus;
    dateRead?: string;
    dateAdded?: string;
    tags: string[];
    /** Goodreads' own count of how many times this was read. */
    readCount: number;
    warnings: ImportWarning[];
}

export interface ImportSummary {
    books: GoodreadsBook[];
    /** Rows that had no usable title and were dropped. */
    skipped: number;
    counts: Record<ImportWarningKind, number>;
}

function num(raw: string | undefined): number | undefined {
    if (!raw) return undefined;
    const n = Number(raw.trim());
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Combine the author columns into a list, primary author first. */
export function collectAuthors(rec: Record<string, string>): string[] {
    const authors: string[] = [];
    const primary = (rec['Author'] || '').trim();
    if (primary) authors.push(primary);
    const additional = (rec['Additional Authors'] || '').trim();
    if (additional) {
        for (const a of additional.split(',')) {
            const name = a.trim();
            if (name && !authors.includes(name)) authors.push(name);
        }
    }
    return authors;
}

/** Map one CSV record to a book, collecting per-row warnings. */
export function mapRecord(rec: Record<string, string>): GoodreadsBook | null {
    const title = (rec['Title'] || '').trim();
    if (!title) return null;

    const warnings: ImportWarning[] = [];
    const status = mapExclusiveShelf(rec['Exclusive Shelf'] || '');
    const dateRead = parseGoodreadsDate(rec['Date Read'] || '');
    const readCountRaw = Number((rec['Read Count'] || '').trim());
    const readCount = Number.isFinite(readCountRaw) && readCountRaw > 0 ? readCountRaw : 0;
    const pages = num(rec['Number of Pages']);

    if (status === 'finished' && !dateRead) {
        warnings.push({
            kind: 'missing-read-date',
            message:
                'Marked read but has no read date. This is a known Goodreads export bug — re-export in a few days and compare.',
        });
    }
    if (readCount > 1) {
        warnings.push({
            kind: 'reread-history-lost',
            message: `Goodreads records ${readCount} reads but exports only one date. Earlier reads cannot be recovered from the CSV.`,
        });
    }
    if (!pages) {
        warnings.push({
            kind: 'no-page-count',
            message: 'No page count. Page-based progress will be unavailable until one is set.',
        });
    }

    return {
        title,
        authors: collectAuthors(rec),
        isbn10: cleanIsbn(rec['ISBN'] || ''),
        isbn13: cleanIsbn(rec['ISBN13'] || ''),
        publisher: (rec['Publisher'] || '').trim() || undefined,
        published:
            (rec['Original Publication Year'] || '').trim() ||
            (rec['Year Published'] || '').trim() ||
            undefined,
        pages,
        rating: normaliseRating(Number(rec['My Rating'] || '0')),
        review: (rec['My Review'] || '').trim() || undefined,
        privateNotes: (rec['Private Notes'] || '').trim() || undefined,
        status,
        dateRead,
        dateAdded: parseGoodreadsDate(rec['Date Added'] || ''),
        tags: parseShelves(rec['Bookshelves'] || ''),
        readCount,
        warnings,
    };
}

/** Parse and map a full Goodreads export. */
export function importGoodreadsCsv(csv: string): ImportSummary {
    const records = parseCsvRecords(csv);
    const books: GoodreadsBook[] = [];
    let skipped = 0;
    const counts: Record<ImportWarningKind, number> = {
        'missing-read-date': 0,
        'reread-history-lost': 0,
        'no-page-count': 0,
        'missing-title': 0,
    };

    for (const rec of records) {
        const book = mapRecord(rec);
        if (!book) {
            skipped++;
            counts['missing-title']++;
            continue;
        }
        for (const w of book.warnings) counts[w.kind]++;
        books.push(book);
    }

    return { books, skipped, counts };
}

/** Quick check that a file actually looks like a Goodreads export. */
export function looksLikeGoodreadsExport(csv: string): boolean {
    const firstLine = csv.slice(0, 2000).split(/\r?\n/)[0] || '';
    return /Exclusive Shelf/.test(firstLine) && /Title/.test(firstLine);
}

// --- conversion into Dogear's model -----------------------------------------

/**
 * Pull series information out of a Goodreads title.
 *
 * Goodreads has no series field in its export; it embeds the series in the
 * title, as "Gideon the Ninth (The Locked Tomb #1)" or "Harry Potter and the
 * Sorcerer's Stone (Harry Potter, #1)". Left alone, every book in a series
 * gets a cluttered title and Dogear's series fields stay empty.
 *
 * A "#" is required, so ordinary parenthetical subtitles — "The Power Broker
 * (Urban studies & biography)" — are left exactly as they are.
 */
export function splitSeriesFromTitle(raw: string): {
    title: string;
    series?: string;
    seriesPosition?: number;
} {
    const match = /^(.*?)\s*\(([^()]*?),?\s*#([\d.]+)(?:\s*-\s*[\d.]+)?\)\s*$/.exec(raw.trim());
    if (!match) return { title: raw.trim() };

    const title = match[1].trim();
    const series = match[2].trim();
    const position = Number(match[3]);

    // A title that is nothing but a series reference is not worth splitting.
    if (title === '' || series === '') return { title: raw.trim() };

    return {
        title,
        series,
        seriesPosition: Number.isFinite(position) ? position : undefined,
    };
}

/**
 * Turn a parsed Goodreads row into a Dogear book.
 *
 * Two decisions worth stating:
 *
 * Goodreads stores exactly one read date, even when it says you read a book
 * four times. There is no way to recover the missing dates, so rather than
 * inventing four sessions with fabricated dates, one session is created with
 * the date that actually exists and the true count is recorded in a warning.
 * A tracker that quietly makes up history is worse than one that admits a gap.
 *
 * Reviews and private notes are prose and belong in the note body, not in
 * frontmatter. They are returned separately so the caller can write them
 * under the Notes heading, where Dogear will never touch them again.
 */
/** A date the reading log can actually read back. */
export function isIsoDate(value: string | undefined): value is string {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [y, m, d] = value.split('-').map(Number);
    if (m < 1 || m > 12 || d < 1 || d > 31) return false;
    // Reject dates that do not exist, such as 2026-02-31.
    const probe = new Date(Date.UTC(y, m - 1, d));
    return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

export function goodreadsToBook(
    gb: GoodreadsBook,
    defaultFormat: Format,
): { book: Book; notes: string } {
    // Validate rather than trust. This function is exported and a malformed
    // row must not be able to write nonsense into a note — particularly a
    // date, which the log parser would fail to read back and silently drop.
    const readDate = isIsoDate(gb.dateRead) ? gb.dateRead : undefined;
    const addedDate = isIsoDate(gb.dateAdded) ? gb.dateAdded : undefined;
    const pages = typeof gb.pages === 'number' && gb.pages > 0 ? Math.round(gb.pages) : undefined;

    const sessions: ReadingSession[] = [];

    if (gb.status === 'finished') {
        sessions.push({
            id: 's1',
            format: defaultFormat,
            // Goodreads exports no start date, only a read date.
            finished: readDate,
            entries: [],
        });
    } else if (gb.status === 'reading') {
        sessions.push({
            id: 's1',
            format: defaultFormat,
            started: addedDate,
            entries: [],
        });
    }
    // 'want-to-read' and 'dnf' get no session: there is nothing to record.

    const { title, series, seriesPosition } = splitSeriesFromTitle(gb.title);

    // Goodreads exports no cover image. Open Library serves covers at a URL
    // built from the ISBN, so any book with one gets artwork for free — no
    // search, no API call, no rate limit, no key. Without this an imported
    // library is a wall of blank placeholders.
    const isbn = gb.isbn13 ?? gb.isbn10;
    const cover = isbn ? coverUrlFromIsbn(isbn, 'M') : undefined;

    const book: Book = {
        schemaVersion: SCHEMA_VERSION,
        title,
        series,
        seriesPosition,
        cover,
        authors: gb.authors,
        isbn10: gb.isbn10,
        isbn13: gb.isbn13,
        publisher: gb.publisher,
        published: gb.published,
        tags: gb.tags,
        metrics: { pages },
        rating: normaliseRating(gb.rating),
        status: gb.status,
        sessions,
    };

    // Preserve the reader's own writing verbatim.
    const parts: string[] = [];
    if (gb.review && gb.review.trim() !== '') parts.push(gb.review.trim());
    if (gb.privateNotes && gb.privateNotes.trim() !== '') {
        parts.push(`**Private notes**\n\n${gb.privateNotes.trim()}`);
    }
    if (gb.readCount > 1) {
        parts.push(
            `_Goodreads recorded ${gb.readCount} reads of this book but exports only the most recent date, so earlier reads could not be imported._`,
        );
    }

    return { book, notes: parts.join('\n\n') };
}

/**
 * A key for spotting a book already in the vault.
 *
 * ISBN when there is one, otherwise title and primary author normalised. The
 * same rule the repository uses, extracted so an import can check a thousand
 * books against an index instead of scanning the folder a thousand times.
 */
export function duplicateKey(book: {
    isbn13?: string;
    isbn10?: string;
    title: string;
    authors: string[];
}): string {
    const isbn = (book.isbn13 ?? book.isbn10 ?? '').replace(/[^0-9Xx]/g, '').toUpperCase();
    if (isbn !== '') return `isbn:${isbn}`;
    const title = book.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const author = (book.authors[0] ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return `t:${title}|a:${author}`;
}
