// Dogear — tests for the CSV export.
//
// The export is Goodreads-shaped so other trackers can read it, and the
// importer already understands that shape — so the strongest test here is a
// round trip: what goes out must come back in with nothing silently lost.

import {
    EXPORT_COLUMNS,
    armourIsbn,
    bookToRow,
    exportLibraryCsv,
    exportTitle,
    formatCsvField,
    isoToGoodreadsDate,
    lastFinishedDate,
    statusToShelf,
} from '../src/exportcsv';
import { importGoodreadsCsv, goodreadsToBook } from '../src/goodreads';
import { SCHEMA_VERSION, type Book } from '../src/model';

interface Harness {
    describe: (name: string, fn: () => void | Promise<void>) => Promise<void>;
    ok: (cond: boolean, msg: string) => void;
    eq: <T>(actual: T, expected: T, msg: string) => void;
    close: (actual: number, expected: number, msg: string) => void;
}

function makeBook(overrides: Partial<Book>): Book {
    return {
        schemaVersion: SCHEMA_VERSION,
        title: 'The Power Broker',
        authors: ['Robert A. Caro'],
        tags: [],
        metrics: {},
        status: 'want-to-read',
        sessions: [],
        ...overrides,
    };
}

export async function runExportTests({ describe, ok, eq }: Harness): Promise<void> {
    await describe('export: RFC 4180 field quoting', () => {
        eq(formatCsvField('plain'), 'plain', 'plain text passes through');
        eq(formatCsvField('a, b'), '"a, b"', 'commas force quoting');
        eq(formatCsvField('He said "hi"'), '"He said ""hi"""', 'quotes are doubled');
        eq(formatCsvField('line one\nline two'), '"line one\nline two"', 'newlines force quoting');
        eq(formatCsvField(''), '', 'empty stays empty');
    });

    await describe('export: small mappings', () => {
        eq(statusToShelf('finished'), 'read', 'finished becomes read');
        eq(statusToShelf('reading'), 'currently-reading', 'reading becomes currently-reading');
        eq(statusToShelf('want-to-read'), 'to-read', 'want-to-read becomes to-read');
        eq(statusToShelf('dnf'), 'dnf', 'dnf stays dnf');

        eq(isoToGoodreadsDate('2024-03-12'), '2024/03/12', 'ISO date becomes Goodreads date');
        eq(armourIsbn('0060512750'), '="0060512750"', 'ISBN gets Excel armour');
        eq(armourIsbn(undefined), '', 'missing ISBN stays blank');

        eq(
            exportTitle(makeBook({ series: 'The Locked Tomb', seriesPosition: 1 })),
            'The Power Broker (The Locked Tomb #1)',
            'series and position embedded in the title',
        );
        eq(
            exportTitle(makeBook({ series: 'The Locked Tomb' })),
            'The Power Broker',
            'series without a position is left out rather than mangled',
        );
    });

    await describe('export: the read date is the most recent finish', () => {
        const book = makeBook({
            status: 'finished',
            sessions: [
                { id: 's1', format: 'print', finished: '2020-02-01', entries: [] },
                { id: 's2', format: 'audio', finished: '2024-03-12', entries: [] },
            ],
        });
        eq(lastFinishedDate(book), '2024-03-12', 'later session wins');

        const abandoned = makeBook({
            sessions: [
                { id: 's1', format: 'print', finished: '2020-02-01', entries: [] },
                {
                    id: 's2',
                    format: 'print',
                    entries: [],
                    abandoned: { fraction: 0.4, reason: 'dull' },
                },
            ],
        });
        eq(lastFinishedDate(abandoned), '2020-02-01', 'an abandonment is not a finish');
        eq(lastFinishedDate(makeBook({})), undefined, 'no sessions means no date');
    });

    await describe('export: a full row', () => {
        const book = makeBook({
            title: 'The Dispossessed',
            authors: ['Ursula K. Le Guin', 'Someone Else'],
            isbn10: '0060512750',
            isbn13: '9780060512750',
            publisher: 'Harper',
            published: '1974',
            tags: ['sci-fi', 'favourites'],
            metrics: { pages: 387 },
            rating: 3.75,
            status: 'finished',
            sessions: [
                { id: 's1', format: 'print', started: '2024-01-02', finished: '2024-03-12', entries: [] },
                { id: 's2', format: 'audio', started: '2025-01-01', finished: '2025-02-01', entries: [] },
            ],
        });
        const row = bookToRow(book);
        eq(row.length, EXPORT_COLUMNS.length, 'one cell per column');

        const cell = (name: string): string => row[EXPORT_COLUMNS.indexOf(name as (typeof EXPORT_COLUMNS)[number])];
        eq(cell('Title'), 'The Dispossessed', 'title');
        eq(cell('Author'), 'Ursula K. Le Guin', 'first author');
        eq(cell('Additional Authors'), 'Someone Else', 'remaining authors');
        eq(cell('ISBN'), '="0060512750"', 'armoured ISBN10');
        eq(cell('ISBN13'), '="9780060512750"', 'armoured ISBN13');
        eq(cell('My Rating'), '3.75', 'rating');
        eq(cell('Number of Pages'), '387', 'page count');
        eq(cell('Date Read'), '2025/02/01', 'most recent finish date, Goodreads style');
        eq(cell('Bookshelves'), 'sci-fi, favourites', 'tags as shelves');
        eq(cell('Exclusive Shelf'), 'read', 'status as exclusive shelf');
        eq(cell('Read Count'), '2', 'both completed reads counted');
        eq(cell('My Review'), '', 'prose is never squeezed into the CSV');
    });

    await describe('export: the document', () => {
        const csv = exportLibraryCsv([
            makeBook({ title: 'Zulu Title' }),
            makeBook({ title: 'Alpha Title' }),
        ]);
        const lines = csv.trim().split('\n');
        eq(lines.length, 3, 'header plus one line per book');
        eq(lines[0], EXPORT_COLUMNS.join(','), 'header lists the columns');
        // The first cell is the (blank) Book Id, so the title comes second.
        ok(lines[1].startsWith(',Alpha Title'), 'sorted by title');
        ok(lines[2].startsWith(',Zulu Title'), 'second book follows the sort');
        ok(csv.endsWith('\n'), 'file ends with a newline');

        eq(exportLibraryCsv([]).trim(), EXPORT_COLUMNS.join(','), 'empty library is header only');

        const unrated = exportLibraryCsv([makeBook({})]);
        ok(unrated.split('\n')[1].includes(',0,'), 'unrated exports 0, the Goodreads convention');
    });

    await describe('export: round trip through the importer', () => {
        const sources = [
            {
                title: 'Gideon the Ninth (The Locked Tomb #1)',
                authors: ['Tamsyn Muir'],
                isbn13: '9781250313195',
                publisher: 'Tor',
                published: '2019',
                pages: 462,
                rating: 5,
                tags: ['sci-fi'],
                readCount: 1,
                warnings: [],
                status: 'finished' as const,
                dateRead: '2024-03-12',
            },
            {
                title: 'Dune',
                authors: ['Frank Herbert', 'Brian Herbert'],
                isbn13: '9780441013593',
                pages: 604,
                rating: 3.75,
                tags: [],
                readCount: 1,
                warnings: [],
                status: 'reading' as const,
                dateAdded: '2025-06-01',
            },
            {
                title: 'Ulysses',
                authors: ['James Joyce'],
                tags: ['classics'],
                readCount: 1,
                warnings: [],
                status: 'dnf' as const,
            },
            {
                title: 'Some TBR Book',
                authors: ['Anon'],
                tags: [],
                readCount: 1,
                warnings: [],
                status: 'want-to-read' as const,
            },
        ];

        const books = sources.map((s) => goodreadsToBook(s, 'print').book);
        const back = importGoodreadsCsv(exportLibraryCsv(books));

        eq(back.books.length, 4, 'every book comes back');
        eq(back.skipped, 0, 'nothing dropped');

        const gideon = back.books.find((b) => b.title === 'Gideon the Ninth (The Locked Tomb #1)');
        ok(gideon !== undefined, 'exported title with embedded series comes back');
        eq(gideon?.authors, ['Tamsyn Muir'], 'author survives');
        eq(gideon?.isbn13, '9781250313195', 'ISBN survives de-armouring');
        eq(gideon?.rating, 5, 'rating survives');
        eq(gideon?.status, 'finished', 'finished survives');
        eq(gideon?.dateRead, '2024-03-12', 'read date survives');
        eq(gideon?.pages, 462, 'page count survives');
        eq(gideon?.tags, ['sci-fi'], 'tags survive');
        eq(gideon?.publisher, 'Tor', 'publisher survives');
        eq(gideon?.published, '2019', 'year survives');

        // The importer hands the embedded series to goodreadsToBook to split.
        if (gideon) {
            const { book } = goodreadsToBook(gideon, 'print');
            eq(book.title, 'Gideon the Ninth', 'series split back out of the title');
            eq(book.series, 'The Locked Tomb', 'series name recovered');
            eq(book.seriesPosition, 1, 'series position recovered');
        }

        const dune = back.books.find((b) => b.title === 'Dune');
        eq(dune?.status, 'reading', 'reading survives');
        eq(dune?.rating, 3.75, 'quarter-star rating survives');
        eq(dune?.authors, ['Frank Herbert', 'Brian Herbert'], 'co-authors survive');

        const ulysses = back.books.find((b) => b.title === 'Ulysses');
        eq(ulysses?.status, 'dnf', 'dnf survives');

        const tbr = back.books.find((b) => b.title === 'Some TBR Book');
        eq(tbr?.status, 'want-to-read', 'want-to-read survives');
    });
}
