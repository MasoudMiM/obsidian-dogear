// Dogear — storing covers in the vault.
//
// Why this is opt-in rather than automatic:
//
// Open Library's own documentation asks that the cover service be used for
// display and not for bulk download, and limits an address to 100 cover
// lookups every five minutes. Quietly fetching several hundred images the
// moment someone imports a library would be exactly the behaviour they are
// asking not to see. So this runs only when asked, moves deliberately slowly,
// and can be stopped and resumed.
//
// It is also worth being honest that this buys less than it appears to.
// Obsidian is a browser, and a browser already caches images — covers are not
// re-fetched on every glance at the library. What storing them locally really
// buys is permanence: they work offline, they are backed up with the vault,
// and they survive Open Library moving or removing a file.
//
// The cost is vault size. A few hundred medium covers is several megabytes,
// which is nothing on disk but is not nothing over a sync service on a phone.
//
// DOM-free and dependency-free.

import type { Book } from './model';
import { isRemoteCover } from './library';
import { sanitiseFilename } from './paths';

/** A book whose cover could be brought into the vault. */
export interface CoverJob {
    path: string;
    book: Book;
    /** Where the image would be written. */
    target: string;
    /** Where it would be fetched from. */
    source: string;
}

/**
 * A stable, readable filename for a cover.
 *
 * The ISBN is preferred because it is unique and never changes; a retitled or
 * re-imported book keeps the same file rather than accumulating copies. Books
 * without one fall back to the title, sanitised the same way note filenames
 * are.
 */
export function coverFilename(book: Book, source: string): string {
    const isbn = (book.isbn13 ?? book.isbn10 ?? '').replace(/[^0-9Xx]/g, '');
    const stem = isbn !== '' ? isbn : sanitiseFilename(book.title).slice(0, 80);

    // Keep the real extension where the address offers one, since not every
    // cover is a JPEG.
    const match = /\.(jpe?g|png|webp|gif)(?:\?|$)/i.exec(source);
    const ext = match ? match[1].toLowerCase() : 'jpg';
    return `${stem}.${ext === 'jpeg' ? 'jpg' : ext}`;
}

/** Join a folder and filename without doubling or dropping the separator. */
export function joinPath(folder: string, name: string): string {
    const clean = folder.replace(/\/+$/, '');
    return clean === '' ? name : `${clean}/${name}`;
}

/**
 * Which books would be fetched, and to where.
 *
 * Skips books whose cover already lives in the vault, so the operation can be
 * interrupted and resumed without redoing work — and so running it twice is
 * harmless.
 */
export function planCoverDownloads(
    entries: Array<{ path: string; book: Book }>,
    folder: string,
): CoverJob[] {
    const jobs: CoverJob[] = [];
    for (const { path, book } of entries) {
        const source = book.cover;
        // Nothing to fetch, or it is already a vault file.
        if (!source || !isRemoteCover(source)) continue;

        const target = joinPath(folder, coverFilename(book, source));
        jobs.push({ path, book, target, source });
    }
    return jobs;
}

/** Split a plan into work to do and files already present. */
export function partitionJobs(
    jobs: CoverJob[],
    exists: (path: string) => boolean,
): { toFetch: CoverJob[]; alreadyThere: CoverJob[] } {
    const toFetch: CoverJob[] = [];
    const alreadyThere: CoverJob[] = [];
    for (const job of jobs) {
        if (exists(job.target)) alreadyThere.push(job);
        else toFetch.push(job);
    }
    return { toFetch, alreadyThere };
}

/**
 * Is this response actually an image?
 *
 * Open Library answers a missing cover with a 1x1 transparent GIF, which is a
 * perfectly valid image file and would be saved as one. Anything this small
 * is a placeholder, not artwork.
 */
export function looksLikeRealImage(bytes: ArrayBuffer, contentType?: string): boolean {
    if (bytes.byteLength < 1024) return false;
    if (contentType && !/^image\//i.test(contentType)) return false;
    return true;
}

/** How long a download of this size will take at the given rate, in seconds. */
export function estimateSeconds(count: number, perMinute: number): number {
    if (count <= 0) return 0;
    return Math.ceil((count / perMinute) * 60);
}

/** A rough, friendly duration. */
export function describeDuration(seconds: number): string {
    if (seconds < 60) return 'under a minute';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
    const hours = Math.round(minutes / 60);
    return `about ${hours} hour${hours === 1 ? '' : 's'}`;
}
