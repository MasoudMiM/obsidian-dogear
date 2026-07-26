// Dogear — tests for reading-status parsing and reconciliation.
//
// These cover a data-loss bug: a status Dogear did not recognise was silently
// replaced with 'want-to-read' on read, and then written back to the file on
// the next save. A hand-edited or typo'd status quietly demoted a finished
// book, and the reading log that proved otherwise was ignored.

import { parseStatus, READING_STATUSES, type ReadingSession } from '../src/model';
import { resolveStatus, parseBookNote, serialiseBookNote } from '../src/note';
import { mapExclusiveShelf } from '../src/goodreads';

interface Harness {
    describe: (name: string, fn: () => void | Promise<void>) => Promise<void>;
    ok: (cond: boolean, msg: string) => void;
    eq: <T>(actual: T, expected: T, msg: string) => void;
    close: (actual: number, expected: number, msg: string) => void;
}

/** A session that reached the end, i.e. proof the book was finished. */
const finishedSession: ReadingSession = {
    id: 'r1',
    format: 'print',
    started: '2024-01-04',
    finished: '2024-03-12',
    entries: [{ date: '2024-03-12', fraction: 1, raw: { unit: 'percent', value: 100 } }],
};

const openSession: ReadingSession = {
    id: 'r1',
    format: 'print',
    started: '2024-01-04',
    entries: [{ date: '2024-01-14', fraction: 0.17, raw: { unit: 'percent', value: 17 } }],
};

export async function runStatusTests({ describe, ok, eq }: Harness): Promise<void> {
    await describe('status: canonical values are accepted unchanged', () => {
        for (const s of READING_STATUSES) {
            eq(parseStatus(s), s, `${s} parses to itself`);
        }
    });

    await describe('status: Goodreads and common spellings are recognised', () => {
        eq(parseStatus('read'), 'finished', 'read means finished');
        eq(parseStatus('to-read'), 'want-to-read', 'to-read is the TBR pile');
        eq(parseStatus('currently-reading'), 'reading', 'currently-reading is reading');
        eq(parseStatus('did-not-finish'), 'dnf', 'did-not-finish is dnf');
        eq(parseStatus('abandoned'), 'dnf', 'abandoned is dnf');
        eq(parseStatus('completed'), 'finished', 'completed is finished');
        eq(parseStatus('tbr'), 'want-to-read', 'tbr is the TBR pile');
        eq(parseStatus('in-progress'), 'reading', 'in-progress is reading');
    });

    await describe('status: spelling is normalised, not guessed at', () => {
        eq(parseStatus('Want To Read'), 'want-to-read', 'spaces and capitals');
        eq(parseStatus('WANT_TO_READ'), 'want-to-read', 'underscores and shouting');
        eq(parseStatus('  Currently Reading  '), 'reading', 'surrounding whitespace');
        eq(parseStatus('Did Not Finish'), 'dnf', 'spaced-out dnf');
    });

    await describe('status: unrecognised values stay unrecognised', () => {
        eq(parseStatus('nonsense'), undefined, 'gibberish is not silently mapped');
        eq(parseStatus('readathon'), undefined, 'a word containing "read" is not "read"');
        eq(parseStatus('on-hold'), undefined, 'genuinely ambiguous, so left alone');
        eq(parseStatus(''), undefined, 'empty string');
        eq(parseStatus(undefined), undefined, 'missing value');
    });

    await describe('status: an absent status is not an error', () => {
        const r = resolveStatus(undefined, []);
        eq(r.status, 'want-to-read', 'a book with no status is on the TBR pile');
        eq(r.issue, undefined, 'and that is not reported as a problem');
    });

    await describe('status: a recognised alias is resolved without complaint', () => {
        const r = resolveStatus('read', [finishedSession]);
        eq(r.status, 'finished', 'read resolves to finished');
        eq(r.issue, undefined, 'an understood spelling is not a problem');
    });

    await describe('status: an unknown status defers to the reading log', () => {
        const r = resolveStatus('nonsense', [finishedSession]);
        eq(r.status, 'finished', 'a completed session outweighs an unreadable status');
        ok(r.issue !== undefined, 'but the unreadable status is reported');
        eq(r.issue?.field, 'status', 'the issue names the field');
        eq(r.issue?.found, 'nonsense', 'and quotes what was actually in the file');
        eq(r.issue?.resolvedTo, 'finished', 'and says what it used instead');
        ok(r.issue!.message.includes('nonsense'), 'the message is specific enough to act on');
    });

    await describe('status: an unknown status with an open session means reading', () => {
        const r = resolveStatus('gibberish', [openSession]);
        eq(r.status, 'reading', 'an unfinished session means reading');
        ok(r.issue !== undefined, 'still reported');
    });

    await describe('status: an unknown status with no log falls back safely', () => {
        const r = resolveStatus('gibberish', []);
        eq(r.status, 'want-to-read', 'nothing to infer from, so the safe default');
        ok(r.issue !== undefined, 'and it is reported rather than hidden');
    });

    // --- the regression itself ---------------------------------------------

    const goodreadsish = `---
dogear: 1
title: The Power Broker
status: read
pages: 1246
---

## Reading log

### Read 1 — print · 2024-01-04 → 2024-03-12

- 2024-03-12 · page 1246 · 100%
`;

    await describe('status: a Goodreads-style status no longer demotes the book', () => {
        const parsed = parseBookNote(goodreadsish);
        eq(parsed.book.status, 'finished', 'status: read is read as finished, not want-to-read');
        eq(parsed.issues.length, 0, 'an understood alias is not flagged');

        const written = serialiseBookNote(parsed.book, goodreadsish);
        ok(written.includes('status: finished'), 'and the file is corrected on write');
        ok(!written.includes('status: want-to-read'), 'the finished book is never demoted');
    });

    const broken = goodreadsish.replace('status: read', 'status: maybe?');

    await describe('status: an unreadable status is reported, not silently rewritten', () => {
        const parsed = parseBookNote(broken);
        eq(parsed.book.status, 'finished', 'the log still proves the book was finished');
        eq(parsed.issues.length, 1, 'exactly one problem is reported');
        eq(parsed.issues[0].kind, 'unknown-status', 'and it is the right kind');
        eq(parsed.issues[0].found, 'maybe?', 'naming the value found in the file');
    });

    await describe('status: a clean note reports no problems', () => {
        const clean = goodreadsish.replace('status: read', 'status: finished');
        const parsed = parseBookNote(clean);
        eq(parsed.issues.length, 0, 'nothing to report');
        eq(parsed.book.status, 'finished', 'status preserved');
        // The first write normalises blank-line spacing, which is a one-off.
        // What matters is that every write after it is a no-op, or a synced
        // vault gets a fresh conflict on every save.
        const once = serialiseBookNote(parsed.book, clean);
        const twice = serialiseBookNote(parseBookNote(once).book, once);
        eq(twice, once, 'repeated writes are stable, so no spurious diff in a synced vault');
    });

    await describe('status: reading a note does not change a status the log cannot judge', () => {
        // want-to-read with no sessions: there is nothing to reconcile against,
        // and the stored value must be trusted rather than recomputed.
        const tbr = `---
dogear: 1
title: Unread Book
status: want-to-read
---

## Reading log
`;
        const parsed = parseBookNote(tbr);
        eq(parsed.book.status, 'want-to-read', 'left exactly as found');
        eq(parsed.issues.length, 0, 'and not reported');
    });

    await describe('status: hostile input cannot throw or invent a status', () => {
        const junk = [
            '---', '{}', '[]', 'null', 'undefined', '0', '-', '____', '   ',
            'status', 'read-', '-read', 'read--read', '\u0000', 'ré^ad',
            'a'.repeat(500), '<script>', '../../etc/passwd', '🙂',
        ];
        let threw = false;
        for (const v of junk) {
            let out: unknown;
            try {
                out = parseStatus(v);
            } catch {
                threw = true;
                break;
            }
            const valid = out === undefined || (READING_STATUSES as string[]).includes(out as string);
            ok(valid, `${JSON.stringify(v.slice(0, 20))} yields undefined or a real status`);
        }
        ok(!threw, 'no input throws');

        // Separator collapsing must not turn junk into a match by accident.
        eq(parseStatus('read-'), 'finished', 'a trailing separator is trimmed, not treated as new value');
        eq(parseStatus('re-ad'), undefined, 'but a hyphen inside a word is not removed');
    });

    // --- the importer must keep behaving as it did --------------------------

    await describe('status: Goodreads shelf mapping is unchanged', () => {
        eq(mapExclusiveShelf('read'), 'finished', 'read shelf');
        eq(mapExclusiveShelf('currently-reading'), 'reading', 'currently-reading shelf');
        eq(mapExclusiveShelf('to-read'), 'want-to-read', 'to-read shelf');
        eq(mapExclusiveShelf('dnf'), 'dnf', 'custom dnf shelf');
        eq(mapExclusiveShelf('gave-up-on'), 'dnf', 'another custom dnf spelling');
        eq(
            mapExclusiveShelf('my-weird-shelf'),
            'want-to-read',
            'an unknown custom shelf still defaults to the TBR pile',
        );
    });
}
