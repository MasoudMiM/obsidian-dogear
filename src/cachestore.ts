// Dogear — persistent metadata cache.
//
// Every provider caches catalogue responses in memory, but that cache used to
// die with the process: restart Obsidian and books the plugin already knew
// were asked for again. This module serialises those caches so a restart
// costs no requests at all — the largest remaining reduction in load on the
// free catalogues Dogear depends on.
//
// The on-disk shape is deliberately boring: versioned JSON, one section per
// provider, each entry a URL, the response JSON and an expiry. Catalogue
// responses only — no vault content, nothing user-authored — and the file
// never leaves the machine. A corrupt or outdated file is discarded
// wholesale rather than partially trusted; the cache is a convenience, and
// rebuilding it is always an option.
//
// DOM-free and dependency-free.

/** One cached catalogue response. */
export interface CachedResponse {
    value: unknown;
    /** Epoch ms after which the entry must not be used. */
    expires: number;
}

/** The live entries of one provider's cache, keyed by request URL. */
export type CacheSnapshot = Record<string, CachedResponse>;

/** Bumped whenever the on-disk shape changes incompatibly. */
export const CACHE_FILE_VERSION = 1;

interface CacheFile {
    version: number;
    savedAt: number;
    providers: Record<string, CacheSnapshot>;
}

/** Serialise every provider's cache into the on-disk format. */
export function serializeCacheFile(
    providers: Record<string, CacheSnapshot>,
    savedAt: number,
): string {
    const file: CacheFile = { version: CACHE_FILE_VERSION, savedAt, providers };
    return JSON.stringify(file);
}

function isCachedResponse(v: unknown, now: number): v is CachedResponse {
    if (v === null || typeof v !== 'object') return false;
    const entry = v as Record<string, unknown>;
    return (
        typeof entry.expires === 'number' &&
        Number.isFinite(entry.expires) &&
        entry.expires > now &&
        'value' in entry
    );
}

/**
 * Parse a cache file, dropping anything expired or malformed.
 *
 * Returns null when the file as a whole cannot be trusted — not valid JSON,
 * not an object, or a different format version. Individual provider sections
 * that are not objects are skipped rather than rejecting the rest.
 */
export function parseCacheFile(
    raw: string,
    now: number,
): Record<string, CacheSnapshot> | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    const file = parsed as Record<string, unknown>;
    if (file.version !== CACHE_FILE_VERSION) return null;
    if (file.providers === null || typeof file.providers !== 'object' || Array.isArray(file.providers)) {
        return null;
    }

    const out: Record<string, CacheSnapshot> = {};
    for (const [providerId, section] of Object.entries(file.providers as Record<string, unknown>)) {
        if (section === null || typeof section !== 'object' || Array.isArray(section)) continue;
        const snapshot: CacheSnapshot = {};
        for (const [url, entry] of Object.entries(section as Record<string, unknown>)) {
            if (isCachedResponse(entry, now)) snapshot[url] = { value: entry.value, expires: entry.expires };
        }
        out[providerId] = snapshot;
    }
    return out;
}

/** Copy the live entries of a cache map, leaving out anything expired. */
export function snapshotOf(map: Map<string, CachedResponse>, now: number): CacheSnapshot {
    const out: CacheSnapshot = {};
    for (const [url, entry] of map) {
        if (entry.expires > now) out[url] = { value: entry.value, expires: entry.expires };
    }
    return out;
}

/**
 * Drop expired entries and cap the count, keeping the entries that expire
 * last. Ordered so that restoring into a Map puts the soonest-expiring entry
 * first, which is the one insertion-order eviction should claim next.
 */
export function pruneSnapshot(
    snapshot: CacheSnapshot,
    now: number,
    maxEntries: number,
): Array<[string, CachedResponse]> {
    const live = Object.entries(snapshot).filter(([, entry]) => entry.expires > now);
    live.sort((a, b) => a[1].expires - b[1].expires);
    return live.slice(Math.max(0, live.length - maxEntries));
}
