// Dogear — tests for the note and network layers.

import {
    splitNote,
    joinNote,
    parseYaml,
    stringifyYaml,
    quoteScalar,
    unquoteScalar,
    asString,
    asNumber,
    asList,
} from '../src/yaml';

import {
    parsePositionText,
    renderPositionText,
    renderReadingLog,
    parseReadingLog,
    splitBody,
    replaceSection,
    bookToFrontmatter,
    frontmatterToBook,
    parseBookNote,
    serialiseBookNote,
    parseFormatLabel,
    newBookNote,
    DEFAULT_LOG_HEADING,
} from '../src/note';

import { OpenLibraryClient, parseRetryAfter, type HttpResponse } from '../src/olclient';
import {
    SCHEMA_VERSION,
    sessionFormats,
    formatBreakdown,
    type Book,
    type ReadingSession,
} from '../src/model';
import { USER_AGENT } from '../src/openlibrary';

// --- harness ----------------------------------------------------------------

export interface Harness {
    describe: (name: string, fn: () => void | Promise<void>) => Promise<void>;
    ok: (cond: boolean, label: string, detail?: string) => void;
    eq: (a: unknown, b: unknown, label: string) => void;
    close: (a: number, b: number, label: string, tol?: number) => void;
}

export async function runNoteTests(h: Harness): Promise<void> {
    const { describe, ok, eq } = h;

    // --- yaml ---------------------------------------------------------------

    await describe('yaml: note splitting', () => {
        const note = '---\ntitle: X\n---\nbody here\n';
        const s = splitNote(note);
        ok(s.hasFrontmatter, 'frontmatter detected');
        eq(s.frontmatter, 'title: X', 'frontmatter extracted');
        eq(s.body, 'body here\n', 'body extracted');

        const bare = splitNote('just a body');
        ok(!bare.hasFrontmatter, 'body-only note has no frontmatter');
        eq(bare.body, 'just a body', 'body preserved when no frontmatter');

        // A horizontal rule further down must not be mistaken for a fence.
        const tricky = splitNote('---\na: 1\n---\ntext\n\n---\n\nmore\n');
        eq(tricky.frontmatter, 'a: 1', 'only the leading block is frontmatter');
        ok(tricky.body.includes('more'), 'later horizontal rule left in body');

        eq(joinNote('a: 1', 'body'), '---\na: 1\n---\nbody', 'note rejoined');
        eq(joinNote('', 'body'), 'body', 'empty frontmatter omits fences');
    });

    await describe('yaml: scalar quoting', () => {
        eq(quoteScalar('simple'), 'simple', 'plain word unquoted');
        ok(quoteScalar('The Dispossessed: An Ambiguous Utopia').startsWith('"'), 'colon forces quotes');
        ok(quoteScalar('123').startsWith('"'), 'numeric-looking string quoted to stay a string');
        ok(quoteScalar('true').startsWith('"'), 'boolean-looking string quoted');
        ok(quoteScalar('').startsWith('"'), 'empty string quoted');
        ok(quoteScalar('- leading dash').startsWith('"'), 'leading dash quoted');
        eq(unquoteScalar('"He said \\"hi\\""'), 'He said "hi"', 'escaped quotes decoded');
        eq(unquoteScalar('plain'), 'plain', 'unquoted scalar passes through');

        for (const s of ['a: b', 'quote " inside', "apostrophe's", '#hash', '', '3.5']) {
            eq(unquoteScalar(quoteScalar(s)), s, `round trip ${JSON.stringify(s)}`);
        }
    });

    await describe('yaml: parse and stringify', () => {
        const yaml = [
            'dogear: 1',
            'title: "The Dispossessed: An Ambiguous Utopia"',
            'authors:',
            '  - Ursula K. Le Guin',
            '  - Someone Else',
            'pages: 387',
            'rating: 4.5',
            'tags: [sci-fi, favourites]',
            'empty:',
        ].join('\n');
        const map = parseYaml(yaml);
        eq(map.dogear, 1, 'number parsed as number');
        eq(map.title, 'The Dispossessed: An Ambiguous Utopia', 'quoted title with colon parsed');
        eq(map.authors, ['Ursula K. Le Guin', 'Someone Else'], 'block list parsed');
        eq(map.pages, 387, 'page count parsed');
        eq(map.rating, 4.5, 'decimal rating parsed');
        eq(map.tags, ['sci-fi', 'favourites'], 'inline flow list parsed');
        eq(map.empty, '', 'empty value becomes empty string');

        const out = stringifyYaml(
            { title: 'A: B', pages: 10, authors: ['X'], extra: 'kept' },
            ['title', 'authors', 'pages'],
        );
        const lines = out.split('\n');
        eq(lines[0], 'title: "A: B"', 'key order respected and colon quoted');
        ok(out.includes('extra: kept'), 'unlisted key still emitted');
        ok(out.indexOf('authors:') < out.indexOf('pages:'), 'declared order honoured');

        // Round trip.
        const src = { title: 'A: B', pages: 10, authors: ['X', 'Y'], rating: 3.75 };
        const round = parseYaml(stringifyYaml(src, ['title']));
        eq(round.title, 'A: B', 'title round trips');
        eq(round.authors, ['X', 'Y'], 'authors round trip');
        eq(round.rating, 3.75, 'rating round trips as number');

        eq(parseYaml(''), {}, 'empty yaml is an empty map');
        eq(parseYaml('# just a comment'), {}, 'comments ignored');
        eq(parseYaml('nonsense line without colon'), {}, 'garbage skipped, no throw');
    });

    await describe('yaml: typed accessors', () => {
        eq(asString('x'), 'x', 'string accessor');
        eq(asString('  '), undefined, 'blank string is undefined');
        eq(asString(undefined), undefined, 'missing is undefined');
        eq(asNumber(5), 5, 'number accessor');
        eq(asNumber('5'), 5, 'numeric string coerced');
        eq(asNumber('abc'), undefined, 'non-numeric is undefined');
        eq(asList(['a']), ['a'], 'list passes through');
        eq(asList('a'), ['a'], 'bare scalar becomes single-item list');
        eq(asList(undefined), [], 'missing becomes empty list');
    });

    // --- position text ------------------------------------------------------

    await describe('note: position text round trip', () => {
        eq(parsePositionText('page 200'), { unit: 'page', value: 200 }, 'page parsed');
        eq(parsePositionText('p. 200'), { unit: 'page', value: 200 }, 'abbreviated page parsed');
        eq(parsePositionText('45%'), { unit: 'percent', value: 45 }, 'percent parsed');
        eq(parsePositionText('45.5%'), { unit: 'percent', value: 45.5 }, 'decimal percent parsed');
        eq(
            parsePositionText('2:30 left'),
            { unit: 'remaining', value: 9000 },
            'time remaining parsed',
        );
        eq(
            parsePositionText('2:30 remaining'),
            { unit: 'remaining', value: 9000 },
            '"remaining" wording also accepted',
        );
        eq(
            parsePositionText('2:30 listened'),
            { unit: 'elapsed', value: 9000 },
            'time listened parsed',
        );
        eq(
            parsePositionText('listened 2:30'),
            { unit: 'elapsed', value: 9000 },
            'listened prefix accepted',
        );
        eq(parsePositionText('gibberish'), null, 'unknown text rejected');
        eq(parsePositionText(''), null, 'empty rejected');

        // "left" must win over any generic time reading.
        const r = parsePositionText('2:30 left');
        eq(r?.unit, 'remaining', 'remaining takes priority over elapsed');

        const entries = [
            { date: '2026-01-01', fraction: 0.5, raw: { unit: 'page' as const, value: 200 } },
            { date: '2026-01-01', fraction: 0.45, raw: { unit: 'percent' as const, value: 45 } },
            { date: '2026-01-01', fraction: 0.25, raw: { unit: 'elapsed' as const, value: 9000 } },
            { date: '2026-01-01', fraction: 0.75, raw: { unit: 'remaining' as const, value: 9000 } },
        ];
        for (const e of entries) {
            const text = renderPositionText(e);
            const back = parsePositionText(text);
            eq(back, { unit: e.raw.unit, value: e.raw.value }, `render/parse round trip: ${text}`);
        }
    });

    // --- reading log --------------------------------------------------------

    const sampleSessions: ReadingSession[] = [
        {
            id: 's1',
            format: 'print',
            started: '2024-01-02',
            finished: '2024-03-12',
            rating: 4.5,
            entries: [
                { date: '2024-01-02', fraction: 0.0026, raw: { unit: 'page', value: 1 } },
                { date: '2024-02-01', fraction: 0.517, raw: { unit: 'page', value: 200 } },
            ],
        },
        {
            id: 's2',
            format: 'audio',
            started: '2026-01-05',
            entries: [
                { date: '2026-01-05', fraction: 0.75, raw: { unit: 'remaining', value: 9000 } },
            ],
        },
    ];

    await describe('note: reading log rendering and parsing', () => {
        const rendered = renderReadingLog(sampleSessions);
        ok(rendered.includes('### Read 1 — print'), 'session header rendered');
        ok(rendered.includes('2024-01-02 → 2024-03-12'), 'date range rendered');
        ok(rendered.includes('4.5★'), 'rating rendered');
        ok(rendered.includes('- 2024-02-01 · page 200'), 'entry rendered');
        ok(rendered.includes('2:30 left'), 'audiobook remaining rendered');

        const metrics = { pages: 387, duration: 36000 };
        const parsed = parseReadingLog(rendered, metrics);
        eq(parsed.sessions.length, 2, 'both sessions recovered');
        eq(parsed.unparsed, [], 'nothing unparsed');
        eq(parsed.sessions[0].format, 'print', 'print format recovered');
        eq(parsed.sessions[0].started, '2024-01-02', 'start date recovered');
        eq(parsed.sessions[0].finished, '2024-03-12', 'finish date recovered');
        eq(parsed.sessions[0].rating, 4.5, 'rating recovered');
        eq(parsed.sessions[0].entries.length, 2, 'entries recovered');
        eq(parsed.sessions[0].entries[1].raw, { unit: 'page', value: 200 }, 'raw unit preserved');
        eq(parsed.sessions[1].format, 'audio', 'audio format recovered');
        eq(
            parsed.sessions[1].entries[0].raw,
            { unit: 'remaining', value: 9000 },
            'remaining unit survives the round trip',
        );
        // And it still normalises correctly on the way back in.
        h.close(parsed.sessions[1].entries[0].fraction, 0.75, 'remaining renormalised to 75%');
    });

    await describe('note: DNF session round trip', () => {
        const dnf: ReadingSession[] = [
            {
                id: 's1',
                format: 'ebook',
                started: '2023-09-09',
                entries: [],
                abandoned: { fraction: 0.34, reason: 'lost the thread' },
            },
        ];
        const text = renderReadingLog(dnf);
        ok(text.includes('abandoned at 34%'), 'abandon position rendered');
        ok(text.includes('reason: lost the thread'), 'reason rendered');

        const back = parseReadingLog(text, { pages: 700 });
        eq(back.sessions[0].abandoned?.fraction, 0.34, 'abandon position recovered');
        eq(back.sessions[0].abandoned?.reason, 'lost the thread', 'reason recovered');
        eq(back.sessions[0].finished, undefined, 'abandoned session has no finish date');
        eq(back.sessions[0].format, 'ebook', 'format recovered');
    });

    await describe('note: reading log tolerance', () => {
        const metrics = { pages: 300 };
        // Hand-edited variations a reader might plausibly produce.
        const messy = [
            '### Read 1 — print · 2024-01-01 → 2024-02-01',
            '- 2024-01-01 · page 10',
            '* 2024-01-05 · page 50',
            '- 2024-01-06 - page 90',
            '- not a real line',
            '- 2024-01-07 · flibbertigibbet',
        ].join('\n');
        const parsed = parseReadingLog(messy, metrics);
        eq(parsed.sessions.length, 1, 'one session found');
        eq(parsed.sessions[0].entries.length, 3, 'asterisk and dash bullets both accepted');
        eq(parsed.unparsed.length, 2, 'unreadable lines reported, not silently dropped');

        // Entries with no header still get a session rather than vanishing.
        const orphan = parseReadingLog('- 2024-01-01 · page 10', metrics);
        eq(orphan.sessions.length, 1, 'orphan entries get a synthesised session');
        eq(orphan.sessions[0].entries.length, 1, 'orphan entry preserved');

        // A page number beyond the book cannot be normalised; report it.
        const impossible = parseReadingLog('- 2024-01-01 · page 9999', metrics);
        eq(impossible.unparsed.length, 1, 'out-of-range position reported as unparsed');

        eq(renderReadingLog([]).includes('No reading logged'), true, 'empty log has placeholder');
    });

    // --- section ownership --------------------------------------------------

    await describe('note: section splitting and replacement', () => {
        const body = [
            'Some intro prose.',
            '',
            '## Reading log',
            '',
            '### Read 1 — print',
            '- 2024-01-01 · page 10',
            '',
            '## Notes',
            '',
            'My private thoughts.',
        ].join('\n');

        const split = splitBody(body, 'Reading log');
        ok(split.found, 'section located');
        ok(split.before.includes('Some intro prose'), 'prose before preserved');
        ok(split.section.includes('page 10'), 'section content captured');
        ok(split.after.includes('My private thoughts'), 'content after preserved');
        ok(!split.section.includes('My private thoughts'), 'notes not swallowed by the section');

        const replaced = replaceSection(body, 'Reading log', '### Read 1 — print\n- 2024-06-01 · page 99');
        ok(replaced.includes('Some intro prose'), 'intro survives replacement');
        ok(replaced.includes('My private thoughts'), 'user notes survive replacement');
        ok(replaced.includes('page 99'), 'new content written');
        ok(!replaced.includes('page 10'), 'old log content replaced');

        // Inserting when the section does not exist yet.
        const inserted = replaceSection('Just notes.', 'Reading log', 'content');
        ok(inserted.startsWith('Just notes.'), 'existing body kept when inserting');
        ok(inserted.includes('## Reading log'), 'heading inserted');

        eq(splitBody('no headings here', 'Reading log').found, false, 'missing section reported');

        // A sub-heading inside the section must stay with it.
        const nested = ['## Reading log', '### Read 1 — print', '- 2024-01-01 · page 1', '## After'].join('\n');
        const ns = splitBody(nested, 'Reading log');
        ok(ns.section.includes('### Read 1'), 'sub-heading stays inside the section');
        ok(ns.after.includes('## After'), 'next same-level heading starts the tail');
    });

    // --- whole note ---------------------------------------------------------

    const sampleBook: Book = {
        schemaVersion: SCHEMA_VERSION,
        title: 'The Dispossessed: An Ambiguous Utopia',
        authors: ['Ursula K. Le Guin'],
        cover: 'https://covers.openlibrary.org/b/id/240727-L.jpg',
        isbn13: '9780060512750',
        publisher: 'Harper Voyager',
        published: '2003',
        series: 'Hainish Cycle',
        seriesPosition: 6,
        tags: ['sci-fi'],
        metrics: { pages: 387, duration: 19800 },
        rating: 4.5,
        status: 'finished',
        sessions: sampleSessions,
        olWork: '/works/OL27448W',
        olEdition: '/books/OL_GOOD',
    };

    await describe('note: frontmatter mapping', () => {
        const map = bookToFrontmatter(sampleBook);
        eq(map.dogear, SCHEMA_VERSION, 'schema version stamped');
        eq(map.title, 'The Dispossessed: An Ambiguous Utopia', 'title mapped');
        eq(map.pages, 387, 'pages mapped');
        eq(map.duration, '5:30', 'duration written in H:MM');
        eq(map.rating, 4.5, 'rating mapped');
        eq(map.status, 'finished', 'status mapped');

        const back = frontmatterToBook(map);
        eq(back.title, sampleBook.title, 'title recovered');
        eq(back.metrics.duration, 19800, 'duration parsed back to seconds');
        eq(back.metrics.pages, 387, 'pages recovered');
        eq(back.rating, 4.5, 'rating recovered');
        eq(back.seriesPosition, 6, 'series position recovered');
        eq(back.tags, ['sci-fi'], 'tags recovered');

        // Unknown keys must survive.
        const merged = bookToFrontmatter(sampleBook, { cssclasses: 'cards', myField: 'keep me' });
        eq(merged.cssclasses, 'cards', 'unknown key preserved');
        eq(merged.myField, 'keep me', 'second unknown key preserved');

        // Bad status falls back safely.
        eq(frontmatterToBook({ status: 'nonsense' }).status, 'want-to-read', 'unknown status defaults');
        eq(frontmatterToBook({}).title, '', 'missing title yields empty string, no throw');
    });

    await describe('note: full note round trip', () => {
        const content = newBookNote(sampleBook);
        ok(content.startsWith('---\n'), 'frontmatter fence present');
        ok(content.includes('## Reading log'), 'log section written');

        const parsed = parseBookNote(content);
        eq(parsed.book.title, sampleBook.title, 'title round trips');
        eq(parsed.book.authors, sampleBook.authors, 'authors round trip');
        eq(parsed.book.metrics, sampleBook.metrics, 'metrics round trip');
        eq(parsed.book.rating, sampleBook.rating, 'rating round trips');
        eq(parsed.book.status, sampleBook.status, 'status round trips');
        eq(parsed.book.sessions.length, 2, 'both sessions round trip');
        eq(parsed.book.sessions[0].rating, 4.5, 'session rating round trips');
        eq(
            parsed.book.sessions[1].entries[0].raw,
            { unit: 'remaining', value: 9000 },
            'audiobook remaining survives a full note round trip',
        );
        eq(parsed.unparsed, [], 'no unparsed lines');

        // Serialising twice must be stable — no drift, no duplicated sections.
        const again = serialiseBookNote(parsed.book, content);
        eq(again, content, 'serialisation is idempotent');
    });

    await describe('note: user content is never destroyed', () => {
        const original = [
            '---',
            'title: "Old Title"',
            'cssclasses: cards',
            'myCustomField: precious',
            '---',
            '',
            'A paragraph I wrote before the log.',
            '',
            '## Reading log',
            '',
            '### Read 1 — print · 2024-01-01 → 2024-02-01',
            '- 2024-01-01 · page 10',
            '',
            '## My notes',
            '',
            'Chapter 3 is the heart of the book.',
            '',
            '### Sub-note',
            '',
            'More thoughts.',
        ].join('\n');

        const parsed = parseBookNote(original);
        // Simulate the plugin updating status and adding an entry.
        const updated: Book = {
            ...parsed.book,
            title: 'New Title',
            status: 'finished',
            metrics: { pages: 300 },
            sessions: [
                {
                    ...parsed.book.sessions[0],
                    entries: [
                        ...parsed.book.sessions[0].entries,
                        { date: '2024-02-01', fraction: 1, raw: { unit: 'page', value: 300 } },
                    ],
                },
            ],
        };
        const written = serialiseBookNote(updated, original);

        ok(written.includes('cssclasses: cards'), 'unknown frontmatter key survives a write');
        ok(written.includes('myCustomField: precious'), 'second unknown key survives');
        ok(written.includes('A paragraph I wrote before the log.'), 'prose before the log survives');
        ok(written.includes('## My notes'), 'user heading after the log survives');
        ok(written.includes('Chapter 3 is the heart of the book.'), 'user notes survive');
        ok(written.includes('### Sub-note'), 'user sub-heading survives');
        ok(written.includes('More thoughts.'), 'trailing user prose survives');
        ok(written.includes('page 300'), 'new entry written');
        ok(written.includes('title: New Title'), 'managed field updated');
        ok(!written.includes('Old Title'), 'stale managed value replaced');

        // Only one log section, no duplication on repeated writes.
        const twice = serialiseBookNote(updated, written);
        const count = (twice.match(/## Reading log/g) ?? []).length;
        eq(count, 1, 'repeated writes do not duplicate the log section');
        eq(twice, written, 'second write is a no-op');
    });

    await describe('note: a finish date is never mistaken for a start date (regression)', () => {
        // Found by the fuzz suite. A session with a finish date but no start
        // date renders as "? → 2021-06-11". The old parser took the first date
        // it found anywhere in the header, silently turning the finish date
        // into a start date — real data corruption, on every read.
        const noStart: Book = {
            ...sampleBook,
            sessions: [{ id: 's1', format: 'ebook', entries: [], finished: '2021-06-11', rating: 1.75 }],
        };
        const written = serialiseBookNote(noStart);
        ok(written.includes('? → 2021-06-11'), 'unknown start rendered as a placeholder');

        const back = parseBookNote(written).book.sessions[0];
        eq(back.started, undefined, 'start stays unknown');
        eq(back.finished, '2021-06-11', 'finish date correctly assigned to finish');
        eq(back.rating, 1.75, 'rating still recovered');
        eq(serialiseBookNote(parseBookNote(written).book, written), written, 'and it is idempotent');

        // The mirror case: a start with no finish must not gain one.
        const noFinish: Book = {
            ...sampleBook,
            sessions: [{ id: 's1', format: 'print', entries: [], started: '2024-01-01' }],
        };
        const w2 = serialiseBookNote(noFinish);
        const b2 = parseBookNote(w2).book.sessions[0];
        eq(b2.started, '2024-01-01', 'start recovered');
        eq(b2.finished, undefined, 'open session stays open');

        // Hand-written header with no arrow still falls back sensibly.
        const manual = parseReadingLog('### Read 1 — print 2024-01-01 2024-02-01', { pages: 100 });
        eq(manual.sessions[0].started, '2024-01-01', 'fallback start');
        eq(manual.sessions[0].finished, '2024-02-01', 'fallback finish');
    });

    await describe('note: a zero rating never reaches disk (regression)', () => {
        // Found by the fuzz suite. Rating 0 means "unrated", so writing it
        // literally made notes flip-flop between saves: written as `rating: 0`,
        // read back as undefined, written again without the key. In a synced
        // or git-backed vault that is a spurious diff on every save.
        const zeroRated: Book = { ...sampleBook, rating: 0, sessions: [] };
        const written = serialiseBookNote(zeroRated);
        ok(!/^rating:/m.test(written), 'zero book rating not written to frontmatter');
        eq(serialiseBookNote(parseBookNote(written).book, written), written, 'and the write is idempotent');

        const zeroSession: Book = {
            ...sampleBook,
            rating: undefined,
            sessions: [
                { id: 's1', format: 'print', entries: [], started: '2024-01-01', finished: '2024-02-01', rating: 0 },
            ],
        };
        const w2 = serialiseBookNote(zeroSession);
        ok(!w2.includes('0★'), 'zero session rating not rendered in the log');
        eq(serialiseBookNote(parseBookNote(w2).book, w2), w2, 'session write is idempotent too');

        // A real rating must still survive.
        const rated = serialiseBookNote({ ...sampleBook, rating: 3.75, sessions: [] });
        ok(/^rating: 3\.75$/m.test(rated), 'a genuine rating is still written');
    });

    await describe('note: handles notes with no frontmatter', () => {
        const plain = 'Just some notes about a book.';
        const parsed = parseBookNote(plain);
        eq(parsed.book.title, '', 'no title found');
        eq(parsed.book.sessions, [], 'no sessions found');

        const written = serialiseBookNote({ ...sampleBook, sessions: [] }, plain);
        ok(written.startsWith('---'), 'frontmatter added');
        ok(written.includes('Just some notes about a book.'), 'original prose preserved');
    });

    await describe('note: custom log heading', () => {
        const content = newBookNote({ ...sampleBook, sessions: sampleSessions }, 'Reading journey');
        ok(content.includes('## Reading journey'), 'custom heading used');
        const parsed = parseBookNote(content, 'Reading journey');
        eq(parsed.book.sessions.length, 2, 'sessions parsed under custom heading');
        // Parsing with the wrong heading finds nothing but must not throw.
        eq(parseBookNote(content, DEFAULT_LOG_HEADING).book.sessions.length, 0, 'wrong heading finds no sessions');
    });

    // --- network client -----------------------------------------------------

    function stubClient(
        responses: Record<string, HttpResponse | (() => HttpResponse)>,
        opts: Record<string, unknown> = {},
    ) {
        const calls: string[] = [];
        const headers: Record<string, string>[] = [];
        let clock = 0;
        const client = new OpenLibraryClient(
            async (url, hdrs) => {
                calls.push(url);
                headers.push(hdrs);
                const key = Object.keys(responses).find((k) => url.includes(k));
                if (!key) throw new Error(`no stub for ${url}`);
                const r = responses[key];
                return typeof r === 'function' ? r() : r;
            },
            {
                now: () => clock,
                sleep: async (ms) => {
                    clock += ms;
                },
                minIntervalMs: 0,
                backoffMs: 10,
                ...opts,
            },
        );
        return { client, calls, headers, tick: (ms: number) => (clock += ms) };
    }

    const SEARCH_JSON = {
        docs: [
            {
                key: '/works/OL27448W',
                title: 'The Dispossessed',
                author_name: ['Ursula K. Le Guin'],
                cover_i: 240727,
                edition_count: 5,
                number_of_pages_median: 341,
                subject: ['Science fiction'],
            },
        ],
    };
    const EDITIONS_JSON = {
        entries: [
            {
                key: '/books/OL_GOOD',
                number_of_pages: 387,
                isbn_13: ['9780060512750'],
                covers: [240727],
                languages: [{ key: '/languages/eng' }],
                publishers: ['Harper Voyager'],
            },
        ],
    };

    await describe('client: search and caching', async () => {
        const { client, calls, headers } = stubClient({
            'search.json': { status: 200, json: SEARCH_JSON },
        });

        const first = await client.search('dispossessed');
        eq(first.length, 1, 'search returns mapped results');
        eq(first[0].title, 'The Dispossessed', 'title mapped through the client');
        eq(calls.length, 1, 'one request made');
        eq(headers[0]['User-Agent'], USER_AGENT, 'User-Agent sent as Open Library requests');

        const second = await client.search('dispossessed');
        eq(second.length, 1, 'cached search still returns results');
        eq(calls.length, 1, 'identical query served from cache, no second request');
        eq(client.stats.cacheHits, 1, 'cache hit counted');

        const empty = await client.search('   ');
        eq(empty, [], 'blank query short-circuits');
        eq(calls.length, 1, 'blank query makes no request');
    });

    await describe('client: cache expiry', async () => {
        const { client, calls, tick } = stubClient(
            { 'search.json': { status: 200, json: SEARCH_JSON } },
            { ttlMs: 1000 },
        );
        await client.search('x');
        eq(calls.length, 1, 'first call hits the network');
        tick(500);
        await client.search('x');
        eq(calls.length, 1, 'still cached within TTL');
        tick(1000);
        await client.search('x');
        eq(calls.length, 2, 'refetched after TTL expiry');
    });

    await describe('client: retry and backoff', async () => {
        let attempts = 0;
        const { client, calls } = stubClient({
            'search.json': () => {
                attempts++;
                if (attempts < 3) return { status: 500, json: null };
                return { status: 200, json: SEARCH_JSON };
            },
        });
        const results = await client.search('x');
        eq(results.length, 1, 'succeeds after transient 500s');
        eq(calls.length, 3, 'retried twice before succeeding');
        eq(client.stats.retries, 2, 'retries counted');
    });

    await describe('client: gives up on non-retryable errors', async () => {
        const { client, calls } = stubClient({ 'search.json': { status: 404, json: null } });
        let threw = false;
        try {
            await client.search('x');
        } catch {
            threw = true;
        }
        ok(threw, '404 surfaces as an error');
        eq(calls.length, 1, '404 is not retried');
    });

    await describe('client: a 429 triggers a cooldown, not a retry storm', async () => {
        // Open Library has an open issue about rate limits firing far too
        // eagerly, and Audiobookshelf hit the same wall. Retrying immediately
        // makes it worse, so a 429 must stand the client down instead.
        let calls = 0;
        const { client } = stubClient({
            'search.json': () => {
                calls++;
                return { status: 429, json: null, headers: { 'retry-after': '30' } };
            },
        });

        let err: Error | null = null;
        try {
            await client.search('dune');
        } catch (e) {
            err = e as Error;
        }
        ok(err?.name === 'RateLimitError', 'a dedicated rate-limit error is raised');
        ok(/30s/.test(err?.message ?? ''), 'the message says how long to wait');
        eq(calls, 1, '429 is NOT retried — one request only');
        eq(client.stats.rateLimited, 1, 'rate limiting counted');

        // While cooling down, no further request may be attempted at all.
        let second: Error | null = null;
        try {
            await client.search('dune two');
        } catch (e) {
            second = e as Error;
        }
        ok(second?.name === 'RateLimitError', 'subsequent searches fail fast');
        eq(calls, 1, 'no request made while standing down');
    });

    await describe('client: cooldown expires and requests resume', async () => {
        let calls = 0;
        const { client, tick } = stubClient({
            'search.json': () => {
                calls++;
                return calls === 1
                    ? { status: 429, json: null, headers: { 'retry-after': '5' } }
                    : { status: 200, json: SEARCH_JSON };
            },
        });

        try {
            await client.search('a');
        } catch {
            /* expected */
        }
        eq(calls, 1, 'first attempt rate limited');

        tick(6000);
        const results = await client.search('b');
        eq(results.length, 1, 'search works again once the cooldown passes');
        eq(calls, 2, 'exactly one further request made');
    });

    await describe('client: Retry-After parsing', () => {
        const now = Date.parse('2026-07-18T12:00:00Z');
        eq(parseRetryAfter('30', now), 30_000, 'seconds form parsed');
        eq(parseRetryAfter('0', now), 0, 'zero seconds parsed');
        eq(parseRetryAfter(undefined, now), null, 'missing header returns null');
        eq(parseRetryAfter('nonsense', now), null, 'garbage returns null');
        const httpDate = parseRetryAfter('Sat, 18 Jul 2026 12:01:00 GMT', now);
        eq(httpDate, 60_000, 'HTTP-date form parsed');
        // A date in the past must not produce a negative wait.
        eq(parseRetryAfter('Sat, 18 Jul 2026 11:00:00 GMT', now), 0, 'past date clamps to zero');
    });

    await describe('client: falls back to a default cooldown', async () => {
        const { client } = stubClient(
            { 'search.json': { status: 429, json: null } },
            { defaultCooldownMs: 45_000 },
        );
        let err: Error | null = null;
        try {
            await client.search('x');
        } catch (e) {
            err = e as Error;
        }
        ok(/45s/.test(err?.message ?? ''), 'default cooldown used when no Retry-After is sent');
    });

    await describe('client: 5xx is still retried', async () => {
        let n = 0;
        const { client, calls } = stubClient({
            'search.json': () => {
                n++;
                return n < 3 ? { status: 503, json: null } : { status: 200, json: SEARCH_JSON };
            },
        });
        const r = await client.search('x');
        eq(r.length, 1, 'recovers from transient 5xx');
        eq(calls.length, 3, 'server errors are retried, unlike rate limits');
    });

    await describe('client: resolve skips or performs the editions call', async () => {
        // Multi-edition work: needs the editions lookup.
        const multi = stubClient({
            'search.json': { status: 200, json: SEARCH_JSON },
            'editions.json': { status: 200, json: EDITIONS_JSON },
        });
        const works = await multi.client.search('x');
        const meta = await multi.client.resolve(works[0]);
        eq(meta.pages, 387, 'edition page count used');
        eq(meta.olEdition, '/books/OL_GOOD', 'edition key captured');
        ok(
            multi.calls.some((c) => c.includes('editions.json')),
            'editions endpoint called for a multi-edition work',
        );

        // Single-edition work: the extra call is skipped.
        const single = stubClient({
            'search.json': {
                status: 200,
                json: { docs: [{ ...SEARCH_JSON.docs[0], edition_count: 1 }] },
            },
        });
        const w = await single.client.search('x');
        const m = await single.client.resolve(w[0]);
        eq(m.pages, 341, 'median page count used for a single-edition work');
        ok(
            !single.calls.some((c) => c.includes('editions.json')),
            'editions call skipped when the work has one edition',
        );
    });

    await describe('client: resolve degrades gracefully', async () => {
        const { client } = stubClient({
            'search.json': { status: 200, json: SEARCH_JSON },
            'editions.json': { status: 500, json: null },
        });
        const works = await client.search('x');
        const meta = await client.resolve(works[0]);
        eq(meta.pages, 341, 'falls back to work-level median when editions fail');
        eq(meta.olEdition, undefined, 'no edition key when the lookup failed');
        eq(meta.title, 'The Dispossessed', 'book is still addable despite the failure');
    });

    await describe('client: cache eviction is bounded', async () => {
        const { client, calls } = stubClient(
            { 'search.json': { status: 200, json: SEARCH_JSON } },
            { maxEntries: 2 },
        );
        await client.search('a');
        await client.search('b');
        await client.search('c'); // evicts 'a'
        eq(calls.length, 3, 'three distinct queries fetched');
        await client.search('c');
        eq(calls.length, 3, 'most recent still cached');
        await client.search('a');
        eq(calls.length, 4, 'evicted entry refetched');
    });

    /** Minimal book for the note tests below. */
    const makeBook = (over: Partial<Book>): Book => ({
        schemaVersion: SCHEMA_VERSION,
        title: 'A Book',
        authors: ['An Author'],
        tags: [],
        metrics: {},
        status: 'reading',
        sessions: [],
        ...over,
    });

    await describe('note: progress entries can carry a thought', () => {
        const book = makeBook({
            sessions: [
                {
                    id: 's1',
                    format: 'print',
                    started: '2026-01-01',
                    entries: [
                        {
                            date: '2026-01-02',
                            fraction: 0.4,
                            raw: { unit: 'page', value: 200 },
                            note: 'the Jones Beach chapter is extraordinary',
                        },
                        { date: '2026-01-03', fraction: 0.5, raw: { unit: 'page', value: 250 } },
                    ],
                },
            ],
            metrics: { pages: 500 },
        });

        const text = serialiseBookNote(book, '');
        ok(
            text.includes('the Jones Beach chapter is extraordinary'),
            'the note is written into the log',
        );

        const parsed = parseBookNote(text);
        const entries = parsed.book.sessions[0].entries;
        eq(entries[0].note, 'the Jones Beach chapter is extraordinary', 'note survives a round trip');
        eq(entries[0].raw.value, 200, 'and the position is still parsed correctly');
        eq(entries[1].note, undefined, 'an entry without a note stays without one');
    });

    await describe('note: awkward entry notes are handled', () => {
        const withDash = makeBook({
            sessions: [
                {
                    id: 's1',
                    format: 'print',
                    started: '2026-01-01',
                    entries: [
                        {
                            date: '2026-01-02',
                            fraction: 0.5,
                            raw: { unit: 'percent', value: 50 },
                            // A note containing the separator itself.
                            note: 'good so far — though the middle drags',
                        },
                    ],
                },
            ],
        });
        const round = parseBookNote(serialiseBookNote(withDash, ''));
        eq(
            round.book.sessions[0].entries[0].note,
            'good so far — though the middle drags',
            'a note containing an em dash survives, split on the first one only',
        );
        eq(round.book.sessions[0].entries[0].raw.value, 50, 'position still correct');

        // Multi-line notes would break the list grammar, so they are folded.
        const multiline = makeBook({
            sessions: [
                {
                    id: 's1',
                    format: 'print',
                    started: '2026-01-01',
                    entries: [
                        {
                            date: '2026-01-02',
                            fraction: 0.5,
                            raw: { unit: 'percent', value: 50 },
                            note: 'first line\nsecond line',
                        },
                    ],
                },
            ],
        });
        const text = serialiseBookNote(multiline, '');
        eq(text.split('\n').filter((l) => l.startsWith('- 2026-01-02')).length, 1, 'still one line');
        eq(
            parseBookNote(text).book.sessions[0].entries[0].note,
            'first line second line',
            'newlines folded to spaces rather than corrupting the log',
        );
    });

    await describe('note: a book read in two formats', () => {
        // The case both major trackers handle badly. Their users switch
        // editions mid-book and re-log the same percentage so that "nothing
        // appears to change"; here it is just an entry.
        const book = makeBook({
            metrics: { pages: 500, duration: 36000 },
            sessions: [
                {
                    id: 's1',
                    format: 'print',
                    started: '2026-01-01',
                    entries: [
                        { date: '2026-01-02', fraction: 0.2, raw: { unit: 'page', value: 100 } },
                        // Commute: switched to the audiobook.
                        {
                            date: '2026-01-03',
                            fraction: 0.5,
                            raw: { unit: 'elapsed', value: 18000 },
                            format: 'audio',
                        },
                        // Back to print at home.
                        { date: '2026-01-04', fraction: 0.6, raw: { unit: 'page', value: 300 } },
                    ],
                },
            ],
        });

        const text = serialiseBookNote(book, '');
        const lines = text.split('\n').filter((l) => l.startsWith('- 2026-01'));
        eq(lines.length, 3, 'three entries written');
        ok(!lines[0].includes('print'), 'the session format is not repeated on every line');
        ok(lines[1].includes('audiobook'), 'the switch to audio is recorded');
        ok(!lines[2].includes('print'), 'switching back is implied by the session format');

        const parsed = parseBookNote(text);
        const entries = parsed.book.sessions[0].entries;
        eq(entries[0].format, undefined, 'unchanged entries carry no format');
        eq(entries[1].format, 'audio', 'the switched entry round trips');
        eq(entries[1].raw.value, 18000, 'and its position is intact');
        eq(entries[2].format, undefined, 'back to the session default');
    });

    await describe('note: entries carry a comparable percentage', () => {
        const book = makeBook({
            metrics: { pages: 500, duration: 36000 },
            sessions: [
                {
                    id: 's1',
                    format: 'print',
                    started: '2026-01-01',
                    entries: [
                        { date: '2026-01-02', fraction: 0.4, raw: { unit: 'page', value: 200 } },
                        { date: '2026-01-03', fraction: 0.5, raw: { unit: 'percent', value: 50 } },
                        { date: '2026-01-04', fraction: 0.75, raw: { unit: 'elapsed', value: 27000 } },
                    ],
                },
            ],
        });
        const lines = serialiseBookNote(book, '').split('\n').filter((l) => l.startsWith('- 2026-01'));

        ok(lines[0].includes('page 200') && lines[0].includes('40%'), 'a page entry gains a percentage');
        // "50% · 50%" would be silly.
        eq((lines[1].match(/%/g) ?? []).length, 1, 'a percentage entry is not restated');
        ok(lines[2].includes('75%'), 'a time entry gains a percentage');

        // Deliberately NOT done: deriving a page number from a percentage.
        // Percentages are approximate by nature; page numbers assert a
        // precision the reader never gave. Deriving toward less precision is
        // safe, deriving toward more is invention.
        ok(!lines[1].includes('page'), 'no page number is invented from a percentage');
        ok(!lines[2].includes('page'), 'no page number is invented from an audiobook position');
    });

    await describe('note: percentages are recomputed, not trusted', () => {
        // If a page count is corrected later, every page-based entry should
        // re-derive rather than keep a stale figure.
        const wrong = makeBook({
            metrics: { pages: 500 },
            sessions: [
                {
                    id: 's1',
                    format: 'print',
                    started: '2026-01-01',
                    // Stored fraction deliberately disagrees with the position.
                    entries: [{ date: '2026-01-02', fraction: 0.99, raw: { unit: 'page', value: 250 } }],
                },
            ],
        });
        const line = serialiseBookNote(wrong, '')
            .split('\n')
            .find((l) => l.startsWith('- 2026-01-02'));
        ok(line?.includes('50%') ?? false, 'derived from the page, not the stale fraction');
        ok(!(line?.includes('99%') ?? true), 'the disagreeing stored value is ignored');
    });

    await describe('note: format labels are recognised in any form', () => {
        eq(parseFormatLabel('audiobook'), 'audio', 'the word the interface uses');
        eq(parseFormatLabel('Audiobook'), 'audio', 'case insensitive');
        eq(parseFormatLabel('audio'), 'audio', 'the stored key');
        eq(parseFormatLabel('print'), 'print', 'print');
        eq(parseFormatLabel('Ebook'), 'ebook', 'ebook');
        eq(parseFormatLabel('page 200'), undefined, 'a position is not a format');
        eq(parseFormatLabel('50%'), undefined, 'a percentage is not a format');
    });

    await describe('note: the session header names every medium used', () => {
        const mixed = makeBook({
            metrics: { pages: 500, duration: 36000 },
            sessions: [
                {
                    id: 's1',
                    format: 'print',
                    started: '2026-01-01',
                    entries: [
                        { date: '2026-01-02', fraction: 0.1, raw: { unit: 'percent', value: 10 } },
                        {
                            date: '2026-01-03',
                            fraction: 0.15,
                            raw: { unit: 'percent', value: 15 },
                            format: 'ebook',
                        },
                        {
                            date: '2026-01-04',
                            fraction: 0.25,
                            raw: { unit: 'percent', value: 25 },
                            format: 'audio',
                        },
                    ],
                },
            ],
        });

        const text = serialiseBookNote(mixed, '');
        const header = text.split('\n').find((l) => l.startsWith('### ')) ?? '';
        ok(header.includes('print'), 'the starting medium is named');
        ok(header.includes('ebook'), 'and the ebook');
        ok(header.includes('audiobook'), 'and the audiobook');
        ok(
            header.indexOf('print') < header.indexOf('ebook'),
            'the session format comes first, which is what makes parsing safe',
        );

        // The important part: a multi-format header must not corrupt the
        // fallback medium for entries that carry none.
        const parsed = parseBookNote(text);
        eq(parsed.book.sessions[0].format, 'print', 'session format recovered from a list');
        eq(parsed.book.sessions[0].entries[0].format, undefined, 'first entry still inherits');
        eq(parsed.book.sessions[0].entries[1].format, 'ebook', 'ebook entry preserved');
        eq(parsed.book.sessions[0].entries[2].format, 'audio', 'audio entry preserved');

        // A single-format session should read exactly as before.
        const plain = makeBook({
            sessions: [{ id: 's1', format: 'audio', started: '2026-01-01', entries: [] }],
        });
        const plainHeader = serialiseBookNote(plain, '').split('\n').find((l) => l.startsWith('### ')) ?? '';
        eq(
            (plainHeader.match(/audiobook|print|ebook/g) ?? []).length,
            1,
            'one medium, named once',
        );
        eq(parseBookNote(serialiseBookNote(plain, '')).book.sessions[0].format, 'audio', 'round trips');
    });

    await describe('model: which media a session used, and how much in each', () => {
        const session = {
            id: 's1',
            format: 'print' as const,
            started: '2026-01-01',
            entries: [
                { date: '2026-01-02', fraction: 0.2, raw: { unit: 'percent' as const, value: 20 } },
                {
                    date: '2026-01-03',
                    fraction: 0.6,
                    raw: { unit: 'percent' as const, value: 60 },
                    format: 'audio' as const,
                },
                { date: '2026-01-04', fraction: 0.7, raw: { unit: 'percent' as const, value: 70 } },
            ],
        };

        eq(sessionFormats(session), ['print', 'audio'], 'media listed, session format first');

        const breakdown = formatBreakdown(session);
        eq(breakdown.length, 2, 'two media');
        eq(breakdown[0].format, 'audio', 'sorted by how much ground each covered');
        ok(Math.abs(breakdown[0].share - 0.4) < 0.001, 'audio covered 20% to 60%');
        ok(Math.abs(breakdown[1].share - 0.3) < 0.001, 'print covered 0-20% and 60-70%');

        // Going back over ground already covered credits nobody: this measures
        // the book, not the effort.
        const backtrack = {
            ...session,
            entries: [
                { date: '2026-01-02', fraction: 0.5, raw: { unit: 'percent' as const, value: 50 } },
                {
                    date: '2026-01-03',
                    fraction: 0.3,
                    raw: { unit: 'percent' as const, value: 30 },
                    format: 'audio' as const,
                },
            ],
        };
        const b2 = formatBreakdown(backtrack);
        eq(b2.length, 1, 're-reading earlier pages in another medium adds no share');
        eq(b2[0].format, 'print', 'only the ground actually gained counts');

        eq(formatBreakdown({ ...session, entries: [] }), [], 'no entries, no breakdown');
    });
}
