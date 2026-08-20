// Dogear — tests for the persistent metadata cache.
//
// The cache used to die with the process: restart Obsidian and every known
// book was asked for again. These tests cover the on-disk format and the
// snapshot/restore wiring that lets the caches survive a restart.

import {
    CACHE_FILE_VERSION,
    parseCacheFile,
    pruneSnapshot,
    serializeCacheFile,
    snapshotOf,
    type CacheSnapshot,
} from '../src/cachestore';
import { OpenLibraryClient, type HttpResponse } from '../src/olclient';
import { GoogleBooksProvider, buildGoogleSearchUrl } from '../src/providers/googlebooks';

interface Harness {
    describe: (name: string, fn: () => void | Promise<void>) => Promise<void>;
    ok: (cond: boolean, msg: string) => void;
    eq: <T>(actual: T, expected: T, msg: string) => void;
    close: (actual: number, expected: number, msg: string) => void;
}

const HOUR = 60 * 60 * 1000;

export async function runCacheStoreTests({ describe, ok, eq }: Harness): Promise<void> {
    await describe('cachestore: file round trip', () => {
        const providers: Record<string, CacheSnapshot> = {
            openlibrary: {
                'https://openlibrary.org/search.json?q=dune': {
                    value: { docs: [{ key: '/works/OL1W', title: 'Dune' }] },
                    expires: 1000 + 24 * HOUR,
                },
            },
            googlebooks: {},
        };
        const raw = serializeCacheFile(providers, 1000);
        const back = parseCacheFile(raw, 1000);
        ok(back !== null, 'a freshly written file parses');
        eq(
            back?.openlibrary['https://openlibrary.org/search.json?q=dune'].value,
            providers.openlibrary['https://openlibrary.org/search.json?q=dune'].value,
            'response JSON survives the round trip',
        );
        eq(Object.keys(back?.googlebooks ?? {}).length, 0, 'empty section stays empty');
    });

    await describe('cachestore: untrustworthy files are rejected', () => {
        eq(parseCacheFile('not json', 0), null, 'invalid JSON rejected');
        eq(parseCacheFile('"a string"', 0), null, 'non-object rejected');
        eq(parseCacheFile('[]', 0), null, 'array rejected');
        eq(
            parseCacheFile(JSON.stringify({ version: CACHE_FILE_VERSION + 1, providers: {} }), 0),
            null,
            'future version rejected',
        );
        eq(
            parseCacheFile(JSON.stringify({ version: CACHE_FILE_VERSION }), 0),
            null,
            'missing providers rejected',
        );

        // A broken section is skipped, not allowed to sink the whole file.
        const mixed = parseCacheFile(
            JSON.stringify({
                version: CACHE_FILE_VERSION,
                savedAt: 0,
                providers: {
                    openlibrary: 'garbage',
                    loc: { 'https://loc.gov/x': { value: { ok: true }, expires: 5000 } },
                },
            }),
            1000,
        );
        ok(mixed !== null, 'file with one broken section still parses');
        eq(Object.keys(mixed?.openlibrary ?? {}).length, 0, 'broken section treated as empty');
        eq(Object.keys(mixed?.loc ?? {}).length, 1, 'healthy section kept');
    });

    await describe('cachestore: expired and malformed entries dropped', () => {
        const raw = JSON.stringify({
            version: CACHE_FILE_VERSION,
            savedAt: 0,
            providers: {
                openlibrary: {
                    fresh: { value: 1, expires: 2000 },
                    stale: { value: 2, expires: 500 },
                    noExpiry: { value: 3 },
                    badExpiry: { value: 4, expires: 'soon' },
                    notAnEntry: 'nope',
                },
            },
        });
        const parsed = parseCacheFile(raw, 1000);
        eq(Object.keys(parsed?.openlibrary ?? {}), ['fresh'], 'only the live, well-formed entry kept');
    });

    await describe('cachestore: pruning keeps what expires last', () => {
        const snapshot: CacheSnapshot = {
            a: { value: 'a', expires: 3000 },
            b: { value: 'b', expires: 1000 },
            c: { value: 'c', expires: 5000 },
            dead: { value: 'd', expires: 500 },
        };
        const kept = pruneSnapshot(snapshot, 900, 2);
        eq(
            kept.map(([url]) => url),
            ['a', 'c'],
            'cap keeps the latest-expiring entries, soonest first',
        );
        eq(pruneSnapshot(snapshot, 9000, 10).length, 0, 'everything expired means nothing kept');
    });

    await describe('cachestore: snapshotOf skips expired entries', () => {
        const map = new Map<string, { value: unknown; expires: number }>([
            ['live', { value: 1, expires: 2000 }],
            ['dead', { value: 2, expires: 1000 }],
        ]);
        eq(Object.keys(snapshotOf(map, 1000)), ['live'], 'expired entry left out');
    });

    await describe('cachestore: client restore and snapshot', async () => {
        let requests = 0;
        const requester = async (url: string): Promise<HttpResponse> => {
            requests++;
            return { status: 200, json: { fetched: url } };
        };

        let now = 1000;
        const restored = new OpenLibraryClient(requester, { now: () => now, ttlMs: HOUR });
        restored.restore({
            'https://openlibrary.org/search.json?q=dune': {
                value: { docs: [] },
                expires: now + HOUR,
            },
            'https://openlibrary.org/search.json?q=stale': {
                value: { docs: [] },
                expires: now - 1,
            },
        });

        const hit = await restored.getJson('https://openlibrary.org/search.json?q=dune');
        eq(hit, { docs: [] }, 'restored entry served without a request');
        eq(requests, 0, 'no network call for a restored entry');
        eq(restored.stats.cacheHits, 1, 'restore counts as a cache hit');

        await restored.getJson('https://openlibrary.org/search.json?q=stale');
        eq(requests, 1, 'an entry that expired over the restart is refetched');

        // Snapshot only reports what is still live.
        now += 2 * HOUR;
        eq(Object.keys(restored.snapshot()).length, 0, 'snapshot drops entries that expired');
    });

    await describe('cachestore: restore respects the entry cap', async () => {
        const client = new OpenLibraryClient(
            async () => ({ status: 200, json: null }),
            { maxEntries: 2, now: () => 1000 },
        );
        client.restore({
            a: { value: 1, expires: 2000 },
            b: { value: 2, expires: 3000 },
            c: { value: 3, expires: 4000 },
        });
        eq(Object.keys(client.snapshot()).sort(), ['b', 'c'], 'excess entries dropped, newest kept');
    });

    await describe('cachestore: writes announce themselves for persistence', async () => {
        let writes = 0;
        const client = new OpenLibraryClient(
            async () => ({ status: 200, json: { ok: true } }),
            { now: () => 1000, onCacheWrite: () => writes++ },
        );
        await client.getJson('https://openlibrary.org/search.json?q=x');
        eq(writes, 1, 'caching a response fires the write hook');
        await client.getJson('https://openlibrary.org/search.json?q=x');
        eq(writes, 1, 'serving from cache does not fire it again');
    });

    await describe('cachestore: provider restore (Google Books)', async () => {
        let requests = 0;
        const url = buildGoogleSearchUrl('dune', 20);
        const provider = new GoogleBooksProvider(
            async () => {
                requests++;
                return { status: 200, json: { items: [] } };
            },
            { now: () => 1000 },
        );
        provider.restore({
            [url]: {
                value: {
                    items: [
                        {
                            id: 'v1',
                            volumeInfo: { title: 'Dune', authors: ['Frank Herbert'] },
                        },
                    ],
                },
                expires: 2000,
            },
        });

        const hits = await provider.search('dune');
        eq(requests, 0, 'restored provider answers without a request');
        eq(hits.length, 1, 'restored response maps to hits');
        eq(hits[0].title, 'Dune', 'hit carries the restored data');
    });
}
