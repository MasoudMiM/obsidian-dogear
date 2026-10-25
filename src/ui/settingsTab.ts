// Dogear — settings tab.
//
// Follows the official UI text guidelines:
//   - No top-level heading naming the plugin; general settings sit at the top
//     with no heading at all.
//   - Section headings avoid the word "settings" ("Books", not "Book settings").
//   - Sentence case throughout.
//   - Headings via Setting.setHeading(), never raw <h2> elements.

import { App, Notice, Plugin, PluginSettingTab, Setting, type TextComponent } from 'obsidian';
import { FORMAT_LABELS, type Format } from '../model';
import { renderFilenameTemplate, sanitiseFilename } from '../paths';
import {
    ALL_PROVIDER_IDS,
    cleanHeading,
    templateHasPlaceholder,
    type DogearSettings,
} from '../settings';

/** What the settings tab needs. Deliberately not the whole plugin. */
export interface SettingsHost {
    /** The live settings object, mutated in place then saved. */
    current: DogearSettings;
    saveSettings(): Promise<void>;
}

export class DogearSettingTab extends PluginSettingTab {
    constructor(
        app: App,
        // The base class needs the real plugin; the tab itself needs only the
        // two members in SettingsHost, so both are passed explicitly.
        plugin: Plugin,
        private readonly host: SettingsHost,
    ) {
        super(app, plugin);
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.addClass('dogear-settings');

        const s = this.host.current;
        const save = () => void this.host.saveSettings();

        // --- general (no heading, per the guidelines) ------------------------

        new Setting(containerEl)
            .setName('Books folder')
            .setDesc('Where book notes are created. Leave empty to use the vault root.')
            .addText((text) =>
                text
                    .setPlaceholder('Books')
                    .setValue(s.booksFolder)
                    .onChange((value) => {
                        s.booksFolder = value.trim();
                        save();
                    }),
            );

        const templateSetting = new Setting(containerEl)
            .setName('Note name')
            .setDesc('Placeholders: {{title}}, {{author}}, {{authors}}, {{year}}, {{series}}.');

        // A live preview turns an abstract template into something you can see
        // before it names three hundred files.
        const preview = templateSetting.descEl.createDiv({ cls: 'dogear-settings__preview' });
        const renderPreview = (template: string) => {
            preview.empty();
            if (!templateHasPlaceholder(template)) {
                preview.createSpan({
                    cls: 'dogear-settings__preview-warning',
                    text: 'This template has no placeholders, so every book would get the same name.',
                });
                return;
            }
            const example = sanitiseFilename(
                renderFilenameTemplate(template, {
                    title: 'The Dispossessed',
                    authors: ['Ursula K. Le Guin'],
                    published: '1974',
                    series: 'Hainish Cycle',
                }),
            );
            preview.createSpan({ text: 'Example: ' });
            preview.createSpan({ cls: 'dogear-settings__preview-name', text: `${example}.md` });
        };

        templateSetting.addText((text) =>
            text
                .setPlaceholder('{{title}} - {{author}}')
                .setValue(s.filenameTemplate)
                .onChange((value) => {
                    s.filenameTemplate = value;
                    renderPreview(value);
                    save();
                }),
        );
        renderPreview(s.filenameTemplate);

        new Setting(containerEl)
            .setName('Open the note after adding a book')
            .addToggle((toggle) =>
                toggle.setValue(s.openOnCreate).onChange((value) => {
                    s.openOnCreate = value;
                    save();
                }),
            );

        // --- reading --------------------------------------------------------

        new Setting(containerEl).setName('Reading').setHeading();

        new Setting(containerEl)
            .setName('Default format')
            .setDesc('Preselected when you start reading a book.')
            .addDropdown((drop) => {
                for (const [value, label] of Object.entries(FORMAT_LABELS)) {
                    drop.addOption(value, label);
                }
                drop.setValue(s.defaultFormat).onChange((value) => {
                    s.defaultFormat = value as Format;
                    save();
                });
            });

        new Setting(containerEl)
            .setName('Reading log heading')
            .setDesc(
                'The section of each note that Dogear manages. Everything else in the note is left alone.',
            )
            .addText((text) =>
                text
                    .setPlaceholder('Reading log')
                    .setValue(s.logHeading)
                    .onChange((value) => {
                        s.logHeading = cleanHeading(value) || 'Reading log';
                        save();
                    }),
            );

        // --- reading goal ---------------------------------------------------

        new Setting(containerEl).setName('Reading goal').setHeading();

        const goalHost = containerEl.createDiv({ cls: 'dogear-settings__goals' });
        const renderGoals = () => {
            goalHost.empty();
            const years = Object.keys(s.readingGoals)
                .map(Number)
                .filter((year) => Number.isInteger(year))
                .sort((a, b) => b - a);

            if (years.length === 0) {
                goalHost.createDiv({
                    cls: 'dogear-settings__empty',
                    text: 'No goals yet. Set one below and the statistics page will track it.',
                });
                return;
            }

            for (const year of years) {
                const row = new Setting(goalHost).setName(String(year));
                row.addText((text) => {
                    text.inputEl.type = 'number';
                    text.inputEl.min = '1';
                    text.inputEl.max = '10000';
                    text.setPlaceholder('Books')
                        .setValue(String(s.readingGoals[String(year)]))
                        .onChange((value) => {
                            const target = Number.parseInt(value, 10);
                            if (Number.isFinite(target) && target > 0) {
                                s.readingGoals[String(year)] = Math.min(target, 10000);
                                save();
                            }
                        });
                    // Leaving a blank or invalid field should show what was
                    // actually stored rather than an empty box.
                    text.inputEl.addEventListener('blur', () => {
                        text.setValue(String(s.readingGoals[String(year)]));
                    });
                });
                row.addExtraButton((btn) =>
                    btn
                        .setIcon('trash-2')
                        .setTooltip('Remove this goal')
                        .onClick(() => {
                            delete s.readingGoals[String(year)];
                            save();
                            renderGoals();
                        }),
                );
            }
        };
        renderGoals();

        let newGoalYear = String(new Date().getFullYear());
        let newGoalTarget = '';
        let newGoalTargetInput: TextComponent | null = null;
        const addGoal = new Setting(containerEl)
            .setName('Add a goal')
            .setDesc(
                "Goals are kept per year, so next year's target never rewrites last year's.",
            );
        addGoal.addText((text) => {
            text.inputEl.type = 'number';
            text.inputEl.min = '1000';
            text.inputEl.max = '9999';
            text.setPlaceholder('Year')
                .setValue(newGoalYear)
                .onChange((value) => {
                    newGoalYear = value;
                });
        });
        addGoal.addText((text) => {
            newGoalTargetInput = text;
            text.inputEl.type = 'number';
            text.inputEl.min = '1';
            text.inputEl.max = '10000';
            text.setPlaceholder('Books').onChange((value) => {
                newGoalTarget = value;
            });
        });
        addGoal.addButton((btn) =>
            btn.setButtonText('Add').onClick(() => {
                const year = Number.parseInt(newGoalYear, 10);
                const target = Number.parseInt(newGoalTarget, 10);
                if (!Number.isInteger(year) || year < 1000 || year > 9999) {
                    new Notice('Dogear: enter a four-digit year.');
                    return;
                }
                if (!Number.isFinite(target) || target < 1) {
                    new Notice('Dogear: enter how many books you want to read.');
                    return;
                }
                s.readingGoals[String(year)] = Math.min(target, 10000);
                save();
                newGoalTarget = '';
                newGoalTargetInput?.setValue('');
                renderGoals();
            }),
        );

        // --- book data ------------------------------------------------------

        new Setting(containerEl).setName('Book data').setHeading();

        const PROVIDER_LABELS: Record<string, string> = {
            openlibrary: 'Open Library',
            googlebooks: 'Google Books',
            loc: 'Library of Congress',
            internetarchive: 'Internet Archive',
        };
        const PROVIDER_NOTES: Record<string, string> = {
            openlibrary:
                'Fully open data, no account needed. Best coverage of older and non-English editions, but it throttles requests heavily.',
            googlebooks:
                'The best metadata of the three, but it needs a free API key. Without one, requests share a single global quota that is almost always exhausted, so Dogear skips it rather than wasting the attempt.',
            loc:
                'Librarian-made catalogue records, no key needed. The most authoritative source here for US-published books, but search results rarely include page counts, and it blocks callers for an hour if pushed, so Dogear queries it gently.',
            internetarchive:
                'Scanned and digitised books, no key needed. Good for older and out-of-print titles. Metadata is uneven and page counts are approximate.',
        };

        const coverSetting = new Setting(containerEl).setName('Cover folder');
        coverSetting.descEl.createDiv({
            text: 'Where covers are kept when you run "Download covers into the vault". Covers stored in the vault work offline and are backed up with your notes; the alternative is fetching them from Open Library each time, which needs a connection and can be rate limited.',
        });
        coverSetting.addText((text) =>
            text
                .setPlaceholder('Books/covers')
                .setValue(s.coverFolder)
                .onChange((value) => {
                    const clean = value.trim().replace(/^\/+|\/+$/g, '');
                    if (clean !== '') {
                        s.coverFolder = clean;
                        save();
                    }
                }),
        );

        new Setting(containerEl)
            .setName('Where book data comes from')
            .setDesc(
                'Sources are tried in order until one answers. If the first is unavailable, Dogear moves on to the next rather than failing.',
            );

        const renderProviders = (host: HTMLElement) => {
            host.empty();
            for (const id of ALL_PROVIDER_IDS) {
                const position = s.providers.indexOf(id);
                const enabled = position >= 0;

                const row = new Setting(host)
                    .setName(
                        enabled
                            ? `${position + 1}. ${PROVIDER_LABELS[id]}`
                            : PROVIDER_LABELS[id],
                    )
                    .setDesc(PROVIDER_NOTES[id]);

                if (enabled && position > 0) {
                    row.addExtraButton((btn) =>
                        btn
                            .setIcon('arrow-up')
                            .setTooltip('Try this source earlier')
                            .onClick(() => {
                                const next = [...s.providers];
                                [next[position - 1], next[position]] = [
                                    next[position],
                                    next[position - 1],
                                ];
                                s.providers = next;
                                save();
                                renderProviders(host);
                            }),
                    );
                }

                row.addToggle((toggle) =>
                    toggle.setValue(enabled).onChange((value) => {
                        if (value) {
                            s.providers = [...s.providers, id];
                        } else if (s.providers.length > 1) {
                            s.providers = s.providers.filter((p) => p !== id);
                        } else {
                            // Refuse to leave no way of adding a book at all.
                            toggle.setValue(true);
                            new Notice('Dogear: keep at least one book source enabled.');
                            return;
                        }
                        save();
                        renderProviders(host);
                    }),
                );
            }
        };
        const providerHost = containerEl.createDiv({ cls: 'dogear-settings__providers' });
        renderProviders(providerHost);

        new Setting(containerEl)
            .setName('Google Books country')
            .setDesc(
                'Two-letter country code, such as US or GB. Google refuses requests when it cannot work out where you are, because its display rights vary by country. Leave empty to use your system setting.',
            )
            .addText((text) =>
                text
                    .setPlaceholder('Detected automatically')
                    .setValue(s.googleCountry)
                    .onChange((value) => {
                        const code = value.trim().toUpperCase();
                        if (code === '' || /^[A-Z]{2}$/.test(code)) {
                            s.googleCountry = code;
                            save();
                        }
                    }),
            );

        const keySetting = new Setting(containerEl).setName('Google Books API key');
        // Be specific about why this matters. "Optional" undersells it: the
        // key-free quota is shared with every other application calling Google
        // Books without a key, so in practice it is usually already spent.
        keySetting.descEl.createDiv({
            text: 'Without a key, Dogear shares one anonymous quota with every other application that calls Google Books key-free. That pool is frequently exhausted by other people, so Google Books will often be unavailable. A key is free, takes a few minutes, and gives you your own daily allowance.',
        });
        const help = keySetting.descEl.createDiv({ cls: 'dogear-settings__preview' });
        help.createSpan({ text: 'Get one from the ' });
        const keyLink = help.createEl('a', {
            text: 'Google Cloud console',
            href: 'https://console.cloud.google.com/apis/library/books.googleapis.com',
        });
        keyLink.setAttr('rel', 'noopener');
        help.createSpan({
            text: ': create a project, enable the Books API, then create an API key.',
        });
        keySetting
            .addText((text) => {
                text.inputEl.type = 'password';
                text.inputEl.autocomplete = 'off';
                text.setPlaceholder('Leave empty for keyless access')
                    .setValue(s.googleApiKey)
                    .onChange((value) => {
                        s.googleApiKey = value.trim();
                        save();
                    });
            });

        new Setting(containerEl)
            .setName('Preferred edition language')
            .setDesc('Three-letter code, such as eng, fre or deu. Used when picking an edition.')
            .addText((text) =>
                text
                    .setPlaceholder('eng')
                    .setValue(s.preferredLanguage)
                    .onChange((value) => {
                        const code = value.trim().toLowerCase();
                        if (/^[a-z]{2,3}$/.test(code)) {
                            s.preferredLanguage = code;
                            save();
                        }
                    }),
            );

        const cacheSetting = new Setting(containerEl)
            .setName('Remember search results for')
            .setDesc(
                'Open Library is free and donation-funded. Caching keeps Dogear from asking for the same book twice.',
            );
        const cacheReadout = cacheSetting.controlEl.createSpan({
            cls: 'dogear-slider-value',
            text: `${s.cacheHours} h`,
        });
        cacheReadout.setAttr('aria-live', 'polite');
        cacheSetting.addSlider((slider) =>
            slider
                .setLimits(1, 168, 1)
                .setValue(s.cacheHours)
                .onChange((value) => {
                    s.cacheHours = value;
                    cacheReadout.setText(`${value} h`);
                    save();
                }),
        );

        // --- attribution ----------------------------------------------------

        const credit = containerEl.createDiv({ cls: 'dogear-settings__credit' });
        credit.createSpan({ text: 'Book data from ' });
        const ol = credit.createEl('a', { text: 'Open Library', href: 'https://openlibrary.org' });
        ol.setAttr('rel', 'noopener');
        credit.createSpan({ text: ', a project of the Internet Archive, and ' });
        const gb = credit.createEl('a', {
            text: 'Google Books',
            href: 'https://books.google.com',
        });
        gb.setAttr('rel', 'noopener');
        credit.createSpan({ text: '.' });
    }
}
