// Dogear — book repository.
//
// All vault access goes through the `VaultLike` interface so the logic can be
// tested against an in-memory fake. The real implementation (in main.ts) wires
// it to Obsidian's APIs, following the official guidelines:
//
//   - `Vault.process()` for background edits, because it is atomic and won't
//     conflict with other plugins touching the same file
//   - `FileManager.processFrontMatter()` for frontmatter, so Obsidian owns the
//     YAML layout and it stays consistent with the Properties UI
//   - `Vault.getFileByPath()` rather than iterating every file
//   - the Vault API rather than the Adapter API
//
// The split matters: frontmatter goes through Obsidian, the reading log goes
// through us. Neither writer touches the other's territory.

import type { Book, ReadingSession, ReadingStatus, BookMetrics } from './model';
import { deriveStatus } from './model';
import {
    bookToFrontmatter,
    parseBookNote,
    renderReadingLog,
    replaceSection,
    DEFAULT_LOG_HEADING,
} from './note';
import { buildNotePath, renderFilenameTemplate, uniquePath } from './paths';
import type { DogearSettings } from './settings';
import type { YamlMap } from './yaml';

/** The slice of the vault Dogear needs. Implemented over Obsidian in main.ts. */
export interface VaultLike {
    exists(path: string): boolean;
    read(path: string): Promise<string>;
    create(path: string, content: string): Promise<void>;
    /** Atomic read-modify-write of the whole file. */
    process(path: string, fn: (content: string) => string): Promise<void>;
    /** Atomic frontmatter mutation, using Obsidian's own YAML handling. */
    processFrontMatter(path: string, fn: (fm: YamlMap) => void): Promise<void>;
    /** Ensure a folder exists, creating parents as needed. */
    ensureFolder(path: string): Promise<void>;
    /** Paths of all markdown notes under a folder. */
    listNotes(folder: string): string[];
}

export interface CreateResult {
    path: string;
    created: boolean;
}

export class BookRepository {
    constructor(
        private readonly vault: VaultLike,
        private readonly settings: () => DogearSettings,
    ) {}

    private get heading(): string {
        return this.settings().logHeading || DEFAULT_LOG_HEADING;
    }

    /** Where a new note for this book would go, avoiding collisions. */
    plannedPath(book: Book): string {
        const s = this.settings();
        const basename = renderFilenameTemplate(s.filenameTemplate, {
            title: book.title,
            authors: book.authors,
            published: book.published,
            series: book.series,
        });
        return uniquePath(s.booksFolder, basename, (p) => this.vault.exists(p));
    }

    /**
     * Create a note for a book.
     *
     * Frontmatter is written via processFrontMatter after creation rather than
     * baked into the initial content, so Obsidian formats the YAML and the
     * Properties panel agrees with what is on disk from the very first save.
     */
    async create(book: Book, notes = ''): Promise<CreateResult> {
        const s = this.settings();
        if (s.booksFolder.trim() !== '') {
            await this.vault.ensureFolder(s.booksFolder);
        }
        const path = this.plannedPath(book);
        // The control block goes above the log, so the first thing you see in
        // a new book note is something you can click.
        const panel = '```dogear\n```\n';
        // A "Notes" heading is offered but never managed. Obsidian already
        // has the best notes system available — the note itself — and a
        // Dogear-owned notes section would compete with it, need parsing, and
        // put the reader's writing at risk on every save. So this is a
        // signpost, nothing more: everything under it belongs to the reader
        // and Dogear will not touch it again.
        const notesBody = notes.trim() === '' ? '' : `${notes.trim()}\n`;
        const notesSection = `\n## Notes\n\n${notesBody}`;
        const body = `${panel}\n${replaceSection('', this.heading, renderReadingLog(book.sessions, book.metrics))}${notesSection}`;

        await this.vault.create(path, body);
        await this.writeFrontmatter(path, book);
        return { path, created: true };
    }

    /** Read a book back from a note. */
    async load(path: string): Promise<Book | null> {
        if (!this.vault.exists(path)) return null;
        const content = await this.vault.read(path);
        return parseBookNote(content, this.heading).book;
    }

    /** Read a book plus any log lines that could not be understood. */
    async loadDetailed(path: string): Promise<{ book: Book; unparsed: string[] } | null> {
        if (!this.vault.exists(path)) return null;
        const content = await this.vault.read(path);
        const parsed = parseBookNote(content, this.heading);
        return { book: parsed.book, unparsed: parsed.unparsed };
    }

    /** Write frontmatter only, leaving the body untouched. */
    async writeFrontmatter(path: string, book: Book): Promise<void> {
        await this.vault.processFrontMatter(path, (fm) => {
            const next = bookToFrontmatter(book, fm);
            // Remove keys we manage that are no longer set, so clearing a
            // rating in the UI actually clears it on disk.
            for (const key of Object.keys(fm)) {
                if (!(key in next)) delete fm[key];
            }
            for (const [k, v] of Object.entries(next)) fm[k] = v;
        });
    }

    /** Write the reading log only, leaving frontmatter and prose untouched. */
    async writeLog(
        path: string,
        sessions: ReadingSession[],
        metrics: BookMetrics = {},
    ): Promise<void> {
        await this.vault.process(path, (content) =>
            replaceSection(content, this.heading, renderReadingLog(sessions, metrics)),
        );
    }

    /**
     * Persist a whole book.
     *
     * Two atomic operations rather than one, because frontmatter belongs to
     * Obsidian and the log belongs to us. The log is written first so that if
     * the second call fails, the note is never left claiming a status its log
     * does not support.
     */
    async save(path: string, book: Book): Promise<void> {
        await this.writeLog(path, book.sessions);
        await this.writeFrontmatter(path, book);
    }

    /** Every book note under the configured folder. */
    async all(): Promise<Array<{ path: string; book: Book }>> {
        const paths = this.vault.listNotes(this.settings().booksFolder);
        const out: Array<{ path: string; book: Book }> = [];
        for (const path of paths) {
            const book = await this.load(path);
            // A note with no title is not a book note; skip rather than show
            // an empty card for every stray file in the folder.
            if (book && book.title.trim() !== '') out.push({ path, book });
        }
        return out;
    }

    /** Find an existing note for a book, by Open Library key then by title. */
    async findExisting(book: Book): Promise<string | null> {
        const candidates = await this.all();
        if (book.olWork) {
            const byKey = candidates.find((c) => c.book.olWork === book.olWork);
            if (byKey) return byKey.path;
        }
        if (book.googleId) {
            const byGoogle = candidates.find((c) => c.book.googleId === book.googleId);
            if (byGoogle) return byGoogle.path;
        }
        // A book added from one source and then found via another shares no
        // identifier, so fall back to matching on ISBN before title.
        const isbn = book.isbn13 ?? book.isbn10;
        if (isbn) {
            const byIsbn = candidates.find(
                (c) => (c.book.isbn13 ?? c.book.isbn10) === isbn,
            );
            if (byIsbn) return byIsbn.path;
        }
        const title = book.title.trim().toLowerCase();
        const byTitle = candidates.find((c) => c.book.title.trim().toLowerCase() === title);
        return byTitle ? byTitle.path : null;
    }
}

// --- session helpers --------------------------------------------------------
//
// Pure operations on session lists, used by the UI. Kept here rather than in
// the modal so they can be tested without a DOM.

/** Start a new reading session, which is also how a reread begins. */
export function startSession(book: Book, format: Format2, today: string): Book {
    const session: ReadingSession = {
        id: `s${book.sessions.length + 1}`,
        format,
        started: today,
        entries: [],
    };
    const sessions = [...book.sessions, session];
    return { ...book, sessions, status: deriveStatus(sessions) };
}

type Format2 = Book['sessions'][number]['format'];

/** Append a progress entry to the current session, starting one if needed. */
export function logProgress(
    book: Book,
    entry: {
        date: string;
        fraction: number;
        raw: ReadingSession['entries'][number]['raw'];
        format?: Format2;
        note?: string;
    },
    format: Format2,
): Book {
    let sessions = book.sessions;
    if (sessions.length === 0 || sessions[sessions.length - 1].finished || sessions[sessions.length - 1].abandoned) {
        sessions = [
            ...sessions,
            { id: `s${sessions.length + 1}`, format, started: entry.date, entries: [] },
        ];
    }
    const last = sessions[sessions.length - 1];
    const updated: ReadingSession = { ...last, entries: [...last.entries, entry] };
    const next = [...sessions.slice(0, -1), updated];
    return { ...book, sessions: next, status: deriveStatus(next) };
}

/**
 * Begin a fresh read of a book that is already finished or abandoned.
 *
 * Deliberately explicit. Previously a reread appeared as a side effect of
 * logging progress against a finished book, which is a surprising way to
 * discover that your library now claims you read something twice.
 */
export function startReread(book: Book, format: Format2, today: string): Book {
    const sessions: ReadingSession[] = [
        ...book.sessions,
        {
            id: `s${book.sessions.length + 1}`,
            format,
            started: today,
            entries: [],
        },
    ];
    return { ...book, sessions, status: 'reading' };
}

/** Mark the current session finished. */
export function finishSession(book: Book, date: string, rating?: number): Book {
    if (book.sessions.length === 0) {
        const sessions: ReadingSession[] = [
            { id: 's1', format: 'print', started: date, finished: date, entries: [], rating },
        ];
        return { ...book, sessions, status: 'finished' };
    }
    const last = book.sessions[book.sessions.length - 1];
    const updated: ReadingSession = {
        ...last,
        finished: date,
        rating: rating ?? last.rating,
        abandoned: undefined,
    };
    const next = [...book.sessions.slice(0, -1), updated];
    return { ...book, sessions: next, status: 'finished' };
}

/** Abandon the current session, recording where and optionally why. */
export function abandonSession(
    book: Book,
    fraction: number,
    reason: string | undefined,
    date: string,
): Book {
    if (book.sessions.length === 0) {
        const sessions: ReadingSession[] = [
            { id: 's1', format: 'print', started: date, entries: [], abandoned: { fraction, reason } },
        ];
        return { ...book, sessions, status: 'dnf' };
    }
    const last = book.sessions[book.sessions.length - 1];
    const updated: ReadingSession = {
        ...last,
        abandoned: { fraction, reason },
        finished: undefined,
    };
    const next = [...book.sessions.slice(0, -1), updated];
    return { ...book, sessions: next, status: 'dnf' };
}

/**
 * Apply an explicit status change from the UI.
 *
 * Setting a status is a shortcut for a session action, so the log stays the
 * source of truth rather than drifting from the frontmatter.
 */
export function applyStatus(
    book: Book,
    status: ReadingStatus,
    today: string,
    defaultFormat: Format2,
): Book {
    const current = book.sessions.length === 0 ? null : book.sessions[book.sessions.length - 1];

    switch (status) {
        case 'want-to-read':
            // Only meaningful if nothing has been logged; otherwise leave the
            // history alone and just record the intent.
            return { ...book, status: 'want-to-read' };
        case 'reading': {
            if (!current) return startSession(book, defaultFormat, today);
            if (current.finished || current.abandoned) {
                // Reopen the existing read rather than starting a new one.
                // Now that "Read it again" is an explicit action, clicking
                // "Reading" on a finished book almost always means the
                // Finished button was pressed by mistake — and silently
                // inventing a second read is the more destructive reading of
                // an ambiguous click.
                const sessions = [...book.sessions];
                const reopened = { ...current };
                delete reopened.finished;
                delete reopened.abandoned;
                sessions[sessions.length - 1] = reopened;
                return { ...book, sessions, status: 'reading' };
            }
            return { ...book, status: 'reading' };
        }
        case 'finished':
            return finishSession(book, today);
        case 'dnf': {
            const fraction = current
                ? current.entries.reduce((m, e) => Math.max(m, e.fraction), 0)
                : 0;
            return abandonSession(book, fraction, undefined, today);
        }
    }
}
