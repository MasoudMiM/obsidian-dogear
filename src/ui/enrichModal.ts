// Dogear — book enrichment modal.
//
// Shows the metadata a provider found alongside what the note already has,
// previews the merge, and hands the merged book to the caller to save.

import { App, Modal, Setting } from 'obsidian';
import { type Book } from '../model';
import { type BookMetadata } from '../providers/types';
import { mergeBookMetadata } from '../enrich';
import { formatDuration } from '../progress';

export class BookEnrichModal extends Modal {
    private book: Book;
    private metadata: BookMetadata;
    private enrichedBook: Book;
    private onSave: (book: Book) => Promise<void>;

    constructor(
        app: App,
        options: {
            book: Book;
            metadata: BookMetadata;
            onSave: (book: Book) => Promise<void>;
        },
    ) {
        super(app);
        this.book = options.book;
        this.metadata = options.metadata;
        this.onSave = options.onSave;
        this.enrichedBook = mergeBookMetadata(this.book, this.metadata);

        this.setTitle('Enrich book');
        this.modalEl.addClass('dogear-enrich-modal');
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('p', {
            cls: 'dogear-modal__intro',
            text: 'Review the metadata found for this book and confirm the enrichment. Your own details are never overwritten.',
        });

        const currentInfo = contentEl.createDiv({ cls: 'dogear-enrich__current' });
        currentInfo.createEl('h3', { text: 'Current information' });
        this.renderBookInfo(currentInfo, this.book);

        const foundInfo = contentEl.createDiv({ cls: 'dogear-enrich__found' });
        foundInfo.createEl('h3', { text: 'Found metadata' });
        this.renderMetadata(foundInfo, this.metadata);

        const preview = contentEl.createDiv({ cls: 'dogear-enrich__preview' });
        preview.createEl('h3', { text: 'Preview of updated book' });
        this.renderBookInfo(preview, this.enrichedBook);

        const buttons = new Setting(contentEl);
        buttons.addButton((btn) => btn.setButtonText('Cancel').onClick(() => this.close()));
        buttons.addButton((btn) =>
            btn
                .setButtonText('Enrich book')
                .setCta()
                .onClick(() => void this.submit()),
        );
    }

    private field(container: HTMLElement, label: string, value: string | undefined): void {
        if (value === undefined || value === '') return;
        container.createDiv({
            cls: 'dogear-enrich__field',
            text: `${label}: ${value}`,
        });
    }

    private renderBookInfo(container: HTMLElement, book: Book): void {
        const info = container.createDiv({ cls: 'dogear-enrich__info' });

        this.field(info, 'Title', book.title);
        this.field(info, 'Authors', book.authors.length > 0 ? book.authors.join(', ') : undefined);
        this.field(info, 'ISBN-13', book.isbn13);
        this.field(info, 'ISBN-10', book.isbn10);
        this.field(info, 'Publisher', book.publisher);
        this.field(info, 'Published', book.published);
        this.field(info, 'Pages', book.metrics.pages?.toString());
        this.field(info, 'Duration', book.metrics.duration ? formatDuration(book.metrics.duration) : undefined);
        this.field(info, 'Tags', book.tags.length > 0 ? book.tags.join(', ') : undefined);
    }

    private renderMetadata(container: HTMLElement, metadata: BookMetadata): void {
        const info = container.createDiv({ cls: 'dogear-enrich__metadata' });

        this.field(info, 'Title', metadata.title);
        this.field(info, 'Authors', metadata.authors.length > 0 ? metadata.authors.join(', ') : undefined);
        this.field(info, 'ISBN-13', metadata.isbn13);
        this.field(info, 'ISBN-10', metadata.isbn10);
        this.field(info, 'Publisher', metadata.publisher);
        this.field(info, 'Published', metadata.published);
        this.field(info, 'Pages', metadata.pages?.toString());
        this.field(info, 'Tags', metadata.tags.length > 0 ? metadata.tags.join(', ') : undefined);
        this.field(info, 'Cover', metadata.cover);
    }

    private async submit(): Promise<void> {
        await this.onSave(this.enrichedBook);
        this.close();
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
