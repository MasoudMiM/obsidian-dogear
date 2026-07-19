// Dogear — the library view.
//
// The plugin's front door. Until now the only way to see your books was the
// file explorer, which is a list of filenames — fine for notes, useless for a
// library. Readers recognise books by their covers.
//
// Deliberately a full tab rather than a sidebar panel: a cover grid needs
// width, and this is a place you browse rather than glance at.
//
// Notes on the implementation:
//   - No reference to this view is held anywhere. Obsidian may construct it
//     more than once, and holding one leaks. Everything is reached through
//     getLeavesOfType.
//   - Covers are plain <img> tags pointing at Open Library. They cost no API
//     call, load lazily, and fall back to a typographic placeholder on 404,
//     so a book without artwork still looks deliberate.

import { ItemView, WorkspaceLeaf, type App } from 'obsidian';
import {
    STATUS_LABELS,
    currentFraction,
    type Book,
} from '../model';
import {
    SORT_LABELS,
    coverCandidates,
    isRemoteCover,
    filterBooks,
    sortBooks,
    type Filter,
    type Sort,
} from '../library';

export interface LibraryHost {
    /** Every book in the vault, freshly read. */
    all: () => Promise<Array<{ path: string; book: Book }>>;
    /** Open a book note, optionally in a new tab. */
    open: (path: string, newTab?: boolean) => Promise<void>;
    addBook: () => void;
}
import { describeRating } from '../format';

export const VIEW_TYPE_LIBRARY = 'dogear-library';

export class LibraryView extends ItemView {
    private entries: Array<{ path: string; book: Book }> = [];
    private filter: Filter = 'all';
    private sort: Sort = 'recent';
    private query = '';
    private loading = true;

    constructor(
        leaf: WorkspaceLeaf,
        private readonly host: LibraryHost,
    ) {
        super(leaf);
    }

    getViewType(): string {
        return VIEW_TYPE_LIBRARY;
    }

    getDisplayText(): string {
        return 'Library';
    }

    getIcon(): string {
        return 'library';
    }

    async onOpen(): Promise<void> {
        this.containerEl.children[1].addClass('dogear-library');
        this.render();
        await this.refresh();
    }

    /** Re-read every book and redraw. */
    async refresh(): Promise<void> {
        this.loading = true;
        try {
            this.entries = await this.host.all();
        } finally {
            this.loading = false;
        }
        this.render();
    }

    async onClose(): Promise<void> {
        this.containerEl.children[1].empty();
    }

    /**
     * Redraw, keeping the reader's place.
     *
     * A redraw is triggered by any note edit, including ones the reader is
     * making elsewhere. Rebuilding the DOM blindly would clear the search box
     * mid-word and throw away the scroll position — so both are captured and
     * restored around the rebuild.
     */
    private render(): void {
        const root = this.containerEl.children[1] as HTMLElement;

        const active = document.activeElement;
        const wasSearching = active instanceof HTMLInputElement && root.contains(active);
        const caret = wasSearching ? active.selectionStart : null;
        const scroll = root.scrollTop;

        root.empty();
        this.renderControls(root);
        this.renderBody(root);

        if (wasSearching) {
            const box = root.querySelector<HTMLInputElement>('.dogear-library__search');
            if (box) {
                box.focus();
                if (caret !== null) box.setSelectionRange(caret, caret);
            }
        }
        root.scrollTop = scroll;
    }

    private renderBody(root: HTMLElement): void {
        if (this.loading) {
            root.createDiv({ cls: 'dogear-library__empty', text: 'Reading your library…' });
            return;
        }

        if (this.entries.length === 0) {
            this.renderFirstRun(root);
            return;
        }

        const shown = sortBooks(filterBooks(this.entries, this.filter, this.query), this.sort);

        if (shown.length === 0) {
            root.createDiv({ cls: 'dogear-library__empty', text: this.emptyMessage() });
            return;
        }

        const grid = root.createDiv({ cls: 'dogear-library__grid' });
        for (const entry of shown) this.renderCard(grid, entry);
    }

    /**
     * Why the grid is empty. Saying "nothing matches that search" when there
     * is no search is worse than saying nothing: it sends the reader looking
     * for a filter they never set.
     */
    private emptyMessage(): string {
        if (this.query.trim() !== '') return 'Nothing matches that search.';
        if (this.filter === 'all') return 'No books yet.';
        return `Nothing on the ${STATUS_LABELS[this.filter].toLowerCase()} shelf yet.`;
    }

    private renderControls(parent: HTMLElement): void {
        const bar = parent.createDiv({ cls: 'dogear-library__bar' });

        // Counts on the tabs, so the shape of the library is visible at once.
        const tabs = bar.createDiv({ cls: 'dogear-library__tabs' });
        tabs.setAttr('role', 'tablist');
        const options: Array<[Filter, string]> = [
            ['all', 'All'],
            ['reading', STATUS_LABELS.reading],
            ['want-to-read', STATUS_LABELS['want-to-read']],
            ['finished', STATUS_LABELS.finished],
            ['dnf', STATUS_LABELS.dnf],
        ];
        // A tablist is expected to be navigable with arrow keys, with only
        // the selected tab in the tab order. Tabbing through five shelves to
        // reach the search box is the alternative, and it is tiresome.
        const buttons: HTMLElement[] = [];
        options.forEach(([value, label], index) => {
            const count =
                value === 'all'
                    ? this.entries.length
                    : this.entries.filter((e) => e.book.status === value).length;
            const selected = this.filter === value;

            const btn = tabs.createEl('button', {
                cls: 'dogear-library__tab',
                text: count > 0 ? `${label} (${count})` : label,
            });
            btn.setAttr('type', 'button');
            btn.setAttr('role', 'tab');
            btn.setAttr('aria-selected', String(selected));
            btn.tabIndex = selected ? 0 : -1;
            if (selected) btn.addClass('is-active');
            buttons.push(btn);

            btn.addEventListener('click', () => {
                this.filter = value;
                this.render();
            });

            btn.addEventListener('keydown', (evt: KeyboardEvent) => {
                const step =
                    evt.key === 'ArrowRight' ? 1 : evt.key === 'ArrowLeft' ? -1 : 0;
                let target: number | null = null;
                if (step !== 0) target = (index + step + options.length) % options.length;
                else if (evt.key === 'Home') target = 0;
                else if (evt.key === 'End') target = options.length - 1;
                if (target === null) return;

                evt.preventDefault();
                this.filter = options[target][0];
                this.render();
                // Keep focus on the tab strip after the redraw.
                const tabEls = (this.containerEl.children[1] as HTMLElement).querySelectorAll<HTMLElement>(
                    '.dogear-library__tab',
                );
                tabEls[target]?.focus();
            });
        });

        const tools = bar.createDiv({ cls: 'dogear-library__tools' });

        const search = tools.createEl('input', { cls: 'dogear-library__search' });
        search.type = 'search';
        search.placeholder = 'Search title, author or series';
        search.value = this.query;
        search.setAttr('aria-label', 'Search your library');
        search.addEventListener('input', () => {
            this.query = search.value;
            // Redraw only the grid so the search box keeps focus and caret.
            this.renderGridOnly();
        });

        const sort = tools.createEl('select', { cls: 'dropdown dogear-library__sort' });
        sort.setAttr('aria-label', 'Sort books');
        for (const key of Object.keys(SORT_LABELS) as Sort[]) {
            const opt = sort.createEl('option', { text: SORT_LABELS[key] });
            opt.value = key;
        }
        sort.value = this.sort;
        sort.addEventListener('change', () => {
            this.sort = sort.value as Sort;
            this.renderGridOnly();
        });
    }

    /** Redraw the grid without touching the controls, to preserve focus. */
    private renderGridOnly(): void {
        const root = this.containerEl.children[1] as HTMLElement;
        const existing = root.querySelector('.dogear-library__grid');
        const empty = root.querySelector('.dogear-library__empty');
        existing?.remove();
        empty?.remove();

        const shown = sortBooks(filterBooks(this.entries, this.filter, this.query), this.sort);
        if (shown.length === 0) {
            root.createDiv({ cls: 'dogear-library__empty', text: this.emptyMessage() });
            return;
        }
        const grid = root.createDiv({ cls: 'dogear-library__grid' });
        for (const entry of shown) this.renderCard(grid, entry);
    }

    private renderFirstRun(parent: HTMLElement): void {
        const box = parent.createDiv({ cls: 'dogear-library__empty' });
        box.createDiv({ cls: 'dogear-library__emptytitle', text: 'No books yet' });
        box.createDiv({
            text: 'Add a book to get started, or import your library from Goodreads.',
        });
        const btn = box.createEl('button', { cls: 'mod-cta', text: 'Add a book' });
        btn.setAttr('type', 'button');
        btn.addEventListener('click', () => this.host.addBook());
    }

    private renderCard(grid: HTMLElement, entry: { path: string; book: Book }): void {
        const { book, path } = entry;

        // A div rather than a button: a button may only contain phrasing
        // content, and these cards hold images and stacked text. The ARIA
        // role and key handling below give it the same behaviour honestly.
        const card = grid.createDiv({ cls: 'dogear-card' });
        card.setAttr('role', 'button');
        card.tabIndex = 0;
        const label = [book.title, book.authors[0]].filter(Boolean).join(', by ');
        card.setAttr('aria-label', `Open ${label}`);

        // Ctrl/Cmd-click and middle-click open in a new tab, as they do
        // everywhere else in Obsidian. Breaking that convention in one view
        // is the kind of small wrongness people cannot name but do notice.
        card.addEventListener('click', (evt: MouseEvent) => {
            void this.host.open(path, evt.ctrlKey || evt.metaKey);
        });
        card.addEventListener('auxclick', (evt: MouseEvent) => {
            if (evt.button !== 1) return;
            evt.preventDefault();
            void this.host.open(path, true);
        });
        card.addEventListener('keydown', (evt: KeyboardEvent) => {
            if (evt.key !== 'Enter' && evt.key !== ' ') return;
            evt.preventDefault();
            void this.host.open(path, false);
        });

        const art = card.createDiv({ cls: 'dogear-card__art' });
        // A cover kept in the vault has to be turned into a displayable
        // address; a web one is already usable.
        const candidates = coverCandidates(book)
            .map((c) => (isRemoteCover(c) ? c : this.resolveVaultCover(c)))
            .filter((c): c is string => c !== null);
        if (candidates.length > 0) {
            const img = art.createEl('img', { cls: 'dogear-card__img' });
            img.alt = '';
            // Lazy, so opening a large library does not request hundreds of
            // images at once — Open Library allows 100 ISBN cover lookups per
            // five minutes and answers 403 beyond that.
            img.loading = 'lazy';

            let attempt = 0;
            const next = () => {
                attempt++;
                if (attempt < candidates.length) {
                    // Coverage differs between a book's ISBN-10 and ISBN-13,
                    // so the other one is worth a try before giving up.
                    img.src = candidates[attempt];
                    return;
                }
                img.remove();
                this.renderPlaceholder(art, book);
            };

            img.addEventListener('error', next);
            // A 1x1 image is a missing cover wearing a success code. Open
            // Library serves one unless asked not to, and an address stored
            // before we started asking will still arrive that way.
            img.addEventListener('load', () => {
                if (img.naturalWidth <= 1 || img.naturalHeight <= 1) next();
            });
            img.src = candidates[0];
        } else {
            this.renderPlaceholder(art, book);
        }

        // Progress sits on the artwork for books in progress only.
        if (book.status === 'reading') {
            const fraction = currentFraction(book.sessions);
            const bar = art.createDiv({ cls: 'dogear-card__progress' });
            const fill = bar.createDiv({ cls: 'dogear-card__progressfill' });
            fill.style.setProperty('--dogear-progress', `${Math.round(fraction * 100)}%`);
            bar.setAttr('aria-label', `${Math.round(fraction * 100)}% read`);
        }

        const text = card.createDiv({ cls: 'dogear-card__text' });
        text.createDiv({ cls: 'dogear-card__title', text: book.title });
        if (book.authors.length > 0) {
            text.createDiv({ cls: 'dogear-card__author', text: book.authors[0] });
        }
        if (book.rating !== undefined) {
            // "★ 4.5" rather than "4.5 stars": in a dense grid a glyph is read
            // at a glance where a word has to be parsed, and the numeral keeps
            // quarter-star ratings exact in a way drawn stars cannot.
            const rating = text.createDiv({
                cls: 'dogear-card__rating',
                text: `★ ${book.rating}`,
            });
            rating.setAttr('aria-label', describeRating(book.rating));
        }
    }

    /** Turn a vault path into an address the browser can load. */
    private resolveVaultCover(path: string): string | null {
        const file = this.app.metadataCache.getFirstLinkpathDest(path, '');
        return file ? this.app.vault.getResourcePath(file) : null;
    }

    /** Typographic fallback: the title, set large, on a tinted card. */
    private renderPlaceholder(parent: HTMLElement, book: Book): void {
        const box = parent.createDiv({ cls: 'dogear-card__placeholder' });
        box.createDiv({ cls: 'dogear-card__placeholdertitle', text: book.title });
        if (book.authors[0]) {
            box.createDiv({ cls: 'dogear-card__placeholderauthor', text: book.authors[0] });
        }
    }
}

/** Open the library, reusing an existing tab if one is already open. */
export async function openLibrary(app: App): Promise<void> {
    const { workspace } = app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_LIBRARY);
    if (existing.length > 0) {
        await workspace.revealLeaf(existing[0]);
        return;
    }
    const leaf = workspace.getLeaf('tab');
    await leaf.setViewState({ type: VIEW_TYPE_LIBRARY, active: true });
    await workspace.revealLeaf(leaf);
}
