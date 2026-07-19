// Dogear — plugin entry point.
//
// Guideline compliance notes:
//   - `Vault.process()` for background body edits (atomic, conflict-safe).
//   - `FileManager.processFrontMatter()` for frontmatter, so Obsidian owns the
//     YAML and the Properties panel always agrees with the file.
//   - `Vault.getFileByPath()` rather than iterating the vault.
//   - `normalizePath()` on every user-supplied path.
//   - `requestUrl()` for network access, which avoids CORS and works on mobile.
//   - No default hotkeys on commands.
//   - Nothing is detached in `onunload()`.
//   - No references to view instances are held anywhere.

import {
    MarkdownView,
    Menu,
    Notice,
    Plugin,
    TFile,
    TFolder,
    normalizePath,
    requestUrl,
} from 'obsidian';

import { SCHEMA_VERSION, type Book } from './model';
import { OpenLibraryClient, type HttpResponse } from './olclient';
import { coverUrlFromIsbn } from './openlibrary';
import {
    planCoverDownloads,
    partitionJobs,
    looksLikeRealImage,
    estimateSeconds,
    describeDuration,
} from './covers';
import { ProviderChain } from './providers/chain';
import { TokenBucket } from './ratelimit';
import { GoogleBooksProvider, countryFromLocale } from './providers/googlebooks';
import { OpenLibraryProvider } from './providers/openlibrary';
import { InternetArchiveProvider } from './providers/internetarchive';
import { LibraryOfCongressProvider } from './providers/loc';
import type { BookProvider, SearchHit } from './providers/types';
import { BookRepository, type VaultLike } from './repository';
import { DEFAULT_SETTINGS, normaliseSettings, type DogearSettings } from './settings';
import type { YamlMap } from './yaml';
import { BookDetailModal } from './ui/bookModal';
import { openBookSearch } from './ui/searchModal';
import { ManualBookModal } from './ui/manualModal';
import { BookPanel, DOGEAR_BLOCK } from './ui/bookPanel';
import { GoodreadsImportModal } from './ui/importModal';
import { CoverModal } from './ui/coverModal';
import { LibraryView, VIEW_TYPE_LIBRARY, openLibrary as revealLibrary } from './ui/libraryView';
import { StatsView, VIEW_TYPE_STATS, openStats as revealStats } from './ui/statsView';
import { DogearSettingTab } from './ui/settingsTab';

export default class DogearPlugin extends Plugin {
    settings: DogearSettings = { ...DEFAULT_SETTINGS };
    private client!: OpenLibraryClient;
    private google!: GoogleBooksProvider;
    private archive!: InternetArchiveProvider;
    private loc!: LibraryOfCongressProvider;
    private chain!: ProviderChain;
    private repo!: BookRepository;

    async onload(): Promise<void> {
        await this.loadSettings();

        const ttlMs = this.settings.cacheHours * 60 * 60 * 1000;

        // Deliberately conservative. Open Library publishes no rate limit and
        // enforces one anyway, so the safe assumption is that a human browsing
        // is roughly the upper bound: a small burst, then a trickle.
        const olBucket = new TokenBucket({ capacity: 5, refillPerSecond: 0.5 });
        // Google's published free ceiling is 1,000 queries per day. One per
        // second with a small burst stays far below it.
        const googleBucket = new TokenBucket({ capacity: 5, refillPerSecond: 1 });
        // The Archive publishes no figure but asks callers to cache and be
        // considerate, so this is deliberately gentle.
        const archiveBucket = new TokenBucket({ capacity: 3, refillPerSecond: 0.5 });
        // The Library of Congress documents 20 requests a minute and blocks
        // for a full HOUR if exceeded. Every other source here forgives in
        // minutes, so this one runs at half the stated limit, not near it.
        const locBucket = new TokenBucket({ capacity: 3, refillPerSecond: 10 / 60 });

        this.client = new OpenLibraryClient(this.request, { ttlMs, bucket: olBucket });
        this.google = new GoogleBooksProvider(this.request, {
            ttlMs,
            apiKey: this.settings.googleApiKey || undefined,
            // Google rejects requests whose origin it cannot geolocate, so a
            // country is effectively mandatory. Detect it rather than making
            // the reader find a setting before their first search works.
            country: this.resolveCountry(),
            bucket: googleBucket,
        });

        this.archive = new InternetArchiveProvider(this.request, {
            ttlMs,
            bucket: archiveBucket,
        });

        this.loc = new LibraryOfCongressProvider(this.request, {
            ttlMs,
            bucket: locBucket,
        });

        const openLibrary = new OpenLibraryProvider(
            this.client,
            () => this.settings.preferredLanguage,
        );
        const byId: Record<string, BookProvider> = {
            openlibrary: openLibrary,
            googlebooks: this.google,
            loc: this.loc,
            internetarchive: this.archive,
        };
        // Order comes from settings, so a reader who finds one source better
        // for their library can put it first.
        this.chain = new ProviderChain(() =>
            this.settings.providers
                .map((id) => byId[id])
                .filter((p): p is BookProvider => p !== undefined),
        );
        this.repo = new BookRepository(this.createVaultAdapter(), () => this.settings);

        this.addSettingTab(new DogearSettingTab(this.app, this));

        // Ribbon icons and commands are cleaned up automatically on unload.
        this.addRibbonIcon('book-plus', 'Add a book', () => this.addBook());

        // No reference to the view is kept: Obsidian may build it more than
        // once, and holding one leaks.
        this.registerView(
            VIEW_TYPE_LIBRARY,
            (leaf) =>
                new LibraryView(leaf, {
                    all: () => this.repo.all(),
                    open: (path: string, newTab?: boolean) => this.openNote(path, newTab),
                    addBook: () => this.addBook(),
                }),
        );

        this.registerView(
            VIEW_TYPE_STATS,
            (leaf) => new StatsView(leaf, { all: () => this.repo.all() }),
        );

        this.addRibbonIcon('library', 'Open your library', () => void revealLibrary(this.app));

        this.addCommand({
            id: 'open-stats',
            name: 'Reading statistics',
            callback: () => void revealStats(this.app),
        });

        this.addCommand({
            id: 'open-library',
            name: 'Open your library',
            callback: () => void revealLibrary(this.app),
        });

        // Keep the grid in step with the vault without polling.
        this.registerEvent(
            this.app.metadataCache.on('changed', (file) => {
                if (this.isBookNote(file)) this.refreshLibrary();
            }),
        );
        this.registerEvent(
            this.app.vault.on('delete', () => this.refreshLibrary()),
        );
        this.registerEvent(
            this.app.vault.on('rename', () => this.refreshLibrary()),
        );

        this.addCommand({
            id: 'add-book',
            name: 'Add a book',
            callback: () => this.addBook(),
        });

        // Always available, and never dependent on a book source being up.
        this.addCommand({
            id: 'add-book-manually',
            name: 'Add a book manually',
            callback: () => this.addBookManually(),
        });

        // The in-note control panel. This is the primary interface: relying on
        // the command palette for progress logging is not a graphical one.
        this.registerMarkdownCodeBlockProcessor(DOGEAR_BLOCK, (_source, el, ctx) => {
            void this.renderPanel(el, ctx.sourcePath);
        });

        // Two more routes to the same place, because discoverability is the
        // whole problem being solved here.
        this.registerEvent(
            this.app.workspace.on('file-menu', (menu: Menu, file) => {
                if (file instanceof TFile && this.isBookNote(file)) {
                    menu.addItem((item) =>
                        item
                            .setTitle('Update reading progress')
                            .setIcon('book-open')
                            .onClick(() => void this.openBookModal(file)),
                    );
                }
            }),
        );
        this.registerEvent(
            this.app.workspace.on('editor-menu', (menu: Menu, _editor, view) => {
                const file = view instanceof MarkdownView ? view.file : null;
                if (file && this.isBookNote(file)) {
                    menu.addItem((item) =>
                        item
                            .setTitle('Update reading progress')
                            .setIcon('book-open')
                            .onClick(() => void this.openBookModal(file)),
                    );
                }
            }),
        );

        this.addCommand({
            id: 'set-cover',
            name: 'Set the cover for this book',
            checkCallback: (checking: boolean) => {
                const file = this.app.workspace.getActiveFile();
                if (!file || !this.isBookNote(file)) return false;
                if (!checking) {
                    void (async () => {
                        const book = await this.repo.load(file.path);
                        if (book) this.editCover(file.path, book);
                    })();
                }
                return true;
            },
        });

        this.addCommand({
            id: 'download-covers',
            name: 'Download covers into the vault',
            callback: () => void this.downloadCovers(),
        });

        this.addCommand({
            id: 'backfill-covers',
            name: 'Add missing covers',
            callback: () => void this.backfillCovers(),
        });

        this.addCommand({
            id: 'import-goodreads',
            name: 'Import from Goodreads',
            callback: () => this.importGoodreads(),
        });

        this.addCommand({
            id: 'update-progress',
            name: 'Update reading progress',
            // checkCallback so the command only appears when it can actually run.
            checkCallback: (checking: boolean) => {
                const file = this.app.workspace.getActiveFile();
                if (!file || !this.isBookNote(file)) return false;
                if (!checking) void this.openBookModal(file);
                return true;
            },
        });
    }

    onunload(): void {
        if (this.libraryRefreshHandle !== null) {
            window.clearTimeout(this.libraryRefreshHandle);
            this.libraryRefreshHandle = null;
        }
        // Nothing to detach. Commands, ribbon icons, settings tabs and
        // registered events are released by Obsidian.
        this.client?.clearCache();
        this.google?.clearCache();
        this.archive?.clearCache();
        this.loc?.clearCache();
    }

    // --- settings -----------------------------------------------------------

    async loadSettings(): Promise<void> {
        this.settings = normaliseSettings(await this.loadData());
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    // --- network ------------------------------------------------------------

    /**
     * Obsidian's requestUrl, adapted to the client's interface.
     *
     * requestUrl (rather than fetch) sidesteps CORS and behaves consistently
     * on mobile. It throws on non-2xx by default, so `throw: false` is set to
     * let the client apply its own retry policy.
     */
    private request = async (
        url: string,
        headers: Record<string, string>,
    ): Promise<HttpResponse> => {
        try {
            return await this.sendRequest(url, headers);
        } catch (err) {
            // `User-Agent` is a forbidden header name in browser contexts. On
            // platforms where requestUrl routes through the renderer, setting
            // it throws before any request is made. Open Library asks clients
            // to identify themselves, so we try to — but being unable to send
            // the header must not stop the plugin working.
            if ('User-Agent' in headers) {
                const { 'User-Agent': _omitted, ...rest } = headers;
                return await this.sendRequest(url, rest);
            }
            throw err;
        }
    };

    private async sendRequest(
        url: string,
        headers: Record<string, string>,
    ): Promise<HttpResponse> {
        const response = await requestUrl({ url, headers, method: 'GET', throw: false });

        // Header names are case-insensitive; lower-case them so Retry-After
        // can be found regardless of how the server capitalised it.
        const headersOut: Record<string, string> = {};
        for (const [k, v] of Object.entries(response.headers ?? {})) {
            headersOut[k.toLowerCase()] = String(v);
        }

        let json: unknown = null;
        let bodySnippet: string | undefined;
        try {
            json = response.json;
        } catch {
            json = null;
        }

        // Capture the raw body for EVERY failure, not just ones where JSON
        // parsing threw. Without this, an error response with a perfectly
        // readable body arrives as `json: null` with nothing to explain it,
        // and the cause has to be guessed at.
        if (response.status < 200 || response.status >= 300) {
            try {
                const text = response.text;
                if (text) bodySnippet = text.slice(0, 300).replace(/\s+/g, ' ').trim();
            } catch {
                bodySnippet = undefined;
            }
        }

        return { status: response.status, json, bodySnippet, headers: headersOut };
    }

    // --- vault adapter ------------------------------------------------------

    private createVaultAdapter(): VaultLike {
        const { vault, fileManager } = this.app;

        return {
            exists: (path: string): boolean =>
                vault.getFileByPath(normalizePath(path)) !== null,

            read: async (path: string): Promise<string> => {
                const file = this.mustGetFile(path);
                // cachedRead is preferred for reads we don't intend to write back.
                return vault.cachedRead(file);
            },

            create: async (path: string, content: string): Promise<void> => {
                await vault.create(normalizePath(path), content);
            },

            process: async (path: string, fn: (content: string) => string): Promise<void> => {
                const file = this.mustGetFile(path);
                await vault.process(file, fn);
            },

            processFrontMatter: async (path: string, fn: (fm: YamlMap) => void): Promise<void> => {
                const file = this.mustGetFile(path);
                await fileManager.processFrontMatter(file, (fm) => fn(fm as YamlMap));
            },

            ensureFolder: async (path: string): Promise<void> => {
                const normalised = normalizePath(path);
                if (normalised === '' || normalised === '/') return;
                const existing = vault.getAbstractFileByPath(normalised);
                if (existing instanceof TFolder) return;
                if (existing) {
                    throw new Error(`"${normalised}" exists but is not a folder`);
                }
                await vault.createFolder(normalised);
            },

            listNotes: (folder: string): string[] => {
                const prefix = normalizePath(folder);
                return vault
                    .getMarkdownFiles()
                    .filter((f) => (prefix === '' ? true : f.path.startsWith(`${prefix}/`)))
                    .map((f) => f.path);
            },
        };
    }

    /** Configured country, else the system locale's, else a sane default. */
    private resolveCountry(): string {
        if (this.settings.googleCountry) return this.settings.googleCountry;
        const fromLocale =
            countryFromLocale(typeof navigator !== 'undefined' ? navigator.language : undefined);
        return fromLocale ?? 'US';
    }

    private mustGetFile(path: string): TFile {
        const file = this.app.vault.getFileByPath(normalizePath(path));
        if (!file) throw new Error(`Note not found: ${path}`);
        return file;
    }

    // --- actions ------------------------------------------------------------

    private addBook(): void {
        openBookSearch(this.app, this.chain, async (hit: SearchHit) => {
            const notice = new Notice('Dogear: fetching book details…', 0);
            try {
                const meta = await this.chain.resolve(hit);
                const book: Book = {
                    schemaVersion: SCHEMA_VERSION,
                    title: meta.title,
                    authors: meta.authors,
                    cover: meta.cover,
                    isbn10: meta.isbn10,
                    isbn13: meta.isbn13,
                    publisher: meta.publisher,
                    published: meta.published,
                    tags: meta.tags,
                    metrics: { pages: meta.pages },
                    status: 'want-to-read',
                    sessions: [],
                    olWork: meta.olWork,
                    olEdition: meta.olEdition,
                    googleId: meta.googleId,
                };

                const existing = await this.repo.findExisting(book);
                if (existing) {
                    notice.hide();
                    new Notice(`Dogear: "${book.title}" is already in your library.`);
                    await this.openNote(existing);
                    return;
                }

                const { path } = await this.repo.create(book);
                notice.hide();
                new Notice(`Dogear: added "${book.title}".`);
                if (this.settings.openOnCreate) await this.openNote(path);
            } catch (err) {
                notice.hide();
                throw err;
            }
        },
        (title) => this.addBookManually(title),
        );
    }

    /**
     * Create a book from typed details.
     *
     * Deliberately has no dependency on any provider: this is the path that
     * works when every catalogue is unavailable, and for books no catalogue
     * has in the first place.
     */
    /**
     * Give a cover to every book that has an ISBN but no artwork.
     *
     * Costs no network requests: the cover URL is derived from the ISBN, and
     * the image is fetched by the note itself when displayed. Books without an
     * ISBN are left alone rather than given a broken link.
     */
    private async backfillCovers(): Promise<void> {
        const notice = new Notice('Dogear: looking for books without covers…', 0);
        try {
            const all = await this.repo.all();
            const missing = all.filter(
                (e) => !e.book.cover && (e.book.isbn13 || e.book.isbn10),
            );

            if (missing.length === 0) {
                notice.hide();
                const noIsbn = all.filter((e) => !e.book.cover).length;
                new Notice(
                    noIsbn > 0
                        ? `Dogear: no covers to add. ${noIsbn} ${noIsbn === 1 ? 'book has' : 'books have'} no ISBN to build one from.`
                        : 'Dogear: every book already has a cover.',
                );
                return;
            }

            let done = 0;
            for (const entry of missing) {
                const isbn = entry.book.isbn13 ?? entry.book.isbn10;
                if (!isbn) continue;
                await this.repo.save(entry.path, {
                    ...entry.book,
                    cover: coverUrlFromIsbn(isbn, 'M'),
                });
                done++;
            }
            notice.hide();
            new Notice(`Dogear: added covers to ${done} ${done === 1 ? 'book' : 'books'}.`);
        } catch (err) {
            notice.hide();
            const message = err instanceof Error ? err.message : String(err);
            new Notice(`Dogear: couldn't add covers. ${message}`);
        }
    }

    /** The founding use case: getting a dead Goodreads export into the vault. */
    private importGoodreads(): void {
        new GoodreadsImportModal(this.app, {
            defaultFormat: this.settings.defaultFormat,
            existing: () => this.repo.all(),
            create: async (book, notes) => {
                const { path } = await this.repo.create(book, notes);
                return path;
            },
        }).open();
    }

    private addBookManually(initialTitle?: string): void {
        new ManualBookModal(
            this.app,
            { initialTitle, defaultFormat: this.settings.defaultFormat },
            async (book) => {
                const existing = await this.repo.findExisting(book);
                if (existing) {
                    new Notice(`Dogear: "${book.title}" is already in your library.`);
                    await this.openNote(existing);
                    return;
                }
                const { path } = await this.repo.create(book);
                new Notice(`Dogear: added "${book.title}".`);
                if (this.settings.openOnCreate) await this.openNote(path);
            },
        ).open();
    }

    private isBookNote(file: TFile): boolean {
        const cache = this.app.metadataCache.getFileCache(file);
        const fm = cache?.frontmatter;
        if (fm && 'dogear' in fm) return true;
        // Fall back to folder membership, so notes made before the schema
        // stamp existed still open.
        const folder = normalizePath(this.settings.booksFolder);
        return folder !== '' && file.path.startsWith(`${folder}/`);
    }

    private async openBookModal(file: TFile): Promise<void> {
        const loaded = await this.repo.loadDetailed(file.path);
        if (!loaded) {
            new Notice("Dogear: couldn't read that note.");
            return;
        }
        if (loaded.unparsed.length > 0) {
            new Notice(
                `Dogear: ${loaded.unparsed.length} line(s) in the reading log couldn't be read and were left untouched.`,
            );
        }

        new BookDetailModal(this.app, {
            book: loaded.book,
            defaultFormat: this.settings.defaultFormat,
            onSave: async (book) => {
                await this.repo.save(file.path, book);
            },
            onOpenNote: () => void this.openNote(file.path),
        }).open();
    }

    /** Render the in-note panel for the book the block belongs to. */
    private async renderPanel(el: HTMLElement, sourcePath: string): Promise<void> {
        const loaded = await this.repo.loadDetailed(sourcePath);
        if (!loaded) {
            el.createDiv({ cls: 'dogear-panel__error', text: 'Dogear could not read this note.' });
            return;
        }

        const file = this.app.vault.getFileByPath(normalizePath(sourcePath));
        const panel = new BookPanel(el, {
            app: this.app,
            sourcePath,
            book: loaded.book,
            defaultFormat: this.settings.defaultFormat,
            save: async (book) => {
                await this.repo.save(sourcePath, book);
            },
            reload: async () => this.repo.load(sourcePath),
            openDetails: () => {
                if (file) void this.openBookModal(file);
            },
            editCover: () => this.editCover(sourcePath, loaded.book),
        });
        // Registering the child lets Obsidian unload it with the view, so no
        // references are held after the note closes.
        this.addChild(panel);
    }

    private libraryRefreshHandle: number | null = null;

    /**
     * Ask any open library tab to re-read the vault.
     *
     * Debounced, because a single keystroke in a book note fires a metadata
     * change, and re-reading every book on each one would make typing in a
     * large vault crawl.
     */
    private refreshLibrary(): void {
        const watching =
            this.app.workspace.getLeavesOfType(VIEW_TYPE_LIBRARY).length +
            this.app.workspace.getLeavesOfType(VIEW_TYPE_STATS).length;
        if (watching === 0) return;
        if (this.libraryRefreshHandle !== null) window.clearTimeout(this.libraryRefreshHandle);
        this.libraryRefreshHandle = window.setTimeout(() => {
            this.libraryRefreshHandle = null;
            this.doRefreshLibrary();
        }, 500);
    }

    private doRefreshLibrary(): void {
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_LIBRARY)) {
            const view = leaf.view;
            if (view instanceof LibraryView) void view.refresh();
        }
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_STATS)) {
            const view = leaf.view;
            if (view instanceof StatsView) void view.refresh();
        }
    }

    /**
     * Fetch remote covers and keep them in the vault.
     *
     * Deliberately slow. Open Library allows 100 cover lookups per address
     * every five minutes and asks that the service not be used for bulk
     * downloading, so this runs at well under a third of that rate. It is a
     * one-off cost for permanence, not something to hurry.
     *
     * Resumable: covers already present are adopted rather than refetched, so
     * stopping Obsidian part-way through loses nothing.
     */
    private async downloadCovers(): Promise<void> {
        const folder = this.settings.coverFolder;
        const entries = await this.repo.all();
        const jobs = planCoverDownloads(entries, folder);
        const { toFetch, alreadyThere } = partitionJobs(jobs, (p) =>
            this.app.vault.getFileByPath(normalizePath(p)) !== null,
        );

        // Adopt anything already downloaded, whatever else happens.
        for (const job of alreadyThere) {
            const fresh = await this.repo.load(job.path);
            if (fresh && fresh.cover !== job.target) {
                await this.repo.save(job.path, { ...fresh, cover: job.target });
            }
        }

        if (toFetch.length === 0) {
            new Notice(
                alreadyThere.length > 0
                    ? `Dogear: all ${alreadyThere.length} covers are already in your vault.`
                    : 'Dogear: no remote covers to download.',
            );
            return;
        }

        // Twelve a minute, against a documented limit of twenty.
        const perMinute = 12;
        const estimate = describeDuration(estimateSeconds(toFetch.length, perMinute));
        const notice = new Notice(
            `Dogear: downloading ${toFetch.length} covers. This will take ${estimate}, and you can keep working.`,
            8000,
        );
        void notice;

        await this.ensureCoverFolder(folder);
        const bucket = new TokenBucket({ capacity: 3, refillPerSecond: perMinute / 60 });

        let saved = 0;
        let missing = 0;
        let failed = 0;
        const progress = new Notice('Dogear: starting…', 0);

        try {
            for (let i = 0; i < toFetch.length; i++) {
                const job = toFetch[i];
                await bucket.take();
                progress.setMessage(
                    `Dogear: covers ${i + 1} of ${toFetch.length} — ${saved} saved, ${missing} unavailable`,
                );

                try {
                    const res = await requestUrl({ url: job.source, method: 'GET', throw: false });
                    if (res.status === 403 || res.status === 429) {
                        // Being asked to slow down mid-run: stop rather than
                        // push through and risk a longer block.
                        progress.hide();
                        new Notice(
                            `Dogear: the cover service asked us to slow down. Saved ${saved} so far — run the command again later to continue.`,
                        );
                        return;
                    }
                    if (res.status < 200 || res.status >= 300) {
                        missing++;
                        continue;
                    }
                    if (!looksLikeRealImage(res.arrayBuffer, res.headers?.['content-type'])) {
                        // A blank placeholder, not artwork worth keeping.
                        missing++;
                        continue;
                    }

                    await this.app.vault.createBinary(
                        normalizePath(job.target),
                        res.arrayBuffer,
                    );
                    const fresh = await this.repo.load(job.path);
                    if (fresh) await this.repo.save(job.path, { ...fresh, cover: job.target });
                    saved++;
                } catch {
                    failed++;
                }
            }
        } finally {
            progress.hide();
        }

        const parts = [`Dogear: saved ${saved} ${saved === 1 ? 'cover' : 'covers'}`];
        if (missing > 0) parts.push(`${missing} had no artwork available`);
        if (failed > 0) parts.push(`${failed} failed`);
        new Notice(`${parts.join('. ')}.`);
    }

    /** Create the cover folder, including any parents, if it is missing. */
    private async ensureCoverFolder(path: string): Promise<void> {
        const normalised = normalizePath(path);
        if (normalised === '' || normalised === '/') return;
        // Create each level in turn: createFolder does not make parents.
        const parts = normalised.split('/').filter((p) => p !== '');
        let sofar = '';
        for (const part of parts) {
            sofar = sofar === '' ? part : `${sofar}/${part}`;
            const existing = this.app.vault.getAbstractFileByPath(sofar);
            if (existing instanceof TFolder) continue;
            if (existing) throw new Error(`"${sofar}" exists but is not a folder`);
            await this.app.vault.createFolder(sofar);
        }
    }

    /** Let the reader set artwork Open Library does not have. */
    private editCover(path: string, book: Book): void {
        new CoverModal(
            this.app,
            { title: book.title, current: book.cover },
            async (cover) => {
                const fresh = (await this.repo.load(path)) ?? book;
                await this.repo.save(path, { ...fresh, cover });
                new Notice(cover ? 'Dogear: cover updated.' : 'Dogear: cover removed.');
            },
        ).open();
    }

    private async openNote(path: string, newTab = false): Promise<void> {
        const file = this.app.vault.getFileByPath(normalizePath(path));
        if (!file) return;
        // getLeaf(false) reuses the current tab, matching Obsidian's own
        // behaviour when opening a note from a modal. A modifier click asks
        // for a new one.
        await this.app.workspace.getLeaf(newTab ? 'tab' : false).openFile(file);
    }
}
