// Dogear — tests for the debounced search helper.

import { DebouncedSearch, type SearchTimers } from '../src/search';
import { todayIso, describeRating, formatPercent } from '../src/format';
import type { Harness } from './note.test';

/** Controllable clock so debouncing can be tested without waiting. */
class FakeTimers implements SearchTimers {
    private next = 1;
    private queue = new Map<number, { fn: () => void; at: number }>();
    now = 0;

    setTimeout(fn: () => void, ms: number): number {
        const id = this.next++;
        this.queue.set(id, { fn, at: this.now + ms });
        return id;
    }
    clearTimeout(handle: number): void {
        this.queue.delete(handle);
    }
    /** Advance time and run anything due. */
    advance(ms: number): void {
        this.now += ms;
        const due = [...this.queue.entries()]
            .filter(([, t]) => t.at <= this.now)
            .sort((a, b) => a[1].at - b[1].at);
        for (const [id, t] of due) {
            this.queue.delete(id);
            t.fn();
        }
    }
    get pending(): number {
        return this.queue.size;
    }
}

/** A fetch whose resolution we control, to force out-of-order responses. */
function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

export async function runSearchTests(h: Harness): Promise<void> {
    const { describe, ok, eq } = h;

    await describe('search: debouncing', async () => {
        const timers = new FakeTimers();
        const queries: string[] = [];
        const search = new DebouncedSearch<string>({
            fetch: async (q) => {
                queries.push(q);
                return [q];
            },
            delayMs: 400,
            minLength: 2,
            timers,
        });

        // Simulate typing "dune" one character at a time.
        void search.search('d');
        void search.search('du');
        void search.search('dun');
        const last = search.search('dune');

        eq(queries.length, 0, 'nothing fetched while still typing');
        timers.advance(399);
        eq(queries.length, 0, 'nothing fetched before the quiet period elapses');
        timers.advance(1);
        await flush();

        eq(queries, ['dune'], 'exactly one request, for the final query');
        eq(await last, ['dune'], 'the final call receives the results');
        eq(search.stats.fetches, 1, 'one fetch counted');
    });

    await describe('search: short queries never hit the network', async () => {
        const timers = new FakeTimers();
        let calls = 0;
        const search = new DebouncedSearch<string>({
            fetch: async () => {
                calls++;
                return [];
            },
            minLength: 2,
            timers,
        });

        eq(await search.search('d'), [], 'single character returns nothing');
        eq(await search.search(''), [], 'empty query returns nothing');
        eq(await search.search('   '), [], 'whitespace-only query returns nothing');
        timers.advance(1000);
        await flush();
        eq(calls, 0, 'no request made for any short query');
        eq(timers.pending, 0, 'no timer left pending');
    });

    await describe('search: out-of-order responses are discarded', async () => {
        const timers = new FakeTimers();
        const slow = deferred<string[]>();
        const fast = deferred<string[]>();
        let call = 0;

        const search = new DebouncedSearch<string>({
            fetch: async () => {
                call++;
                return call === 1 ? slow.promise : fast.promise;
            },
            delayMs: 100,
            minLength: 2,
            timers,
        });

        // First query fires.
        const first = search.search('du');
        timers.advance(100);
        await flush();

        // Second query fires before the first has responded.
        const second = search.search('dune');
        timers.advance(100);
        await flush();

        // The FAST (newer) request resolves first.
        fast.resolve(['dune result']);
        await flush();
        eq(await second, ['dune result'], 'newer query returns its own results');

        // Now the SLOW (older) request finally resolves. It must be ignored.
        slow.resolve(['stale du result']);
        await flush();
        eq(await first, [], 'stale response discarded rather than shown');
        eq(search.stats.discarded, 1, 'discard counted');
    });

    await describe('search: superseded pending calls resolve rather than dangle', async () => {
        const timers = new FakeTimers();
        const search = new DebouncedSearch<string>({
            fetch: async (q) => [q],
            delayMs: 100,
            minLength: 2,
            timers,
        });

        const abandoned = search.search('du');
        const current = search.search('dune');
        timers.advance(100);
        await flush();

        // The abandoned promise must settle, or SuggestModal would hang on it.
        eq(await abandoned, [], 'superseded call resolves with an empty list');
        eq(await current, ['dune'], 'current call resolves normally');
    });

    await describe('search: errors surface without breaking the list', async () => {
        const timers = new FakeTimers();
        const errors: string[] = [];
        const search = new DebouncedSearch<string>({
            fetch: async () => {
                throw new Error('network down');
            },
            delayMs: 100,
            minLength: 2,
            timers,
            onError: (e) => errors.push(e.message),
        });

        const result = search.search('dune');
        timers.advance(100);
        await flush();

        eq(await result, [], 'a failed search resolves empty rather than rejecting');
        eq(errors, ['network down'], 'the error is reported to the UI');
    });

    await describe('search: loading state is reported', async () => {
        const timers = new FakeTimers();
        const states: boolean[] = [];
        const search = new DebouncedSearch<string>({
            fetch: async (q) => [q],
            delayMs: 100,
            minLength: 2,
            timers,
            onLoadingChange: (l) => states.push(l),
        });

        const p = search.search('dune');
        eq(states, [], 'not loading while merely debouncing');
        timers.advance(100);
        await flush();
        await p;
        eq(states, [true, false], 'loading turns on when the request starts and off when it ends');
    });

    await describe('search: cancel stops pending work', async () => {
        const timers = new FakeTimers();
        let calls = 0;
        const search = new DebouncedSearch<string>({
            fetch: async () => {
                calls++;
                return [];
            },
            delayMs: 100,
            minLength: 2,
            timers,
        });

        const p = search.search('dune');
        search.cancel();
        timers.advance(1000);
        await flush();

        eq(calls, 0, 'cancelling before the timer fires makes no request');
        eq(await p, [], 'the cancelled promise still settles');
        eq(timers.pending, 0, 'no timers left behind when the modal closes');
    });

    await describe('search: a late response after cancel is ignored', async () => {
        const timers = new FakeTimers();
        const pendingFetch = deferred<string[]>();
        const search = new DebouncedSearch<string>({
            fetch: async () => pendingFetch.promise,
            delayMs: 100,
            minLength: 2,
            timers,
        });

        const p = search.search('dune');
        timers.advance(100);
        await flush();
        // Modal closes while the request is still in flight.
        search.cancel();
        pendingFetch.resolve(['too late']);
        await flush();

        eq(await p, [], 'response arriving after cancel is discarded');
        ok(search.stats.discarded >= 1, 'discard counted after cancel');
    });

    await describe('format: local date, not UTC', () => {
        // The bug this guards against: toISOString() converts to UTC, so
        // logging progress at 8pm in New York would file it under tomorrow.
        const evening = new Date(2026, 6, 18, 20, 30, 0);
        eq(todayIso(evening), '2026-07-18', 'evening stays on the same local day');

        const earlyMorning = new Date(2026, 0, 1, 0, 5, 0);
        eq(todayIso(earlyMorning), '2026-01-01', "new year's morning is not backdated");

        const endOfMonth = new Date(2026, 1, 28, 23, 59, 0);
        eq(todayIso(endOfMonth), '2026-02-28', 'late-night end of month stays put');

        eq(todayIso(new Date(2026, 8, 5)), '2026-09-05', 'single digits zero padded');
    });

    await describe('format: rating descriptions for screen readers', () => {
        eq(describeRating(0), 'Not rated', 'zero reads as not rated');
        eq(describeRating(1), '1 star', 'singular star');
        eq(describeRating(2), '2 stars', 'plural stars');
        eq(describeRating(3.5), '3 and a half stars', 'half star spoken naturally');
        eq(describeRating(4.25), '4 and a quarter stars', 'quarter star');
        eq(describeRating(4.75), '4 and three quarters stars', 'three quarters');
        eq(describeRating(5), '5 stars', 'maximum');
        eq(describeRating(-1), 'Not rated', 'negative reads as not rated');
    });

    await describe('format: percentages', () => {
        eq(formatPercent(0.5), '50%', 'half');
        eq(formatPercent(0), '0%', 'zero');
        eq(formatPercent(1), '100%', 'complete');
        eq(formatPercent(0.333), '33%', 'rounded');
        eq(formatPercent(1.5), '100%', 'clamped above');
        eq(formatPercent(-1), '0%', 'clamped below');
    });
}
