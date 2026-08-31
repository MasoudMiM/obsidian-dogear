// Dogear — enrichment logic.
//
// Pure, DOM-free functions for enriching a manually-added book with
// metadata from a provider, kept here so they can be unit tested.

import { type Book } from './model';
import { type BookMetadata } from './providers/types';

/**
 * Build the search query used to find the book in a provider.
 *
 * An ISBN is the most reliable identifier and some providers support
 * fielded ISBN queries, so it wins when present. Otherwise we fall back
 * to title plus authors.
 */
export function buildEnrichQuery(book: Pick<Book, 'title' | 'authors' | 'isbn10' | 'isbn13'>): string {
    const isbn = book.isbn13 || book.isbn10;
    if (isbn) return `isbn:${isbn}`;
    return [book.title, ...book.authors].join(' ').trim();
}

/**
 * Merge provider metadata into an existing book.
 *
 * The reader's own data always wins: enrichment fills gaps and never
 * overwrites a field the reader (or an earlier enrichment) already set.
 * Progress, sessions, status and rating are untouched.
 */
export function mergeBookMetadata(book: Book, metadata: BookMetadata): Book {
    const first = (existing: string | undefined, found: string | undefined) =>
        existing || found;

    const tags = [...book.tags];
    for (const tag of metadata.tags) {
        if (!tags.includes(tag)) tags.push(tag);
    }

    return {
        ...book,
        title: book.title || metadata.title,
        authors: book.authors.length > 0 ? book.authors : metadata.authors,
        cover: book.cover || metadata.cover,
        isbn10: first(book.isbn10, metadata.isbn10),
        isbn13: first(book.isbn13, metadata.isbn13),
        publisher: first(book.publisher, metadata.publisher),
        published: first(book.published, metadata.published),
        tags,
        metrics: {
            pages: book.metrics.pages ?? metadata.pages,
            duration: book.metrics.duration,
        },
        olWork: book.olWork ?? metadata.olWork,
        olEdition: book.olEdition ?? metadata.olEdition,
        googleId: book.googleId ?? metadata.googleId,
    };
}
