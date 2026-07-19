// Dogear — reading statistics.
//
// The design constraint that shaped everything here: an imported library
// knows almost nothing. Goodreads exports a finish date, a rating and a page
// count, and no start date at all — so pace, time-to-finish and streaks
// cannot be computed for the great majority of anyone's books.
//
// A statistics page full of empty charts is worse than a smaller one that is
// always true, so every figure below works from a finish date, a rating and a
// page count alone. Anything richer appears only when the data to support it
// actually exists.
//
// What is deliberately absent:
//   - Mood and genre. There is no such data in a vault, and inventing a
//     tagging chore to fill a chart is the wrong trade.
//   - Reading pace and streaks. Unavailable for imported books, and the
//     roadmap already records that some readers actively want a tracker that
//     does not keep score of their habits.
//   - Anything requiring a comparison to other readers. Single-user vault.
//
// Pure and DOM-free.

import type { Book, ReadingStatus } from './model';
import { isTimeBased } from './model';

export interface YearSummary {
    year: number;
    books: number;
    pages: number;
    /** Listening time in seconds, for audiobooks. */
    seconds: number;
}

export interface AuthorCount {
    author: string;
    books: number;
}

export interface Bucket {
    label: string;
    count: number;
}

export interface Stats {
    /** Books finished in the selected span. */
    finished: number;
    pages: number;
    seconds: number;
    /** Books finished with no page count, so totals can be qualified. */
    pagesUnknown: number;
    averageRating: number | null;
    ratedCount: number;
    /** Mean pages of the books that have a page count. */
    averagePages: number | null;
    longest: { title: string; pages: number } | null;
    shortest: { title: string; pages: number } | null;
    ratings: Bucket[];
    lengths: Bucket[];
    authors: AuthorCount[];
    /** Books finished per year, oldest first, for the whole library. */
    byYear: YearSummary[];
    /** Books finished per month of the selected year, or null for all time. */
    byMonth: Bucket[] | null;
    /** Current shelf sizes, which are always about now rather than a span. */
    shelves: Array<{ status: ReadingStatus; count: number }>;
    /** Finished books carrying no date, so they cannot be placed in a year. */
    undated: number;
}

/** The year a book was finished, or null if unknown. */
export function finishYear(book: Book): number | null {
    let latest: string | null = null;
    for (const session of book.sessions) {
        if (session.finished && (latest === null || session.finished > latest)) {
            latest = session.finished;
        }
    }
    if (!latest) return null;
    const year = Number(latest.slice(0, 4));
    return Number.isFinite(year) ? year : null;
}

/** The month index (0-11) a book was finished, or null. */
export function finishMonth(book: Book): number | null {
    let latest: string | null = null;
    for (const session of book.sessions) {
        if (session.finished && (latest === null || session.finished > latest)) {
            latest = session.finished;
        }
    }
    if (!latest) return null;
    const month = Number(latest.slice(5, 7));
    return month >= 1 && month <= 12 ? month - 1 : null;
}

/** Was this book read as an audiobook? */
export function wasListened(book: Book): boolean {
    const last = book.sessions[book.sessions.length - 1];
    return last ? isTimeBased(last.format) : false;
}

/** Every year in which something was finished, newest first. */
export function yearsPresent(books: Book[]): number[] {
    const years = new Set<number>();
    for (const book of books) {
        const year = finishYear(book);
        if (year !== null) years.add(year);
    }
    return [...years].sort((a, b) => b - a);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Length bands.
 *
 * Readers asked for finer detail at the long end specifically — the gap
 * between a 500-page book and a 1,200-page one is the whole point, and a
 * single "500+" bucket erases it.
 */
const LENGTH_BANDS: Array<{ label: string; min: number; max: number }> = [
    { label: 'Under 200', min: 0, max: 199 },
    { label: '200–299', min: 200, max: 299 },
    { label: '300–399', min: 300, max: 399 },
    { label: '400–499', min: 400, max: 499 },
    { label: '500–699', min: 500, max: 699 },
    { label: '700–999', min: 700, max: 999 },
    { label: '1000+', min: 1000, max: Number.MAX_SAFE_INTEGER },
];

export function lengthBand(pages: number): string {
    const band = LENGTH_BANDS.find((b) => pages >= b.min && pages <= b.max);
    return band ? band.label : LENGTH_BANDS[LENGTH_BANDS.length - 1].label;
}

/**
 * Compute everything for a span.
 *
 * `year` of null means the whole library.
 */
export function computeStats(
    entries: Array<{ book: Book }>,
    year: number | null,
): Stats {
    const books = entries.map((e) => e.book);

    // Shelves describe the library now, not a period, so they are counted
    // across everything regardless of the selected year.
    const statuses: ReadingStatus[] = ['reading', 'want-to-read', 'finished', 'dnf'];
    const shelves = statuses.map((status) => ({
        status,
        count: books.filter((b) => b.status === status).length,
    }));

    // Every year, for the trend, independent of the selection.
    const yearMap = new Map<number, YearSummary>();
    let undated = 0;
    for (const book of books) {
        if (book.status !== 'finished') continue;
        const y = finishYear(book);
        if (y === null) {
            undated++;
            continue;
        }
        const row = yearMap.get(y) ?? { year: y, books: 0, pages: 0, seconds: 0 };
        row.books++;
        if (wasListened(book)) row.seconds += book.metrics.duration ?? 0;
        else row.pages += book.metrics.pages ?? 0;
        yearMap.set(y, row);
    }
    const byYear = [...yearMap.values()].sort((a, b) => a.year - b.year);

    // The selected span.
    const inSpan = books.filter((b) => {
        if (b.status !== 'finished') return false;
        if (year === null) return true;
        return finishYear(b) === year;
    });

    let pages = 0;
    let seconds = 0;
    let pagesUnknown = 0;
    const withPages: Array<{ title: string; pages: number }> = [];

    for (const book of inSpan) {
        if (wasListened(book)) {
            seconds += book.metrics.duration ?? 0;
            if (!book.metrics.duration && !book.metrics.pages) pagesUnknown++;
        } else if (book.metrics.pages) {
            pages += book.metrics.pages;
            withPages.push({ title: book.title, pages: book.metrics.pages });
        } else {
            pagesUnknown++;
        }
    }

    const rated = inSpan.filter((b) => b.rating !== undefined);
    const averageRating =
        rated.length > 0
            ? Math.round((rated.reduce((sum, b) => sum + (b.rating ?? 0), 0) / rated.length) * 100) /
              100
            : null;

    const sortedByLength = [...withPages].sort((a, b) => b.pages - a.pages);

    // Ratings, in whole stars: quarter-star precision makes a twenty-bar
    // chart nobody can read at a glance.
    const ratingBuckets: Bucket[] = [1, 2, 3, 4, 5].map((star) => ({
        label: `${star}★`,
        count: rated.filter((b) => Math.round(b.rating ?? 0) === star).length,
    }));

    const lengthCounts = new Map<string, number>();
    for (const item of withPages) {
        const label = lengthBand(item.pages);
        lengthCounts.set(label, (lengthCounts.get(label) ?? 0) + 1);
    }
    const lengths = LENGTH_BANDS.map((b) => ({
        label: b.label,
        count: lengthCounts.get(b.label) ?? 0,
    })).filter((b) => b.count > 0);

    const authorCounts = new Map<string, number>();
    for (const book of inSpan) {
        const author = book.authors[0];
        if (!author) continue;
        authorCounts.set(author, (authorCounts.get(author) ?? 0) + 1);
    }
    const authors = [...authorCounts.entries()]
        .map(([author, count]) => ({ author, books: count }))
        .filter((a) => a.books > 1)
        .sort((a, b) => b.books - a.books || a.author.localeCompare(b.author))
        .slice(0, 8);

    const byMonth =
        year === null
            ? null
            : MONTHS.map((label, index) => ({
                  label,
                  count: inSpan.filter((b) => finishMonth(b) === index).length,
              }));

    return {
        finished: inSpan.length,
        pages,
        seconds,
        pagesUnknown,
        averageRating,
        ratedCount: rated.length,
        averagePages:
            withPages.length > 0
                ? Math.round(withPages.reduce((s, x) => s + x.pages, 0) / withPages.length)
                : null,
        longest: sortedByLength[0] ?? null,
        shortest: sortedByLength[sortedByLength.length - 1] ?? null,
        ratings: ratingBuckets,
        lengths,
        authors,
        byYear,
        byMonth,
        shelves,
        undated,
    };
}

/** "12 hours" / "3 days" style figure for listening time. */
export function describeListening(seconds: number): string {
    if (seconds <= 0) return '';
    const hours = seconds / 3600;
    if (hours < 1) return `${Math.round(seconds / 60)} minutes`;
    if (hours < 100) return `${Math.round(hours)} hours`;
    return `${Math.round(hours).toLocaleString()} hours`;
}
