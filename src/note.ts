// Dogear — book note serialisation.
//
// A book note is plain Markdown:
//
//   ---
//   <flat frontmatter: metadata, status, rating>
//   ---
//   ## Reading log
//   ### Read 1 — print · 2024-01-02 → 2024-03-12 · 4.5★
//   - 2024-01-02 · page 1
//   - 2024-03-12 · page 387
//
//   ## Notes
//   ...anything the reader wrote...
//
// THE CONTRACT: Dogear owns the frontmatter keys it knows about and the
// "Reading log" section. Everything else — unknown frontmatter keys, prose
// above the log, every heading after it — is preserved byte for byte.
//
// This matters. The main Goodreads-sync plugin for Obsidian wiped user edits
// on every sync, and that is the single loudest complaint about tools in this
// space. Dogear should never eat someone's notes.
//
// DOM-free and dependency-free.

import {
    type Book,
    type Format,
    type ProgressEntry,
    type ReadingSession,
    type ReadingStatus,
    type BookMetrics,
    SCHEMA_VERSION,
    FORMATS,
    FORMAT_LABELS,
    sessionFormats,
    READING_STATUSES,
    normaliseRating,
    deriveStatus,
} from './model';
import { formatDuration, parseDuration, normalisePosition } from './progress';
import { sanitiseTags } from './paths';
import {
    type YamlMap,
    splitNote,
    joinNote,
    parseYaml,
    stringifyYaml,
    asString,
    asNumber,
    asList,
} from './yaml';

/** Heading that marks the section Dogear owns. Configurable in settings. */
export const DEFAULT_LOG_HEADING = 'Reading log';

/** Frontmatter key order — keeps diffs small and the Properties panel tidy. */
export const KEY_ORDER = [
    'dogear',
    'title',
    'authors',
    'cover',
    'status',
    'rating',
    'pages',
    'duration',
    'series',
    'seriesPosition',
    'publisher',
    'published',
    'isbn10',
    'isbn13',
    'tags',
    'olWork',
    'olEdition',
    'googleId',
];

/** Keys Dogear manages. Anything else in frontmatter is left alone. */
const OWNED_KEYS = new Set(KEY_ORDER);

// --- position text ----------------------------------------------------------

export interface ParsedPositionText {
    unit: 'page' | 'percent' | 'elapsed' | 'remaining';
    value: number;
}

/**
 * Parse the position half of a log line.
 *
 * Order matters: "2:30 left" must be read as remaining before any generic
 * time pattern can claim it as elapsed.
 */
export function parsePositionText(text: string): ParsedPositionText | null {
    const t = text.trim().toLowerCase();
    if (t === '') return null;

    // "2:30 left" / "2:30 remaining"
    const remaining = /^([\d:hms.\s]+?)\s*(?:left|remaining)$/.exec(t);
    if (remaining) {
        const secs = parseDuration(remaining[1]);
        return secs === null ? null : { unit: 'remaining', value: secs };
    }

    // "listened 2:30" / "2:30 listened"
    const listenedAfter = /^([\d:hms.\s]+?)\s*listened$/.exec(t);
    if (listenedAfter) {
        const secs = parseDuration(listenedAfter[1]);
        return secs === null ? null : { unit: 'elapsed', value: secs };
    }
    const listenedBefore = /^listened\s+(.+)$/.exec(t);
    if (listenedBefore) {
        const secs = parseDuration(listenedBefore[1]);
        return secs === null ? null : { unit: 'elapsed', value: secs };
    }

    // "45%"
    const percent = /^(\d+(?:\.\d+)?)\s*%$/.exec(t);
    if (percent) return { unit: 'percent', value: Number(percent[1]) };

    // "page 200" / "p. 200" / "p200"
    const page = /^(?:page|p\.?)\s*(\d+)$/.exec(t);
    if (page) return { unit: 'page', value: Number(page[1]) };

    return null;
}

/** Render a progress entry's position back to text. */
export function renderPositionText(entry: ProgressEntry): string {
    const { unit, value } = entry.raw;
    switch (unit) {
        case 'page':
            return `page ${value}`;
        case 'percent':
            return `${trimNum(value)}%`;
        case 'elapsed':
            return `${formatDuration(value)} listened`;
        case 'remaining':
            return `${formatDuration(value)} left`;
    }
}

function trimNum(n: number): string {
    return String(Math.round(n * 100) / 100);
}

// --- reading log ------------------------------------------------------------

const DATE_RE = /(\d{4}-\d{2}-\d{2})/;

/** Recognise a format written in a log line, in any case. */
export function parseFormatLabel(text: string): Format | undefined {
    const clean = text.trim().toLowerCase();
    for (const key of Object.keys(FORMAT_LABELS) as Format[]) {
        if (FORMAT_LABELS[key].toLowerCase() === clean || key === clean) return key;
    }
    // "audiobook" is what the interface says; "audio" is what we store.
    if (clean === 'audiobook') return 'audio';
    return undefined;
}

/** Separates a logged position from the thought recorded with it. */
export const NOTE_SEPARATOR = '—';

/**
 * Notes are single-line by construction: the log is a list, and a multi-line
 * entry would break the grammar. Longer writing belongs in the note body.
 */
export function cleanEntryNote(note: string | undefined): string | undefined {
    if (note === undefined) return undefined;
    const cleaned = note.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    return cleaned === '' ? undefined : cleaned;
}

/** Render one session as a Markdown block. */
export function renderSession(
    session: ReadingSession,
    index: number,
    metrics: BookMetrics = {},
): string[] {
    // Every medium used, not just the one the session started in. A header
    // reading "print" on a session containing audiobook entries is simply
    // wrong, and this is the line most people will actually read.
    const media = sessionFormats(session)
        .map((f) => FORMAT_LABELS[f].toLowerCase())
        .join(', ');
    const parts: string[] = [`Read ${index + 1} — ${media}`];

    if (session.abandoned) {
        const from = session.started ?? '?';
        const pct = trimNum(session.abandoned.fraction * 100);
        parts.push(`${from} → abandoned at ${pct}%`);
        if (session.abandoned.reason) parts.push(`reason: ${session.abandoned.reason}`);
    } else if (session.started || session.finished) {
        parts.push(`${session.started ?? '?'} → ${session.finished ?? '…'}`);
    }

    // Same normalisation as the frontmatter: never render an unrated 0.
    const rating = normaliseRating(session.rating);
    if (rating !== undefined) parts.push(`${trimNum(rating)}★`);

    const lines = [`### ${parts.join(' · ')}`];
    for (const entry of session.entries) {
        const parts = [entry.date, renderPositionText(entry)];

        // The normalised percentage, so entries stay comparable when the
        // units change mid-book. Skipped when the reader already gave a
        // percentage, since "50% · 50%" helps nobody.
        //
        // Recomputed from what the reader actually typed rather than trusting
        // the stored fraction. That makes the raw value authoritative: if a
        // page count is corrected later, every page-based entry re-derives
        // correctly, and serialising twice can never produce two different
        // files.
        if (entry.raw.unit !== 'percent') {
            const norm = normalisePosition(entry.raw.unit, entry.raw.value, metrics);
            const fraction = norm.ok ? norm.fraction : entry.fraction;
            parts.push(`${Math.round(fraction * 1000) / 10}%`);
        }

        // Only when it differs from the session's format.
        if (entry.format && entry.format !== session.format) {
            parts.push(FORMAT_LABELS[entry.format].toLowerCase());
        }

        const note = cleanEntryNote(entry.note);
        const suffix = note ? ` ${NOTE_SEPARATOR} ${note}` : '';
        lines.push(`- ${parts.join(' · ')}${suffix}`);
    }
    return lines;
}

/** Render the whole log section body (without the heading). */
export function renderReadingLog(
    sessions: ReadingSession[],
    metrics: BookMetrics = {},
): string {
    if (sessions.length === 0) {
        return '_No reading logged yet._';
    }
    const blocks = sessions.map((s, i) => renderSession(s, i, metrics).join('\n'));
    return blocks.join('\n\n');
}

export interface ParsedLog {
    sessions: ReadingSession[];
    /** Lines that looked like entries but could not be understood. */
    unparsed: string[];
}

/**
 * Parse a reading log section back into sessions.
 *
 * Tolerant: tokens are recognised wherever they appear in the header rather
 * than by strict position, so a reader who reorders or lightly edits a header
 * by hand does not lose their data.
 */
export function parseReadingLog(text: string, metrics: BookMetrics): ParsedLog {
    const sessions: ReadingSession[] = [];
    const unparsed: string[] = [];
    let current: ReadingSession | null = null;
    let counter = 0;

    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line === '') continue;

        if (line.startsWith('###')) {
            const header = line.replace(/^#+\s*/, '');
            current = parseSessionHeader(header, ++counter);
            sessions.push(current);
            continue;
        }

        const entryMatch = /^[-*]\s+(.*)$/.exec(line);
        if (!entryMatch) continue;

        let content = entryMatch[1];

        // Strip any trailing note first, so its text cannot be mistaken for
        // a field.
        let noteText: string | undefined;
        const noteIdx = content.indexOf(NOTE_SEPARATOR);
        if (noteIdx >= 0) {
            noteText = cleanEntryNote(content.slice(noteIdx + NOTE_SEPARATOR.length));
            content = content.slice(0, noteIdx).trim();
        }

        let datePart: string;
        let posPart: string;
        let entryFormat: Format | undefined;

        if (content.includes('·')) {
            const segments = content.split('·').map((x) => x.trim()).filter((x) => x !== '');
            datePart = segments.shift() ?? '';

            // Identify a format label wherever it sits.
            const fmtIdx = segments.findIndex((seg) => parseFormatLabel(seg) !== undefined);
            if (fmtIdx >= 0) {
                entryFormat = parseFormatLabel(segments[fmtIdx]);
                segments.splice(fmtIdx, 1);
            }

            // What remains is the position and, optionally, the rendered
            // percentage. The percentage is recomputed from the position, so
            // the stored copy is only for the reader's benefit and is dropped.
            if (segments.length > 1 && /^\d+(\.\d+)?\s*%$/.test(segments[segments.length - 1])) {
                segments.pop();
            }
            posPart = segments.join(' · ').trim();
        } else {
            const m = /^(\d{4}-\d{2}-\d{2})[\s:—-]+(.*)$/.exec(content);
            if (!m) {
                unparsed.push(line);
                continue;
            }
            datePart = m[1];
            posPart = m[2];
        }

        const dateMatch = DATE_RE.exec(datePart);
        const parsedPos = parsePositionText(posPart);
        if (!dateMatch || !parsedPos) {
            unparsed.push(line);
            continue;
        }

        const norm = normalisePosition(parsedPos.unit, parsedPos.value, metrics);
        if (!norm.ok) {
            unparsed.push(line);
            continue;
        }

        if (!current) {
            // Entries before any header: synthesise a session so nothing is lost.
            current = {
                id: `s${++counter}`,
                format: 'print',
                entries: [],
            };
            sessions.push(current);
        }
        current.entries.push({
            date: dateMatch[1],
            fraction: norm.fraction,
            raw: norm.raw,
            format: entryFormat,
            note: noteText,
        });
    }

    return { sessions, unparsed };
}

function parseSessionHeader(header: string, counter: number): ReadingSession {
    const session: ReadingSession = {
        id: `s${counter}`,
        format: 'print',
        entries: [],
    };

    const lower = header.toLowerCase();

    // Format: take the medium that appears FIRST in the header, because the
    // renderer always writes the session's own format first and any others
    // after it. Scanning in a fixed order instead would attribute entries to
    // the wrong medium as soon as a session used more than one.
    //
    // "audiobook" is checked before "audio" so the longer word wins; a word
    // boundary after "audio" would never match inside "audiobook" anyway.
    const candidates: Array<[string, Format]> = [
        ['audiobook', 'audio'],
        ['audio', 'audio'],
        ['ebook', 'ebook'],
        ['print', 'print'],
    ];
    let bestAt = Number.MAX_SAFE_INTEGER;
    for (const [word, format] of candidates) {
        const at = new RegExp(`\\b${word}\\b`).exec(lower)?.index ?? -1;
        if (at >= 0 && at < bestAt) {
            bestAt = at;
            session.format = format;
        }
    }

    // Dates. These must be read positionally around the arrow, NOT by simply
    // taking the first date found: a session with a finish date but no start
    // renders as "? → 2021-06-11", and grabbing the first date would silently
    // turn a finish date into a start date. (Caught by the fuzz suite.)
    const arrowIdx = header.indexOf('→');
    if (arrowIdx >= 0) {
        const left = header.slice(0, arrowIdx);
        const right = header.slice(arrowIdx + 1);

        const leftDate = DATE_RE.exec(left);
        if (leftDate) session.started = leftDate[1];

        const abandoned = /abandoned\s+at\s+(\d+(?:\.\d+)?)\s*%/i.exec(right);
        if (abandoned) {
            const reason = /reason:\s*([^·]+)/i.exec(right);
            session.abandoned = {
                fraction: Number(abandoned[1]) / 100,
                reason: reason ? reason[1].trim() : undefined,
            };
        } else {
            const rightDate = DATE_RE.exec(right);
            if (rightDate) session.finished = rightDate[1];
        }
    } else {
        // No arrow — a hand-written header. Fall back to positional dates.
        const dates = header.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
        if (dates.length > 0) session.started = dates[0];
        const abandoned = /abandoned\s+at\s+(\d+(?:\.\d+)?)\s*%/i.exec(header);
        if (abandoned) {
            const reason = /reason:\s*([^·]+)/i.exec(header);
            session.abandoned = {
                fraction: Number(abandoned[1]) / 100,
                reason: reason ? reason[1].trim() : undefined,
            };
        } else if (dates.length > 1) {
            session.finished = dates[1];
        }
    }

    const rating = /(\d+(?:\.\d+)?)\s*★/.exec(header);
    if (rating) session.rating = normaliseRating(Number(rating[1]));

    return session;
}

// --- body sections ----------------------------------------------------------

export interface BodySplit {
    before: string;
    section: string;
    after: string;
    found: boolean;
}

/**
 * Split a body around the section Dogear owns.
 *
 * The section runs from its heading to the next heading of the same or higher
 * level, so nested sub-headings inside the log stay with it.
 */
export function splitBody(body: string, heading: string): BodySplit {
    const lines = body.split(/\r?\n/);
    const target = heading.trim().toLowerCase();
    let startIdx = -1;
    let level = 2;

    for (let i = 0; i < lines.length; i++) {
        const m = /^(#{1,6})\s+(.*?)\s*$/.exec(lines[i]);
        if (m && m[2].trim().toLowerCase() === target) {
            startIdx = i;
            level = m[1].length;
            break;
        }
    }

    if (startIdx === -1) {
        return { before: body, section: '', after: '', found: false };
    }

    let endIdx = lines.length;
    for (let i = startIdx + 1; i < lines.length; i++) {
        const m = /^(#{1,6})\s+/.exec(lines[i]);
        if (m && m[1].length <= level) {
            endIdx = i;
            break;
        }
    }

    return {
        before: lines.slice(0, startIdx).join('\n'),
        section: lines.slice(startIdx + 1, endIdx).join('\n'),
        after: lines.slice(endIdx).join('\n'),
        found: true,
    };
}

/** Replace (or insert) the owned section, leaving all other content intact. */
export function replaceSection(body: string, heading: string, content: string): string {
    const split = splitBody(body, heading);
    const block = `## ${heading}\n\n${content.trim()}\n`;

    if (!split.found) {
        const existing = body.replace(/\s+$/, '');
        return existing === '' ? block : `${existing}\n\n${block}`;
    }

    const before = split.before.replace(/\s+$/, '');
    const after = split.after.replace(/^\s+/, '');
    let out = before === '' ? block : `${before}\n\n${block}`;
    if (after !== '') out = `${out}\n${after}`;
    return out;
}

// --- book <-> note ----------------------------------------------------------

function statusFrom(raw: string | undefined): ReadingStatus | undefined {
    if (!raw) return undefined;
    const v = raw.trim().toLowerCase();
    return (READING_STATUSES as string[]).includes(v) ? (v as ReadingStatus) : undefined;
}

/** Build the frontmatter map for a book, preserving unknown existing keys. */
export function bookToFrontmatter(book: Book, existing: YamlMap = {}): YamlMap {
    const out: YamlMap = {};

    // Carry over anything Dogear does not manage.
    for (const [k, v] of Object.entries(existing)) {
        if (!OWNED_KEYS.has(k)) out[k] = v;
    }

    out.dogear = SCHEMA_VERSION;
    // Trim on write. Leading/trailing whitespace in a title is never intended,
    // and normalising it here (rather than silently on read) keeps writes
    // idempotent instead of producing a diff on the first save.
    out.title = book.title.trim();
    if (book.authors.length > 0) out.authors = book.authors;
    if (book.cover) out.cover = book.cover;
    out.status = book.status;
    // Normalise on write as well as read. A rating of 0 means "unrated", so
    // writing it literally would make the note flip-flop between saves —
    // written as `rating: 0`, read back as undefined, then written without
    // the key. That produces a spurious diff on every save in a synced vault.
    const rating = normaliseRating(book.rating);
    if (rating !== undefined) out.rating = rating;
    if (book.metrics.pages) out.pages = book.metrics.pages;
    if (book.metrics.duration) out.duration = formatDuration(book.metrics.duration);
    if (book.series) out.series = book.series;
    if (book.seriesPosition !== undefined) out.seriesPosition = book.seriesPosition;
    if (book.publisher) out.publisher = book.publisher;
    if (book.published) out.published = book.published;
    if (book.isbn10) out.isbn10 = book.isbn10;
    if (book.isbn13) out.isbn13 = book.isbn13;
    // Catalogue subjects arrive as free text ("City planning"), which is not
    // a valid Obsidian tag. Sanitise on write so the Properties panel never
    // shows a broken tag.
    const tags = sanitiseTags(book.tags);
    if (tags.length > 0) out.tags = tags;
    if (book.olWork) out.olWork = book.olWork;
    if (book.olEdition) out.olEdition = book.olEdition;
    if (book.googleId) out.googleId = book.googleId;

    return out;
}

/** Read book metadata out of a frontmatter map. */
export function frontmatterToBook(map: YamlMap): Omit<Book, 'sessions'> {
    const durationRaw = asString(map.duration);
    const duration = durationRaw ? (parseDuration(durationRaw) ?? undefined) : undefined;

    return {
        schemaVersion: asNumber(map.dogear) ?? SCHEMA_VERSION,
        title: asString(map.title) ?? '',
        authors: asList(map.authors),
        cover: asString(map.cover),
        isbn10: asString(map.isbn10),
        isbn13: asString(map.isbn13),
        publisher: asString(map.publisher),
        published: asString(map.published),
        series: asString(map.series),
        seriesPosition: asNumber(map.seriesPosition),
        tags: asList(map.tags),
        metrics: { pages: asNumber(map.pages), duration },
        rating: normaliseRating(asNumber(map.rating)),
        status: statusFrom(asString(map.status)) ?? 'want-to-read',
        olWork: asString(map.olWork),
        olEdition: asString(map.olEdition),
        googleId: asString(map.googleId),
    };
}

export interface ParsedBook {
    book: Book;
    unparsed: string[];
    /** Frontmatter as found, so unknown keys can be written back. */
    rawFrontmatter: YamlMap;
}

/** Parse a complete note into a book. */
export function parseBookNote(content: string, heading = DEFAULT_LOG_HEADING): ParsedBook {
    const { frontmatter, body } = splitNote(content);
    const map = parseYaml(frontmatter);
    const meta = frontmatterToBook(map);
    const split = splitBody(body, heading);
    const { sessions, unparsed } = parseReadingLog(split.section, meta.metrics);

    return {
        book: { ...meta, sessions },
        unparsed,
        rawFrontmatter: map,
    };
}

/**
 * Write a book back into note content.
 *
 * `existingContent` is passed so unknown frontmatter and all prose outside the
 * log section survive untouched.
 */
export function serialiseBookNote(
    book: Book,
    existingContent = '',
    heading = DEFAULT_LOG_HEADING,
): string {
    const { frontmatter, body } = splitNote(existingContent);
    const existingMap = parseYaml(frontmatter);
    const map = bookToFrontmatter(book, existingMap);
    const newBody = replaceSection(body, heading, renderReadingLog(book.sessions, book.metrics));
    return joinNote(stringifyYaml(map, KEY_ORDER), newBody);
}

/** Create note content for a brand new book. */
export function newBookNote(book: Book, heading = DEFAULT_LOG_HEADING): string {
    return serialiseBookNote(book, '', heading);
}

/** Reconcile a stored status against session history. */
export function reconcileStatus(book: Book): ReadingStatus {
    if (book.sessions.length === 0) return book.status;
    return deriveStatus(book.sessions);
}
