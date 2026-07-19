// Dogear — book search modal.
//
// A SuggestModal backed by Open Library. Two things it must get right:
//
//   - Not firing a request per keystroke. getSuggestions runs on every input
//     event, so all lookups go through DebouncedSearch.
//   - Saying something useful when there is nothing to show. An empty list
//     with no explanation is the most common failure of search UIs; here the
//     state is always named — prompting, searching, no results, or offline.

import { App, Notice, SuggestModal } from 'obsidian';
import type { ProviderChain } from '../providers/chain';
import type { SearchHit } from '../providers/types';
import { DebouncedSearch } from '../search';
import { createCover } from './components';

const MIN_QUERY = 3;

/** Marker for the synthetic "enter it yourself" row. */
export const MANUAL_HIT_ID = '__dogear_manual__';

function manualHit(
    query: string,
    reason: string | null,
    hadResults: boolean,
): SearchHit {
    return {
        providerId: 'manual',
        id: MANUAL_HIT_ID,
        title: query,
        authors: [],
        tags: [],
        complete: true,
        raw: { reason, hadResults },
    };
}

export class BookSearchModal extends SuggestModal<SearchHit> {
    private readonly search: DebouncedSearch<SearchHit>;
    private lastError: string | null = null;
    private rateLimited = false;
    private allFailed = false;
    private configProblem: { message: string; remedy: string } | null = null;
    private lastQuery = '';
    /** Which source answered, so the interface can say where data came from. */
    private usedProvider: string | null = null;

    constructor(
        app: App,
        private readonly chain: ProviderChain,
        private readonly onChoose: (hit: SearchHit) => void,
        /** Opens manual entry, prefilled with whatever was typed. */
        private readonly onManual: (title: string) => void,
    ) {
        super(app);

        this.setPlaceholder('Search by title, author, or ISBN');
        this.setInstructions([
            { command: '↑↓', purpose: 'to navigate' },
            { command: '↵', purpose: 'to add this book' },
            { command: 'esc', purpose: 'to dismiss' },
        ]);
        this.modalEl.addClass('dogear-search-modal');

        this.search = new DebouncedSearch<SearchHit>({
            fetch: async (query) => {
                const result = await this.chain.search(query, 20);
                this.usedProvider = result.usedProvider;
                return result.hits;
            },
            delayMs: 600,
            minLength: MIN_QUERY,
            onError: (err, query) => {
                this.lastError = err.message;
                this.rateLimited = err.name === 'RateLimitError';
                this.allFailed = err.name === 'AllProvidersFailedError';
                // A fixable problem beats an unfixable one: if any provider
                // failed for a reason the reader can act on, show that instead
                // of a generic "everything is down".
                const candidates: Error[] = [
                    err,
                    ...((err as Error & { errors?: Error[] }).errors ?? []),
                ];
                const fixable = candidates.find((e) => e.name === 'ProviderConfigError') as
                    | (Error & { remedy: string })
                    | undefined;
                this.configProblem = fixable
                    ? { message: fixable.message, remedy: fixable.remedy }
                    : null;
                // A real network failure is worth logging: without it the only
                // signal is a message in a modal the user has already closed.
                console.error(`Dogear: search for "${query}" failed`, err);
            },
        });
    }

    async getSuggestions(query: string): Promise<SearchHit[]> {
        this.lastQuery = query.trim();
        this.lastError = null;
        this.rateLimited = false;
        this.allFailed = false;
        this.configProblem = null;
        const hits = await this.search.search(query);
        if (this.lastQuery.length < MIN_QUERY) return hits;

        // Manual entry is ALWAYS offered, not just when nothing was found.
        // A list of near-misses is still a dead end if none of them is the
        // book you actually own, and catalogue search is frequently wrong
        // rather than merely empty.
        return [...hits, manualHit(this.lastQuery, this.failureSummary(), hits.length > 0)];
    }

    /** A short reason for the manual row, or null if the search simply missed. */
    private failureSummary(): string | null {
        if (this.configProblem) return this.configProblem.message;
        if (this.rateLimited || this.allFailed) return this.lastError;
        return null;
    }

    renderSuggestion(hit: SearchHit, el: HTMLElement): void {
        el.addClass('dogear-result');

        if (hit.id === MANUAL_HIT_ID) {
            el.addClass('dogear-result--manual');
            const box = el.createDiv({ cls: 'dogear-result__text' });
            const info = (hit.raw ?? {}) as { reason?: string | null; hadResults?: boolean };
            box.createDiv({
                cls: 'dogear-result__title',
                text: info.hadResults
                    ? `None of these? Add “${hit.title}” yourself`
                    : `Add “${hit.title}” yourself`,
            });
            box.createDiv({
                cls: 'dogear-result__meta',
                text: info.reason
                    ? 'No book source could answer, so enter the details by hand.'
                    : info.hadResults
                      ? 'Catalogue search is often wrong rather than empty. Enter the details by hand instead.'
                      : 'No matches. Enter the details by hand instead.',
            });
            if (info.reason) {
                box.createDiv({ cls: 'dogear-result__detail is-muted', text: info.reason });
            }
            return;
        }

        createCover(el, { url: hit.coverUrl, title: hit.title, cls: 'dogear-cover--thumb' });

        const text = el.createDiv({ cls: 'dogear-result__text' });
        text.createDiv({ cls: 'dogear-result__title', text: hit.title });

        const meta: string[] = [];
        if (hit.authors.length > 0) meta.push(hit.authors.slice(0, 2).join(', '));
        if (hit.year) meta.push(String(hit.year));
        text.createDiv({ cls: 'dogear-result__meta', text: meta.join(' · ') });

        // Page count is what makes page-based progress possible, so surface
        // whether we have one before the reader commits to adding the book.
        const detail = text.createDiv({ cls: 'dogear-result__detail' });
        if (hit.pages) {
            detail.setText(`${hit.pages} pages`);
        } else {
            detail.setText('Page count unknown');
            detail.addClass('is-muted');
        }

        // Name the source. Data quality varies a lot between catalogues, and
        // knowing where a record came from is how you judge whether to trust
        // an odd-looking page count or a missing author.
        const label = this.chain.byId(hit.providerId)?.label;
        if (label) {
            el.createDiv({ cls: 'dogear-result__source', text: label });
        }
    }

    /** Shown when getSuggestions returns nothing. */
    onNoSuggestion(): void {
        const el = this.resultContainerEl;
        el.empty();
        const empty = el.createDiv({ cls: 'dogear-empty' });

        if (this.configProblem) {
            // Something the reader can fix, so say what to do rather than
            // telling them to wait.
            empty.createDiv({ cls: 'dogear-empty__title', text: 'A book source needs setting up' });
            empty.createDiv({ cls: 'dogear-empty__body', text: this.configProblem.message });
            empty.createDiv({ cls: 'dogear-empty__body is-muted', text: this.configProblem.remedy });
            return;
        }
        if (this.allFailed) {
            empty.createDiv({ cls: 'dogear-empty__title', text: 'No book source could answer' });
            empty.createDiv({ cls: 'dogear-empty__body', text: this.lastError ?? '' });
            empty.createDiv({
                cls: 'dogear-empty__body is-muted',
                text: 'Every source Dogear knows about is unavailable right now. You can add or reorder sources in settings.',
            });
            return;
        }
        if (this.rateLimited) {
            // Naming the cause matters. "Check your connection" would send
            // people debugging a network that is working perfectly.
            empty.createDiv({ cls: 'dogear-empty__title', text: 'Open Library is throttling requests' });
            empty.createDiv({ cls: 'dogear-empty__body', text: this.lastError ?? '' });
            empty.createDiv({
                cls: 'dogear-empty__body is-muted',
                text: 'This is a known problem on their side, not with your connection. Dogear has stopped sending requests so the block does not get longer, and will try the next source instead.',
            });
            return;
        }
        if (this.lastError) {
            empty.createDiv({
                cls: 'dogear-empty__title',
                text: "Couldn't reach Open Library",
            });
            // Show what actually went wrong. A generic "check your connection"
            // is actively misleading when the connection is fine and the
            // server returned an error, and it makes the problem unreportable.
            empty.createDiv({ cls: 'dogear-empty__body', text: this.lastError });
            empty.createDiv({
                cls: 'dogear-empty__body is-muted',
                text: 'Full details are in the developer console.',
            });
            return;
        }
        if (this.lastQuery.length < MIN_QUERY) {
            empty.createDiv({ cls: 'dogear-empty__title', text: 'Start typing to find a book' });
            empty.createDiv({
                cls: 'dogear-empty__body',
                text: 'A title works best. You can also search by author or paste an ISBN.',
            });
            return;
        }
        empty.createDiv({ cls: 'dogear-empty__title', text: `No results for "${this.lastQuery}"` });
        empty.createDiv({
            cls: 'dogear-empty__body',
            text: 'Try fewer words, or search by ISBN for an exact match.',
        });
    }

    onChooseSuggestion(hit: SearchHit): void {
        if (hit.id === MANUAL_HIT_ID) {
            this.onManual(hit.title);
            return;
        }
        this.onChoose(hit);
    }

    onClose(): void {
        // Stop any in-flight lookup so a late response can't touch a closed modal.
        this.search.cancel();
        super.onClose();
    }
}

/** Convenience wrapper that reports failures as a Notice. */
export function openBookSearch(
    app: App,
    chain: ProviderChain,
    onChoose: (hit: SearchHit) => void | Promise<void>,
    onManual: (title: string) => void,
): void {
    new BookSearchModal(
        app,
        chain,
        (hit) => {
            void (async () => {
                try {
                    await onChoose(hit);
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    new Notice(`Dogear: couldn't add that book. ${message}`);
                }
            })();
        },
        onManual,
    ).open();
}
