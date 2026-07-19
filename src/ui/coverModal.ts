// Dogear — setting a cover by hand.
//
// Open Library's cover collection is good but far from complete: books in
// non-Latin scripts, small presses, older editions and translations are all
// routinely missing, and no amount of cleverness will conjure artwork that
// nobody has uploaded.
//
// So the escape hatch is the important part. A cover can be any image in the
// vault, which is better than a web address in every way that matters: it
// works offline, it survives Open Library changing or disappearing, it is
// backed up with everything else, and it is the reader's own file.

import { App, Modal, Notice, Setting } from 'obsidian';
import { isRemoteCover, normaliseCoverInput } from '../library';
import { createMessage } from './components';

export class CoverModal extends Modal {
    private value: string;

    constructor(
        app: App,
        private readonly options: { title: string; current?: string },
        private readonly onSubmit: (cover: string | undefined) => Promise<void>,
    ) {
        super(app);
        this.value = options.current ?? '';
        this.setTitle('Book cover');
        this.modalEl.addClass('dogear-cover-modal');
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('p', {
            cls: 'dogear-modal__intro',
            text: `Choose the cover for ${this.options.title}.`,
        });

        const help = contentEl.createDiv({ cls: 'dogear-modal__hint' });
        help.createDiv({
            text: 'Drag an image into your vault, then paste its name here — a plain path or a [[wiki link]] both work. An image kept in the vault works offline and is backed up with your notes.',
        });
        help.createDiv({
            text: 'A web address works too, but it will only show while you are online, and it breaks if the far end moves the file.',
        });

        const preview = contentEl.createDiv({ cls: 'dogear-cover-modal__preview' });
        const feedback = contentEl.createDiv({ cls: 'dogear-log__feedback' });

        const renderPreview = () => {
            preview.empty();
            const cover = normaliseCoverInput(this.value);
            if (!cover) {
                preview.createDiv({
                    cls: 'dogear-cover-modal__none',
                    text: 'No cover set.',
                });
                return;
            }
            const src = this.resolve(cover);
            if (!src) {
                createMessage(
                    preview,
                    "That file isn't in the vault. Check the name, including the folder if it is in one.",
                    'error',
                );
                return;
            }
            const img = preview.createEl('img', { cls: 'dogear-cover-modal__img' });
            img.src = src;
            img.alt = '';
            img.addEventListener('error', () => {
                img.remove();
                createMessage(preview, "That image couldn't be loaded.", 'error');
            });
        };

        new Setting(contentEl)
            .setName('Cover')
            .setDesc('An image in your vault, or a web address.')
            .addText((text) => {
                text.inputEl.addClass('dogear-cover-modal__input');
                text.setPlaceholder('covers/mockingbird.jpg')
                    .setValue(this.value)
                    .onChange((v) => {
                        this.value = v;
                        renderPreview();
                    });
            });

        renderPreview();

        new Setting(contentEl)
            .addButton((b) =>
                b.setButtonText('Remove cover').onClick(() => {
                    void this.commit(undefined, feedback);
                }),
            )
            .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
            .addButton((b) =>
                b
                    .setButtonText('Save')
                    .setCta()
                    .onClick(() => {
                        void this.commit(normaliseCoverInput(this.value), feedback);
                    }),
            );
    }

    /** Turn a stored cover into something an <img> can display. */
    private resolve(cover: string): string | null {
        if (isRemoteCover(cover)) return cover;
        const file = this.app.metadataCache.getFirstLinkpathDest(cover, '');
        return file ? this.app.vault.getResourcePath(file) : null;
    }

    private async commit(cover: string | undefined, feedback: HTMLElement): Promise<void> {
        feedback.empty();
        if (cover && !isRemoteCover(cover) && !this.resolve(cover)) {
            createMessage(feedback, "That file isn't in the vault, so it was not saved.", 'error');
            return;
        }
        this.close();
        try {
            await this.onSubmit(cover);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            new Notice(`Dogear: couldn't save the cover. ${message}`);
        }
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
