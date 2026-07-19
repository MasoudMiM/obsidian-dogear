// Dogear — Open Library provider.
//
// Wraps the existing OpenLibraryClient in the common provider interface.
// Open Library stays FIRST in the chain: it is fully open data, needs no key,
// has the best coverage of older and non-English editions, and asks nothing of
// the user. It is only unreliable, not bad.

import type { BookMetadata, BookProvider, SearchHit } from './types';
import type { OpenLibraryClient } from '../olclient';
import { coverUrlFromId, coverUrlFromIsbn, type WorkResult } from '../openlibrary';

export const OL_PROVIDER_ID = 'openlibrary';

/** Map an Open Library work result into a neutral search hit. */
export function workToHit(work: WorkResult): SearchHit {
    const cover = work.coverId
        ? coverUrlFromId(work.coverId, 'M')
        : work.isbns[0]
          ? coverUrlFromIsbn(work.isbns[0], 'M')
          : undefined;
    return {
        providerId: OL_PROVIDER_ID,
        id: work.workKey,
        title: work.title,
        subtitle: work.subtitle,
        authors: work.authors,
        year: work.firstPublishYear,
        coverUrl: cover,
        pages: work.medianPages,
        isbn13: work.isbns[0],
        publisher: work.publishers[0],
        published: work.firstPublishYear ? String(work.firstPublishYear) : undefined,
        tags: work.subjects.slice(0, 8),
        // A work usually needs an editions lookup to pin down a page count.
        complete: false,
        raw: work,
    };
}

export class OpenLibraryProvider implements BookProvider {
    readonly id = OL_PROVIDER_ID;
    readonly label = 'Open Library';
    readonly attribution = 'Open Library, a project of the Internet Archive';

    constructor(
        private readonly client: OpenLibraryClient,
        private readonly preferredLanguage: () => string = () => 'eng',
    ) {}

    cooldownRemaining(): number {
        return this.client.cooldownRemaining;
    }

    async search(query: string, limit = 20): Promise<SearchHit[]> {
        const works = await this.client.search(query, limit);
        return works.map(workToHit);
    }

    async resolve(hit: SearchHit): Promise<BookMetadata> {
        const work = hit.raw as WorkResult;
        const meta = await this.client.resolve(work, {
            language: this.preferredLanguage(),
        });
        return {
            title: meta.title,
            authors: meta.authors,
            cover: meta.cover,
            isbn10: meta.isbn10,
            isbn13: meta.isbn13,
            publisher: meta.publisher,
            published: meta.published,
            pages: meta.pages,
            tags: meta.tags,
            olWork: meta.olWork,
            olEdition: meta.olEdition,
            source: OL_PROVIDER_ID,
        };
    }
}
