// Dogear — tests for the enrichment logic.

import { buildEnrichQuery, mergeBookMetadata } from '../src/enrich';
import { type Book } from '../src/model';
import { type BookMetadata } from '../src/providers/types';
import type { Harness } from './note.test';

const baseBook: Book = {
    schemaVersion: 1,
    title: 'Some Book',
    authors: ['An Author'],
    tags: ['history'],
    metrics: {},
    status: 'want-to-read',
    sessions: [],
};

const meta = (over: Partial<BookMetadata> = {}): BookMetadata => ({
    title: 'Some Book: A Definitive Edition',
    authors: ['An Author'],
    tags: ['history', 'biography'],
    source: 'openlibrary',
    ...over,
});

export async function runEnrichTests(h: Harness): Promise<void> {
    const { describe, ok, eq } = h;

    await describe('enrich: building the search query', () => {
        eq(
            buildEnrichQuery({ ...baseBook, isbn13: '9780060512750' }),
            'isbn:9780060512750',
            'an ISBN-13 is preferred and fielded',
        );
        eq(
            buildEnrichQuery({ ...baseBook, isbn13: undefined, isbn10: '0060512750' }),
            'isbn:0060512750',
            'an ISBN-10 is used when there is no ISBN-13',
        );
        eq(
            buildEnrichQuery({ ...baseBook, isbn13: undefined, isbn10: undefined }),
            'Some Book An Author',
            'without an ISBN, title and authors are used',
        );
        eq(
            buildEnrichQuery({ ...baseBook, isbn13: undefined, isbn10: undefined, authors: [] }),
            'Some Book',
            'a lone title still makes a query',
        );
    });
    await describe('enrich: merging metadata never overwrites the reader', () => {
        const book: Book = {
            ...baseBook,
            title: 'My Own Title',
            publisher: 'A Publisher',
            metrics: { pages: 100 },
            olWork: '/works/OL1W',
        };
        const found: BookMetadata = {
            title: 'Different Title',
            authors: ['Someone Else'],
            publisher: 'Other Press',
            published: '1999',
            pages: 300,
            tags: [],
            olWork: '/works/OL9W',
            olEdition: '/books/OL9M',
            source: 'openlibrary',
        };

        const merged = mergeBookMetadata(book, found);
        eq(merged.title, 'My Own Title', 'an existing title is kept');
        eq(merged.publisher, 'A Publisher', 'an existing publisher is kept');
        eq(merged.published, '1999', 'a missing field is filled in');
        eq(merged.metrics.pages, 100, 'an existing page count is kept');
        eq(merged.olWork, '/works/OL1W', 'an existing work key is kept');
        eq(merged.olEdition, '/books/OL9M', 'a missing edition key is filled in');
        eq(merged.authors, ['An Author'], 'existing authors are kept');
        eq(merged.status, 'want-to-read', 'status untouched');
        eq(merged.sessions, [], 'sessions untouched');
    });

    await describe('enrich: merging fills an empty book in', () => {
        const bare: Book = { ...baseBook, title: 'A Nameless Book', authors: [], metrics: {} };
        const found: BookMetadata = {
            title: 'The Real Title',
            authors: ['The Real Author'],
            isbn13: '9780060512750',
            pages: 387,
            tags: ['sci-fi'],
            source: 'googlebooks',
        };

        const merged = mergeBookMetadata(bare, found);
        eq(merged.isbn13, '9780060512750', 'ISBN filled in');
        eq(merged.metrics.pages, 387, 'page count filled in');
        eq(merged.authors, ['The Real Author'], 'authors filled in');
        eq(merged.tags, ['history', 'sci-fi'], 'provider tags are added to the reader tags');
    });

    await describe('enrich: merging tags without duplicates', () => {
        const merged = mergeBookMetadata(
            { ...baseBook, tags: ['sci-fi', 'favourites'] },
            { ...meta(), tags: ['sci-fi', 'space'] },
        );
        eq(merged.tags, ['sci-fi', 'favourites', 'space'], 'a repeated tag is added only once');
        ok(merged.tags[0] === 'sci-fi', 'the reader tags come first');
    });
}
