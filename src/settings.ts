// Dogear — settings model.
//
// Kept DOM-free so defaults and validation can be unit tested. The settings
// *tab* lives in the UI layer.

import type { Format } from './model';
import { DEFAULT_LOG_HEADING } from './note';

export interface DogearSettings {
    /** Folder that holds book notes. Empty means the vault root. */
    booksFolder: string;
    /** Filename template. See renderFilenameTemplate for placeholders. */
    filenameTemplate: string;
    /** Heading of the section Dogear owns inside a book note. */
    logHeading: string;
    /** Format preselected when logging progress on a new book. */
    defaultFormat: Format;
    /** Open the note immediately after adding a book. */
    openOnCreate: boolean;
    /** Preferred language for edition selection, as an ISO 639-2 code. */
    preferredLanguage: string;
    /** Cache lifetime for metadata responses, in hours. */
    cacheHours: number;
    /**
     * Metadata sources, in the order they should be tried. Removing an id
     * disables that source.
     */
    providers: string[];
    /**
     * Optional Google Books API key. Searching works without one, but Google
     * describes keyless access as rate limited and unsuitable for sustained
     * use, so heavy users can supply their own.
     */
    googleApiKey: string;
    /**
     * ISO 3166-1 alpha-2 country code for Google Books. Empty means detect it
     * from the system locale. Google refuses requests it cannot geolocate,
     * because its display rights differ by country.
     */
    googleCountry: string;
    /**
     * Where downloaded covers are kept. Relative to the vault, like the books
     * folder, so people who keep attachments somewhere specific can say so.
     */
    coverFolder: string;
}

/** Every provider Dogear knows about, in default order. */
export const ALL_PROVIDER_IDS = [
    'openlibrary',
    'googlebooks',
    'loc',
    'internetarchive',
];

export const DEFAULT_SETTINGS: DogearSettings = {
    booksFolder: 'Books',
    filenameTemplate: '{{title}} - {{author}}',
    logHeading: DEFAULT_LOG_HEADING,
    defaultFormat: 'print',
    openOnCreate: true,
    preferredLanguage: 'eng',
    cacheHours: 24,
    // Open Library first: fully open data, no key, best coverage of older and
    // non-English editions. Google Books second: more reliable and better
    // populated page counts, but a commercial service.
    providers: ['openlibrary', 'googlebooks', 'loc', 'internetarchive'],
    googleApiKey: '',
    googleCountry: '',
    coverFolder: 'Books/covers',
};

/**
 * Coerce loaded settings into something usable.
 *
 * Settings come from disk and may be hand-edited, partial, or written by an
 * older version, so every field is validated rather than trusted.
 */
export function normaliseSettings(raw: unknown): DogearSettings {
    const input = (raw ?? {}) as Partial<DogearSettings>;
    const out: DogearSettings = { ...DEFAULT_SETTINGS };

    if (typeof input.booksFolder === 'string') out.booksFolder = input.booksFolder;

    // An empty template would produce "Untitled" for every book.
    if (typeof input.filenameTemplate === 'string' && input.filenameTemplate.trim() !== '') {
        out.filenameTemplate = input.filenameTemplate.trim();
    }
    if (typeof input.logHeading === 'string') {
        const heading = cleanHeading(input.logHeading);
        if (heading !== '') out.logHeading = heading;
    }
    if (
        input.defaultFormat === 'print' ||
        input.defaultFormat === 'ebook' ||
        input.defaultFormat === 'audio'
    ) {
        out.defaultFormat = input.defaultFormat;
    }
    if (typeof input.openOnCreate === 'boolean') out.openOnCreate = input.openOnCreate;
    if (typeof input.preferredLanguage === 'string' && /^[a-z]{2,3}$/i.test(input.preferredLanguage)) {
        out.preferredLanguage = input.preferredLanguage.toLowerCase();
    }
    if (typeof input.cacheHours === 'number' && Number.isFinite(input.cacheHours)) {
        // Clamp: zero disables caching entirely, which is rude to a free API.
        out.cacheHours = Math.min(Math.max(input.cacheHours, 1), 24 * 30);
    }
    if (Array.isArray(input.providers)) {
        const valid = input.providers.filter(
            (id): id is string => typeof id === 'string' && ALL_PROVIDER_IDS.includes(id),
        );
        // Deduplicate while preserving the user's order.
        const seen = new Set<string>();
        const ordered = valid.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
        // An empty list would leave no way to add a book at all.
        out.providers = ordered.length > 0 ? ordered : [...DEFAULT_SETTINGS.providers];
    }
    if (typeof input.googleApiKey === 'string') out.googleApiKey = input.googleApiKey.trim();
    if (typeof input.coverFolder === 'string' && input.coverFolder.trim() !== '') {
        out.coverFolder = input.coverFolder.trim().replace(/^\/+|\/+$/g, '');
    }
    if (typeof input.googleCountry === 'string') {
        const code = input.googleCountry.trim().toUpperCase();
        out.googleCountry = /^[A-Z]{2}$/.test(code) ? code : '';
    }

    return out;
}

/**
 * Strip markdown heading syntax from a heading setting.
 *
 * The note shows "## Reading log", so typing exactly that into the setting is
 * the obvious thing to do — and it produced "## ## Reading log", which then
 * failed to match the existing section and orphaned the reader's log. The
 * hashes are supplied by the renderer; this only wants the text.
 */
export function cleanHeading(raw: string): string {
    return raw.replace(/^\s*#{1,6}\s*/, '').trim();
}

/** Warn about a template that references nothing — every note would collide. */
export function templateHasPlaceholder(template: string): boolean {
    return /\{\{\w+\}\}/.test(template);
}
