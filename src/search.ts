// Dogear — debounced search with a stale-response guard.
//
// Two separate problems, both of which bite network-backed suggestion lists:
//
//   1. SuggestModal calls getSuggestions on EVERY keystroke. Typing
//      "the dispossessed" would fire seventeen requests at a free,
//      donation-funded API. So: debounce.
//
//   2. Responses can arrive out of order. If the request for "du" is slow and
//      the request for "dune" is fast, the "du" results can land last and
//      replace the correct ones. So: tag each request and discard anything
//      that isn't the newest.
//
// Timers are injected so this is testable without real time passing.

export interface SearchTimers {
    setTimeout: (fn: () => void, ms: number) => number;
    clearTimeout: (handle: number) => void;
}

/** Default timers. In the plugin these are window's, per the guidelines. */
export const defaultTimers: SearchTimers = {
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (h) => window.clearTimeout(h),
};

export interface DebouncedSearchOptions<T> {
    /** The actual lookup. */
    fetch: (query: string) => Promise<T[]>;
    /** Quiet period before firing, in ms. */
    delayMs?: number;
    /** Queries shorter than this never hit the network. */
    minLength?: number;
    timers?: SearchTimers;
    /** Called when a request fails, so the UI can say something useful. */
    onError?: (error: Error, query: string) => void;
    /** Called when a request starts or finishes, for a loading indicator. */
    onLoadingChange?: (loading: boolean) => void;
}

export class DebouncedSearch<T> {
    private handle: number | null = null;
    private sequence = 0;
    private pendingResolve: ((value: T[]) => void) | null = null;
    private readonly delayMs: number;
    private readonly minLength: number;
    private readonly timers: SearchTimers;

    /** Counters for tests and diagnostics. */
    stats = { fetches: 0, discarded: 0 };

    constructor(private readonly options: DebouncedSearchOptions<T>) {
        this.delayMs = options.delayMs ?? 400;
        this.minLength = options.minLength ?? 2;
        this.timers = options.timers ?? defaultTimers;
    }

    /**
     * Run a search. Resolves with results, or an empty list if this call was
     * superseded — never rejects, because SuggestModal has nowhere to put an
     * error and an unhandled rejection would break the list entirely.
     */
    search(query: string): Promise<T[]> {
        const trimmed = query.trim();

        // Cancel any pending timer; a newer keystroke supersedes it.
        if (this.handle !== null) {
            this.timers.clearTimeout(this.handle);
            this.handle = null;
        }
        // Resolve the superseded call so its promise never dangles.
        if (this.pendingResolve) {
            this.pendingResolve([]);
            this.pendingResolve = null;
        }

        if (trimmed.length < this.minLength) {
            this.options.onLoadingChange?.(false);
            return Promise.resolve([]);
        }

        const ticket = ++this.sequence;

        return new Promise<T[]>((resolve) => {
            this.pendingResolve = resolve;
            this.handle = this.timers.setTimeout(() => {
                this.handle = null;
                this.pendingResolve = null;
                this.options.onLoadingChange?.(true);
                this.stats.fetches++;

                this.options
                    .fetch(trimmed)
                    .then((results) => {
                        // Discard anything that is no longer the newest request.
                        if (ticket !== this.sequence) {
                            this.stats.discarded++;
                            resolve([]);
                            return;
                        }
                        this.options.onLoadingChange?.(false);
                        resolve(results);
                    })
                    .catch((err: unknown) => {
                        if (ticket !== this.sequence) {
                            this.stats.discarded++;
                            resolve([]);
                            return;
                        }
                        this.options.onLoadingChange?.(false);
                        this.options.onError?.(
                            err instanceof Error ? err : new Error(String(err)),
                            trimmed,
                        );
                        resolve([]);
                    });
            }, this.delayMs);
        });
    }

    /** Cancel any pending work. Call when the modal closes. */
    cancel(): void {
        if (this.handle !== null) {
            this.timers.clearTimeout(this.handle);
            this.handle = null;
        }
        if (this.pendingResolve) {
            this.pendingResolve([]);
            this.pendingResolve = null;
        }
        // Invalidate in-flight requests so late responses are ignored.
        this.sequence++;
    }
}
