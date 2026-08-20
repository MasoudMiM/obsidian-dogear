// Dogear — CSV export.
//
// The library is already plain Markdown you can take anywhere; this exists to
// interoperate with other trackers rather than to escape this one. The format
// is a Goodreads-shaped CSV because that is what every other reading tracker
// already knows how to import. Columns a Goodreads export carries but Dogear
// does not track are left blank rather than invented.
//
// Losses, stated rather than hidden:
//   - Reviews and notes are prose in the note body and stay there; they are
//     not squeezed into a CSV cell.
//   - A book read more than once exports the most recent finish date and the
//     true read count — the same flattening Goodreads itself performs, and
//     the importer warns about on the way back in.
//   - A series without a position number cannot be embedded in the title and
//     is left out.
//
// DOM-free and dependency-free.

import { completedReadCount, type Book, type ReadingStatus } from './model';

/** The Goodreads columns Dogear has something honest to put in. */
export const EXPORT_COLUMNS = [
    'Book Id',
    'Title',
    'Author',
    'Additional Authors',
    'ISBN',
    'ISBN13',
    'My Rating',
    'Publisher',
    'Number of Pages',
    'Year Published',
    'Original Publication Year',
    'Date Read',
    'Date Added',
    'Bookshelves',
    'Exclusive Shelf',
    'My Review',
    'Read Count',
] as const;

/** RFC 4180: quote a field when it contains a comma, quote or newline. */
export function formatCsvField(value: string): string {
    if (/[",\r\n]/.test(value)) {
        return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
}

export function toCsvLine(fields: string[]): string {
    return fields.map(formatCsvField).join(',');
}

/** Dogear statuses back into Goodreads shelf names. */
export function statusToShelf(status: ReadingStatus): string {
    switch (status) {
        case 'finished':
            return 'read';
        case 'reading':
            return 'currently-reading';
        case 'want-to-read':
            return 'to-read';
        case 'dnf':
            return 'dnf';
    }
}

/** ISO YYYY-MM-DD into the YYYY/MM/DD Goodreads uses. */
export function isoToGoodreadsDate(iso: string): string {
    return iso.replace(/-/g, '/');
}

/** Excel armour, the way Goodreads does it, so leading zeros survive. */
export function armourIsbn(isbn: string | undefined): string {
    return isbn ? `="${isbn}"` : '';
}

/**
 * Goodreads has no series field; it embeds the series in the title. This is
 * the inverse of splitSeriesFromTitle, so a book with a series position
 * round-trips through the importer without losing it.
 */
export function exportTitle(book: Book): string {
    if (book.series && book.series.trim() !== '' && book.seriesPosition !== undefined) {
        return `${book.title} (${book.series} #${book.seriesPosition})`;
    }
    return book.title;
}

/** The most recent completed session's finish date, if any. */
export function lastFinishedDate(book: Book): string | undefined {
    for (let i = book.sessions.length - 1; i >= 0; i--) {
        const session = book.sessions[i];
        if (session.finished && !session.abandoned) return session.finished;
    }
    return undefined;
}

/** One book as cells aligned with EXPORT_COLUMNS. */
export function bookToRow(book: Book): string[] {
    const published = book.published ?? '';
    const readDate = lastFinishedDate(book);
    return [
        '',
        exportTitle(book),
        book.authors[0] ?? '',
        book.authors.slice(1).join(', '),
        armourIsbn(book.isbn10),
        armourIsbn(book.isbn13),
        String(book.rating ?? 0),
        book.publisher ?? '',
        book.metrics.pages !== undefined ? String(book.metrics.pages) : '',
        published,
        published,
        readDate ? isoToGoodreadsDate(readDate) : '',
        '',
        book.tags.join(', '),
        statusToShelf(book.status),
        '',
        String(completedReadCount(book.sessions)),
    ];
}

/**
 * The whole library as one CSV document.
 *
 * Sorted by title then author so two exports of the same library are
 * identical files, which makes diffing them painless.
 */
export function exportLibraryCsv(books: Book[]): string {
    const sorted = [...books].sort((a, b) => {
        const byTitle = a.title.toLowerCase().localeCompare(b.title.toLowerCase());
        if (byTitle !== 0) return byTitle;
        const authorA = a.authors[0] ?? '';
        const authorB = b.authors[0] ?? '';
        return authorA.localeCompare(authorB);
    });

    const lines = [toCsvLine([...EXPORT_COLUMNS])];
    for (const book of sorted) {
        lines.push(toCsvLine(bookToRow(book)));
    }
    return `${lines.join('\n')}\n`;
}
