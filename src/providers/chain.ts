// Dogear — the provider chain.
//
// Tries each enabled provider in turn and returns the first usable answer.
// This is the difference between "the plugin is broken today" and "the plugin
// quietly used a different source today".
//
// Rules:
//   - Providers in a cooldown are skipped without a request, so a throttled
//     source costs nothing.
//   - A provider that fails is recorded and the chain moves on.
//   - Only if EVERY provider fails does the caller see an error, and that
//     error names each provider and why it failed.
//   - The provider that answered is reported, so the interface can say where
//     the data came from rather than pretending it is all one source.

import {
    AllProvidersFailedError,
    dedupeKey,
    type BookMetadata,
    type BookProvider,
    type SearchHit,
} from './types';

export interface ChainSearchResult {
    hits: SearchHit[];
    /** Provider that supplied the results, or null when none did. */
    usedProvider: string | null;
    /** Providers that were tried and failed, in order. */
    failures: Array<{ provider: string; reason: string }>;
    /** Providers skipped because they were cooling down. */
    skipped: string[];
}

/**
 * How long a single provider gets before the chain gives up on it.
 *
 * Without this, a request that never resolves — a stalled connection, a DNS
 * hang, a provider bug — leaves the search spinning forever with no error and
 * no way to reach the next source. A slow source should cost a few seconds,
 * not the whole feature.
 */
export const PROVIDER_TIMEOUT_MS = 10_000;

export class TimeoutError extends Error {
    constructor(provider: string, ms: number) {
        const took = ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`;
        super(`${provider} did not respond within ${took}.`);
        this.name = 'TimeoutError';
    }
}

export class ProviderChain {
    constructor(
        private readonly providers: () => BookProvider[],
        private readonly timeoutMs: number = PROVIDER_TIMEOUT_MS,
        /** Injected for tests; defaults to real timers. */
        private readonly timers: {
            setTimeout: (fn: () => void, ms: number) => number;
            clearTimeout: (id: number) => void;
        } = {
            setTimeout: (fn, ms) => Number(setTimeout(fn, ms)),
            clearTimeout: (id) => clearTimeout(id),
        },
    ) {}

    /** Race a provider against the clock so one bad source cannot hang the rest. */
    private async withTimeout<T>(provider: BookProvider, work: Promise<T>): Promise<T> {
        let timer: number | undefined;
        try {
            return await Promise.race([
                work,
                new Promise<never>((_, reject) => {
                    timer = this.timers.setTimeout(
                        () => reject(new TimeoutError(provider.label, this.timeoutMs)),
                        this.timeoutMs,
                    );
                }),
            ]);
        } finally {
            if (timer !== undefined) this.timers.clearTimeout(timer);
        }
    }

    /** Providers currently available, in configured order. */
    available(): BookProvider[] {
        return this.providers();
    }

    byId(id: string): BookProvider | undefined {
        return this.providers().find((p) => p.id === id);
    }

    /**
     * Search each provider in order until one returns results.
     *
     * A provider returning zero results is NOT treated as failure — it may
     * genuinely not have the book — but the chain continues so a second source
     * gets the chance to find it.
     */
    async search(query: string, limit = 20): Promise<ChainSearchResult> {
        const failures: Array<{ provider: string; reason: string }> = [];
        const errors: Error[] = [];
        const skipped: string[] = [];
        const providers = this.providers();

        if (providers.length === 0) {
            return { hits: [], usedProvider: null, failures, skipped };
        }

        for (const provider of providers) {
            // Permanently unusable (needs a key, say). Skip without a request.
            const blocked = provider.unavailableReason?.() ?? null;
            if (blocked) {
                skipped.push(provider.id);
                failures.push({ provider: provider.label, reason: blocked });
                continue;
            }

            const cooldown = provider.cooldownRemaining?.() ?? 0;
            if (cooldown > 0) {
                skipped.push(provider.id);
                failures.push({
                    provider: provider.label,
                    reason: `standing down for ${Math.ceil(cooldown / 1000)}s`,
                });
                continue;
            }

            try {
                const hits = await this.withTimeout(provider, provider.search(query, limit));
                if (hits.length > 0) {
                    return { hits, usedProvider: provider.id, failures, skipped };
                }
                // No results: keep the answer but try the next source too.
            } catch (err) {
                const error = err instanceof Error ? err : new Error(String(err));
                errors.push(error);
                failures.push({ provider: provider.label, reason: error.message });
            }
        }

        // Every provider either failed or was skipped.
        if (failures.length === providers.length) {
            throw new AllProvidersFailedError(failures, errors);
        }
        // At least one provider answered honestly with nothing.
        return { hits: [], usedProvider: null, failures, skipped };
    }

    /** Resolve a hit using the provider that produced it. */
    async resolve(hit: SearchHit): Promise<BookMetadata> {
        const provider = this.byId(hit.providerId);
        if (!provider) throw new Error(`Unknown book source: ${hit.providerId}`);
        return this.withTimeout(provider, provider.resolve(hit));
    }
}

/** Merge results from several providers, keeping the first of each book. */
export function mergeHits(groups: SearchHit[][]): SearchHit[] {
    const seen = new Set<string>();
    const out: SearchHit[] = [];
    for (const group of groups) {
        for (const hit of group) {
            const key = dedupeKey(hit);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(hit);
        }
    }
    return out;
}
