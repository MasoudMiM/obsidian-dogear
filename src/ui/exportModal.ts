// Dogear — CSV export.
//
// The counterpart to the Goodreads import. The point is interoperating with
// other trackers, so the file is written into the vault where the reader can
// see it, move it and hand it to whatever comes next — not downloaded into a
// browser folder the vault never sees again. That also keeps it working on
// mobile, where there is no browser download to speak of.

import { App, Modal, Notice, Setting } from 'obsidian';
import type { Book } from '../model';
import { exportLibraryCsv } from '../exportcsv';
import { createMessage } from './components';

export interface ExportHost {
    /** Every book in the library. */
    books: () => Promise<Array<{ path: string; book: Book }>>;
    /** Write the finished file into the vault. */
    write: (path: string, content: string) => Promise<void>;
}

export const DEFAULT_EXPORT_FILENAME = 'dogear-library-export.csv';

export class ExportCsvModal extends Modal {
    private filename = DEFAULT_EXPORT_FILENAME;
    private exporting = false;

    constructor(
        app: App,
        private readonly host: ExportHost,
    ) {
        super(app);
        this.setTitle('Export your library as CSV');
        this.modalEl.addClass('dogear-export-modal');
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('p', {
            cls: 'dogear-modal__intro',
            text: 'Writes every book to a CSV that other reading trackers can import. Your notes and reviews stay in the vault — only what the library knows about each book goes into the file.',
        });

        let nameInput: HTMLInputElement | null = null;

        new Setting(contentEl)
            .setName('Filename')
            .setDesc('An existing file with this name in your vault is replaced.')
            .addText((text) => {
                nameInput = text.inputEl;
                text.setPlaceholder(DEFAULT_EXPORT_FILENAME)
                    .setValue(this.filename)
                    .onChange((v) => {
                        this.filename = v;
                    });
            });

        const feedback = contentEl.createDiv({ cls: 'dogear-log__feedback' });

        new Setting(contentEl)
            .addButton((btn) => btn.setButtonText('Cancel').onClick(() => this.close()))
            .addButton((btn) =>
                btn
                    .setButtonText('Export')
                    .setCta()
                    .onClick(() => void this.submit(feedback)),
            );

        window.setTimeout(() => {
            nameInput?.focus();
            nameInput?.select();
        }, 0);
    }

    private async submit(feedback: HTMLElement): Promise<void> {
        feedback.empty();
        if (this.exporting) return;

        let name = this.filename.trim();
        if (name === '') {
            createMessage(feedback, 'A filename is needed to write the export.', 'error');
            return;
        }
        if (!/\.csv$/i.test(name)) name = `${name}.csv`;

        this.exporting = true;
        try {
            const entries = await this.host.books();
            const csv = exportLibraryCsv(entries.map((e) => e.book));
            await this.host.write(name, csv);
            this.close();
            new Notice(
                `Dogear: exported ${entries.length} ${entries.length === 1 ? 'book' : 'books'} to ${name}.`,
            );
        } catch (err) {
            this.exporting = false;
            const message = err instanceof Error ? err.message : String(err);
            createMessage(feedback, `Couldn't write the export: ${message}`, 'error');
        }
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
