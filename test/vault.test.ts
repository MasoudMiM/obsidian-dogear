// Dogear — tests for paths, settings and the repository layer.

import {
    sanitiseFilename,
    sanitiseTag,
    sanitiseTags,
    normaliseFolder,
    renderFilenameTemplate,
    buildNotePath,
    uniquePath,
    basenameOf,
    MAX_BASENAME,
} from '../src/paths';

import {
    DEFAULT_SETTINGS,
    normaliseSettings,
    templateHasPlaceholder,
    cleanHeading,
} from '../src/settings';

import {
    importGoodreadsCsv,
    goodreadsToBook,
    duplicateKey,
    isIsoDate,
    looksLikeGoodreadsExport,
    splitSeriesFromTitle,
} from '../src/goodreads';
import { ProviderChain } from '../src/providers/chain';
import {
    sortBooks,
    filterBooks,
    lastActivity,
    foldAccents,
    coverCandidates,
    upgradeCoverUrl,
    isRemoteCover,
    normaliseCoverInput,
} from '../src/library';
import { coverUrlFromIsbn } from '../src/openlibrary';
import {
    computeStats,
    finishYear,
    finishMonth,
    lengthBand,
    yearsPresent,
    describeListening,
} from '../src/stats';
import {
    coverFilename,
    planCoverDownloads,
    partitionJobs,
    joinPath,
    looksLikeRealImage,
    estimateSeconds,
    describeDuration,
} from '../src/covers';
import type { BookProvider } from '../src/providers/types';
import {
    BookRepository,
    startReread,
    type VaultLike,
    startSession,
    logProgress,
    finishSession,
    abandonSession,
    applyStatus,
} from '../src/repository';

import { SCHEMA_VERSION, type Book, type ReadingStatus } from '../src/model';
import { splitNote, joinNote, parseYaml, stringifyYaml, type YamlMap } from '../src/yaml';
import { KEY_ORDER } from '../src/note';
import type { Harness } from './note.test';

// --- in-memory vault --------------------------------------------------------

/**
 * Stands in for Obsidian's vault. `processFrontMatter` mimics Obsidian's
 * behaviour: it hands over a parsed object, and rewrites the YAML itself.
 */
class FakeVault implements VaultLike {
    files = new Map<string, string>();
    folders = new Set<string>();
    /** Records the order of operations, so we can assert write behaviour. */
    ops: string[] = [];

    exists(path: string): boolean {
        return this.files.has(path);
    }
    async read(path: string): Promise<string> {
        this.ops.push(`read:${path}`);
        const v = this.files.get(path);
        if (v === undefined) throw new Error(`no such file: ${path}`);
        return v;
    }
    async create(path: string, content: string): Promise<void> {
        if (this.files.has(path)) throw new Error(`already exists: ${path}`);
        this.ops.push(`create:${path}`);
        this.files.set(path, content);
    }
    async process(path: string, fn: (content: string) => string): Promise<void> {
        this.ops.push(`process:${path}`);
        const current = this.files.get(path);
        if (current === undefined) throw new Error(`no such file: ${path}`);
        this.files.set(path, fn(current));
    }
    async processFrontMatter(path: string, fn: (fm: YamlMap) => void): Promise<void> {
        this.ops.push(`frontmatter:${path}`);
        const current = this.files.get(path);
        if (current === undefined) throw new Error(`no such file: ${path}`);
        const { frontmatter, body } = splitNote(current);
        const map = parseYaml(frontmatter);
        fn(map);
        this.files.set(path, joinNote(stringifyYaml(map, KEY_ORDER), body));
    }
    async ensureFolder(path: string): Promise<void> {
        this.folders.add(path);
    }
    listNotes(folder: string): string[] {
        const prefix = folder === '' ? '' : `${folder}/`;
        return [...this.files.keys()]
            .filter((p) => p.startsWith(prefix) && p.endsWith('.md'))
            .sort();
    }
}

function makeBook(over: Partial<Book> = {}): Book {
    return {
        schemaVersion: SCHEMA_VERSION,
        title: 'The Dispossessed',
        authors: ['Ursula K. Le Guin'],
        tags: [],
        metrics: { pages: 387 },
        status: 'want-to-read',
        sessions: [],
        ...over,
    };
}

export async function runVaultTests(h: Harness): Promise<void> {
    const { describe, ok, eq } = h;

    // --- filenames ----------------------------------------------------------

    await describe('paths: filename sanitisation', () => {
        eq(sanitiseFilename('The Dispossessed'), 'The Dispossessed', 'clean title untouched');
        eq(
            sanitiseFilename('The Dispossessed: An Ambiguous Utopia'),
            'The Dispossessed - An Ambiguous Utopia',
            'colon becomes a dash, not deleted',
        );
        eq(
            sanitiseFilename('Cloud Atlas / Ghostwritten'),
            'Cloud Atlas - Ghostwritten',
            'slash becomes a dash so words do not run together',
        );
        eq(
            sanitiseFilename("Who's Afraid of Virginia Woolf?"),
            "Who's Afraid of Virginia Woolf",
            'question mark removed, apostrophe kept',
        );
        eq(sanitiseFilename('Say "Hello"'), 'Say Hello', 'double quotes removed');
        eq(sanitiseFilename('Chapter #1'), 'Chapter 1', 'hash removed (breaks wikilinks)');
        eq(sanitiseFilename('Notes [draft]'), 'Notes draft', 'square brackets removed');
        eq(sanitiseFilename('Power^Up'), 'PowerUp', 'caret removed (breaks block refs)');
        eq(sanitiseFilename('a|b'), 'a - b', 'pipe treated as a separator');
        eq(sanitiseFilename('Nineteen Eighty-Four'), 'Nineteen Eighty-Four', 'real hyphens preserved');
        eq(sanitiseFilename('...'), 'Untitled', 'punctuation-only name falls back');
        eq(sanitiseFilename('  padded  '), 'padded', 'outer whitespace trimmed');
        eq(sanitiseFilename('trailing.'), 'trailing', 'trailing dot removed (Windows)');
        eq(sanitiseFilename('.hidden'), 'hidden', 'leading dot removed (unix hidden file)');
        eq(sanitiseFilename('a   b'), 'a b', 'runs of whitespace collapsed');
        eq(sanitiseFilename(''), 'Untitled', 'empty name gets a fallback');
        eq(sanitiseFilename('///'), 'Untitled', 'name of only separators gets a fallback');
        eq(sanitiseFilename('CON'), 'CON (book)', 'Windows reserved name made safe');
        eq(sanitiseFilename('nul'), 'nul (book)', 'reserved name check is case-insensitive');
        ok(sanitiseFilename('x'.repeat(400)).length <= MAX_BASENAME, 'long name truncated');
        eq(sanitiseFilename('Émigré 日本語'), 'Émigré 日本語', 'unicode preserved');

        // Control characters must not reach the filesystem.
        eq(sanitiseFilename('bad\u0000name'), 'badname', 'null byte stripped');
        eq(sanitiseFilename('tab\tseparated'), 'tab separated', 'tab normalised to a space');
    });

    await describe('paths: folders and full paths', () => {
        eq(normaliseFolder('Books'), 'Books', 'plain folder');
        eq(normaliseFolder('/Books/'), 'Books', 'leading and trailing slashes removed');
        eq(normaliseFolder('Books//Fiction'), 'Books/Fiction', 'empty segment removed');
        eq(normaliseFolder('  Books / Fiction '), 'Books/Fiction', 'segments trimmed');
        eq(normaliseFolder(''), '', 'empty means vault root');
        eq(normaliseFolder('./Books'), 'Books', 'current-directory segment dropped');

        eq(buildNotePath('Books', 'Dune'), 'Books/Dune.md', 'path built');
        eq(buildNotePath('', 'Dune'), 'Dune.md', 'root path has no leading slash');
        eq(buildNotePath('Books', 'A: B'), 'Books/A - B.md', 'basename sanitised in path');
        eq(basenameOf('Books/Dune.md'), 'Dune', 'basename extracted');
        eq(basenameOf('Dune.md'), 'Dune', 'basename without folder');
    });

    await describe('paths: filename templates', () => {
        const ctx = {
            title: 'The Dispossessed',
            authors: ['Ursula K. Le Guin', 'Someone Else'],
            published: '2003',
            series: 'Hainish Cycle',
        };
        eq(
            renderFilenameTemplate('{{title}} - {{author}}', ctx),
            'The Dispossessed - Ursula K. Le Guin',
            'title and first author',
        );
        eq(renderFilenameTemplate('{{title}}', ctx), 'The Dispossessed', 'title only');
        eq(
            renderFilenameTemplate('{{title}} ({{year}})', ctx),
            'The Dispossessed (2003)',
            'year extracted from publication date',
        );
        eq(
            renderFilenameTemplate('{{authors}}', ctx),
            'Ursula K. Le Guin, Someone Else',
            'all authors joined',
        );
        eq(renderFilenameTemplate('{{series}} - {{title}}', ctx), 'Hainish Cycle - The Dispossessed', 'series');

        // The important case: a missing value must not leave dangling punctuation.
        const noAuthor = { title: 'Beowulf', authors: [] };
        eq(
            renderFilenameTemplate('{{title}} - {{author}}', noAuthor),
            'Beowulf',
            'dangling separator removed when the author is unknown',
        );
        eq(
            renderFilenameTemplate('{{title}} ({{year}})', noAuthor),
            'Beowulf',
            'empty parentheses removed when the year is unknown',
        );
        eq(
            renderFilenameTemplate('{{author}} - {{title}}', noAuthor),
            'Beowulf',
            'leading separator removed too',
        );
        eq(
            renderFilenameTemplate('{{title}} {{nonsense}}', noAuthor),
            'Beowulf {{nonsense}}',
            'unknown placeholder left visible rather than silently blanked',
        );
        eq(templateHasPlaceholder('{{title}}'), true, 'placeholder detected');
        eq(templateHasPlaceholder('static'), false, 'static template detected');
    });

    await describe('paths: collision handling', () => {
        const taken = new Set(['Books/Dune.md', 'Books/Dune (2).md']);
        eq(
            uniquePath('Books', 'Dune', (p) => taken.has(p)),
            'Books/Dune (3).md',
            'skips existing numbered variants',
        );
        eq(
            uniquePath('Books', 'Fresh', (p) => taken.has(p)),
            'Books/Fresh.md',
            'no suffix when free',
        );
        // Two different books with the same title must both be storable.
        const one = uniquePath('Books', 'Ulysses', () => false);
        eq(one, 'Books/Ulysses.md', 'first copy takes the plain name');
    });

    await describe('paths: catalogue subjects become valid tags', () => {
        // Obsidian tags cannot contain spaces, and writing raw subjects into
        // the `tags` property produced entries the Properties panel showed as
        // broken — worse than having no tags at all.
        eq(sanitiseTag('City planning'), 'City-planning', 'spaces become hyphens');
        eq(sanitiseTag('Science fiction'), 'Science-fiction', 'ordinary subject');
        eq(
            sanitiseTag('Biography & Autobiography'),
            'Biography-Autobiography',
            'ampersand does not run words together',
        );
        eq(sanitiseTag('Moses, Robert'), 'Moses-Robert', 'comma handled');
        eq(sanitiseTag('  padded  '), 'padded', 'whitespace trimmed');
        eq(sanitiseTag('already-fine'), 'already-fine', 'valid tag untouched');
        eq(sanitiseTag('nested/tag'), 'nested/tag', 'nested tags are legal and preserved');
        eq(sanitiseTag('Émigré'), 'Émigré', 'unicode letters kept');
        eq(sanitiseTag('---'), undefined, 'punctuation-only subject dropped');
        eq(sanitiseTag(''), undefined, 'empty dropped');
        eq(sanitiseTag('1974'), undefined, 'a digits-only tag is invalid in Obsidian');
        eq(sanitiseTag('!!!'), undefined, 'symbols-only dropped');

        eq(
            sanitiseTags(['City planning', 'city  planning', 'Utopias']),
            ['City-planning', 'Utopias'],
            'duplicates removed case-insensitively',
        );
        eq(sanitiseTags(['1974', '']), [], 'unusable subjects produce no tags at all');
    });

    // --- settings -----------------------------------------------------------

    await describe('settings: normalisation', () => {
        eq(normaliseSettings(undefined), DEFAULT_SETTINGS, 'undefined yields defaults');
        eq(normaliseSettings({}), DEFAULT_SETTINGS, 'empty object yields defaults');
        eq(normaliseSettings(null), DEFAULT_SETTINGS, 'null yields defaults');

        const partial = normaliseSettings({ booksFolder: 'Library' });
        eq(partial.booksFolder, 'Library', 'provided value kept');
        eq(partial.filenameTemplate, DEFAULT_SETTINGS.filenameTemplate, 'missing field defaulted');

        eq(
            normaliseSettings({ filenameTemplate: '   ' }).filenameTemplate,
            DEFAULT_SETTINGS.filenameTemplate,
            'blank template rejected (would name every note Untitled)',
        );
        eq(
            normaliseSettings({ defaultFormat: 'papyrus' }).defaultFormat,
            'print',
            'invalid format rejected',
        );
        eq(normaliseSettings({ defaultFormat: 'audio' }).defaultFormat, 'audio', 'valid format kept');
        eq(normaliseSettings({ cacheHours: 0 }).cacheHours, 1, 'cache clamped to a polite minimum');
        eq(normaliseSettings({ cacheHours: 99999 }).cacheHours, 720, 'cache clamped to a maximum');
        eq(normaliseSettings({ cacheHours: 'lots' }).cacheHours, 24, 'non-numeric cache rejected');
        eq(
            normaliseSettings({ preferredLanguage: 'FRE' }).preferredLanguage,
            'fre',
            'language lowercased',
        );
        eq(
            normaliseSettings({ preferredLanguage: 'nonsense' }).preferredLanguage,
            'eng',
            'invalid language code rejected',
        );
        eq(normaliseSettings({ openOnCreate: false }).openOnCreate, false, 'boolean respected');
    });

    // --- repository ---------------------------------------------------------

    await describe('repository: creating a book note', async () => {
        const vault = new FakeVault();
        const repo = new BookRepository(vault, () => DEFAULT_SETTINGS);

        const result = await repo.create(makeBook());
        eq(result.path, 'Books/The Dispossessed - Ursula K. Le Guin.md', 'path from template');
        ok(vault.folders.has('Books'), 'books folder ensured');

        const content = vault.files.get(result.path) as string;
        ok(content.includes('## Reading log'), 'log section created');
        ok(content.includes('title: The Dispossessed'), 'frontmatter written');
        ok(content.includes('dogear: 1'), 'schema version stamped');

        // Frontmatter must be written through processFrontMatter, not baked in.
        ok(
            vault.ops.includes(`frontmatter:${result.path}`),
            'frontmatter written via processFrontMatter, as the guidelines require',
        );

        const loaded = await repo.load(result.path);
        eq(loaded?.title, 'The Dispossessed', 'book reads back');
        eq(loaded?.metrics.pages, 387, 'metrics read back');
    });

    await describe('repository: notes never contain a broken tag', async () => {
        const vault = new FakeVault();
        const repo = new BookRepository(vault, () => DEFAULT_SETTINGS);
        const { path } = await repo.create(
            makeBook({ tags: ['City planning', 'Biography & Autobiography', '1974'] }),
        );
        const content = vault.files.get(path) as string;
        ok(content.includes('City-planning'), 'subject written as a valid tag');
        ok(!content.includes('City planning'), 'the raw spaced version is not written');
        ok(!/^\s+- 1974$/m.test(content), 'a digits-only subject is dropped');
    });

    await describe('repository: new notes carry the control panel', async () => {
        const vault = new FakeVault();
        const repo = new BookRepository(vault, () => DEFAULT_SETTINGS);
        const { path } = await repo.create(makeBook());
        const content = vault.files.get(path) as string;
        // Without this block there is no graphical way to log progress.
        ok(content.includes('```dogear'), 'the control block is inserted');
        ok(
            content.indexOf('```dogear') < content.indexOf('## Reading log'),
            'and appears above the log, so it is the first thing you see',
        );
    });

    await describe('repository: a reread is explicit, never a side effect', async () => {
        // Previously, logging progress against a finished book quietly created
        // "Read 2". Discovering your library thinks you read something twice
        // because you typed in the wrong box is not acceptable behaviour.
        const finished = makeBook({
            status: 'finished',
            sessions: [
                {
                    id: 's1',
                    format: 'print',
                    started: '2026-01-01',
                    finished: '2026-01-10',
                    entries: [],
                },
            ],
        });

        const reread = startReread(finished, 'audio', '2026-07-18');
        eq(reread.sessions.length, 2, 'a second session is created');
        eq(reread.status, 'reading', 'and the book is reading again');
        eq(reread.sessions[1].format, 'audio', 'the new format is used');
        eq(reread.sessions[1].started, '2026-07-18', 'started today');
        eq(reread.sessions[0].finished, '2026-01-10', 'the first read is left untouched');
    });

    await describe('repository: new notes include a place to write', async () => {
        const vault = new FakeVault();
        const repo = new BookRepository(vault, () => DEFAULT_SETTINGS);
        const { path } = await repo.create(makeBook());
        const content = vault.files.get(path) as string;
        ok(content.includes('## Notes'), 'a Notes heading is offered');
        ok(
            content.indexOf('## Reading log') < content.indexOf('## Notes'),
            'below the log, since notes grow and the log stays compact',
        );
    });

    await describe('repository: user writing under Notes is never touched', async () => {
        const vault = new FakeVault();
        const repo = new BookRepository(vault, () => DEFAULT_SETTINGS);
        const { path } = await repo.create(makeBook());

        // Simulate the reader actually using the section.
        const original = vault.files.get(path) as string;
        const written = original.replace(
            '## Notes\n',
            '## Notes\n\nCaro spends 200 pages on a single parkway and it is riveting.\n\n### Chapter thoughts\n\n- Jones Beach\n',
        );
        vault.files.set(path, written);

        // Now save through Dogear, several times.
        const loaded = await repo.load(path);
        ok(loaded !== null, 'note reloads');
        await repo.save(path, { ...loaded!, rating: 4.5 });
        await repo.save(path, { ...loaded!, rating: 3 });

        const after = vault.files.get(path) as string;
        ok(after.includes('Caro spends 200 pages on a single parkway'), 'prose preserved');
        ok(after.includes('### Chapter thoughts'), 'sub-headings preserved');
        ok(after.includes('- Jones Beach'), 'lists preserved');
    });

    await describe('goodreads: a whole export lands in the vault', async () => {
        // End to end: the founding use case, from raw CSV to book notes.
        // The ISBN columns use Goodreads' real =""..."" Excel-formula wrapping.
        const csv = [
            'Book Id,Title,Author,Author l-f,Additional Authors,ISBN,ISBN13,My Rating,Average Rating,Publisher,Binding,Number of Pages,Year Published,Original Publication Year,Date Read,Date Added,Bookshelves,Exclusive Shelf,My Review,Private Notes,Read Count',
            '1,"The Power Broker","Robert A. Caro","Caro, Robert A.",,"=""0394480767""","=""9780394480763""",5,4.5,Knopf,Hardcover,1246,1974,1974,2024/03/12,2023/01/02,"history, nyc",read,"Astonishing.","Lent to Sam.",1',
            '2,"The Dispossessed","Ursula K. Le Guin","Le Guin, Ursula K.",,"=""0060512750""","=""9780060512750""",4,4.2,Harper,Paperback,387,2003,1974,,2024/06/01,"sci-fi",currently-reading,,,1',
            '3,"Some Doorstop","A Writer","Writer, A",,"=""""","=""""",0,3.9,,Paperback,,2010,,,2020/05/05,,to-read,,,1',
            '4,"Read Twice","Someone","Someone",,"=""""","=""""",3,3.5,,Paperback,200,2001,,2022/08/08,2021/01/01,,read,,,4',
            '5,"",,"",,"=""""","=""""",0,0,,,,,,,,,to-read,,,1',
        ].join('\n');

        const summary = importGoodreadsCsv(csv);
        eq(summary.books.length, 4, 'four usable rows');
        eq(summary.skipped, 1, 'the titleless row is dropped');
        eq(summary.counts['reread-history-lost'], 1, 'the four-times read is flagged');

        const vault = new FakeVault();
        const repo = new BookRepository(vault, () => DEFAULT_SETTINGS);

        for (const gb of summary.books) {
            const { book, notes } = goodreadsToBook(gb, 'print');
            await repo.create(book, notes);
        }

        const all = await repo.all();
        eq(all.length, 4, 'four notes created');

        const caro = all.find((b) => b.book.title === 'The Power Broker');
        ok(caro !== undefined, 'the finished book exists');
        eq(caro?.book.status, 'finished', 'status mapped from the shelf');
        eq(caro?.book.rating, 5, 'rating carried');
        eq(caro?.book.metrics.pages, 1246, 'page count carried');
        eq(caro?.book.isbn13, '9780394480763', 'ISBN unwrapped from the Excel formula');
        eq(caro?.book.sessions[0].finished, '2024-03-12', 'read date became a finished session');

        // The review must survive as prose, and survive later saves.
        const caroText = vault.files.get(caro!.path) as string;
        ok(caroText.includes('Astonishing.'), 'the review is in the note body');
        ok(caroText.includes('Lent to Sam.'), 'private notes too');
        await repo.save(caro!.path, { ...caro!.book, rating: 4 });
        const afterSave = vault.files.get(caro!.path) as string;
        ok(afterSave.includes('Astonishing.'), 'and is untouched by a later save');

        const leguin = all.find((b) => b.book.title === 'The Dispossessed');
        eq(leguin?.book.status, 'reading', 'currently-reading mapped');
        eq(leguin?.book.sessions.length, 1, 'with an open session');
        eq(leguin?.book.sessions[0].finished, undefined, 'not finished');

        const doorstop = all.find((b) => b.book.title === 'Some Doorstop');
        eq(doorstop?.book.status, 'want-to-read', 'to-read mapped');
        eq(doorstop?.book.sessions.length, 0, 'and gets no session');
        eq(doorstop?.book.rating, undefined, 'a Goodreads 0 is not a zero-star rating');

        const twice = all.find((b) => b.book.title === 'Read Twice');
        const twiceText = vault.files.get(twice!.path) as string;
        ok(twiceText.includes('4 reads'), 'the lost reread history is admitted in the note');

        // Re-importing the same file must not double the library.
        const seen = new Set(all.map((e) => duplicateKey(e.book)));
        const wouldCreate = summary.books.filter((gb) => !seen.has(duplicateKey(gb)));
        eq(wouldCreate.length, 0, 'a second import of the same export adds nothing');
    });

    // --- hardening: findings from adversarial probing -----------------------

    await describe('hardening: a review that mimics Dogear\'s own markup', async () => {
        // The worst realistic case for data loss. Someone's Goodreads review
        // contains a horizontal rule, a code fence, or a line that looks like
        // a session header — and the parser must not absorb any of it as data
        // or lose any of it on save.
        const prose = [
            '## Reading log',
            '',
            '### Read 99 — audio · 1999-01-01 → 1999-12-31',
            '- 1999-01-01 · 10%',
            '',
            'Real review text that must survive.',
            '',
            '---',
            '',
            '```dogear',
            '```',
            '',
            '## Notes',
            'Nested duplicate heading.',
        ].join('\n');

        const vault = new FakeVault();
        const repo = new BookRepository(vault, () => DEFAULT_SETTINGS);
        const { path } = await repo.create(makeBook({ title: 'Adversarial' }), prose);

        const loaded = await repo.load(path);
        ok(loaded !== null, 'the note still parses');
        eq(loaded?.sessions.length, 0, 'the fake session header was not absorbed as real data');

        // Three saves, because corruption often appears only on the second.
        await repo.save(path, { ...loaded!, rating: 4 });
        await repo.save(path, { ...loaded!, rating: 3 });
        await repo.save(path, { ...loaded!, rating: 5 });

        const after = vault.files.get(path) as string;
        const missing = prose
            .split('\n')
            .filter((line) => line.trim() !== '' && !after.includes(line));
        eq(missing, [], 'every non-empty line of the review survived three saves');
    });

    await describe('hardening: saving repeatedly changes nothing', async () => {
        const vault = new FakeVault();
        const repo = new BookRepository(vault, () => DEFAULT_SETTINGS);
        const { path } = await repo.create(
            makeBook({
                title: 'Stable',
                metrics: { pages: 300 },
                sessions: [
                    {
                        id: 's1',
                        format: 'print',
                        started: '2026-01-01',
                        entries: [
                            { date: '2026-01-02', fraction: 0.5, raw: { unit: 'page', value: 150 } },
                        ],
                    },
                ],
            }),
            'A review.',
        );

        await repo.save(path, (await repo.load(path))!);
        const first = vault.files.get(path) as string;
        await repo.save(path, (await repo.load(path))!);
        const second = vault.files.get(path) as string;
        await repo.save(path, (await repo.load(path))!);
        const third = vault.files.get(path) as string;

        eq(first, second, 'a second save is byte-identical');
        eq(second, third, 'and so is a third — no drift, no growth');
    });

    await describe('hardening: the log heading setting rejects markdown hashes', () => {
        // Typing "## Reading log" into the setting is the obvious thing to do,
        // since that is what the note shows. It produced "## ## Reading log",
        // which then failed to match the existing section and orphaned the log.
        eq(cleanHeading('## Reading log'), 'Reading log', 'hashes stripped');
        eq(cleanHeading('# Log'), 'Log', 'a single hash too');
        eq(cleanHeading('###   Spaced'), 'Spaced', 'and the spacing after them');
        eq(cleanHeading('  ## Padded  '), 'Padded', 'with surrounding whitespace');
        eq(cleanHeading('Reading log'), 'Reading log', 'plain text is untouched');
        eq(cleanHeading('C# Programming'), 'C# Programming', 'a hash mid-word is not a heading');

        eq(
            normaliseSettings({ logHeading: '## Reading log' }).logHeading,
            'Reading log',
            'settings normalise it on the way in',
        );
        eq(
            normaliseSettings({ logHeading: '###' }).logHeading,
            DEFAULT_SETTINGS.logHeading,
            'a heading of nothing but hashes falls back to the default',
        );
    });

    await describe('hardening: every status transition, applied twice', () => {
        const statuses: ReadingStatus[] = ['want-to-read', 'reading', 'finished', 'dnf'];
        for (const from of statuses) {
            for (const to of statuses) {
                let book = applyStatus(makeBook({ sessions: [] }), from, '2026-01-01', 'print');
                book = applyStatus(book, to, '2026-02-01', 'print');
                const once = book.sessions.length;
                book = applyStatus(book, to, '2026-03-01', 'print');

                eq(book.status, to, `${from} → ${to} ends in the right status`);
                eq(
                    book.sessions.length,
                    once,
                    `${from} → ${to} clicked twice does not grow the history`,
                );
            }
        }
    });

    await describe('hardening: a source that never responds cannot hang the search', async () => {
        // Without a timeout, a stalled connection leaves the search spinning
        // forever with no error and no way to reach the next source.
        const hanging: BookProvider = {
            id: 'hang',
            label: 'Stalled Source',
            attribution: '',
            search: () => new Promise<never>(() => {}),
            resolve: async () => ({ title: '', authors: [], tags: [], source: 'hang' }),
        };
        const working: BookProvider = {
            id: 'ok',
            label: 'Working Source',
            attribution: '',
            search: async () => [
                { providerId: 'ok', id: '1', title: 'Found', authors: [], tags: [], complete: true },
            ],
            resolve: async () => ({ title: 'Found', authors: [], tags: [], source: 'ok' }),
        };

        const chain = new ProviderChain(() => [hanging, working], 50);
        const result = await chain.search('x');
        eq(result.usedProvider, 'ok', 'the chain moves past the stalled source');
        ok(
            result.failures.some((f) => /did not respond/.test(f.reason)),
            'and says plainly that it timed out',
        );

        const onlyHang = new ProviderChain(() => [hanging], 50);
        let err: Error | null = null;
        try {
            await onlyHang.search('x');
        } catch (e) {
            err = e as Error;
        }
        ok(err !== null, 'a lone stalled source produces an error rather than silence');
        ok(/50ms/.test(err?.message ?? ''), 'sub-second timeouts are reported in ms, not "0s"');
    });

    await describe('hardening: a malformed import row cannot poison a note', () => {
        // goodreadsToBook is exported, so it must validate rather than trust.
        // An invalid date is the dangerous one: it writes fine, then fails to
        // parse back, silently losing the finish date.
        const { book } = goodreadsToBook(
            {
                title: 'X',
                authors: [],
                tags: [],
                readCount: 1,
                warnings: [],
                status: 'finished',
                rating: 99,
                pages: -5,
                dateRead: 'not-a-date',
            },
            'print',
        );
        eq(book.rating, 5, 'an out-of-range rating is clamped');
        eq(book.metrics.pages, undefined, 'a negative page count is dropped');
        eq(book.sessions[0].finished, undefined, 'an unparseable date is dropped, not written');

        eq(isIsoDate('2026-07-18'), true, 'a real date passes');
        eq(isIsoDate('2026-02-31'), false, 'a date that does not exist is rejected');
        eq(isIsoDate('2026-13-01'), false, 'month 13 rejected');
        eq(isIsoDate('18/07/2026'), false, 'the wrong format is rejected');
        eq(isIsoDate(undefined), false, 'missing is rejected');
    });

    await describe('goodreads: a real export from the wild', async () => {
        // This is an actual Goodreads export (from BookWyrm's test fixtures),
        // not something written to match the parser. It carries the full
        // 30-column header, the =""..."" Excel-formula ISBN wrapping, an empty
        // ISBN pair, additional authors, accented names, and a 0 rating.
        const csv = [
            'Book Id,Title,Author,Author l-f,Additional Authors,ISBN,ISBN13,My Rating,Average Rating,Publisher,Binding,Number of Pages,Year Published,Original Publication Year,Date Read,Date Added,Bookshelves,Bookshelves with positions,Exclusive Shelf,My Review,Spoiler,Private Notes,Read Count,Recommended For,Recommended By,Owned Copies,Original Purchase Date,Original Purchase Location,Condition,Condition Description',
            '42036538,Gideon the Ninth (The Locked Tomb #1),Tamsyn Muir,"Muir, Tamsyn",,"=""1250313198""","=""9781250313195""",3,4.20,Tor,Hardcover,448,2019,2019,2020/10/25,2020/10/21,,,read,,,,1,,,0,,,,,',
            '52691223,Subcutanean,Aaron A. Reed,"Reed, Aaron A.",,"=""""","=""""",0,4.45,,Paperback,232,2020,,2020/03/06,2020/03/05,,,read,,,,1,,,0,,,,,',
            '28694510,Patisserie at Home,Mélanie Dupuis,"Dupuis, Mélanie",Anne Cazor,"=""0062445316""","=""9780062445315""",2,4.60,Harper Design,Hardcover,288,2016,,,2019/07/08,,,read,"mixed feelings",,,2,,,0,,,,,',
        ].join('\n');

        ok(looksLikeGoodreadsExport(csv), 'recognised as a Goodreads export');
        const summary = importGoodreadsCsv(csv);
        eq(summary.books.length, 3, 'all three rows read');
        eq(summary.skipped, 0, 'none skipped');

        const [gideon, sub, pat] = summary.books;

        // The Excel-formula wrapping is the thing most naive parsers get wrong.
        eq(gideon.isbn10, '1250313198', 'ISBN-10 unwrapped from =""..."" ');
        eq(gideon.isbn13, '9781250313195', 'ISBN-13 unwrapped');
        eq(sub.isbn10, undefined, 'an empty =""""  becomes undefined, not a blank string');
        eq(sub.isbn13, undefined, 'same for ISBN-13');

        eq(gideon.pages, 448, 'page count read');
        eq(gideon.rating, 3, 'rating read');
        eq(gideon.dateRead, '2020-10-25', 'slash-separated date converted to ISO');

        // Goodreads writes 0 for unrated, which must not become zero stars.
        eq(sub.rating, undefined, 'a 0 rating means unrated');

        eq(pat.authors, ['Mélanie Dupuis', 'Anne Cazor'], 'additional authors merged, accents intact');
        eq(pat.dateRead, undefined, 'a missing read date stays missing');
        eq(pat.readCount, 2, 'read count captured');
        eq(summary.counts['missing-read-date'], 1, 'the missing date is reported');
        eq(summary.counts['reread-history-lost'], 1, 'and the unrecoverable reread history');

        // Goodreads has no series field; it hides the series in the title.
        const converted = goodreadsToBook(gideon, 'print');
        eq(converted.book.title, 'Gideon the Ninth', 'series stripped from the title');
        eq(converted.book.series, 'The Locked Tomb', 'series captured');
        eq(converted.book.seriesPosition, 1, 'position captured');

        const patBook = goodreadsToBook(pat, 'print');
        ok(patBook.notes.includes('mixed feelings'), 'the review is preserved');
        ok(patBook.notes.includes('2 reads'), 'and the lost reread history is admitted');

        // The whole thing must land in a vault without incident.
        const vault = new FakeVault();
        const repo = new BookRepository(vault, () => DEFAULT_SETTINGS);
        for (const gb of summary.books) {
            const { book, notes } = goodreadsToBook(gb, 'print');
            await repo.create(book, notes);
        }
        const all = await repo.all();
        eq(all.length, 3, 'three notes created from a real export');
        ok(
            all.some((b) => b.book.series === 'The Locked Tomb'),
            'series survives the round trip through a note',
        );
    });

    await describe('goodreads: series hidden in the title', () => {
        const cases: Array<[string, string, string | undefined, number | undefined]> = [
            ['Gideon the Ninth (The Locked Tomb #1)', 'Gideon the Ninth', 'The Locked Tomb', 1],
            ["Harry Potter and the Sorcerer's Stone (Harry Potter, #1)", "Harry Potter and the Sorcerer's Stone", 'Harry Potter', 1],
            ['The Fellowship of the Ring (The Lord of the Rings, #1)', 'The Fellowship of the Ring', 'The Lord of the Rings', 1],
            ['A Book (Series #2.5)', 'A Book', 'Series', 2.5],
            ['Some Omnibus (Series #1-3)', 'Some Omnibus', 'Series', 1],
        ];
        for (const [input, title, series, position] of cases) {
            const out = splitSeriesFromTitle(input);
            eq(out.title, title, `title cleaned: ${input}`);
            eq(out.series, series, `series found: ${input}`);
            eq(out.seriesPosition, position, `position found: ${input}`);
        }

        // A "#" is required, so ordinary parenthetical subtitles are untouched.
        const untouched = [
            'The Power Broker: Robert Moses and the Fall of New York (Urban studies & biography)',
            'A Book (no number here)',
            'Subcutanean',
            '(#1)',
            'Nested (Parens (Inside) #1)',
        ];
        for (const input of untouched) {
            const out = splitSeriesFromTitle(input);
            eq(out.title, input, `left alone: ${input}`);
            eq(out.series, undefined, `no series invented: ${input}`);
        }
    });

    await describe('library: sorting', () => {
        const e = (title: string, over: Partial<Book> = {}) => ({
            path: `Books/${title}.md`,
            book: makeBook({ title, ...over }),
        });

        const entries = [
            e('Beta', { authors: ['Zed Author'], rating: 3 }),
            e('Alpha', { authors: ['Adams, Ann'], rating: 5 }),
            e('Gamma', { authors: [], rating: undefined }),
        ];

        eq(
            sortBooks(entries, 'title').map((x) => x.book.title),
            ['Alpha', 'Beta', 'Gamma'],
            'by title',
        );
        eq(
            sortBooks(entries, 'author').map((x) => x.book.title),
            ['Alpha', 'Beta', 'Gamma'],
            'by author, with the authorless book last',
        );
        // An unrated book must not sort as if it were zero stars.
        eq(
            sortBooks(entries, 'rating').map((x) => x.book.title),
            ['Alpha', 'Beta', 'Gamma'],
            'by rating, unrated last rather than lowest',
        );

        // Case should not decide the order.
        const mixedCase = [e('banana'), e('Apple'), e('cherry')];
        eq(
            sortBooks(mixedCase, 'title').map((x) => x.book.title),
            ['Apple', 'banana', 'cherry'],
            'title sort ignores case',
        );

        eq(sortBooks([], 'title'), [], 'an empty library sorts fine');
    });

    await describe('library: most recent activity', () => {
        eq(lastActivity(makeBook({ sessions: [] })), '', 'a book with no history has none');

        eq(
            lastActivity(
                makeBook({
                    sessions: [
                        {
                            id: 's1',
                            format: 'print',
                            started: '2026-01-01',
                            finished: '2026-02-01',
                            entries: [
                                { date: '2026-01-15', fraction: 0.5, raw: { unit: 'percent', value: 50 } },
                            ],
                        },
                    ],
                }),
            ),
            '2026-02-01',
            'the latest of start, finish and every entry',
        );

        // An entry logged after the finish date still counts as activity.
        eq(
            lastActivity(
                makeBook({
                    sessions: [
                        {
                            id: 's1',
                            format: 'print',
                            started: '2026-01-01',
                            finished: '2026-02-01',
                            entries: [
                                { date: '2026-03-01', fraction: 1, raw: { unit: 'percent', value: 100 } },
                            ],
                        },
                    ],
                }),
            ),
            '2026-03-01',
            'a later entry wins over the finish date',
        );
    });

    await describe('library: filtering', () => {
        const entries = [
            { path: 'a.md', book: makeBook({ title: 'Dune', authors: ['Frank Herbert'], status: 'reading' }) },
            { path: 'b.md', book: makeBook({ title: 'Dune Messiah', authors: ['Frank Herbert'], status: 'finished' }) },
            { path: 'c.md', book: makeBook({ title: 'Neuromancer', authors: ['William Gibson'], status: 'want-to-read', series: 'Sprawl' }) },
        ];

        eq(filterBooks(entries, 'all', '').length, 3, 'no filter shows everything');
        eq(filterBooks(entries, 'reading', '').length, 1, 'by status');
        eq(filterBooks(entries, 'dnf', '').length, 0, 'an empty shelf');

        eq(filterBooks(entries, 'all', 'dune').length, 2, 'search by title, case insensitive');
        eq(filterBooks(entries, 'all', 'herbert').length, 2, 'search by author');
        eq(filterBooks(entries, 'all', 'sprawl').length, 1, 'search by series');
        eq(filterBooks(entries, 'all', '   ').length, 3, 'whitespace is not a search');
        eq(filterBooks(entries, 'all', 'zzz').length, 0, 'no matches');

        // Filter and search must combine, not override each other.
        eq(filterBooks(entries, 'finished', 'dune').length, 1, 'status and search together');
        eq(filterBooks(entries, 'reading', 'gibson').length, 0, 'and can legitimately find nothing');
    });

    await describe('library: imported books get covers for free', () => {
        // Open Library serves covers at a URL built from the ISBN, so this
        // costs no API call. Without it an imported library is a wall of
        // blank placeholders.
        const withIsbn = goodreadsToBook(
            {
                title: 'A Book',
                authors: [],
                tags: [],
                readCount: 1,
                warnings: [],
                status: 'finished',
                isbn13: '9780394480763',
            },
            'print',
        );
        ok(withIsbn.book.cover?.includes('9780394480763') ?? false, 'cover built from the ISBN');
        ok(withIsbn.book.cover?.startsWith('https://') ?? false, 'over https');

        const withoutIsbn = goodreadsToBook(
            { title: 'B', authors: [], tags: [], readCount: 1, warnings: [], status: 'finished' },
            'print',
        );
        eq(withoutIsbn.book.cover, undefined, 'no ISBN means no cover, rather than a broken link');
    });

    await describe('library: search ignores accents', () => {
        // Someone typing "melanie" expects to find "Mélanie Dupuis". Requiring
        // diacritics the reader may not have on their keyboard is a needless
        // barrier, and book libraries are full of them.
        const entries = [
            { path: 'a.md', book: makeBook({ title: 'Patisserie at Home', authors: ['Mélanie Dupuis'] }) },
            { path: 'b.md', book: makeBook({ title: 'Café Society', authors: [] }) },
            { path: 'c.md', book: makeBook({ title: 'Ñandú', authors: [] }) },
        ];

        eq(filterBooks(entries, 'all', 'melanie').length, 1, 'unaccented query finds an accented author');
        eq(filterBooks(entries, 'all', 'Mélanie').length, 1, 'and the accented query still works');
        eq(filterBooks(entries, 'all', 'cafe').length, 1, 'cafe finds Café');
        eq(filterBooks(entries, 'all', 'nandu').length, 1, 'nandu finds Ñandú');

        eq(foldAccents('Mélanie Dupuis'), 'Melanie Dupuis', 'accents stripped');
        eq(foldAccents('Ñandú'), 'Nandu', 'tilde and acute stripped');
        eq(foldAccents('日本語'), '日本語', 'scripts without diacritics are untouched');
        eq(foldAccents(''), '', 'empty string is safe');
    });

    await describe('library: a search box is not a regular expression', () => {
        // Whatever someone types must be treated as literal text.
        const entries = [
            { path: 'a.md', book: makeBook({ title: 'C++ Primer' }) },
            { path: 'b.md', book: makeBook({ title: 'What? (Really)' }) },
            { path: 'c.md', book: makeBook({ title: '100% Cotton' }) },
        ];
        for (const query of ['C++', '(Really)', '.*', '100%', '\\', '[', '$^', '?']) {
            let threw = false;
            try {
                filterBooks(entries, 'all', query);
            } catch {
                threw = true;
            }
            ok(!threw, `query ${JSON.stringify(query)} does not throw`);
        }
        eq(filterBooks(entries, 'all', '.*').length, 0, 'a regex wildcard matches nothing literally');
        eq(filterBooks(entries, 'all', 'C++').length, 1, 'but literal punctuation matches');
    });

    await describe('library: sorting holds up at scale and does not mutate', () => {
        const statuses: ReadingStatus[] = ['reading', 'finished', 'want-to-read', 'dnf'];
        const many = Array.from({ length: 2000 }, (_, i) => ({
            path: `Books/Book ${i}.md`,
            book: makeBook({
                title: `Book ${i}`,
                authors: [`Author ${i % 200}`],
                rating: i % 6 === 0 ? undefined : ((i % 5) + 1) as number,
                status: statuses[i % 4],
            }),
        }));

        const before = many.map((x) => x.path);
        for (const sort of ['recent', 'title', 'author', 'rating'] as const) {
            const out = sortBooks(many, sort);
            eq(out.length, 2000, `${sort} keeps every book`);
        }
        eq(many.map((x) => x.path), before, 'the input array is never reordered in place');

        // Natural ordering: "Book 2" before "Book 10", which matters for series.
        const numbered = ['Book 10', 'Book 2', 'Book 1'].map((t) => ({
            path: `${t}.md`,
            book: makeBook({ title: t }),
        }));
        eq(
            sortBooks(numbered, 'title').map((x) => x.book.title),
            ['Book 1', 'Book 2', 'Book 10'],
            'numbers sort naturally, not as text',
        );
    });

    await describe('library: sorting ties keep their original order', () => {
        const ties = ['x', 'y', 'z'].map((p) => ({
            path: `${p}.md`,
            book: makeBook({ title: 'Same Title', authors: ['Same Author'] }),
        }));
        for (const sort of ['title', 'author', 'rating', 'recent'] as const) {
            eq(
                sortBooks(ties, sort).map((x) => x.path),
                ['x.md', 'y.md', 'z.md'],
                `${sort} is stable`,
            );
        }
    });

    await describe('library: books with nothing in them still sort', () => {
        const odd = [
            { path: 'a.md', book: makeBook({ title: '', authors: [] }) },
            { path: 'b.md', book: makeBook({ title: '   ', authors: [] }) },
            { path: 'c.md', book: makeBook({ title: 'a'.repeat(500), authors: [] }) },
            { path: 'd.md', book: makeBook({ title: '🎉 Emoji', authors: [] }) },
            { path: 'e.md', book: makeBook({ title: 'العربية', authors: [] }) },
        ];
        for (const sort of ['recent', 'title', 'author', 'rating'] as const) {
            let threw = false;
            try {
                eq(sortBooks(odd, sort).length, 5, `${sort} keeps all five`);
            } catch {
                threw = true;
            }
            ok(!threw, `${sort} survives empty, huge and non-Latin titles`);
        }
    });

    await describe('library: cover addresses to try', () => {
        // Open Library answers a missing cover with a 1x1 transparent GIF and
        // a 200 status unless asked otherwise, which would load "successfully"
        // and stretch one pixel across the card.
        const both = coverCandidates(
            makeBook({ isbn13: '9780394480763', isbn10: '0394480767' }),
        );
        ok(
            both.every((u) => u.includes('default=false')),
            'every address asks for a 404 rather than a blank pixel',
        );
        eq(both.length, 2, 'both ISBNs are worth trying');
        ok(both[0].includes('9780394480763'), 'ISBN-13 first');
        ok(both[1].includes('0394480767'), 'ISBN-10 as the fallback');

        // Coverage genuinely differs between a book's two ISBNs, so the
        // second attempt is not redundant.
        eq(
            coverCandidates(makeBook({ isbn13: '9780394480763' })).length,
            1,
            'one ISBN gives one address',
        );
        eq(coverCandidates(makeBook({})).length, 0, 'no ISBN gives none, rather than a broken link');

        // A stored cover wins: it may have come from a provider that knows
        // better than an address we derived ourselves.
        const stored = coverCandidates(
            makeBook({ cover: 'https://example.com/real.jpg', isbn13: '9780394480763' }),
        );
        eq(stored[0], 'https://example.com/real.jpg', 'the stored cover is tried first');
        eq(stored.length, 2, 'with the derived one still available as a fallback');

        // No duplicates, so a failed attempt is never repeated.
        const dupe = coverCandidates(
            makeBook({
                cover: coverUrlFromIsbn('9780394480763', 'M'),
                isbn13: '9780394480763',
            }),
        );
        eq(dupe.length, 1, 'an address equal to the stored cover is not tried twice');
    });

    await describe('library: covers stored before default=false are repaired', () => {
        // The bug that made a fix look like it had done nothing. Open Library
        // answers a missing cover with a 1x1 GIF and a 200 status, so an
        // address stored without default=false "loads" successfully, no error
        // fires, and the fallback address is never reached.
        const stale = 'https://covers.openlibrary.org/b/isbn/9780061120084-M.jpg';
        eq(
            upgradeCoverUrl(stale),
            `${stale}?default=false`,
            'an old Open Library address is repaired on read',
        );
        eq(
            upgradeCoverUrl(`${stale}?default=false`),
            `${stale}?default=false`,
            'one that already asks is left alone',
        );
        eq(
            upgradeCoverUrl('https://covers.openlibrary.org/b/id/240727-M.jpg?foo=1'),
            'https://covers.openlibrary.org/b/id/240727-M.jpg?foo=1&default=false',
            'an existing query string is respected',
        );
        eq(
            upgradeCoverUrl('https://example.com/cover.jpg'),
            'https://example.com/cover.jpg',
            'other hosts are not touched',
        );
        eq(upgradeCoverUrl('covers/mine.jpg'), 'covers/mine.jpg', 'a vault path is not touched');
        eq(upgradeCoverUrl(undefined), undefined, 'nothing stays nothing');

        // And the repair reaches the candidate list, which is where it counts.
        const book = makeBook({ cover: stale, isbn13: '9780061120084' });
        const candidates = coverCandidates(book);
        ok(candidates[0].includes('default=false'), 'the stored address is fixed before use');
        eq(candidates.length, 1, 'and then matches the derived one, so it is not tried twice');
    });

    await describe('library: covers can live in the vault', () => {
        // Open Library has no artwork for a great many books — non-Latin
        // scripts, small presses, translations. A vault image works offline,
        // is backed up with the notes, and cannot be taken away.
        ok(isRemoteCover('https://covers.openlibrary.org/b/isbn/1-M.jpg'), 'https is remote');
        ok(isRemoteCover('http://example.com/a.jpg'), 'http is remote');
        ok(!isRemoteCover('covers/mockingbird.jpg'), 'a plain path is local');
        ok(!isRemoteCover('Attachments/My Cover.png'), 'so is one with folders and spaces');

        // People paste whatever Obsidian gave them.
        eq(normaliseCoverInput('[[cover.jpg]]'), 'cover.jpg', 'wiki link unwrapped');
        eq(normaliseCoverInput('![[covers/a.png]]'), 'covers/a.png', 'embed unwrapped');
        eq(normaliseCoverInput('![[a.png|300]]'), 'a.png', 'a size hint is dropped');
        eq(normaliseCoverInput('![alt](covers/b.jpg)'), 'covers/b.jpg', 'markdown image unwrapped');
        eq(normaliseCoverInput('  covers/c.jpg  '), 'covers/c.jpg', 'whitespace trimmed');
        eq(
            normaliseCoverInput('https://example.com/d.jpg'),
            'https://example.com/d.jpg',
            'a URL passes through',
        );
        eq(normaliseCoverInput(''), undefined, 'empty means no cover');
        eq(normaliseCoverInput('   '), undefined, 'whitespace means no cover');
    });

    await describe('covers: naming files for the vault', () => {
        // The ISBN is preferred because it never changes: a retitled or
        // re-imported book keeps the same file instead of accumulating copies.
        eq(
            coverFilename(makeBook({ isbn13: '9780061120084', title: 'To Kill a Mockingbird' }), 'x.jpg'),
            '9780061120084.jpg',
            'named by ISBN-13',
        );
        eq(
            coverFilename(makeBook({ isbn10: '0061120081', title: 'X' }), 'x.jpg'),
            '0061120081.jpg',
            'ISBN-10 when there is no 13',
        );
        eq(
            coverFilename(makeBook({ title: 'The Power Broker: Robert Moses' }), 'x.jpg'),
            'The Power Broker - Robert Moses.jpg',
            'falls back to a sanitised title',
        );
        // A title with a path separator must never escape the cover folder.
        ok(
            !coverFilename(makeBook({ title: 'A/B Testing' }), 'x.jpg').includes('/'),
            'a slash in the title cannot become a folder',
        );

        // Not every cover is a JPEG.
        eq(coverFilename(makeBook({ isbn13: '1' }), 'a/b.png'), '1.png', 'png kept');
        eq(coverFilename(makeBook({ isbn13: '1' }), 'a/b.webp'), '1.webp', 'webp kept');
        eq(coverFilename(makeBook({ isbn13: '1' }), 'a/b.jpeg'), '1.jpg', 'jpeg normalised to jpg');
        eq(
            coverFilename(makeBook({ isbn13: '1' }), 'https://x/y-M.jpg?default=false'),
            '1.jpg',
            'a query string does not confuse the extension',
        );
        eq(coverFilename(makeBook({ isbn13: '1' }), 'https://x/nothing'), '1.jpg', 'defaults to jpg');
    });

    await describe('covers: planning a download', () => {
        const entries = [
            { path: 'a.md', book: makeBook({ title: 'Remote', cover: 'https://covers.openlibrary.org/b/isbn/1-M.jpg', isbn13: '1' }) },
            { path: 'b.md', book: makeBook({ title: 'Already local', cover: 'Books/covers/2.jpg', isbn13: '2' }) },
            { path: 'c.md', book: makeBook({ title: 'No cover at all' }) },
        ];

        const jobs = planCoverDownloads(entries, 'Books/covers');
        eq(jobs.length, 1, 'only remote covers are candidates');
        eq(jobs[0].target, 'Books/covers/1.jpg', 'target path built from the folder and ISBN');
        eq(jobs[0].source, 'https://covers.openlibrary.org/b/isbn/1-M.jpg', 'source recorded');

        // Re-running must not redo work, so the operation can be interrupted.
        const done = partitionJobs(jobs, (p) => p === 'Books/covers/1.jpg');
        eq(done.toFetch.length, 0, 'a cover already on disk is not fetched again');
        eq(done.alreadyThere.length, 1, 'but it is still adopted, so the note points at it');

        const fresh = partitionJobs(jobs, () => false);
        eq(fresh.toFetch.length, 1, 'a missing file is fetched');
    });

    await describe('covers: folder joining', () => {
        eq(joinPath('Books/covers', 'a.jpg'), 'Books/covers/a.jpg', 'ordinary join');
        eq(joinPath('Books/covers/', 'a.jpg'), 'Books/covers/a.jpg', 'trailing slash absorbed');
        eq(joinPath('', 'a.jpg'), 'a.jpg', 'vault root');
    });

    await describe('covers: a blank placeholder is not artwork', () => {
        // Open Library answers a missing cover with a 1x1 transparent GIF,
        // which is a valid image and would otherwise be saved as one.
        const tiny = new ArrayBuffer(43);
        const real = new ArrayBuffer(20_000);
        ok(!looksLikeRealImage(tiny), 'a 43-byte GIF is rejected');
        ok(looksLikeRealImage(real, 'image/jpeg'), 'a real image is accepted');
        ok(!looksLikeRealImage(real, 'text/html'), 'an error page is rejected even when large');
        ok(looksLikeRealImage(real), 'a missing content type does not disqualify it');
    });

    await describe('covers: telling the reader how long it will take', () => {
        eq(estimateSeconds(0, 12), 0, 'nothing takes no time');
        eq(estimateSeconds(12, 12), 60, 'twelve at twelve a minute is a minute');
        eq(estimateSeconds(232, 12), 1160, '232 covers at a polite rate');
        eq(describeDuration(30), 'under a minute', 'short');
        eq(describeDuration(1160), 'about 19 minutes', 'the realistic case, stated plainly');
        eq(describeDuration(7200), 'about 2 hours', 'long');
    });

    await describe('stats: the year a book was finished', () => {
        eq(finishYear(makeBook({ sessions: [] })), null, 'no sessions, no year');
        eq(
            finishYear(makeBook({ sessions: [{ id: 's1', format: 'print', started: '2020-01-01', entries: [] }] })),
            null,
            'started but never finished has no finish year',
        );
        eq(
            finishYear(makeBook({ sessions: [{ id: 's1', format: 'print', finished: '2024-03-12', entries: [] }] })),
            2024,
            'the finish date decides',
        );
        // A reread should count in the year of the most recent finish.
        eq(
            finishYear(
                makeBook({
                    sessions: [
                        { id: 's1', format: 'print', finished: '2019-01-01', entries: [] },
                        { id: 's2', format: 'audio', finished: '2025-06-01', entries: [] },
                    ],
                }),
            ),
            2025,
            'the latest finish wins',
        );
        eq(finishMonth(makeBook({ sessions: [{ id: 's1', format: 'print', finished: '2024-03-12', entries: [] }] })), 2, 'March is index 2');
    });

    await describe('stats: length bands go finer at the long end', () => {
        // Readers asked for this specifically: a single "500+" bucket erases
        // the difference between a 500-page book and a 1,200-page one.
        eq(lengthBand(150), 'Under 200', 'short');
        eq(lengthBand(250), '200–299', 'typical novel');
        eq(lengthBand(350), '300–399', 'requested as its own band');
        eq(lengthBand(450), '400–499', 'and this one');
        eq(lengthBand(600), '500–699', 'long');
        eq(lengthBand(800), '700–999', 'longer');
        eq(lengthBand(1246), '1000+', 'The Power Broker');
        eq(lengthBand(0), 'Under 200', 'zero is handled');
    });

    await describe('stats: an imported library, which knows very little', () => {
        // The realistic case: finish dates, ratings and page counts, and no
        // start dates at all, because Goodreads does not export them.
        const entries = [
            { book: makeBook({ title: 'A', status: 'finished', rating: 5, metrics: { pages: 300 }, authors: ['Caro'], sessions: [{ id: 's1', format: 'print', finished: '2024-03-01', entries: [] }] }) },
            { book: makeBook({ title: 'B', status: 'finished', rating: 3, metrics: { pages: 1246 }, authors: ['Caro'], sessions: [{ id: 's1', format: 'print', finished: '2024-07-01', entries: [] }] }) },
            { book: makeBook({ title: 'C', status: 'finished', rating: 4, metrics: {}, authors: ['Le Guin'], sessions: [{ id: 's1', format: 'print', finished: '2025-01-01', entries: [] }] }) },
            { book: makeBook({ title: 'D', status: 'reading', metrics: { pages: 200 }, sessions: [{ id: 's1', format: 'print', started: '2026-01-01', entries: [] }] }) },
            { book: makeBook({ title: 'E', status: 'want-to-read', sessions: [] }) },
            // Finished but with no date — the Goodreads missing-read-date case.
            { book: makeBook({ title: 'F', status: 'finished', rating: 2, metrics: { pages: 100 }, sessions: [{ id: 's1', format: 'print', entries: [] }] }) },
        ];

        const all = computeStats(entries, null);
        eq(all.finished, 4, 'four finished books across all time');
        eq(all.pages, 1646, 'pages summed only where known');
        eq(all.pagesUnknown, 1, 'and the unknown one is counted, not silently dropped');
        eq(all.averageRating, 3.5, 'mean of 5, 3, 4, 2');
        eq(all.ratedCount, 4, 'four rated');
        eq(all.undated, 1, 'the dateless finished book is reported');
        eq(all.longest?.title, 'B', 'longest identified');
        eq(all.shortest?.title, 'F', 'shortest identified');
        eq(all.averagePages, 549, 'mean of 300, 1246, 100');

        // Shelves describe now, not the span.
        eq(all.shelves.find((s) => s.status === 'reading')?.count, 1, 'one currently reading');
        eq(all.shelves.find((s) => s.status === 'want-to-read')?.count, 1, 'one to read');

        // Years.
        eq(all.byYear.map((y) => y.year), [2024, 2025], 'years present, oldest first');
        eq(all.byYear[0].books, 2, '2024 had two');
        eq(all.byYear[0].pages, 1546, 'and its pages');
        eq(all.byMonth, null, 'no month breakdown for all time');

        const y2024 = computeStats(entries, 2024);
        eq(y2024.finished, 2, 'narrowed to one year');
        eq(y2024.pages, 1546, 'pages for that year');
        eq(y2024.averageRating, 4, 'mean of 5 and 3');
        eq(y2024.byMonth?.length, 12, 'twelve months');
        eq(y2024.byMonth?.[2].count, 1, 'one finished in March');
        eq(y2024.byMonth?.[6].count, 1, 'one in July');
        eq(y2024.byMonth?.[0].count, 0, 'none in January');

        // An author is only interesting once they recur.
        eq(all.authors.length, 1, 'only repeated authors are listed');
        eq(all.authors[0].author, 'Caro', 'the one read twice');
        eq(all.authors[0].books, 2, 'with a count');
    });

    await describe('stats: audiobooks are counted in hours, not pages', () => {
        // Page-only statistics quietly exclude people who mostly listen.
        const entries = [
            { book: makeBook({ status: 'finished', metrics: { duration: 36000 }, sessions: [{ id: 's1', format: 'audio', finished: '2026-01-01', entries: [] }] }) },
            { book: makeBook({ status: 'finished', metrics: { pages: 300 }, sessions: [{ id: 's1', format: 'print', finished: '2026-02-01', entries: [] }] }) },
        ];
        const stats = computeStats(entries, 2026);
        eq(stats.seconds, 36000, 'listening time accumulated');
        eq(stats.pages, 300, 'and pages kept separate rather than conflated');
        eq(describeListening(36000), '10 hours', 'stated in hours');
        eq(describeListening(1800), '30 minutes', 'under an hour');
        eq(describeListening(0), '', 'nothing to say when nothing was listened to');
    });

    await describe('stats: an empty library says nothing rather than lying', () => {
        const empty = computeStats([], null);
        eq(empty.finished, 0, 'no books');
        eq(empty.averageRating, null, 'no average rating, rather than zero');
        eq(empty.averagePages, null, 'no average length');
        eq(empty.longest, null, 'no longest');
        eq(empty.shortest, null, 'no shortest');
        eq(empty.byYear, [], 'no years');
        eq(empty.authors, [], 'no authors');
        eq(empty.lengths, [], 'no length bands');

        // A library where nothing is rated must not report 0 stars.
        const unrated = computeStats(
            [{ book: makeBook({ status: 'finished', sessions: [{ id: 's1', format: 'print', finished: '2026-01-01', entries: [] }] }) }],
            null,
        );
        eq(unrated.averageRating, null, 'unrated books give no average');
        eq(unrated.ratedCount, 0, 'and are counted as unrated');
    });

    await describe('stats: which years to offer', () => {
        const books = [
            makeBook({ sessions: [{ id: 's1', format: 'print', finished: '2024-01-01', entries: [] }] }),
            makeBook({ sessions: [{ id: 's1', format: 'print', finished: '2026-01-01', entries: [] }] }),
            makeBook({ sessions: [{ id: 's1', format: 'print', finished: '2024-06-01', entries: [] }] }),
            makeBook({ sessions: [] }),
        ];
        eq(yearsPresent(books), [2026, 2024], 'newest first, deduplicated, undated ignored');
        eq(yearsPresent([]), [], 'an empty library offers no years');
    });

    await describe('repository: name collisions get suffixes', async () => {
        const vault = new FakeVault();
        const repo = new BookRepository(vault, () => DEFAULT_SETTINGS);
        const a = await repo.create(makeBook());
        const b = await repo.create(makeBook());
        ok(a.path !== b.path, 'second book gets a different path');
        ok(b.path.includes('(2)'), 'suffix applied');
        eq(vault.files.size, 2, 'both notes exist');
    });

    await describe('repository: saving preserves user content', async () => {
        const vault = new FakeVault();
        const repo = new BookRepository(vault, () => DEFAULT_SETTINGS);
        const { path } = await repo.create(makeBook());

        // Simulate the reader adding notes and a custom property.
        const withNotes = (vault.files.get(path) as string) + '\n## My notes\n\nChapter 3 is the key.\n';
        vault.files.set(path, withNotes.replace('dogear: 1', 'dogear: 1\nmyField: precious'));

        const book = (await repo.load(path)) as Book;
        const updated = finishSession({ ...book, rating: 4.5 }, '2026-03-01');
        await repo.save(path, updated);

        const after = vault.files.get(path) as string;
        ok(after.includes('## My notes'), 'user heading survives');
        ok(after.includes('Chapter 3 is the key.'), 'user prose survives');
        ok(after.includes('myField: precious'), 'unknown frontmatter key survives');
        ok(after.includes('status: finished'), 'status updated');
        ok(after.includes('rating: 4.5'), 'rating written');
        ok(after.includes('2026-03-01'), 'finish date logged');

        // The log is written before the frontmatter, so a failure mid-save
        // never leaves a status the log cannot justify.
        const logIdx = vault.ops.lastIndexOf(`process:${path}`);
        const fmIdx = vault.ops.lastIndexOf(`frontmatter:${path}`);
        ok(logIdx < fmIdx, 'log written before frontmatter');
    });

    await describe('repository: clearing a managed field removes it', async () => {
        const vault = new FakeVault();
        const repo = new BookRepository(vault, () => DEFAULT_SETTINGS);
        const { path } = await repo.create(makeBook({ rating: 4 }));
        ok((vault.files.get(path) as string).includes('rating: 4'), 'rating written initially');

        const book = (await repo.load(path)) as Book;
        await repo.save(path, { ...book, rating: undefined });
        ok(
            !/^rating:/m.test(vault.files.get(path) as string),
            'clearing a rating removes the key rather than leaving it stale',
        );
    });

    await describe('repository: listing and finding books', async () => {
        const vault = new FakeVault();
        const repo = new BookRepository(vault, () => DEFAULT_SETTINGS);
        await repo.create(makeBook({ title: 'Dune', olWork: '/works/OL1W' }));
        await repo.create(makeBook({ title: 'Ulysses' }));
        // A stray non-book note in the folder must be ignored, not shown blank.
        vault.files.set('Books/Random thoughts.md', 'just some prose');

        const all = await repo.all();
        eq(all.length, 2, 'only real book notes listed');
        eq(
            all.map((b) => b.book.title).sort(),
            ['Dune', 'Ulysses'],
            'both books found',
        );

        const byKey = await repo.findExisting(makeBook({ title: 'Different', olWork: '/works/OL1W' }));
        ok(byKey?.includes('Dune') ?? false, 'matched by Open Library key despite a different title');

        const byTitle = await repo.findExisting(makeBook({ title: 'ulysses' }));
        ok(byTitle?.includes('Ulysses') ?? false, 'matched by title, case-insensitively');

        const missing = await repo.findExisting(makeBook({ title: 'Nothing here' }));
        eq(missing, null, 'unknown book reports no match');
    });

    await describe('repository: the same book from two sources is not duplicated', async () => {
        const vault = new FakeVault();
        const repo = new BookRepository(vault, () => DEFAULT_SETTINGS);

        // Added first from Open Library.
        await repo.create(
            makeBook({
                title: 'The Power Broker',
                isbn13: '9780394480763',
                olWork: '/works/OL1W',
            }),
        );

        // Later found via Google Books — different identifiers entirely, and
        // a slightly different title, but the same ISBN.
        const fromGoogle = makeBook({
            title: 'The Power Broker: Robert Moses and the Fall of New York',
            isbn13: '9780394480763',
            olWork: undefined,
            googleId: 'hkEKEAAAQBAJ',
        });
        const match = await repo.findExisting(fromGoogle);
        ok(match !== null, 'matched across sources by ISBN, despite different titles and ids');

        // And matching by Google id works once it has been stored.
        await repo.create(makeBook({ title: 'Dune', googleId: 'GID123', isbn13: undefined }));
        const byGoogle = await repo.findExisting(
            makeBook({ title: 'Different title', googleId: 'GID123', isbn13: undefined }),
        );
        ok(byGoogle?.includes('Dune') ?? false, 'matched by Google volume id');

        const unrelated = await repo.findExisting(
            makeBook({ title: 'Nothing like it', isbn13: '9999999999999', olWork: undefined }),
        );
        eq(unrelated, null, 'an unrelated book still reports no match');
    });

    // --- session operations -------------------------------------------------

    await describe('sessions: starting, logging, finishing', () => {
        const book = makeBook();
        const started = startSession(book, 'print', '2026-01-01');
        eq(started.sessions.length, 1, 'session created');
        eq(started.status, 'reading', 'status becomes reading');

        const logged = logProgress(
            started,
            { date: '2026-01-05', fraction: 0.5, raw: { unit: 'page', value: 194 } },
            'print',
        );
        eq(logged.sessions[0].entries.length, 1, 'entry appended to the open session');
        eq(logged.status, 'reading', 'still reading');

        const done = finishSession(logged, '2026-02-01', 4.5);
        eq(done.status, 'finished', 'status becomes finished');
        eq(done.sessions[0].finished, '2026-02-01', 'finish date set');
        eq(done.sessions[0].rating, 4.5, 'session rating set');

        // Logging after finishing must start a NEW session — that is a reread.
        const reread = logProgress(
            done,
            { date: '2026-06-01', fraction: 0.1, raw: { unit: 'page', value: 39 } },
            'audio',
        );
        eq(reread.sessions.length, 2, 'reread creates a second session');
        eq(reread.sessions[1].format, 'audio', 'reread can use a different format');
        eq(reread.status, 'reading', 'status back to reading');
        eq(reread.sessions[0].finished, '2026-02-01', 'first read untouched');
    });

    await describe('sessions: abandoning and resuming', () => {
        const book = startSession(makeBook(), 'ebook', '2026-01-01');
        const logged = logProgress(
            book,
            { date: '2026-01-10', fraction: 0.34, raw: { unit: 'percent', value: 34 } },
            'ebook',
        );
        const dropped = abandonSession(logged, 0.34, 'lost the thread', '2026-01-20');
        eq(dropped.status, 'dnf', 'status becomes DNF');
        eq(dropped.sessions[0].abandoned?.fraction, 0.34, 'abandon position recorded');
        eq(dropped.sessions[0].abandoned?.reason, 'lost the thread', 'reason recorded');

        // Picking it up again is a fresh session, preserving the DNF history.
        const resumed = startSession(dropped, 'print', '2027-01-01');
        eq(resumed.sessions.length, 2, 'resuming creates a new session');
        eq(resumed.sessions[0].abandoned?.fraction, 0.34, 'earlier DNF preserved');
        eq(resumed.status, 'reading', 'status back to reading');
    });

    await describe('sessions: status shortcuts keep the log consistent', () => {
        const book = makeBook();
        const reading = applyStatus(book, 'reading', '2026-01-01', 'print');
        eq(reading.sessions.length, 1, 'marking as reading opens a session');

        const finished = applyStatus(reading, 'finished', '2026-02-01', 'print');
        eq(finished.status, 'finished', 'marking as finished closes it');
        eq(finished.sessions.length, 1, 'no extra session created');

        // Marking finished twice must not fabricate a second read.
        const again = applyStatus(finished, 'finished', '2026-02-02', 'print');
        eq(again.sessions.length, 1, 'finishing an already-finished book adds no session');

        // Clicking "Reading" on a finished book REOPENS it rather than
        // inventing a second read. The click is ambiguous — it could mean
        // "reading it again" or "I pressed Finished by mistake" — and now
        // that "Read it again" is an explicit button, the correcting reading
        // is the right one. Silently fabricating a second read is the more
        // destructive interpretation of an ambiguous action.
        const reopened = applyStatus(finished, 'reading', '2026-06-01', 'print');
        eq(reopened.sessions.length, 1, 'no second read is invented');
        eq(reopened.status, 'reading', 'the book is reading again');
        eq(reopened.sessions[0].finished, undefined, 'the mistaken finish date is cleared');
        eq(reopened.sessions[0].started, '2026-01-01', 'the original start date survives');

        // A genuine reread is available, and is explicit.
        const reread = startReread(finished, 'audio', '2026-06-01');
        eq(reread.sessions.length, 2, 'the explicit action does create a second read');

        // Reopening an abandoned book works the same way.
        const abandoned = applyStatus(reading, 'dnf', '2026-03-01', 'print');
        const resumed = applyStatus(abandoned, 'reading', '2026-04-01', 'print');
        eq(resumed.sessions.length, 1, 'no second read from resuming');
        eq(resumed.sessions[0].abandoned, undefined, 'the abandonment is cleared');

        const dnf = applyStatus(reading, 'dnf', '2026-03-01', 'print');
        eq(dnf.status, 'dnf', 'DNF applied');
        eq(dnf.sessions[0].abandoned !== undefined, true, 'abandon recorded on the session');

        // Want-to-read on an untouched book is just intent, no session.
        const tbr = applyStatus(book, 'want-to-read', '2026-01-01', 'print');
        eq(tbr.sessions.length, 0, 'want-to-read creates no session');
        eq(tbr.status, 'want-to-read', 'status set');
    });

    await describe('repository: round trip through the vault preserves sessions', async () => {
        const vault = new FakeVault();
        const repo = new BookRepository(vault, () => DEFAULT_SETTINGS);
        const { path } = await repo.create(makeBook({ metrics: { pages: 387, duration: 36000 } }));

        let book = (await repo.load(path)) as Book;
        book = startSession(book, 'audio', '2026-01-01');
        book = logProgress(
            book,
            { date: '2026-01-02', fraction: 0.75, raw: { unit: 'remaining', value: 9000 } },
            'audio',
        );
        await repo.save(path, book);

        const reloaded = (await repo.load(path)) as Book;
        eq(reloaded.sessions.length, 1, 'session survives the vault round trip');
        eq(reloaded.sessions[0].format, 'audio', 'format survives');
        eq(
            reloaded.sessions[0].entries[0].raw,
            { unit: 'remaining', value: 9000 },
            'time-remaining entry survives a real save and reload',
        );
        eq(reloaded.status, 'reading', 'status survives');
    });
}
