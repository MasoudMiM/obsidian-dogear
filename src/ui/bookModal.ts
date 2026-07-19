// Dogear — book detail modal.
//
// The main interaction surface: set a status, log progress, rate a book, see
// its history. Everything here is clicking and picking; the only typing is a
// number or a timestamp copied off a player.
//
// The progress control is the piece that earns the plugin its keep. It changes
// shape with the format, and for audiobooks it accepts time REMAINING as well
// as time elapsed — because every player shows time left, and every other
// tracker makes you do the subtraction yourself.

import { App, Modal, Notice, Setting } from 'obsidian';
import {
    type Book,
    type Format,
    type PositionUnit,
    type ReadingStatus,
    FORMAT_LABELS,
    POSITION_UNIT_LABELS,
    STATUS_LABELS,
    currentFraction,
    completedReadCount,
} from '../model';
import {
    formatDuration,
    humaniseDuration,
    normalisePosition,
    parseDuration,
    projectedDaysRemaining,
    unitsForFormat,
} from '../progress';
import { renderPositionText } from '../note';
import { todayIso } from '../format';
import { abandonSession, applyStatus, logProgress } from '../repository';
import { createCover, createRating, createSegmented, createMessage } from './components';

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

export interface BookModalOptions {
    book: Book;
    defaultFormat: Format;
    /** Persist changes. Called after every edit. */
    onSave: (book: Book) => Promise<void>;
    /** Open the underlying note. */
    onOpenNote: () => void;
}

export class BookDetailModal extends Modal {
    private book: Book;
    private format: Format;
    private unit: PositionUnit;
    private saving = false;

    constructor(
        app: App,
        private readonly options: BookModalOptions,
    ) {
        super(app);
        this.book = options.book;

        const last = this.book.sessions[this.book.sessions.length - 1];
        this.format = last?.format ?? options.defaultFormat;
        this.unit = unitsForFormat(this.format, this.book.metrics)[0];

        this.setTitle(this.book.title);
        this.modalEl.addClass('dogear-book-modal');
    }

    onOpen(): void {
        this.render();
    }

    private async persist(next: Book): Promise<void> {
        this.book = next;
        if (this.saving) return;
        this.saving = true;
        try {
            await this.options.onSave(next);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            new Notice(`Dogear: couldn't save. ${message}`);
        } finally {
            this.saving = false;
        }
        this.render();
    }

    private render(): void {
        const { contentEl } = this;
        contentEl.empty();

        this.renderHeader(contentEl);
        this.renderStatus(contentEl);
        this.renderProgress(contentEl);
        this.renderRating(contentEl);
        this.renderHistory(contentEl);
        this.renderFooter(contentEl);
    }

    // --- header -------------------------------------------------------------

    private renderHeader(parent: HTMLElement): void {
        const header = parent.createDiv({ cls: 'dogear-book__header' });
        createCover(header, {
            url: this.book.cover,
            title: this.book.title,
            cls: 'dogear-cover--medium',
        });

        const meta = header.createDiv({ cls: 'dogear-book__meta' });
        if (this.book.authors.length > 0) {
            meta.createDiv({ cls: 'dogear-book__authors', text: this.book.authors.join(', ') });
        }

        const bits: string[] = [];
        if (this.book.series) {
            bits.push(
                this.book.seriesPosition
                    ? `${this.book.series} #${this.book.seriesPosition}`
                    : this.book.series,
            );
        }
        if (this.book.published) bits.push(this.book.published);
        if (this.book.metrics.pages) bits.push(`${this.book.metrics.pages} pages`);
        if (this.book.metrics.duration) bits.push(humaniseDuration(this.book.metrics.duration));
        if (bits.length > 0) meta.createDiv({ cls: 'dogear-book__facts', text: bits.join(' · ') });

        const reads = completedReadCount(this.book.sessions);
        if (reads > 1) {
            meta.createDiv({
                cls: 'dogear-book__reads',
                text: `Read ${reads} times`,
            });
        }
    }

    // --- status -------------------------------------------------------------

    private renderStatus(parent: HTMLElement): void {
        new Setting(parent).setName('Status').setHeading();

        createSegmented<ReadingStatus>(parent, {
            label: 'Reading status',
            value: this.book.status,
            choices: (Object.keys(STATUS_LABELS) as ReadingStatus[]).map((value) => ({
                value,
                label: STATUS_LABELS[value],
                icon: STATUS_ICONS[value],
            })),
            onChange: (status) => {
                if (status === 'dnf') {
                    // Abandoning asks one question rather than silently
                    // recording a position the reader never confirmed.
                    new AbandonModal(this.app, this.book, (fraction, reason) => {
                        void this.persist(
                            abandonSession(this.book, fraction, reason, todayIso()),
                        );
                    }).open();
                    return;
                }
                void this.persist(
                    applyStatus(this.book, status, todayIso(), this.options.defaultFormat),
                );
            },
        });
    }

    // --- progress -----------------------------------------------------------

    private renderProgress(parent: HTMLElement): void {
        new Setting(parent).setName('Progress').setHeading();

        const fraction = currentFraction(this.book.sessions);
        const bar = parent.createDiv({ cls: 'dogear-progress' });
        const track = bar.createDiv({ cls: 'dogear-progress__track' });
        track.setAttr('role', 'progressbar');
        track.setAttr('aria-valuemin', '0');
        track.setAttr('aria-valuemax', '100');
        track.setAttr('aria-valuenow', String(Math.round(fraction * 100)));
        track.setAttr('aria-label', 'Reading progress');
        const fill = track.createDiv({ cls: 'dogear-progress__fill' });
        fill.style.setProperty('--dogear-progress', `${Math.round(fraction * 1000) / 10}%`);

        const summary: string[] = [`${Math.round(fraction * 100)}%`];
        if (this.book.metrics.pages) {
            summary.push(`page ${Math.round(fraction * this.book.metrics.pages)} of ${this.book.metrics.pages}`);
        }
        bar.createDiv({ cls: 'dogear-progress__label', text: summary.join(' · ') });

        // Pace is computed from the log, never self-reported.
        const last = this.book.sessions[this.book.sessions.length - 1];
        if (last && !last.finished && !last.abandoned) {
            const days = projectedDaysRemaining(last.entries);
            if (days !== null) {
                bar.createDiv({
                    cls: 'dogear-progress__pace',
                    text:
                        days === 0
                            ? 'On track to finish today'
                            : `About ${days} ${days === 1 ? 'day' : 'days'} left at your current pace`,
                });
            }
        }

        this.renderLogControls(parent);
    }

    private renderLogControls(parent: HTMLElement): void {
        const box = parent.createDiv({ cls: 'dogear-log' });

        // Format first: it determines which units are even meaningful.
        const formatRow = box.createDiv({ cls: 'dogear-log__row' });
        formatRow.createDiv({ cls: 'dogear-log__label', text: 'Format' });
        createSegmented<Format>(formatRow, {
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

        const units = unitsForFormat(this.format, this.book.metrics);
        const entryRow = box.createDiv({ cls: 'dogear-log__row dogear-log__row--entry' });

        const unitSelect = entryRow.createEl('select', { cls: 'dropdown dogear-log__unit' });
        unitSelect.setAttr('aria-label', 'Progress unit');
        for (const u of units) {
            const opt = unitSelect.createEl('option', { text: POSITION_UNIT_LABELS[u] });
            opt.value = u;
        }
        unitSelect.value = this.unit;

        const isTime = this.unit === 'elapsed' || this.unit === 'remaining';
        const input = entryRow.createEl('input', { cls: 'dogear-log__value' });
        input.type = isTime ? 'text' : 'number';
        input.setAttr('aria-label', `Progress in ${POSITION_UNIT_LABELS[this.unit].toLowerCase()}`);
        input.placeholder = isTime ? 'e.g. 2:30' : this.unit === 'percent' ? '0–100' : 'Page number';
        if (!isTime) {
            input.min = '0';
            input.max = this.unit === 'percent' ? '100' : String(this.book.metrics.pages ?? 99999);
            if (this.unit === 'percent') input.step = '1';
        }

        const submit = entryRow.createEl('button', { cls: 'mod-cta dogear-log__submit', text: 'Log' });
        submit.setAttr('type', 'button');

        const feedback = box.createDiv({ cls: 'dogear-log__feedback' });

        // A hint that names the thing people actually see on screen.
        if (this.unit === 'remaining') {
            box.createDiv({
                cls: 'dogear-log__hint',
                text: 'Enter the time your player says is left — Dogear works out the rest.',
            });
        } else if (!this.book.metrics.pages && this.unit === 'percent' && this.format !== 'audio') {
            box.createDiv({
                cls: 'dogear-log__hint',
                text: 'No page count for this book, so progress is tracked as a percentage.',
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
                    isTime ? "That doesn't look like a time. Try 2:30 or 2h 30m." : "That doesn't look like a number.",
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

            const entry = {
                date: todayIso(),
                fraction: result.fraction,
                raw: result.raw,
            };
            void this.persist(logProgress(this.book, entry, this.format));
        };

        submit.addEventListener('click', commit);
        input.addEventListener('keydown', (evt: KeyboardEvent) => {
            if (evt.key === 'Enter') {
                evt.preventDefault();
                commit();
            }
        });
    }

    // --- rating -------------------------------------------------------------

    private renderRating(parent: HTMLElement): void {
        new Setting(parent).setName('Rating').setHeading();
        createRating(parent, {
            value: this.book.rating,
            onChange: (rating) => {
                // Don't re-render on every slider tick; just persist.
                this.book = { ...this.book, rating };
                void this.options.onSave(this.book).catch((err: unknown) => {
                    const message = err instanceof Error ? err.message : String(err);
                    new Notice(`Dogear: couldn't save the rating. ${message}`);
                });
            },
        });
    }

    // --- history ------------------------------------------------------------

    private renderHistory(parent: HTMLElement): void {
        if (this.book.sessions.length === 0) return;
        new Setting(parent).setName('History').setHeading();

        const list = parent.createEl('ul', { cls: 'dogear-history' });
        this.book.sessions.forEach((session, i) => {
            const item = list.createEl('li', { cls: 'dogear-history__item' });

            const title = item.createDiv({ cls: 'dogear-history__title' });
            title.setText(`Read ${i + 1} · ${FORMAT_LABELS[session.format]}`);

            const parts: string[] = [];
            if (session.started) parts.push(`Started ${session.started}`);
            if (session.finished) parts.push(`finished ${session.finished}`);
            if (session.abandoned) {
                parts.push(`stopped at ${Math.round(session.abandoned.fraction * 100)}%`);
                if (session.abandoned.reason) parts.push(`“${session.abandoned.reason}”`);
            }
            if (parts.length > 0) {
                item.createDiv({ cls: 'dogear-history__dates', text: parts.join(', ') });
            }

            if (session.entries.length > 0) {
                const entries = item.createEl('ul', { cls: 'dogear-history__entries' });
                // Most recent first: that is what people look for.
                [...session.entries]
                    .sort((a, b) => b.date.localeCompare(a.date))
                    .slice(0, 5)
                    .forEach((entry) => {
                        entries.createEl('li', {
                            text: `${entry.date} — ${renderPositionText(entry)}`,
                        });
                    });
                if (session.entries.length > 5) {
                    entries.createEl('li', {
                        cls: 'is-muted',
                        text: `and ${session.entries.length - 5} more in the note`,
                    });
                }
            }
        });
    }

    private renderFooter(parent: HTMLElement): void {
        new Setting(parent).addButton((btn) =>
            btn
                .setButtonText('Open note')
                .onClick(() => {
                    this.close();
                    this.options.onOpenNote();
                }),
        );
    }
}

// --- abandon prompt ---------------------------------------------------------

/** Asks where and why a book was set aside, so DNF carries information. */
class AbandonModal extends Modal {
    constructor(
        app: App,
        private readonly book: Book,
        private readonly onConfirm: (fraction: number, reason?: string) => void,
    ) {
        super(app);
        this.setTitle('Stop reading this book?');
    }

    onOpen(): void {
        const { contentEl } = this;
        const current = Math.round(currentFraction(this.book.sessions) * 100);
        let percent = current;
        let reason = '';

        contentEl.createEl('p', {
            cls: 'dogear-modal__intro',
            text: 'Setting a book aside is recorded, not hidden. You can pick it up again later and the history is kept.',
        });

        const stoppedSetting = new Setting(contentEl)
            .setName('Stopped at')
            .setDesc('How far you got, as a percentage.');
        // Show the value inline rather than using setDynamicTooltip(), which is
        // deprecated and was flagged in automated review on a previous plugin.
        const readout = stoppedSetting.controlEl.createSpan({
            cls: 'dogear-slider-value',
            text: `${current}%`,
        });
        readout.setAttr('aria-live', 'polite');
        stoppedSetting.addSlider((slider) =>
            slider
                .setLimits(0, 100, 1)
                .setValue(current)
                .onChange((value) => {
                    percent = value;
                    readout.setText(`${value}%`);
                }),
        );

        new Setting(contentEl)
            .setName('Reason')
            .setDesc('Optional. Useful when you wonder later why you stopped.')
            .addText((text) =>
                text.setPlaceholder('e.g. lost the thread').onChange((value) => {
                    reason = value.trim();
                }),
            );

        new Setting(contentEl)
            .addButton((btn) => btn.setButtonText('Cancel').onClick(() => this.close()))
            .addButton((btn) =>
                btn
                    .setButtonText('Stop reading')
                    .setCta()
                    .onClick(() => {
                        this.close();
                        this.onConfirm(percent / 100, reason === '' ? undefined : reason);
                    }),
            );
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

export { todayIso };
