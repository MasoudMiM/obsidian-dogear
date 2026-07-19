// Dogear — the statistics view.
//
// Restraint is the feature. StoryGraph is praised specifically for not being
// cluttered the way Goodreads is, and a wall of charts is easy to build and
// tiring to read. So this page shows a small number of things that are always
// true, and hides any panel it has no real data for rather than displaying an
// empty frame.
//
// No charting library. Everything is CSS bars and plain elements: a book
// tracker should not carry a megabyte of JavaScript to draw eleven rectangles,
// and hand-built bars inherit the reader's theme for free, which no charting
// library manages convincingly in both light and dark.

import { ItemView, WorkspaceLeaf } from 'obsidian';
import { STATUS_LABELS, type Book } from '../model';
import {
    computeStats,
    describeListening,
    yearsPresent,
    type Bucket,
    type Stats,
} from '../stats';

export const VIEW_TYPE_STATS = 'dogear-stats';

export interface StatsHost {
    all: () => Promise<Array<{ path: string; book: Book }>>;
}

export class StatsView extends ItemView {
    private entries: Array<{ path: string; book: Book }> = [];
    private year: number | null = null;
    private loading = true;

    constructor(
        leaf: WorkspaceLeaf,
        private readonly host: StatsHost,
    ) {
        super(leaf);
    }

    getViewType(): string {
        return VIEW_TYPE_STATS;
    }

    getDisplayText(): string {
        return 'Reading statistics';
    }

    getIcon(): string {
        return 'bar-chart-2';
    }

    async onOpen(): Promise<void> {
        this.containerEl.children[1].addClass('dogear-stats');
        this.render();
        await this.refresh();
    }

    async refresh(): Promise<void> {
        this.loading = true;
        try {
            this.entries = await this.host.all();
            // Default to the most recent year with any reading in it, since
            // "this year" is the question people actually arrive with.
            const years = yearsPresent(this.entries.map((e) => e.book));
            if (this.year === null && years.length > 0) this.year = years[0];
        } finally {
            this.loading = false;
        }
        this.render();
    }

    async onClose(): Promise<void> {
        this.containerEl.children[1].empty();
    }

    private render(): void {
        const root = this.containerEl.children[1] as HTMLElement;
        const scroll = root.scrollTop;
        root.empty();

        if (this.loading) {
            root.createDiv({ cls: 'dogear-stats__empty', text: 'Reading your library…' });
            return;
        }

        const books = this.entries.map((e) => e.book);
        const years = yearsPresent(books);
        const stats = computeStats(this.entries, this.year);

        if (books.length === 0) {
            root.createDiv({
                cls: 'dogear-stats__empty',
                text: 'Nothing to report yet. Finish a book and this page will fill in.',
            });
            return;
        }

        this.renderYearPicker(root, years);
        this.renderHeadline(root, stats);
        this.renderTrend(root, stats);
        this.renderRatings(root, stats);
        this.renderLengths(root, stats);
        this.renderAuthors(root, stats);
        this.renderShelves(root, stats);

        root.scrollTop = scroll;
    }

    // --- span selector ------------------------------------------------------

    private renderYearPicker(parent: HTMLElement, years: number[]): void {
        if (years.length === 0) return;
        const bar = parent.createDiv({ cls: 'dogear-stats__years' });
        bar.setAttr('role', 'tablist');
        bar.setAttr('aria-label', 'Choose a period');

        const options: Array<[number | null, string]> = [
            ...years.slice(0, 6).map((y) => [y, String(y)] as [number, string]),
            [null, 'All time'],
        ];

        options.forEach(([value, label], index) => {
            const selected = this.year === value;
            const btn = bar.createEl('button', { cls: 'dogear-stats__year', text: label });
            btn.setAttr('type', 'button');
            btn.setAttr('role', 'tab');
            btn.setAttr('aria-selected', String(selected));
            btn.tabIndex = selected ? 0 : -1;
            if (selected) btn.addClass('is-active');

            btn.addEventListener('click', () => {
                this.year = value;
                this.render();
            });
            btn.addEventListener('keydown', (evt: KeyboardEvent) => {
                const step = evt.key === 'ArrowRight' ? 1 : evt.key === 'ArrowLeft' ? -1 : 0;
                if (step === 0) return;
                evt.preventDefault();
                const next = (index + step + options.length) % options.length;
                this.year = options[next][0];
                this.render();
                (this.containerEl.children[1] as HTMLElement)
                    .querySelectorAll<HTMLElement>('.dogear-stats__year')
                    [next]?.focus();
            });
        });
    }

    // --- the numbers people came for ---------------------------------------

    private renderHeadline(parent: HTMLElement, stats: Stats): void {
        const row = parent.createDiv({ cls: 'dogear-stats__headline' });

        const figure = (value: string, label: string, note?: string) => {
            const box = row.createDiv({ cls: 'dogear-stats__figure' });
            box.createDiv({ cls: 'dogear-stats__value', text: value });
            box.createDiv({ cls: 'dogear-stats__label', text: label });
            if (note) box.createDiv({ cls: 'dogear-stats__note', text: note });
        };

        figure(
            String(stats.finished),
            stats.finished === 1 ? 'book finished' : 'books finished',
            this.year === null && stats.undated > 0
                ? `${stats.undated} without a date`
                : undefined,
        );

        if (stats.pages > 0) {
            figure(
                stats.pages.toLocaleString(),
                'pages',
                stats.pagesUnknown > 0
                    ? `${stats.pagesUnknown} ${stats.pagesUnknown === 1 ? 'book has' : 'books have'} no page count`
                    : undefined,
            );
        }

        // Only shown when there is listening to report, so print readers are
        // not given a permanent zero.
        if (stats.seconds > 0) {
            figure(describeListening(stats.seconds).replace(/ hours?$/, ''), 'hours listened');
        }

        if (stats.averageRating !== null) {
            figure(
                `★ ${stats.averageRating}`,
                'average rating',
                `from ${stats.ratedCount} rated`,
            );
        }

        if (stats.averagePages !== null) {
            figure(stats.averagePages.toLocaleString(), 'average length');
        }
    }

    // --- year over year, or month by month ---------------------------------

    private renderTrend(parent: HTMLElement, stats: Stats): void {
        const data: Bucket[] =
            stats.byMonth ??
            stats.byYear.map((y) => ({ label: String(y.year), count: y.books }));
        if (data.length === 0) return;
        // A single bar is not a trend.
        if (stats.byMonth === null && data.length < 2) return;

        const panel = this.panel(
            parent,
            stats.byMonth ? 'Through the year' : 'Books finished each year',
        );
        this.renderColumns(panel, data);
    }

    // --- distributions ------------------------------------------------------

    private renderRatings(parent: HTMLElement, stats: Stats): void {
        if (stats.ratedCount === 0) return;
        const panel = this.panel(parent, 'How you rated them');
        this.renderBars(panel, stats.ratings, stats.ratedCount);
    }

    private renderLengths(parent: HTMLElement, stats: Stats): void {
        if (stats.lengths.length < 2) return;
        const panel = this.panel(parent, 'Book lengths');
        const total = stats.lengths.reduce((sum, b) => sum + b.count, 0);
        this.renderBars(panel, stats.lengths, total);

        if (stats.longest && stats.shortest && stats.longest.title !== stats.shortest.title) {
            const foot = panel.createDiv({ cls: 'dogear-stats__foot' });
            foot.createDiv({
                text: `Longest: ${stats.longest.title} (${stats.longest.pages.toLocaleString()} pages)`,
            });
            foot.createDiv({
                text: `Shortest: ${stats.shortest.title} (${stats.shortest.pages.toLocaleString()} pages)`,
            });
        }
    }

    private renderAuthors(parent: HTMLElement, stats: Stats): void {
        if (stats.authors.length === 0) return;
        const panel = this.panel(parent, 'Authors you came back to');
        const max = stats.authors[0].books;
        this.renderBars(
            panel,
            stats.authors.map((a) => ({ label: a.author, count: a.books })),
            max,
        );
    }

    private renderShelves(parent: HTMLElement, stats: Stats): void {
        const withBooks = stats.shelves.filter((s) => s.count > 0);
        if (withBooks.length === 0) return;

        const panel = this.panel(parent, 'Your shelves now');
        const row = panel.createDiv({ cls: 'dogear-stats__shelves' });
        for (const shelf of withBooks) {
            const item = row.createDiv({ cls: 'dogear-stats__shelf' });
            item.createDiv({ cls: 'dogear-stats__shelfcount', text: String(shelf.count) });
            item.createDiv({
                cls: 'dogear-stats__shelflabel',
                text: STATUS_LABELS[shelf.status],
            });
        }
    }

    // --- drawing ------------------------------------------------------------

    private panel(parent: HTMLElement, title: string): HTMLElement {
        const section = parent.createDiv({ cls: 'dogear-stats__panel' });
        section.createEl('h3', { cls: 'dogear-stats__title', text: title });
        return section;
    }

    /** Horizontal bars: best where labels are words. */
    private renderBars(parent: HTMLElement, buckets: Bucket[], max: number): void {
        const scale = Math.max(max, ...buckets.map((b) => b.count), 1);
        const list = parent.createDiv({ cls: 'dogear-stats__bars' });

        for (const bucket of buckets) {
            const row = list.createDiv({ cls: 'dogear-stats__bar' });
            row.createDiv({ cls: 'dogear-stats__barlabel', text: bucket.label });

            const track = row.createDiv({ cls: 'dogear-stats__bartrack' });
            const fill = track.createDiv({ cls: 'dogear-stats__barfill' });
            fill.style.setProperty(
                '--dogear-bar',
                `${bucket.count === 0 ? 0 : Math.max(2, (bucket.count / scale) * 100)}%`,
            );
            if (bucket.count === 0) fill.addClass('is-empty');

            row.createDiv({ cls: 'dogear-stats__barvalue', text: String(bucket.count) });
            row.setAttr('aria-label', `${bucket.label}: ${bucket.count}`);
        }
    }

    /** Vertical columns: best for time, where order carries meaning. */
    private renderColumns(parent: HTMLElement, buckets: Bucket[]): void {
        const scale = Math.max(...buckets.map((b) => b.count), 1);
        const chart = parent.createDiv({ cls: 'dogear-stats__columns' });

        for (const bucket of buckets) {
            const col = chart.createDiv({ cls: 'dogear-stats__column' });
            col.setAttr('aria-label', `${bucket.label}: ${bucket.count}`);

            const value = col.createDiv({ cls: 'dogear-stats__colvalue', text: String(bucket.count) });
            if (bucket.count === 0) value.addClass('is-empty');

            const track = col.createDiv({ cls: 'dogear-stats__coltrack' });
            const fill = track.createDiv({ cls: 'dogear-stats__colfill' });
            fill.style.setProperty(
                '--dogear-bar',
                `${bucket.count === 0 ? 0 : Math.max(3, (bucket.count / scale) * 100)}%`,
            );

            col.createDiv({ cls: 'dogear-stats__collabel', text: bucket.label });
        }
    }
}

/** Open the statistics tab, reusing one if it is already open. */
export async function openStats(app: {
    workspace: {
        getLeavesOfType: (t: string) => WorkspaceLeaf[];
        revealLeaf: (l: WorkspaceLeaf) => void;
        getLeaf: (t: 'tab') => WorkspaceLeaf;
    };
}): Promise<void> {
    const { workspace } = app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_STATS);
    if (existing.length > 0) {
        workspace.revealLeaf(existing[0]);
        return;
    }
    const leaf = workspace.getLeaf('tab');
    await leaf.setViewState({ type: VIEW_TYPE_STATS, active: true });
    workspace.revealLeaf(leaf);
}
