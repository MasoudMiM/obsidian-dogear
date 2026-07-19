// Dogear — Goodreads import.
//
// The founding use case. Goodreads' own export is the only way most people can
// get their reading history out, and the plugins that used to import it have
// gone unmaintained.
//
// Three principles shape this screen:
//
//   1. Nothing is written until you have seen what will be written. The
//      preview is the point; an importer that silently creates 800 notes is a
//      liability, not a feature.
//
//   2. Every book can be deselected individually. People's Goodreads accounts
//      accumulate a decade of "to-read" they no longer want.
//
//   3. Losses are stated plainly. Goodreads exports one read date even when it
//      says you read a book four times, and no importer can recover the rest.
//      Saying so is better than fabricating dates.

import { App, Modal, Notice, Setting } from 'obsidian';
import {
    duplicateKey,
    goodreadsToBook,
    importGoodreadsCsv,
    looksLikeGoodreadsExport,
    type GoodreadsBook,
    type ImportSummary,
} from '../goodreads';
import { STATUS_LABELS, type Book, type Format, type ReadingStatus } from '../model';
import { createMessage } from './components';

export interface ImportHost {
    defaultFormat: Format;
    /** Existing books, for spotting duplicates without rescanning per row. */
    existing: () => Promise<Array<{ path: string; book: Book }>>;
    create: (book: Book, notes: string) => Promise<string>;
}

interface Row {
    source: GoodreadsBook;
    selected: boolean;
    duplicate: boolean;
    el?: HTMLElement;
}

/** Human wording for each warning, used in the summary. */
const WARNING_TEXT: Record<string, (n: number) => string> = {
    'missing-read-date': (n) =>
        `${n} finished ${n === 1 ? 'book has' : 'books have'} no read date. They will be marked finished without one.`,
    'reread-history-lost': (n) =>
        `${n} ${n === 1 ? 'book was' : 'books were'} read more than once. Goodreads exports only the most recent date, so earlier reads cannot be recovered — a note is added to each.`,
    'no-page-count': (n) =>
        `${n} ${n === 1 ? 'book has' : 'books have'} no page count. Progress on those will be tracked by percentage until you add one.`,
    'missing-title': (n) =>
        `${n} ${n === 1 ? 'row' : 'rows'} had no title and will be skipped.`,
};

export class GoodreadsImportModal extends Modal {
    private summary: ImportSummary | null = null;
    private rows: Row[] = [];
    private skipDuplicates = true;
    private filter = '';
    private importing = false;

    constructor(
        app: App,
        private readonly host: ImportHost,
    ) {
        super(app);
        this.setTitle('Import from Goodreads');
        this.modalEl.addClass('dogear-import-modal');
    }

    onOpen(): void {
        this.renderPicker();
    }

    // --- step one: choose a file -------------------------------------------

    private renderPicker(): void {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('p', {
            cls: 'dogear-modal__intro',
            text: 'Export your library from Goodreads, then choose the file here. Nothing is written to your vault until you have reviewed what will be imported.',
        });

        const help = contentEl.createDiv({ cls: 'dogear-import__help' });
        help.createSpan({ text: 'On Goodreads: ' });
        const link = help.createEl('a', {
            text: 'My Books → Import and export',
            href: 'https://www.goodreads.com/review/import',
        });
        link.setAttr('rel', 'noopener');
        help.createSpan({
            text: ', then "Export Library". The file arrives by email and is named goodreads_library_export.csv.',
        });

        const feedback = contentEl.createDiv({ cls: 'dogear-log__feedback' });

        const picker = contentEl.createEl('input', { cls: 'dogear-import__file' });
        picker.type = 'file';
        picker.accept = '.csv,text/csv';
        picker.setAttr('aria-label', 'Goodreads export file');

        picker.addEventListener('change', () => {
            const file = picker.files?.[0];
            if (!file) return;
            feedback.empty();

            const reader = new FileReader();
            reader.onerror = () => {
                createMessage(feedback, "That file couldn't be read.", 'error');
            };
            reader.onload = () => {
                const text = typeof reader.result === 'string' ? reader.result : '';
                if (text.trim() === '') {
                    createMessage(feedback, 'That file is empty.', 'error');
                    return;
                }
                if (!looksLikeGoodreadsExport(text)) {
                    createMessage(
                        feedback,
                        "That doesn't look like a Goodreads export — the header row is missing the columns Dogear needs. Make sure you picked goodreads_library_export.csv.",
                        'error',
                    );
                    return;
                }
                void this.loadCsv(text);
            };
            reader.readAsText(file);
        });
    }

    private async loadCsv(text: string): Promise<void> {
        this.summary = importGoodreadsCsv(text);

        // Build a duplicate index once rather than scanning per book.
        const existing = await this.host.existing();
        const seen = new Set(existing.map((e) => duplicateKey(e.book)));

        this.rows = this.summary.books.map((source) => {
            const duplicate = seen.has(duplicateKey(source));
            return { source, duplicate, selected: !duplicate };
        });

        this.renderPreview();
    }

    // --- step two: review ---------------------------------------------------

    private renderPreview(): void {
        const { contentEl } = this;
        contentEl.empty();
        const summary = this.summary;
        if (!summary) return;

        const dupes = this.rows.filter((r) => r.duplicate).length;

        contentEl.createEl('p', {
            cls: 'dogear-import__count',
            text: `${summary.books.length} ${summary.books.length === 1 ? 'book' : 'books'} found${
                dupes > 0 ? `, ${dupes} already in your vault` : ''
            }.`,
        });

        // What will be lost or approximated, stated before anything is written.
        const notices = contentEl.createDiv({ cls: 'dogear-import__warnings' });
        for (const [kind, count] of Object.entries(summary.counts)) {
            if (count === 0) continue;
            const text = WARNING_TEXT[kind]?.(count);
            if (text) notices.createDiv({ cls: 'dogear-import__warning', text });
        }

        new Setting(contentEl)
            .setName('Skip books already in your vault')
            .setDesc('Matched by ISBN, or by title and author when there is no ISBN.')
            .addToggle((t) =>
                t.setValue(this.skipDuplicates).onChange((v) => {
                    this.skipDuplicates = v;
                    for (const row of this.rows) {
                        if (row.duplicate) row.selected = !v;
                    }
                    this.renderPreview();
                }),
            );

        // Bulk selection by shelf, since that is how people think about it.
        const groups = contentEl.createDiv({ cls: 'dogear-import__groups' });
        const statuses: ReadingStatus[] = ['finished', 'reading', 'want-to-read', 'dnf'];
        for (const status of statuses) {
            const inGroup = this.rows.filter((r) => r.source.status === status);
            if (inGroup.length === 0) continue;
            const btn = groups.createEl('button', {
                text: `${STATUS_LABELS[status]} (${inGroup.length})`,
            });
            btn.setAttr('type', 'button');
            btn.addEventListener('click', () => {
                const allOn = inGroup.every((r) => r.selected);
                for (const r of inGroup) r.selected = !allOn;
                this.renderPreview();
            });
        }

        const search = contentEl.createEl('input', { cls: 'dogear-import__filter' });
        search.type = 'search';
        search.placeholder = 'Filter by title or author';
        search.value = this.filter;
        search.setAttr('aria-label', 'Filter the list');
        search.addEventListener('input', () => {
            this.filter = search.value.toLowerCase();
            this.renderList(listEl);
        });

        const listEl = contentEl.createDiv({ cls: 'dogear-import__list' });
        this.renderList(listEl);

        const footer = contentEl.createDiv({ cls: 'dogear-import__footer' });
        const countEl = footer.createDiv({ cls: 'dogear-import__selected' });
        const update = () => {
            const n = this.rows.filter((r) => r.selected).length;
            countEl.setText(`${n} selected`);
        };
        update();

        new Setting(footer)
            .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
            .addButton((b) =>
                b
                    .setButtonText('Import selected')
                    .setCta()
                    .onClick(() => void this.run()),
            );
    }

    private renderList(host: HTMLElement): void {
        host.empty();
        const visible = this.rows.filter((row) => {
            if (this.filter === '') return true;
            const hay = `${row.source.title} ${row.source.authors.join(' ')}`.toLowerCase();
            return hay.includes(this.filter);
        });

        if (visible.length === 0) {
            host.createDiv({ cls: 'dogear-import__empty', text: 'Nothing matches that filter.' });
            return;
        }

        for (const row of visible) {
            const item = host.createDiv({ cls: 'dogear-import__row' });
            if (row.duplicate) item.addClass('is-duplicate');

            const box = item.createEl('input');
            box.type = 'checkbox';
            box.checked = row.selected;
            const label = `${row.source.title}${row.source.authors[0] ? ` by ${row.source.authors[0]}` : ''}`;
            box.setAttr('aria-label', label);
            box.addEventListener('change', () => {
                row.selected = box.checked;
            });

            const text = item.createDiv({ cls: 'dogear-import__rowtext' });
            text.createDiv({ cls: 'dogear-import__title', text: row.source.title });

            const bits: string[] = [];
            if (row.source.authors.length > 0) bits.push(row.source.authors[0]);
            bits.push(STATUS_LABELS[row.source.status]);
            if (row.source.rating) bits.push(`${row.source.rating}★`);
            if (row.source.dateRead) bits.push(row.source.dateRead);
            if (row.duplicate) bits.push('already in vault');
            text.createDiv({ cls: 'dogear-import__meta', text: bits.join(' · ') });
        }
    }

    // --- step three: write --------------------------------------------------

    private async run(): Promise<void> {
        if (this.importing) return;
        const chosen = this.rows.filter((r) => r.selected);
        if (chosen.length === 0) {
            new Notice('Dogear: nothing selected to import.');
            return;
        }

        this.importing = true;
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('p', { text: `Importing ${chosen.length} books…` });
        const bar = contentEl.createDiv({ cls: 'dogear-progress__track' });
        const fill = bar.createDiv({ cls: 'dogear-progress__fill' });
        const status = contentEl.createDiv({ cls: 'dogear-import__status' });

        let created = 0;
        const failures: string[] = [];

        for (let i = 0; i < chosen.length; i++) {
            const row = chosen[i];
            try {
                const { book, notes } = goodreadsToBook(row.source, this.host.defaultFormat);
                await this.host.create(book, notes);
                created++;
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                failures.push(`${row.source.title}: ${message}`);
            }

            const pct = Math.round(((i + 1) / chosen.length) * 100);
            fill.style.setProperty('--dogear-progress', `${pct}%`);
            status.setText(`${i + 1} of ${chosen.length}`);
            // Yield so the interface can actually paint between books.
            if (i % 10 === 0) await new Promise((r) => window.setTimeout(r, 0));
        }

        this.importing = false;
        this.renderResult(created, failures);
    }

    private renderResult(created: number, failures: string[]): void {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('p', {
            cls: 'dogear-import__count',
            text: `Imported ${created} ${created === 1 ? 'book' : 'books'}.`,
        });

        if (failures.length > 0) {
            const box = contentEl.createDiv({ cls: 'dogear-import__warnings' });
            box.createDiv({
                cls: 'dogear-import__warning',
                text: `${failures.length} could not be created:`,
            });
            // Every failure named. A count alone leaves nothing to act on.
            for (const f of failures.slice(0, 20)) {
                box.createDiv({ cls: 'dogear-import__warning is-muted', text: f });
            }
            if (failures.length > 20) {
                box.createDiv({
                    cls: 'dogear-import__warning is-muted',
                    text: `…and ${failures.length - 20} more.`,
                });
            }
        }

        new Setting(contentEl).addButton((b) =>
            b.setButtonText('Done').setCta().onClick(() => this.close()),
        );
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
