// Dogear — unit tests for the DOM-free logic layer.

import {
    SCHEMA_VERSION,
    normaliseRating,
    deriveStatus,
    completedReadCount,
    currentFraction,
    isTimeBased,
    type ReadingSession,
} from '../src/model';

import {
    normalisePosition,
    parseDuration,
    formatDuration,
    humaniseDuration,
    unitsForFormat,
    defaultUnitForFormat,
    fractionToPages,
    paceFractionPerDay,
    projectedDaysRemaining,
    daysBetween,
} from '../src/progress';

import {
    parseCsv,
    parseCsvRecords,
    cleanIsbn,
    parseGoodreadsDate,
    parseShelves,
    mapExclusiveShelf,
    collectAuthors,
    importGoodreadsCsv,
    looksLikeGoodreadsExport,
    goodreadsToBook,
    duplicateKey,
} from '../src/goodreads';

import {
    buildSearchUrl,
    buildEditionsUrl,
    mapSearchResponse,
    mapEditionsResponse,
    scoreEdition,
    pickBestEdition,
    resolveCoverUrl,
    resolveMetadata,
    coverUrlFromId,
    needsEditionLookup,
    type Edition,
} from '../src/openlibrary';

import { runNoteTests } from './note.test';
import { runFuzzTests } from './fuzz.test';
import { runVaultTests } from './vault.test';
import { runSearchTests } from './search.test';
import { runProviderTests } from './providers.test';

// --- tiny harness -----------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];
let group = '';

async function describe(name: string, fn: () => void | Promise<void>) {
    group = name;
    console.log(`\n  ${name}`);
    await fn();
}

function ok(cond: boolean, label: string, detail?: string) {
    if (cond) {
        passed++;
        console.log(`    PASS  ${label}`);
    } else {
        failed++;
        const msg = `${group} > ${label}${detail ? ` — ${detail}` : ''}`;
        failures.push(msg);
        console.log(`    FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    }
}

function eq(actual: unknown, expected: unknown, label: string) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    ok(a === e, label, a === e ? undefined : `expected ${e}, got ${a}`);
}

function close(actual: number, expected: number, label: string, tol = 1e-6) {
    const good = Math.abs(actual - expected) <= tol;
    ok(good, label, good ? undefined : `expected ~${expected}, got ${actual}`);
}

// --- model ------------------------------------------------------------------

describe('model: rating normalisation', () => {
    eq(normaliseRating(0), undefined, '0 means unrated (Goodreads convention)');
    eq(normaliseRating(undefined), undefined, 'undefined stays undefined');
    eq(normaliseRating(null), undefined, 'null stays undefined');
    eq(normaliseRating(NaN), undefined, 'NaN rejected');
    eq(normaliseRating(4), 4, 'whole star preserved');
    eq(normaliseRating(3.5), 3.5, 'half star preserved');
    eq(normaliseRating(3.75), 3.75, 'quarter star preserved');
    eq(normaliseRating(3.8), 3.75, 'snaps to nearest quarter');
    eq(normaliseRating(3.9), 4, 'snaps up to whole');
    eq(normaliseRating(9), 5, 'clamped to max 5');
    eq(normaliseRating(-2), undefined, 'negative treated as unrated');
    // Guard against binary float drift producing 3.7500000000000004
    const drift = normaliseRating(3.76) as number;
    ok(String(drift).length <= 4, 'no float drift in stored value', `got ${drift}`);
});

describe('model: status derivation from sessions', () => {
    const s = (o: Partial<ReadingSession>): ReadingSession => ({
        id: 'x',
        format: 'print',
        entries: [],
        ...o,
    });

    eq(deriveStatus([]), 'want-to-read', 'no sessions means TBR');
    eq(deriveStatus([s({ started: '2026-01-01' })]), 'reading', 'open session means reading');
    eq(
        deriveStatus([s({ started: '2026-01-01', finished: '2026-01-10' })]),
        'finished',
        'finished session means finished',
    );
    eq(
        deriveStatus([s({ abandoned: { fraction: 0.3, reason: 'dull' } })]),
        'dnf',
        'abandoned session means DNF',
    );
    // The reread case: finished once, now reading again.
    eq(
        deriveStatus([
            s({ id: 'a', started: '2020-01-01', finished: '2020-02-01' }),
            s({ id: 'b', started: '2026-01-01' }),
        ]),
        'reading',
        'reread in progress reports reading, not finished',
    );
});

describe('model: read counts and current position', () => {
    const finished = (id: string): ReadingSession => ({
        id,
        format: 'print',
        entries: [],
        started: '2020-01-01',
        finished: '2020-02-01',
    });
    eq(completedReadCount([finished('a'), finished('b')]), 2, 'two completed reads counted');
    eq(
        completedReadCount([
            finished('a'),
            { id: 'c', format: 'print', entries: [], abandoned: { fraction: 0.2 } },
        ]),
        1,
        'abandoned session not counted as a read',
    );
    eq(currentFraction([]), 0, 'no sessions means zero progress');
    eq(currentFraction([finished('a')]), 1, 'finished session is 100%');
    eq(
        currentFraction([{ id: 'd', format: 'print', entries: [], abandoned: { fraction: 0.42 } }]),
        0.42,
        'abandoned position preserved',
    );
    eq(
        currentFraction([
            {
                id: 'e',
                format: 'print',
                entries: [
                    { date: '2026-01-01', fraction: 0.1, raw: { unit: 'percent', value: 10 } },
                    { date: '2026-01-05', fraction: 0.55, raw: { unit: 'percent', value: 55 } },
                ],
            },
        ]),
        0.55,
        'furthest entry wins',
    );
    ok(isTimeBased('audio') && !isTimeBased('print'), 'audio is time based, print is not');
    eq(SCHEMA_VERSION, 1, 'schema version pinned at 1');
});

// --- progress ---------------------------------------------------------------

describe('progress: page and percent', () => {
    const m = { pages: 300 };
    const r = normalisePosition('page', 150, m);
    ok(r.ok, 'page 150 of 300 accepted');
    if (r.ok) close(r.fraction, 0.5, 'page 150/300 = 50%');

    const p = normalisePosition('percent', 25, {});
    ok(p.ok, 'percent works with no metrics at all');
    if (p.ok) close(p.fraction, 0.25, '25% = 0.25');

    const noPages = normalisePosition('page', 10, {});
    ok(!noPages.ok, 'page rejected when total unknown');
    if (!noPages.ok) eq(noPages.error, 'unknown-total-pages', 'correct error code');

    const over = normalisePosition('page', 400, m);
    ok(!over.ok, 'page beyond end rejected');
    if (!over.ok) eq(over.error, 'exceeds-total', 'exceeds-total reported');

    const over100 = normalisePosition('percent', 101, {});
    ok(!over100.ok, '101% rejected');

    const neg = normalisePosition('page', -5, m);
    ok(!neg.ok, 'negative rejected');
    if (!neg.ok) eq(neg.error, 'negative', 'negative error code');

    const nan = normalisePosition('percent', NaN, {});
    ok(!nan.ok, 'NaN rejected');
});

describe('progress: audiobook elapsed vs remaining', () => {
    // 10 hour audiobook.
    const m = { duration: 36_000 };

    const elapsed = normalisePosition('elapsed', 9_000, m); // 2h30m in
    ok(elapsed.ok, 'elapsed accepted');
    if (elapsed.ok) close(elapsed.fraction, 0.25, '2h30m of 10h = 25%');

    // The differentiator: Audible/Spotify/Kobo show time LEFT.
    const remaining = normalisePosition('remaining', 9_000, m); // 2h30m left
    ok(remaining.ok, 'remaining accepted');
    if (remaining.ok) close(remaining.fraction, 0.75, '2h30m left of 10h = 75% done');

    // elapsed(x) and remaining(x) must be complements.
    const e = normalisePosition('elapsed', 12_345, m);
    const r = normalisePosition('remaining', 12_345, m);
    if (e.ok && r.ok) close(e.fraction + r.fraction, 1, 'elapsed and remaining are complementary');

    const done = normalisePosition('remaining', 0, m);
    if (done.ok) close(done.fraction, 1, 'zero remaining = finished');

    const untouched = normalisePosition('remaining', 36_000, m);
    if (untouched.ok) close(untouched.fraction, 0, 'full runtime remaining = not started');

    const noDur = normalisePosition('remaining', 100, {});
    ok(!noDur.ok, 'remaining rejected with no duration');
    if (!noDur.ok) eq(noDur.error, 'unknown-duration', 'correct error for missing duration');

    const tooMuch = normalisePosition('elapsed', 40_000, m);
    ok(!tooMuch.ok, 'elapsed beyond runtime rejected');

    // Raw input must survive normalisation for faithful redisplay.
    if (remaining.ok) {
        eq(remaining.raw, { unit: 'remaining', value: 9000 }, 'raw input preserved verbatim');
    }
});

describe('progress: duration parsing', () => {
    eq(parseDuration('5:30'), 19_800, 'H:MM reads as hours and minutes');
    eq(parseDuration('1:02:03'), 3_723, 'H:MM:SS parsed');
    eq(parseDuration('0:45'), 2_700, '45 minutes');
    eq(parseDuration('45'), 2_700, 'bare number reads as minutes');
    eq(parseDuration('3h 20m'), 12_000, 'unit suffix form');
    eq(parseDuration('3h'), 10_800, 'hours only');
    eq(parseDuration('20m'), 1_200, 'minutes only');
    eq(parseDuration('90s'), 90, 'seconds only');
    eq(parseDuration('1h30m'), 5_400, 'no space between units');
    eq(parseDuration('  5:30  '), 19_800, 'surrounding whitespace tolerated');
    eq(parseDuration(''), null, 'empty rejected');
    eq(parseDuration('abc'), null, 'garbage rejected');
    eq(parseDuration('1:2:3:4'), null, 'too many segments rejected');
    eq(parseDuration('-5'), null, 'negative rejected');
    eq(parseDuration('5:xx'), null, 'non-numeric segment rejected');

    eq(formatDuration(19_800), '5:30', 'whole minutes render as H:MM');
    eq(formatDuration(3_723), '1:02:03', 'seconds render as H:MM:SS');
    eq(formatDuration(0), '0:00', 'zero renders cleanly');
    eq(formatDuration(-1), '0:00', 'negative clamped');

    // Round trip.
    for (const s of ['5:30', '1:02:03', '0:45']) {
        const secs = parseDuration(s) as number;
        eq(formatDuration(secs), s, `round trip ${s}`);
    }

    eq(humaniseDuration(12_000), '3h 20m', 'humanised hours and minutes');
    eq(humaniseDuration(10_800), '3h', 'humanised whole hours');
    eq(humaniseDuration(1_200), '20m', 'humanised minutes');
    eq(humaniseDuration(0), '0m', 'humanised zero');
});

describe('progress: unit offering per format', () => {
    eq(
        unitsForFormat('audio', { duration: 3600 }),
        ['percent', 'remaining', 'elapsed'],
        'audio offers percent, remaining, elapsed',
    );
    eq(
        unitsForFormat('audio', {}),
        ['percent'],
        'audio with unknown runtime offers percent only',
    );
    eq(unitsForFormat('print', { pages: 300 }), ['page', 'percent'], 'print offers page first');
    eq(unitsForFormat('print', {}), ['percent'], 'print with no page count offers percent only');
    eq(defaultUnitForFormat('audio', { duration: 3600 }), 'percent', 'audio defaults to percent');
    eq(defaultUnitForFormat('print', { pages: 300 }), 'page', 'print defaults to page');
    eq(fractionToPages(0.5, { pages: 301 }), 151, 'fraction converts back to pages');
    eq(fractionToPages(0.5, {}), undefined, 'no page total means no page conversion');
});

describe('progress: computed pace and projection', () => {
    const entries = [
        { date: '2026-01-01', fraction: 0.0, raw: { unit: 'percent' as const, value: 0 } },
        { date: '2026-01-11', fraction: 0.5, raw: { unit: 'percent' as const, value: 50 } },
    ];
    eq(daysBetween('2026-01-01', '2026-01-11'), 10, 'day difference computed');
    close(paceFractionPerDay(entries) as number, 0.05, 'pace is 5% of the book per day');
    eq(projectedDaysRemaining(entries), 10, 'projects 10 more days to finish');

    eq(paceFractionPerDay([entries[0]]), null, 'single entry gives no pace');
    eq(
        paceFractionPerDay([
            { date: '2026-01-01', fraction: 0.1, raw: { unit: 'percent', value: 10 } },
            { date: '2026-01-01', fraction: 0.3, raw: { unit: 'percent', value: 30 } },
        ]),
        null,
        'same-day entries give no pace (no division by zero)',
    );
    eq(
        paceFractionPerDay([
            { date: '2026-01-01', fraction: 0.5, raw: { unit: 'percent', value: 50 } },
            { date: '2026-01-05', fraction: 0.5, raw: { unit: 'percent', value: 50 } },
        ]),
        null,
        'no forward progress gives no pace',
    );
});

// --- goodreads --------------------------------------------------------------

describe('goodreads: converting a row into a book', () => {
    const base = {
        title: 'The Power Broker',
        authors: ['Robert A. Caro'],
        isbn13: '9780394480763',
        publisher: 'Knopf',
        published: '1974',
        pages: 1246,
        rating: 5,
        tags: ['history'],
        readCount: 1,
        warnings: [],
    };

    const finished = goodreadsToBook(
        { ...base, status: 'finished' as const, dateRead: '2024-03-12' },
        'print',
    );
    eq(finished.book.title, 'The Power Broker', 'title carried');
    eq(finished.book.metrics.pages, 1246, 'page count carried');
    eq(finished.book.rating, 5, 'rating carried');
    eq(finished.book.sessions.length, 1, 'a finished book gets a session');
    eq(finished.book.sessions[0].finished, '2024-03-12', 'with the read date');
    eq(finished.book.sessions[0].started, undefined, 'Goodreads exports no start date, so none is invented');

    const reading = goodreadsToBook(
        { ...base, status: 'reading' as const, dateAdded: '2026-01-05' },
        'audio',
    );
    eq(reading.book.sessions[0].started, '2026-01-05', 'a current read starts when it was added');
    eq(reading.book.sessions[0].finished, undefined, 'and is not finished');
    eq(reading.book.sessions[0].format, 'audio', 'the default format is used');

    const wanted = goodreadsToBook({ ...base, status: 'want-to-read' as const }, 'print');
    eq(wanted.book.sessions.length, 0, 'an unread book gets no session at all');

    // Goodreads rates 0 for unrated; that must not become a zero-star rating.
    const unrated = goodreadsToBook({ ...base, status: 'finished' as const, rating: 0 }, 'print');
    eq(unrated.book.rating, undefined, 'an unrated book stays unrated');
});

describe('goodreads: the reader\'s own writing is preserved', () => {
    const withReview = goodreadsToBook(
        {
            title: 'A Book',
            authors: ['Someone'],
            tags: [],
            readCount: 1,
            warnings: [],
            status: 'finished' as const,
            review: 'The best thing I read all year.',
            privateNotes: 'Lent to Sam.',
        },
        'print',
    );
    ok(withReview.notes.includes('The best thing I read all year.'), 'the review is kept');
    ok(withReview.notes.includes('Lent to Sam.'), 'private notes are kept');
    ok(withReview.notes.includes('Private notes'), 'and are labelled');
    // Prose belongs in the note body, not squeezed into frontmatter.
    eq((withReview.book as unknown as Record<string, unknown>).review, undefined, 'review is not a frontmatter field');

    // Rereads: Goodreads exports one date however many times you read it.
    const reread = goodreadsToBook(
        { title: 'B', authors: [], tags: [], readCount: 4, warnings: [], status: 'finished' as const },
        'print',
    );
    ok(reread.notes.includes('4 reads'), 'the true count is recorded');
    eq(reread.book.sessions.length, 1, 'but only one session, since only one date exists');

    const plain = goodreadsToBook(
        { title: 'C', authors: [], tags: [], readCount: 1, warnings: [], status: 'finished' as const },
        'print',
    );
    eq(plain.notes, '', 'nothing to say means nothing written');
});

describe('goodreads: spotting books already in the vault', () => {
    const a = { title: 'The Power Broker', authors: ['Robert A. Caro'], isbn13: '9780394480763' };
    const b = { title: 'Different Title', authors: ['Someone Else'], isbn13: '978-0-394-48076-3' };
    eq(duplicateKey(a), duplicateKey(b), 'ISBN wins over title, and punctuation is ignored');

    const c = { title: 'The Power Broker', authors: ['Robert A. Caro'] };
    const d = { title: 'the power  broker!', authors: ['robert a caro'] };
    eq(duplicateKey(c), duplicateKey(d), 'without an ISBN, title and author are normalised');

    const e = { title: 'Something Else', authors: ['Robert A. Caro'] };
    ok(duplicateKey(c) !== duplicateKey(e), 'different books stay distinct');
});


describe('goodreads: CSV parsing edge cases', () => {
    eq(parseCsv('a,b\n1,2'), [['a', 'b'], ['1', '2']], 'basic rows');
    eq(
        parseCsv('a,b\n"x, y",2'),
        [['a', 'b'], ['x, y', '2']],
        'commas inside quotes preserved',
    );
    eq(
        parseCsv('a\n"line one\nline two"'),
        [['a'], ['line one\nline two']],
        'newlines inside quotes preserved',
    );
    eq(
        parseCsv('a\n"He said ""hi"""'),
        [['a'], ['He said "hi"']],
        'escaped double quotes unescaped',
    );
    eq(parseCsv('a,b\r\n1,2'), [['a', 'b'], ['1', '2']], 'CRLF handled');
    eq(parseCsv('\ufeffa,b\n1,2')[0], ['a', 'b'], 'UTF-8 BOM stripped');
    eq(parseCsv('a,b\n1,2\n'), [['a', 'b'], ['1', '2']], 'trailing newline does not add a row');
});

describe('goodreads: field cleaning', () => {
    eq(cleanIsbn('="0439023483"'), '0439023483', 'Excel armour stripped, leading zero kept');
    eq(cleanIsbn('=""'), undefined, 'empty armoured field is undefined');
    eq(cleanIsbn(''), undefined, 'blank is undefined');
    eq(cleanIsbn('9780439023481'), '9780439023481', 'plain ISBN passes through');

    eq(parseGoodreadsDate('2017/05/24'), '2017-05-24', 'YYYY/MM/DD converted to ISO');
    eq(parseGoodreadsDate('2017/5/4'), '2017-05-04', 'single digits zero padded');
    eq(parseGoodreadsDate(''), undefined, 'blank date is undefined');
    eq(parseGoodreadsDate('not a date'), undefined, 'garbage date is undefined');

    eq(parseShelves('sci-fi, favourites'), ['sci-fi', 'favourites'], 'shelves split and trimmed');
    eq(parseShelves(''), [], 'no shelves gives empty list');

    eq(mapExclusiveShelf('read'), 'finished', 'read maps to finished');
    eq(mapExclusiveShelf('currently-reading'), 'reading', 'currently-reading maps to reading');
    eq(mapExclusiveShelf('to-read'), 'want-to-read', 'to-read maps to want-to-read');
    eq(mapExclusiveShelf('dnf'), 'dnf', 'custom dnf shelf detected');
    eq(mapExclusiveShelf('abandoned'), 'dnf', 'abandoned detected as DNF');
    eq(mapExclusiveShelf('weird-custom'), 'want-to-read', 'unknown shelf defaults to TBR');

    eq(
        collectAuthors({ Author: 'Ursula K. Le Guin', 'Additional Authors': 'Someone Else' }),
        ['Ursula K. Le Guin', 'Someone Else'],
        'primary and additional authors combined',
    );
    eq(
        collectAuthors({ Author: 'A', 'Additional Authors': 'A, B' }),
        ['A', 'B'],
        'duplicate author not repeated',
    );
});

const GOODREADS_CSV = [
    'Book Id,Title,Author,Additional Authors,ISBN,ISBN13,My Rating,Publisher,Number of Pages,Year Published,Original Publication Year,Date Read,Date Added,Bookshelves,Exclusive Shelf,My Review,Read Count',
    '1,The Dispossessed,Ursula K. Le Guin,,="0060512750",="9780060512750",5,Harper,387,2003,1974,2024/03/12,2024/01/02,"sci-fi, favourites",read,"Loved it. ""Utopia"", reconsidered.",2',
    '2,Dune,Frank Herbert,,="0441013597",="9780441013593",0,Ace,604,2005,1965,,2025/06/01,sci-fi,currently-reading,,1',
    '3,Ulysses,James Joyce,,="",="",0,,,1922,1922,,2023/09/09,,dnf,"Bounced off it, twice.",0',
    '4,Some TBR Book,Anon,,="",="",0,,,,,,2026/02/02,,to-read,,0',
].join('\n');

describe('goodreads: full import', () => {
    ok(looksLikeGoodreadsExport(GOODREADS_CSV), 'recognised as a Goodreads export');
    ok(!looksLikeGoodreadsExport('name,email\na,b'), 'unrelated CSV rejected');

    const result = importGoodreadsCsv(GOODREADS_CSV);
    eq(result.books.length, 4, 'all four rows imported');
    eq(result.skipped, 0, 'nothing skipped');

    const [dispossessed, dune, ulysses, tbr] = result.books;

    eq(dispossessed.title, 'The Dispossessed', 'title read');
    eq(dispossessed.authors, ['Ursula K. Le Guin'], 'author read');
    eq(dispossessed.isbn13, '9780060512750', 'ISBN13 unarmoured');
    eq(dispossessed.rating, 5, 'rating read');
    eq(dispossessed.status, 'finished', 'read shelf became finished');
    eq(dispossessed.dateRead, '2024-03-12', 'read date converted');
    eq(dispossessed.tags, ['sci-fi', 'favourites'], 'shelves became tags');
    eq(dispossessed.pages, 387, 'page count read');
    eq(dispossessed.published, '1974', 'original publication year preferred over edition year');
    eq(
        dispossessed.review,
        'Loved it. "Utopia", reconsidered.',
        'review with escaped quotes intact',
    );
    ok(
        dispossessed.warnings.some((w) => w.kind === 'reread-history-lost'),
        'reread warning raised when Read Count is 2',
    );

    eq(dune.status, 'reading', 'currently-reading became reading');
    eq(dune.rating, undefined, 'rating 0 treated as unrated');
    eq(dune.dateRead, undefined, 'no read date for in-progress book');
    ok(
        !dune.warnings.some((w) => w.kind === 'missing-read-date'),
        'no missing-date warning for a book still being read',
    );

    eq(ulysses.status, 'dnf', 'dnf shelf detected');
    eq(ulysses.isbn10, undefined, 'empty armoured ISBN is undefined');
    ok(
        ulysses.warnings.some((w) => w.kind === 'no-page-count'),
        'missing page count warned',
    );

    eq(tbr.status, 'want-to-read', 'to-read became want-to-read');

    ok(result.counts['reread-history-lost'] === 1, 'reread warnings counted once');
    ok(result.counts['no-page-count'] >= 2, 'page count warnings tallied');
});

describe('goodreads: the missing-read-date bug', () => {
    // A book marked read with no date — the known long-standing export bug.
    const csv = [
        'Title,Author,My Rating,Date Read,Exclusive Shelf,Read Count,Number of Pages',
        'Ghost Book,Someone,4,,read,1,200',
    ].join('\n');
    const { books } = importGoodreadsCsv(csv);
    eq(books[0].status, 'finished', 'still imported as finished');
    eq(books[0].dateRead, undefined, 'date left undefined rather than guessed');
    ok(
        books[0].warnings.some((w) => w.kind === 'missing-read-date'),
        'export bug surfaced as a warning',
    );
});

describe('goodreads: malformed input', () => {
    eq(importGoodreadsCsv('').books.length, 0, 'empty file yields no books');
    const headerOnly = importGoodreadsCsv('Title,Author\n');
    eq(headerOnly.books.length, 0, 'header-only file yields no books');
    const noTitle = importGoodreadsCsv('Title,Author\n,Nobody');
    eq(noTitle.books.length, 0, 'row without a title dropped');
    eq(noTitle.skipped, 1, 'dropped row counted as skipped');
});

// --- openlibrary ------------------------------------------------------------

describe('openlibrary: URL construction', () => {
    ok(
        buildSearchUrl('the dispossessed').startsWith('https://openlibrary.org/search.json?q='),
        'search URL well formed',
    );
    ok(
        buildSearchUrl('a b').includes('a%20b') || buildSearchUrl('a b').includes('a+b'),
        'query is URL encoded',
    );
    eq(
        buildEditionsUrl('/works/OL27448W', 10),
        'https://openlibrary.org/works/OL27448W/editions.json?limit=10',
        'editions URL from work key',
    );
    eq(
        buildEditionsUrl('OL27448W', 10),
        'https://openlibrary.org/works/OL27448W/editions.json?limit=10',
        'bare work id also accepted',
    );
    eq(
        coverUrlFromId(240727, 'L'),
        'https://covers.openlibrary.org/b/id/240727-L.jpg',
        'cover URL by id',
    );
});

describe('openlibrary: search response mapping', () => {
    const json = {
        docs: [
            {
                key: '/works/OL27448W',
                title: 'The Dispossessed',
                author_name: ['Ursula K. Le Guin'],
                first_publish_year: 1974,
                cover_i: 240727,
                edition_count: 120,
                number_of_pages_median: 341,
                isbn: ['0060512750', '9780060512750'],
                publisher: ['Harper'],
                subject: ['Science fiction', 'Utopias', 'Anarchism'],
            },
            { title: 'No key, should be skipped' },
            { key: '/works/OL2W' }, // no title, skipped
        ],
    };
    const results = mapSearchResponse(json);
    eq(results.length, 1, 'malformed docs skipped');
    eq(results[0].workKey, '/works/OL27448W', 'work key mapped');
    eq(results[0].authors, ['Ursula K. Le Guin'], 'authors mapped');
    eq(results[0].medianPages, 341, 'median page count captured as fallback');
    eq(results[0].subjects.length, 3, 'subjects captured for tags');

    eq(mapSearchResponse({}), [], 'empty response handled');
    eq(mapSearchResponse(null), [], 'null response handled');
    eq(mapSearchResponse({ docs: 'nonsense' }), [], 'garbage docs handled');
});

describe('openlibrary: edition mapping and selection', () => {
    const json = {
        entries: [
            {
                key: '/books/OL_NOPAGES',
                title: 'The Dispossessed',
                publishers: ['Harper'],
                languages: [{ key: '/languages/eng' }],
            },
            {
                key: '/books/OL_GOOD',
                title: 'The Dispossessed',
                number_of_pages: 387,
                publishers: ['Harper Voyager'],
                publish_date: '2003',
                isbn_10: ['0060512750'],
                isbn_13: ['9780060512750'],
                covers: [240727],
                languages: [{ key: '/languages/eng' }],
            },
            {
                key: '/books/OL_AUDIO',
                title: 'The Dispossessed',
                number_of_pages: 400,
                physical_format: 'Audio CD',
                covers: [999],
                languages: [{ key: '/languages/eng' }],
            },
            {
                key: '/books/OL_FRENCH',
                number_of_pages: 390,
                languages: [{ key: '/languages/fre' }],
            },
        ],
    };
    const editions = mapEditionsResponse(json);
    eq(editions.length, 4, 'all editions mapped');
    eq(editions[1].pages, 387, 'page count read from edition');
    eq(editions[1].isbn13, '9780060512750', 'first ISBN13 taken');
    eq(editions[1].languages, ['eng'], 'language key trimmed to code');
    eq(editions[2].physicalFormat, 'Audio CD', 'physical format captured');

    const best = pickBestEdition(editions);
    eq(best?.editionKey, '/books/OL_GOOD', 'best edition has pages, cover, ISBN and language');

    ok(
        scoreEdition(editions[1]) > scoreEdition(editions[0]),
        'edition with page count outscores one without',
    );
    ok(
        scoreEdition(editions[1]) > scoreEdition(editions[2]),
        'print edition outscores audio edition',
    );
    ok(
        scoreEdition(editions[1]) > scoreEdition(editions[3]),
        'preferred language outscores other language',
    );

    // ISBN preference should override everything else.
    const byIsbn = pickBestEdition(editions, { isbn: '9780060512750' });
    eq(byIsbn?.editionKey, '/books/OL_GOOD', 'ISBN match wins');

    eq(pickBestEdition([]), null, 'no editions returns null');
    eq(mapEditionsResponse({}), [], 'empty editions response handled');
});

describe('openlibrary: skipping the editions round trip', () => {
    const base = {
        workKey: '/works/OL1W',
        title: 'T',
        authors: [],
        isbns: [],
        publishers: [],
        subjects: [],
    };
    ok(
        !needsEditionLookup({ ...base, editionCount: 1, medianPages: 300 }),
        'single-edition work with a page count skips the second API call',
    );
    ok(
        needsEditionLookup({ ...base, editionCount: 1, medianPages: undefined }),
        'single edition with no page count still needs a lookup',
    );
    ok(
        needsEditionLookup({ ...base, editionCount: 42, medianPages: 300 }),
        'multi-edition work needs a lookup to pin the right edition',
    );
    ok(
        needsEditionLookup({ ...base, editionCount: undefined, medianPages: 300 }),
        'unknown edition count needs a lookup',
    );
});

describe('openlibrary: cover resolution priority', () => {
    const work = { coverId: 111, isbns: ['9780060512750'] };
    const edition = { coverId: 222 } as Edition;
    ok(
        (resolveCoverUrl(work, edition) as string).includes('222'),
        'edition cover preferred over work cover',
    );
    ok(
        (resolveCoverUrl(work, null) as string).includes('111'),
        'work cover used when edition has none',
    );
    ok(
        (resolveCoverUrl({ coverId: undefined, isbns: ['9780060512750'] }, null) as string).includes(
            'isbn/9780060512750',
        ),
        'falls back to ISBN cover lookup',
    );
    eq(
        resolveCoverUrl({ coverId: undefined, isbns: [] }, null),
        undefined,
        'no cover available returns undefined',
    );
});

describe('openlibrary: metadata resolution', () => {
    const work = mapSearchResponse({
        docs: [
            {
                key: '/works/OL27448W',
                title: 'The Dispossessed',
                author_name: ['Ursula K. Le Guin'],
                first_publish_year: 1974,
                cover_i: 240727,
                number_of_pages_median: 341,
                isbn: ['9780060512750'],
                publisher: ['Harper'],
                subject: ['Science fiction', 'Utopias'],
            },
        ],
    })[0];

    const edition: Edition = {
        editionKey: '/books/OL_GOOD',
        title: 'The Dispossessed',
        pages: 387,
        publishers: ['Harper Voyager'],
        publishDate: '2003',
        isbn10: '0060512750',
        isbn13: '9780060512750',
        coverId: 240727,
        languages: ['eng'],
    };

    const meta = resolveMetadata(work, edition);
    eq(meta.pages, 387, 'edition page count wins over median');
    eq(meta.publisher, 'Harper Voyager', 'edition publisher wins');
    eq(meta.published, '2003', 'edition publish date wins');
    eq(meta.olWork, '/works/OL27448W', 'work key retained');
    eq(meta.olEdition, '/books/OL_GOOD', 'edition key retained');
    eq(meta.tags, ['Science fiction', 'Utopias'], 'subjects became tags');

    // The important fallback: no edition resolved, but page tracking still works.
    const fallback = resolveMetadata(work, null);
    eq(fallback.pages, 341, 'median page count used when no edition available');
    eq(fallback.publisher, 'Harper', 'work publisher used as fallback');
    eq(fallback.published, '1974', 'first publish year used as fallback');
    eq(fallback.olEdition, undefined, 'no edition key when none chosen');
});

// --- end-to-end sanity ------------------------------------------------------

describe('integration: Goodreads import produces trackable books', () => {
    const { books } = importGoodreadsCsv(GOODREADS_CSV);
    const dune = books.find((b) => b.title === 'Dune')!;

    // A currently-reading book with a page count must support page progress.
    const metrics = { pages: dune.pages };
    const r = normalisePosition('page', 302, metrics);
    ok(r.ok, 'imported book supports page progress immediately');
    if (r.ok) close(r.fraction, 0.5, 'page 302 of 604 is halfway');

    // A book with no page count must still support percent.
    const ulysses = books.find((b) => b.title === 'Ulysses')!;
    const p = normalisePosition('percent', 30, { pages: ulysses.pages });
    ok(p.ok, 'book without page count still supports percent progress');
});

// --- note, yaml and client layers -------------------------------------------

await runNoteTests({ describe, ok, eq, close });
await runVaultTests({ describe, ok, eq, close });
await runSearchTests({ describe, ok, eq, close });
await runProviderTests({ describe, ok, eq, close });
await runFuzzTests({ describe, ok, eq, close });

// --- report -----------------------------------------------------------------

console.log('\n' + '='.repeat(60));
console.log(`  ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
    console.log('\n  Failures:');
    for (const f of failures) console.log(`   - ${f}`);
}
console.log('='.repeat(60) + '\n');

process.exit(failed > 0 ? 1 : 0);
