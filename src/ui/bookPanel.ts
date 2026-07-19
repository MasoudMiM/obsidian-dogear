// Dogear — the in-note control panel.
//
// Every book note carries a small `dogear` code block, which renders as this
// panel. It is the answer to a fair complaint: progress logging that lives
// only in the command palette is not a graphical interface, it is a keyboard
// shortcut with extra steps.
//
// Rendering into the note rather than a sidebar means the controls are where
// the book is, they work in reading view and on mobile, and they survive being
// synced to another device. The block is plain text, so a vault opened without
// Dogear installed shows a small code block and nothing is lost.

import { MarkdownRenderChild, Notice, type App } from 'obsidian';
import {
    type Book,
    type Format,
    type ReadingStatus,
    FORMAT_LABELS,
    STATUS_LABELS,
    currentFraction,
    completedReadCount,
    formatBreakdown,
} from '../model';
import {
    normalisePosition,
    parseDuration,
    projectedDaysRemaining,
    unitsForFormat,
} from '../progress';
import { POSITION_UNIT_LABELS, type PositionUnit } from '../model';
import { logProgress, applyStatus, startReread } from '../repository';
import { todayIso } from '../format';
import { createRating, createSegmented, createMessage } from './components';

/** The language tag that triggers this panel. */
export const DOGEAR_BLOCK = 'dogear';

/** The block inserted into every new book note. */
export const DOGEAR_BLOCK_SOURCE = '```dogear\n```';

const STATUS_ICONS: Record<ReadingStatus, string> = {
    'want-to-read': 'bookmark',
    reading: 'book-open',
    finished: 'check',
    dnf: 'circle-slash',
};

const FORMAT_ICONS: Record<Format, string> = {
    print: 'book',
    ebook: 'tablet',
    audio: 'headphones',
};

export interface PanelOptions {
    app: App;
    /** Path of the note this panel belongs to. */
    sourcePath: string;
    book: Book;
    defaultFormat: Format;
    save: (book: Book) => Promise<void>;
    /** Re-read the book from disk after an external change. */
    reload: () => Promise<Book | null>;
    /** Open the full detail modal, for history and less common actions. */
    openDetails: () => void;
    /** Open the cover picker. */
    editCover: () => void;
}

/**
 * A render child so Obsidian can tear the panel down when the note closes.
 * Holding no references outside this object is what keeps it leak-free.
 */
export class BookPanel extends MarkdownRenderChild {
    private book: Book;
    private format: Format;
    private unit: PositionUnit;
    private busy = false;

    constructor(
        containerEl: HTMLElement,
        private readonly options: PanelOptions,
    ) {
        super(containerEl);
        this.book = options.book;
        const last = this.book.sessions[this.book.sessions.length - 1];
        this.format = last?.format ?? options.defaultFormat;
        this.unit = unitsForFormat(this.format, this.book.metrics)[0];
    }

    onload(): void {
        this.render();

        // Watch for edits made outside the panel — most importantly adding a
        // `pages` property by hand, which is what unlocks page-number
        // logging. Without this the panel keeps showing whatever it read when
        // the note was first opened.
        this.registerEvent(
            this.options.app.metadataCache.on('changed', (file) => {
                if (file.path !== this.options.sourcePath) return;
                void this.refresh();
            }),
        );
    }

    /**
     * Re-read the book and redraw, but only if something actually changed.
     *
     * Our own saves also fire the change event, so redrawing unconditionally
     * would fight the user's cursor and could loop.
     */
    private async refresh(): Promise<void> {
        if (this.busy) return;
        const next = await this.options.reload();
        if (!next) return;
        if (JSON.stringify(next) === JSON.stringify(this.book)) return;
        this.book = next;
        // Units depend on whether a page count exists, so recompute them.
        const units = unitsForFormat(this.format, this.book.metrics);
        if (!units.includes(this.unit)) this.unit = units[0];
        this.render();
    }

    private async persist(next: Book): Promise<void> {
        if (this.busy) return;
        this.busy = true;
        this.book = next;
        try {
            await this.options.save(next);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            new Notice(`Dogear: couldn't save. ${message}`);
        } finally {
            this.busy = false;
        }
        this.render();
    }

    /**
     * What the panel shows depends entirely on where the book is.
     *
     * A single screen showing every control in every state was the original
     * mistake: it offered progress logging on a finished book, which is
     * incoherent, and quietly turned it into a reread. Each state now offers
     * only the actions that mean something in that state.
     */
    private render(): void {
        const root = this.containerEl;
        root.empty();
        root.addClass('dogear-panel');

        this.renderStatus(root);

        switch (this.book.status) {
            case 'want-to-read':
                this.renderNotStarted(root);
                break;
            case 'reading':
                this.renderReading(root);
                break;
            case 'finished':
                this.renderFinished(root);
                break;
            case 'dnf':
                this.renderAbandoned(root);
                break;
        }
    }

    // --- want to read -------------------------------------------------------

    private renderNotStarted(parent: HTMLElement): void {
        // No progress bar: it would always read 0% and says nothing. No
        // rating either — you have not read it yet.
        parent.createDiv({
            cls: 'dogear-panel__note',
            text: 'Not started yet.',
        });

        const row = parent.createDiv({ cls: 'dogear-log__row' });
        row.createDiv({ cls: 'dogear-log__label', text: 'Format' });
        this.renderFormatPicker(row);

        const actions = parent.createDiv({ cls: 'dogear-panel__actions' });
        const start = actions.createEl('button', {
            cls: 'mod-cta',
            text: 'Start reading',
        });
        start.setAttr('type', 'button');
        start.addEventListener('click', () => {
            void this.persist(
                applyStatus(this.book, 'reading', todayIso(), this.format),
            );
        });
        this.renderCoverButton(actions);
        this.renderDetailsButton(actions);
    }

    // --- reading ------------------------------------------------------------

    private renderReading(parent: HTMLElement): void {
        this.renderProgressBar(parent);
        this.renderLogRow(parent);

        const actions = parent.createDiv({ cls: 'dogear-panel__actions' });
        const finish = actions.createEl('button', { cls: 'mod-cta', text: 'Mark finished' });
        finish.setAttr('type', 'button');
        finish.addEventListener('click', () => {
            void this.persist(applyStatus(this.book, 'finished', todayIso(), this.format));
        });

        const stop = actions.createEl('button', { text: 'Stop reading' });
        stop.setAttr('type', 'button');
        stop.addEventListener('click', () => {
            void this.persist(applyStatus(this.book, 'dnf', todayIso(), this.format));
        });

        this.renderCoverButton(actions);
        this.renderDetailsButton(actions);
        this.renderRating(parent, 'Rating');
    }

    // --- finished -----------------------------------------------------------

    private renderFinished(parent: HTMLElement): void {
        const last = this.book.sessions[this.book.sessions.length - 1];
        const reads = completedReadCount(this.book.sessions);

        const bits: string[] = [];
        if (last?.finished) bits.push(`Finished on ${last.finished}`);
        if (last?.started && last.started !== last.finished) {
            bits.push(`started ${last.started}`);
        }
        if (reads > 1) bits.push(`read ${reads} times`);
        parent.createDiv({
            cls: 'dogear-panel__note',
            text: bits.length > 0 ? bits.join(' · ') : 'Finished.',
        });

        // Rating is the main thing you want to do having finished a book, so
        // it leads here rather than sitting at the bottom.
        this.renderRating(parent, 'How was it?');

        const actions = parent.createDiv({ cls: 'dogear-panel__actions' });
        const again = actions.createEl('button', { text: 'Read it again' });
        again.setAttr('type', 'button');
        again.addEventListener('click', () => {
            void this.persist(startReread(this.book, this.format, todayIso()));
        });
        this.renderCoverButton(actions);
        this.renderDetailsButton(actions);
    }

    // --- did not finish -----------------------------------------------------

    private renderAbandoned(parent: HTMLElement): void {
        const last = this.book.sessions[this.book.sessions.length - 1];
        const stopped = last?.abandoned;

        const summary = stopped
            ? `Stopped at ${Math.round(stopped.fraction * 100)}%`
            : 'Set aside.';
        parent.createDiv({ cls: 'dogear-panel__note', text: summary });
        if (stopped?.reason) {
            parent.createDiv({ cls: 'dogear-panel__reason', text: `“${stopped.reason}”` });
        }

        this.renderRating(parent, 'Rating');

        const actions = parent.createDiv({ cls: 'dogear-panel__actions' });
        const resume = actions.createEl('button', { cls: 'mod-cta', text: 'Pick it up again' });
        resume.setAttr('type', 'button');
        resume.addEventListener('click', () => {
            void this.persist(startReread(this.book, this.format, todayIso()));
        });
        this.renderCoverButton(actions);
        this.renderDetailsButton(actions);
    }

    // --- shared pieces ------------------------------------------------------

    /** Let the reader supply artwork Open Library does not have. */
    private renderCoverButton(parent: HTMLElement): void {
        const btn = parent.createEl('button', {
            cls: 'dogear-panel__details',
            text: this.book.cover ? 'Change cover' : 'Add cover',
        });
        btn.setAttr('type', 'button');
        btn.addEventListener('click', () => this.options.editCover());
    }

    private renderDetailsButton(parent: HTMLElement): void {
        const details = parent.createEl('button', {
            cls: 'dogear-panel__details',
            text: 'History and details',
        });
        details.setAttr('type', 'button');
        details.addEventListener('click', () => this.options.openDetails());
    }

    private renderFormatPicker(parent: HTMLElement): void {
        createSegmented<Format>(parent, {
            label: 'Reading format',
            value: this.format,
            choices: (Object.keys(FORMAT_LABELS) as Format[]).map((value) => ({
                value,
                label: FORMAT_LABELS[value],
                icon: FORMAT_ICONS[value],
            })),
            onChange: (format) => {
                this.format = format;
                this.unit = unitsForFormat(format, this.book.metrics)[0];
                this.render();
            },
        });
    }

    private renderRating(parent: HTMLElement, label: string): void {
        const row = parent.createDiv({ cls: 'dogear-panel__rating' });
        row.createSpan({ cls: 'dogear-log__label', text: label });
        createRating(row, {
            value: this.book.rating,
            onChange: (rating) => {
                this.book = { ...this.book, rating };
                void this.options.save(this.book).catch((err: unknown) => {
                    const message = err instanceof Error ? err.message : String(err);
                    new Notice(`Dogear: couldn't save the rating. ${message}`);
                });
            },
        });
    }

    private renderStatus(parent: HTMLElement): void {
        const row = parent.createDiv({ cls: 'dogear-panel__row' });
        createSegmented<ReadingStatus>(row, {
            label: 'Reading status',
            value: this.book.status,
            choices: (Object.keys(STATUS_LABELS) as ReadingStatus[]).map((value) => ({
                value,
                label: STATUS_LABELS[value],
                icon: STATUS_ICONS[value],
            })),
            onChange: (status) => {
                void this.persist(
                    applyStatus(this.book, status, todayIso(), this.format),
                );
            },
        });
    }

    private renderProgressBar(parent: HTMLElement): void {
        const fraction = currentFraction(this.book.sessions);
        const wrap = parent.createDiv({ cls: 'dogear-progress' });

        const track = wrap.createDiv({ cls: 'dogear-progress__track' });
        track.setAttr('role', 'progressbar');
        track.setAttr('aria-valuemin', '0');
        track.setAttr('aria-valuemax', '100');
        track.setAttr('aria-valuenow', String(Math.round(fraction * 100)));
        track.setAttr('aria-label', 'Reading progress');
        const fill = track.createDiv({ cls: 'dogear-progress__fill' });
        fill.style.setProperty('--dogear-progress', `${Math.round(fraction * 1000) / 10}%`);

        const bits: string[] = [`${Math.round(fraction * 100)}%`];
        if (this.book.metrics.pages) {
            bits.push(
                `page ${Math.round(fraction * this.book.metrics.pages)} of ${this.book.metrics.pages}`,
            );
        }
        const reads = completedReadCount(this.book.sessions);
        if (reads > 0) bits.push(reads === 1 ? 'read once' : `read ${reads} times`);
        wrap.createDiv({ cls: 'dogear-progress__label', text: bits.join(' · ') });

        const last = this.book.sessions[this.book.sessions.length - 1];

        // When a book is being read in more than one medium, say how it
        // splits. Otherwise the format picker is the only hint, and it shows
        // what you are about to log rather than what you have done.
        if (last) {
            const breakdown = formatBreakdown(last);
            if (breakdown.length > 1) {
                const text = breakdown
                    .map((b) => `${Math.round(b.share * 100)}% ${FORMAT_LABELS[b.format].toLowerCase()}`)
                    .join(' · ');
                wrap.createDiv({ cls: 'dogear-progress__mix', text });
            }
        }

        if (last && !last.finished && !last.abandoned) {
            const days = projectedDaysRemaining(last.entries);
            if (days !== null) {
                wrap.createDiv({
                    cls: 'dogear-progress__pace',
                    text:
                        days === 0
                            ? 'On track to finish today'
                            : `About ${days} ${days === 1 ? 'day' : 'days'} left at your current pace`,
                });
            }
        }
    }

    private renderLogRow(parent: HTMLElement): void {
        const box = parent.createDiv({ cls: 'dogear-log' });

        const formatRow = box.createDiv({ cls: 'dogear-log__row' });
        formatRow.createDiv({ cls: 'dogear-log__label', text: 'Format' });
        this.renderFormatPicker(formatRow);

        const units = unitsForFormat(this.format, this.book.metrics);
        const entry = box.createDiv({ cls: 'dogear-log__row dogear-log__row--entry' });

        const unitSelect = entry.createEl('select', { cls: 'dropdown dogear-log__unit' });
        unitSelect.setAttr('aria-label', 'Progress unit');
        for (const u of units) {
            const opt = unitSelect.createEl('option', { text: POSITION_UNIT_LABELS[u] });
            opt.value = u;
        }
        unitSelect.value = this.unit;

        const isTime = this.unit === 'elapsed' || this.unit === 'remaining';
        const input = entry.createEl('input', { cls: 'dogear-log__value' });
        input.type = isTime ? 'text' : 'number';
        input.setAttr('aria-label', `Progress in ${POSITION_UNIT_LABELS[this.unit].toLowerCase()}`);
        input.placeholder = isTime ? 'e.g. 2:30' : this.unit === 'percent' ? '0–100' : 'Page number';

        const submit = entry.createEl('button', {
            cls: 'mod-cta dogear-log__submit',
            text: 'Log progress',
        });
        submit.setAttr('type', 'button');

        // An optional thought, tied to this point in the book. Kept to one
        // line on purpose: anything longer belongs in the note body, which
        // Dogear never touches.
        const noteInput = box.createEl('input', { cls: 'dogear-log__note' });
        noteInput.type = 'text';
        noteInput.placeholder = 'Add a thought about this point (optional)';
        noteInput.setAttr('aria-label', 'Note for this progress entry');

        const feedback = box.createDiv({ cls: 'dogear-log__feedback' });

        if (this.unit === 'remaining') {
            box.createDiv({
                cls: 'dogear-log__hint',
                text: 'Enter the time your player says is left — Dogear works out the rest.',
            });
        } else if (!this.book.metrics.pages && this.format !== 'audio') {
            box.createDiv({
                cls: 'dogear-log__hint',
                text: 'No page count on this book yet, so progress is tracked as a percentage. Add a "pages" property to log page numbers.',
            });
        }

        unitSelect.addEventListener('change', () => {
            this.unit = unitSelect.value as PositionUnit;
            this.render();
        });

        const commit = () => {
            feedback.empty();
            const raw = input.value.trim();
            if (raw === '') {
                createMessage(feedback, 'Enter a value first.', 'error');
                input.focus();
                return;
            }
            const value = isTime ? parseDuration(raw) : Number(raw);
            if (value === null || !Number.isFinite(value)) {
                createMessage(
                    feedback,
                    isTime
                        ? "That doesn't look like a time. Try 2:30 or 2h 30m."
                        : "That doesn't look like a number.",
                    'error',
                );
                input.focus();
                return;
            }
            const result = normalisePosition(this.unit, value, this.book.metrics);
            if (!result.ok) {
                createMessage(feedback, result.message, 'error');
                input.focus();
                return;
            }
            const note = noteInput.value.trim() || undefined;
            // Record the medium on the entry when it differs from the one the
            // session started in, so switching between print and audio
            // mid-book is captured rather than silently flattened.
            const session = this.book.sessions[this.book.sessions.length - 1];
            const entryFormat =
                session && !session.finished && !session.abandoned && session.format !== this.format
                    ? this.format
                    : undefined;
            void this.persist(
                logProgress(
                    this.book,
                    {
                        date: todayIso(),
                        fraction: result.fraction,
                        raw: result.raw,
                        format: entryFormat,
                        note,
                    },
                    this.format,
                ),
            );
        };

        submit.addEventListener('click', commit);
        for (const el of [input, noteInput]) {
            el.addEventListener('keydown', (evt: KeyboardEvent) => {
                if (evt.key === 'Enter') {
                    evt.preventDefault();
                    commit();
                }
            });
        }
    }
}
