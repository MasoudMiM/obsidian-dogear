// Dogear — property-based round-trip testing.
//
// The hand-written tests only cover cases I thought of. This generates
// randomised books — including titles full of YAML-hostile punctuation — and
// asserts two properties that must hold universally:
//
//   1. parse(serialise(book)) preserves every field we manage.
//   2. serialise(parse(x)) === x — writing is idempotent, so opening a note
//      and saving it never produces a spurious diff.
//
// Property 2 is the one that protects people's git history and sync conflicts.

import {
    type Book,
    type Format,
    type ReadingSession,
    type ReadingStatus,
    SCHEMA_VERSION,
    normaliseRating,
} from '../src/model';
import { parseBookNote, serialiseBookNote } from '../src/note';
import { sanitiseTags } from '../src/paths';
import type { Harness } from './note.test';

/** Deterministic PRNG so a failure is reproducible from the seed. */
function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0x100000000;
    };
}

const NASTY = [
    'The Dispossessed: An Ambiguous Utopia',
    'Nineteen Eighty-Four',
    '"Quoted" Title',
    "Apostrophe's Tale",
    'Hash # Mark',
    'Colon: Everywhere: Really',
    'Brackets [and] {braces}',
    'Comma, Separated, Values',
    'Trailing space ',
    ' Leading space',
    '- Dash first',
    '123',
    'true',
    'null',
    'Émigré Ünïcode 日本語',
    'Ampersand & Asterisk *',
    'Pipe | Greater >',
    'Percent 100% Sign',
    'Backslash \\ Path',
    'Tilde ~ and at @',
];

const AUTHORS = ['Ursula K. Le Guin', "O'Brien, Flann", 'Anon.', '李白', 'Smith, J. & Jones, K.'];
const TAGS = ['sci-fi', 'to-reread', 'book club', '2026', 'non-fiction'];
const FORMATS: Format[] = ['print', 'ebook', 'audio'];
const STATUSES: ReadingStatus[] = ['want-to-read', 'reading', 'finished', 'dnf'];

function isoDate(rand: () => number): string {
    const y = 2015 + Math.floor(rand() * 11);
    const m = 1 + Math.floor(rand() * 12);
    const d = 1 + Math.floor(rand() * 28);
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function makeBook(rand: () => number, i: number): Book {
    const pages = rand() < 0.85 ? 50 + Math.floor(rand() * 900) : undefined;
    // Durations are stored as H:MM, so generate whole minutes to round-trip exactly.
    const duration = rand() < 0.5 ? (1 + Math.floor(rand() * 1200)) * 60 : undefined;
    const metrics = { pages, duration };

    const sessionCount = Math.floor(rand() * 4); // 0..3, exercising rereads
    const sessions: ReadingSession[] = [];

    for (let s = 0; s < sessionCount; s++) {
        const format = FORMATS[Math.floor(rand() * FORMATS.length)];
        const entries = [];
        const entryCount = Math.floor(rand() * 4);

        for (let e = 0; e < entryCount; e++) {
            // Only pick units the book actually supports, as the UI would.
            const options: Array<'page' | 'percent' | 'elapsed' | 'remaining'> = ['percent'];
            if (pages) options.push('page');
            if (duration && format === 'audio') options.push('elapsed', 'remaining');
            const unit = options[Math.floor(rand() * options.length)];

            let value: number;
            let fraction: number;
            if (unit === 'page') {
                value = 1 + Math.floor(rand() * (pages as number));
                fraction = value / (pages as number);
            } else if (unit === 'percent') {
                value = Math.floor(rand() * 101);
                fraction = value / 100;
            } else if (unit === 'elapsed') {
                value = Math.floor(rand() * (duration as number));
                fraction = value / (duration as number);
            } else {
                value = Math.floor(rand() * (duration as number));
                fraction = ((duration as number) - value) / (duration as number);
            }
            entries.push({
                date: isoDate(rand),
                fraction: Math.round(fraction * 1e6) / 1e6,
                raw: { unit, value },
            });
        }

        const session: ReadingSession = { id: `s${s + 1}`, format, entries };
        if (rand() < 0.8) session.started = isoDate(rand);
        const roll = rand();
        if (roll < 0.5) {
            session.finished = isoDate(rand);
            if (rand() < 0.6) session.rating = Math.round(rand() * 20) / 4;
        } else if (roll < 0.7) {
            session.abandoned = {
                fraction: Math.round(rand() * 100) / 100,
                reason: rand() < 0.5 ? 'lost interest' : undefined,
            };
        }
        sessions.push(session);
    }

    return {
        schemaVersion: SCHEMA_VERSION,
        title: NASTY[i % NASTY.length],
        authors: AUTHORS.slice(0, 1 + Math.floor(rand() * 3)),
        cover: rand() < 0.7 ? 'https://covers.openlibrary.org/b/id/240727-L.jpg' : undefined,
        isbn10: rand() < 0.5 ? '0060512750' : undefined,
        isbn13: rand() < 0.7 ? '9780060512750' : undefined,
        publisher: rand() < 0.6 ? 'Harper & Row' : undefined,
        published: rand() < 0.6 ? '2003' : undefined,
        series: rand() < 0.3 ? 'Hainish Cycle: Part One' : undefined,
        seriesPosition: rand() < 0.3 ? Math.floor(rand() * 10) : undefined,
        tags: TAGS.slice(0, Math.floor(rand() * 4)),
        metrics,
        rating: rand() < 0.6 ? Math.round(rand() * 20) / 4 : undefined,
        status: STATUSES[Math.floor(rand() * STATUSES.length)],
        sessions,
        olWork: rand() < 0.8 ? '/works/OL27448W' : undefined,
        olEdition: rand() < 0.6 ? '/books/OL7353617M' : undefined,
    };
}

export async function runFuzzTests(h: Harness): Promise<void> {
    await h.describe('fuzz: note round trip holds for randomised books', () => {
        const ITERATIONS = 400;
        const rand = rng(20260718);

        let fieldMismatch = 0;
        let notIdempotent = 0;
        let sessionMismatch = 0;
        let unparsedLines = 0;
        let firstFailure = '';

        for (let i = 0; i < ITERATIONS; i++) {
            const book = makeBook(rand, i);
            const content = serialiseBookNote(book);
            const parsed = parseBookNote(content);

            if (parsed.unparsed.length > 0) {
                unparsedLines++;
                if (!firstFailure) {
                    firstFailure = `unparsed on iteration ${i}: ${parsed.unparsed[0]}`;
                }
            }

            // Property 1: managed metadata survives.
            const before = {
                title: book.title.trim(),
                authors: book.authors,
                // Tags are normalised on write so Obsidian never sees a
                // broken one; compare the normalised form.
                tags: sanitiseTags(book.tags),
                pages: book.metrics.pages,
                duration: book.metrics.duration,
                // 0 means unrated by design, so compare the normalised value.
                rating: normaliseRating(book.rating),
                status: book.status,
                series: book.series,
                seriesPosition: book.seriesPosition,
                isbn13: book.isbn13,
                olWork: book.olWork,
            };
            const after = {
                title: parsed.book.title,
                authors: parsed.book.authors,
                tags: parsed.book.tags,
                pages: parsed.book.metrics.pages,
                duration: parsed.book.metrics.duration,
                rating: parsed.book.rating,
                status: parsed.book.status,
                series: parsed.book.series,
                seriesPosition: parsed.book.seriesPosition,
                isbn13: parsed.book.isbn13,
                olWork: parsed.book.olWork,
            };
            if (JSON.stringify(before) !== JSON.stringify(after)) {
                fieldMismatch++;
                if (!firstFailure) {
                    firstFailure = `iteration ${i}: ${JSON.stringify(before)} vs ${JSON.stringify(after)}`;
                }
            }

            // Sessions and their raw units must survive.
            if (parsed.book.sessions.length !== book.sessions.length) {
                sessionMismatch++;
                if (!firstFailure) {
                    firstFailure = `iteration ${i}: ${book.sessions.length} sessions in, ${parsed.book.sessions.length} out`;
                }
            } else {
                for (let s = 0; s < book.sessions.length; s++) {
                    const a = book.sessions[s];
                    const b = parsed.book.sessions[s];
                    const rawA = JSON.stringify(a.entries.map((e) => e.raw));
                    const rawB = JSON.stringify(b.entries.map((e) => e.raw));
                    if (rawA !== rawB || a.format !== b.format) {
                        sessionMismatch++;
                        if (!firstFailure) {
                            firstFailure = `iteration ${i} session ${s}: ${rawA} vs ${rawB}`;
                        }
                        break;
                    }
                }
            }

            // Property 2: writing back is a no-op.
            const rewritten = serialiseBookNote(parsed.book, content);
            if (rewritten !== content) {
                notIdempotent++;
                if (!firstFailure) firstFailure = `iteration ${i} not idempotent`;
            }
        }

        h.eq(fieldMismatch, 0, `metadata survives ${ITERATIONS} randomised round trips`);
        h.eq(sessionMismatch, 0, 'sessions and raw progress units survive');
        h.eq(unparsedLines, 0, 'no generated log line fails to parse');
        h.eq(notIdempotent, 0, 'serialisation is idempotent for every generated book');
        if (firstFailure) console.log(`      first failure: ${firstFailure}`);
    });

    await h.describe('fuzz: hostile titles survive frontmatter', () => {
        let bad = 0;
        let example = '';
        for (const title of NASTY) {
            const book: Book = {
                schemaVersion: SCHEMA_VERSION,
                title,
                authors: ['X'],
                tags: [],
                metrics: {},
                status: 'want-to-read',
                sessions: [],
            };
            const parsed = parseBookNote(serialiseBookNote(book));
            // Leading/trailing whitespace is not meaningfully preservable in a
            // title and is trimmed on read; compare trimmed.
            if (parsed.book.title !== title.trim()) {
                bad++;
                if (!example) example = `${JSON.stringify(title)} -> ${JSON.stringify(parsed.book.title)}`;
            }
        }
        h.eq(bad, 0, `all ${NASTY.length} hostile titles round trip`);
        if (example) console.log(`      example: ${example}`);
    });
}
