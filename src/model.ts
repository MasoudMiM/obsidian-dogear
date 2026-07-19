// Dogear — core data model.
//
// Design commitments (locked during spec, see README/ROADMAP):
//  1. A book has a LIST of reading sessions, never start/finish fields.
//     Rereads fall out of this for free.
//  2. Format lives on the SESSION, not the book, so "immersion reading"
//     (print by night, audio in the car) is representable.
//  3. Ratings are decimals (quarter-star granularity).
//  4. DNF is a first-class status that records where you stopped and why.
//
// This module is DOM-free and dependency-free so it can be unit tested
// in plain node and reused on mobile.

/** Bumped whenever the on-disk frontmatter shape changes incompatibly. */
export const SCHEMA_VERSION = 1;

export type ReadingStatus = 'want-to-read' | 'reading' | 'finished' | 'dnf';

export const READING_STATUSES: ReadingStatus[] = [
    'want-to-read',
    'reading',
    'finished',
    'dnf',
];

/** Human labels for the UI. Kept here so status text is defined once. */
export const STATUS_LABELS: Record<ReadingStatus, string> = {
    'want-to-read': 'Want to read',
    reading: 'Reading',
    finished: 'Finished',
    dnf: 'Did not finish',
};

export type Format = 'print' | 'ebook' | 'audio';

export const FORMATS: Format[] = ['print', 'ebook', 'audio'];

export const FORMAT_LABELS: Record<Format, string> = {
    print: 'Print',
    ebook: 'Ebook',
    audio: 'Audiobook',
};

/** Formats measured in pages vs. measured in time. */
export function isTimeBased(format: Format): boolean {
    return format === 'audio';
}

/**
 * How the reader typed their position in.
 *
 * `remaining` exists because every audiobook player (Audible, Spotify,
 * Kobo) displays time LEFT, while every tracker asks for time listened.
 * Accepting both is the whole point.
 */
export type PositionUnit = 'page' | 'percent' | 'elapsed' | 'remaining';

export const POSITION_UNIT_LABELS: Record<PositionUnit, string> = {
    page: 'Page',
    percent: 'Percent',
    elapsed: 'Time listened',
    remaining: 'Time remaining',
};

/** Raw input exactly as entered, preserved so we can redisplay it faithfully. */
export interface RawPosition {
    unit: PositionUnit;
    /** Pages/percent as a number; elapsed/remaining as seconds. */
    value: number;
}

/** A single logged progress point. */
export interface ProgressEntry {
    /** ISO date, YYYY-MM-DD. */
    date: string;
    /** Normalised 0..1 position through the book. */
    fraction: number;
    /** What the reader actually typed. */
    raw: RawPosition;
    /**
     * The medium used for THIS entry, when it differs from the session's.
     *
     * Reading one book in two formats is common — the print copy at home, the
     * audiobook while commuting — and both major trackers model format on the
     * edition, which forces readers into workarounds like switching editions
     * mid-book and re-logging the same percentage so nothing appears to
     * change. Recording it per entry makes a mixed read the ordinary case
     * rather than a hack.
     *
     * Left undefined when it matches the session format, so the common case
     * of reading a book one way adds no noise to the log.
     */
    format?: Format;
    /**
     * An optional one-line thought recorded with this position.
     *
     * This is the "I'm at page 200 and the Jones Beach chapter is
     * extraordinary" note. Deliberately short and attached to a moment in the
     * book; longer writing belongs in the body of the note, which Dogear
     * never touches.
     */
    note?: string;
}

/** Totals used to normalise positions. Either may be unknown. */
export interface BookMetrics {
    /** Total pages, for print/ebook. */
    pages?: number;
    /** Total runtime in seconds, for audio. */
    duration?: number;
}

export interface AbandonedInfo {
    /** Where they stopped, 0..1. */
    fraction: number;
    reason?: string;
}

/** One pass through a book. A reread is simply a second session. */
export interface ReadingSession {
    /** Stable id so sessions can be edited/removed in the UI. */
    id: string;
    format: Format;
    /** ISO date. */
    started?: string;
    /** ISO date. Presence implies the session completed. */
    finished?: string;
    entries: ProgressEntry[];
    /** Per-session rating — a reread can land differently. */
    rating?: number;
    /** Set when this session ended in a DNF. */
    abandoned?: AbandonedInfo;
}

export interface Book {
    schemaVersion: number;
    title: string;
    authors: string[];
    cover?: string;
    isbn10?: string;
    isbn13?: string;
    publisher?: string;
    published?: string;
    series?: string;
    seriesPosition?: number;
    tags: string[];
    metrics: BookMetrics;
    /** Overall rating. Sessions may carry their own. */
    rating?: number;
    status: ReadingStatus;
    sessions: ReadingSession[];
    /** Open Library work key, e.g. "/works/OL27448W". */
    olWork?: string;
    /** Open Library edition key, e.g. "/books/OL7353617M". */
    olEdition?: string;
    /** Google Books volume id, when that is where the record came from. */
    googleId?: string;
}

// --- rating -----------------------------------------------------------------

export const MAX_RATING = 5;
/** Quarter-star granularity, the finest any mainstream tracker offers. */
export const RATING_STEP = 0.25;

/**
 * Clamp to 0..5 and snap to the nearest quarter star.
 * Returns undefined for unrated (Goodreads exports 0 for "no rating").
 */
export function normaliseRating(value: number | undefined | null): number | undefined {
    if (value === undefined || value === null || !Number.isFinite(value)) return undefined;
    if (value <= 0) return undefined;
    const clamped = Math.min(value, MAX_RATING);
    const snapped = Math.round(clamped / RATING_STEP) * RATING_STEP;
    // Guard against binary float drift (e.g. 3.7500000000000004).
    return Math.round(snapped * 100) / 100;
}

// --- status -----------------------------------------------------------------

/**
 * Derive status from session history.
 *
 * Used to keep an explicitly-set status honest, and to assign one when
 * importing data that only carries dates.
 */
export function deriveStatus(sessions: ReadingSession[]): ReadingStatus {
    if (sessions.length === 0) return 'want-to-read';
    // The most recent session wins; "most recent" = last in the list, since
    // sessions are appended in order.
    const latest = sessions[sessions.length - 1];
    if (latest.abandoned) return 'dnf';
    if (latest.finished) return 'finished';
    return 'reading';
}

/** How many times the book has been read to completion. */
export function completedReadCount(sessions: ReadingSession[]): number {
    return sessions.filter((s) => s.finished && !s.abandoned).length;
}

/** Furthest point reached in the current (last) session, 0..1. */
export function currentFraction(sessions: ReadingSession[]): number {
    if (sessions.length === 0) return 0;
    const latest = sessions[sessions.length - 1];
    if (latest.finished && !latest.abandoned) return 1;
    if (latest.abandoned) return latest.abandoned.fraction;
    if (latest.entries.length === 0) return 0;
    return latest.entries.reduce((max, e) => Math.max(max, e.fraction), 0);
}

/**
 * Every medium used in a session, in a stable order.
 *
 * The session's own format always comes first. That is not cosmetic: the
 * reading log writes this list into the header and parses it back, and
 * entries without an explicit format fall back to the session's. If the order
 * varied, a saved note could come back attributing entries to the wrong
 * medium.
 */
export function sessionFormats(session: ReadingSession): Format[] {
    const used: Format[] = [session.format];
    for (const entry of session.entries) {
        const format = entry.format ?? session.format;
        if (!used.includes(format)) used.push(format);
    }
    return used;
}

/**
 * How much of the book was covered in each medium.
 *
 * Each entry's share is the ground it gained over the previous high-water
 * mark, credited to the medium used for that entry. Re-reading the same
 * chapter in another format therefore counts for nothing, which is right:
 * this measures the book, not the effort.
 */
export function formatBreakdown(
    session: ReadingSession,
): Array<{ format: Format; share: number }> {
    const totals = new Map<Format, number>();
    let high = 0;
    for (const entry of session.entries) {
        const format = entry.format ?? session.format;
        const gained = Math.max(0, entry.fraction - high);
        if (gained > 0) {
            totals.set(format, (totals.get(format) ?? 0) + gained);
            high = entry.fraction;
        }
    }
    return [...totals.entries()]
        .map(([format, share]) => ({ format, share }))
        .sort((a, b) => b.share - a.share);
}
