// Dogear — manual book entry.
//
// The guaranteed path. Every metadata source is a third party that can be
// throttled, rate limited, geo-restricted or simply down, and during testing
// all of them were at once. A reading tracker that cannot record a book under
// those conditions is not a reading tracker.
//
// So metadata lookup is demoted to what it always should have been:
// enrichment, not a prerequisite. This modal depends on nothing but the vault.
//
// It is also the fastest route for books no catalogue has — self-published
// work, obscure editions, manuscripts, a friend's zine.

import { App, Modal, Notice, Setting } from 'obsidian';
import { SCHEMA_VERSION, type Book, type Format } from '../model';
import { formatDuration, parseDuration } from '../progress';
import { createMessage } from './components';

export interface ManualBookResult {
    book: Book;
}

export class ManualBookModal extends Modal {
    private title: string;
    private authors = '';
    private pagesText = '';
    private durationText = '';
    private publisher = '';
    private published = '';
    private isbn = '';

    constructor(
        app: App,
        options: { initialTitle?: string; defaultFormat: Format },
        private readonly onSubmit: (book: Book) => Promise<void>,
    ) {
        super(app);
        this.title = options.initialTitle ?? '';
        this.setTitle('Add a book');
        this.modalEl.addClass('dogear-manual-modal');
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('p', {
            cls: 'dogear-modal__intro',
            text: 'Only a title is required. Everything else can be filled in later, and you can fetch details from a book source at any time.',
        });

        let titleInput: HTMLInputElement | null = null;

        new Setting(contentEl).setName('Title').addText((text) => {
            titleInput = text.inputEl;
            text.setPlaceholder('The Power Broker')
                .setValue(this.title)
                .onChange((v) => {
                    this.title = v;
                });
        });

        new Setting(contentEl)
            .setName('Author')
            .setDesc('Separate multiple authors with commas.')
            .addText((text) =>
                text.setPlaceholder('Robert A. Caro').onChange((v) => {
                    this.authors = v;
                }),
            );

        new Setting(contentEl)
            .setName('Pages')
            .setDesc('Needed to log progress by page number. You can add it later.')
            .addText((text) => {
                text.inputEl.type = 'number';
                text.inputEl.min = '1';
                text.setPlaceholder('1246').onChange((v) => {
                    this.pagesText = v;
                });
            });

        new Setting(contentEl)
            .setName('Audiobook length')
            .setDesc('Needed to log progress by time. Try 5:30 or 5h 30m.')
            .addText((text) =>
                text.setPlaceholder('66:35').onChange((v) => {
                    this.durationText = v;
                }),
            );

        // Secondary details, kept below the fold of attention.
        new Setting(contentEl).setName('Optional details').setHeading();

        new Setting(contentEl).setName('Publisher').addText((text) =>
            text.onChange((v) => {
                this.publisher = v;
            }),
        );
        new Setting(contentEl)
            .setName('Year')
            .addText((text) =>
                text.setPlaceholder('1974').onChange((v) => {
                    this.published = v;
                }),
            );
        new Setting(contentEl)
            .setName('ISBN')
            .setDesc('Lets Dogear match this book to a source later.')
            .addText((text) =>
                text.onChange((v) => {
                    this.isbn = v;
                }),
            );

        const feedback = contentEl.createDiv({ cls: 'dogear-log__feedback' });

        new Setting(contentEl)
            .addButton((btn) => btn.setButtonText('Cancel').onClick(() => this.close()))
            .addButton((btn) =>
                btn
                    .setButtonText('Add book')
                    .setCta()
                    .onClick(() => void this.submit(feedback)),
            );

        // Focus the title so typing can start immediately.
        window.setTimeout(() => titleInput?.focus(), 0);
    }

    private async submit(feedback: HTMLElement): Promise<void> {
        feedback.empty();

        const title = this.title.trim();
        if (title === '') {
            createMessage(feedback, 'A title is needed to create the note.', 'error');
            return;
        }

        let pages: number | undefined;
        if (this.pagesText.trim() !== '') {
            const n = Number(this.pagesText.trim());
            if (!Number.isFinite(n) || n <= 0) {
                createMessage(feedback, 'Pages should be a whole number above zero.', 'error');
                return;
            }
            pages = Math.round(n);
        }

        let duration: number | undefined;
        if (this.durationText.trim() !== '') {
            const secs = parseDuration(this.durationText);
            if (secs === null || secs <= 0) {
                createMessage(
                    feedback,
                    "That length doesn't look right. Try 5:30, or 5h 30m.",
                    'error',
                );
                return;
            }
            duration = secs;
        }

        const isbnClean = this.isbn.replace(/[^0-9Xx]/g, '').toUpperCase();

        const book: Book = {
            schemaVersion: SCHEMA_VERSION,
            title,
            authors: this.authors
                .split(',')
                .map((a) => a.trim())
                .filter((a) => a !== ''),
            publisher: this.publisher.trim() || undefined,
            published: this.published.trim() || undefined,
            isbn13: isbnClean.length === 13 ? isbnClean : undefined,
            isbn10: isbnClean.length === 10 ? isbnClean : undefined,
            tags: [],
            metrics: { pages, duration },
            status: 'want-to-read',
            sessions: [],
        };

        this.close();
        try {
            await this.onSubmit(book);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            new Notice(`Dogear: couldn't create the note. ${message}`);
        }
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

/** Format a duration for display in the manual form. */
export { formatDuration };
