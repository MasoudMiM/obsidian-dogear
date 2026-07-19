// Dogear — note paths and filenames.
//
// Book titles are hostile input for filenames: they contain colons, slashes,
// question marks and quotes as a matter of course ("Who's Afraid of Virginia
// Woolf?", "The Dispossessed: An Ambiguous Utopia", "Cloud Atlas / Ghostwritten").
//
// This module is pure so the rules can be tested exhaustively. Obsidian's
// `normalizePath()` is applied by the caller on top of what we produce here;
// it normalises slashes and unicode but does NOT strip characters that are
// illegal in filenames, so we must do that ourselves.

/**
 * Characters Obsidian rejects in note names, plus the ones that break
 * wikilinks. `#`, `^`, `[` and `]` are legal on disk but corrupt links, so
 * they go too — a book note nobody can link to is not much use.
 */
const ILLEGAL = /[*"\\/<>:|?#^[\]]/g;

/** Control characters, which are legal in some filesystems and awful in all. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point: they must be stripped from filenames.
const CONTROL = /[\u0000-\u001f\u007f]/g;

/**
 * Names Windows refuses regardless of extension. Rare for a book title, but
 * "Con" is a real one-word title and this costs nothing to guard.
 */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Filesystems cap names around 255 bytes; leave room for " (2).md". */
export const MAX_BASENAME = 180;

/**
 * Make a string safe to use as a note filename.
 *
 * Illegal characters are replaced rather than deleted so words don't run
 * together: "Cloud Atlas / Ghostwritten" becomes "Cloud Atlas - Ghostwritten",
 * not "Cloud AtlasGhostwritten".
 */
export function sanitiseFilename(input: string): string {
    // Tabs and newlines are control characters but carry word separation, so
    // they become spaces rather than being deleted ("tab\tseparated" must not
    // collapse to "tabseparated").
    let out = input.normalize('NFC').replace(/[\t\n\r]/g, ' ').replace(CONTROL, '');

    // Separators become a spaced dash so words stay apart and read naturally:
    // "The Dispossessed: An Ambiguous Utopia" -> "The Dispossessed - An ...".
    out = out.replace(/[/\\:|<>]/g, ' - ');
    // Remaining illegal characters carry no separation, so they just go.
    out = out.replace(ILLEGAL, '');

    // Tidy up: collapse whitespace, then collapse runs of dashes introduced
    // above into a single one. The {2,} guard protects real hyphenated titles
    // such as "Nineteen Eighty-Four".
    out = out.replace(/\s+/g, ' ');
    out = out.replace(/(\s*-\s*){2,}/g, ' - ');
    out = out.replace(/^[\s-]+/, '').replace(/[\s-]+$/, '');

    // Leading dots hide files on unix; trailing dots and spaces break Windows.
    out = out.replace(/^\.+/, '').replace(/[. ]+$/, '').trim();

    if (out.length > MAX_BASENAME) {
        out = out.slice(0, MAX_BASENAME).replace(/[.\s-]+$/, '').trim();
    }

    // A name made entirely of punctuation is not a usable filename.
    if (out === '' || !/[\p{L}\p{N}]/u.test(out)) return 'Untitled';
    if (RESERVED.test(out)) return `${out} (book)`;
    return out;
}

/** Normalise a user-supplied folder path: no leading/trailing slashes. */
export function normaliseFolder(folder: string): string {
    return folder
        .split('/')
        .map((s) => s.trim())
        .filter((s) => s !== '' && s !== '.')
        .join('/');
}

export interface FilenameContext {
    title: string;
    authors: string[];
    published?: string;
    series?: string;
}

/**
 * Render a filename template.
 *
 * Supported placeholders: {{title}}, {{author}}, {{authors}}, {{year}},
 * {{series}}. Unknown placeholders are left alone rather than silently
 * blanked, so a typo is visible instead of mysterious.
 */
export function renderFilenameTemplate(template: string, ctx: FilenameContext): string {
    const year = ctx.published ? (/(\d{4})/.exec(ctx.published)?.[1] ?? '') : '';
    const values: Record<string, string> = {
        title: ctx.title,
        author: ctx.authors[0] ?? '',
        authors: ctx.authors.join(', '),
        year,
        series: ctx.series ?? '',
    };

    let out = template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
        const k = key.toLowerCase();
        return k in values ? values[k] : match;
    });

    // A template like "{{title}} - {{author}}" leaves a dangling separator
    // when the author is unknown. Tidy that rather than shipping "Dune - ".
    out = out
        .replace(/\s*[-–—]\s*$/, '')
        .replace(/^\s*[-–—]\s*/, '')
        .replace(/\s*[-–—]\s*[-–—]\s*/g, ' - ')
        .replace(/\(\s*\)/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    return out;
}

/** Build the full vault path for a book note. */
export function buildNotePath(folder: string, basename: string): string {
    const dir = normaliseFolder(folder);
    const name = sanitiseFilename(basename);
    return dir === '' ? `${name}.md` : `${dir}/${name}.md`;
}

/**
 * Find a path that doesn't collide, appending " (2)", " (3)" and so on.
 *
 * `exists` is injected so this stays pure and testable.
 */
export function uniquePath(
    folder: string,
    basename: string,
    exists: (path: string) => boolean,
    limit = 999,
): string {
    const first = buildNotePath(folder, basename);
    if (!exists(first)) return first;

    for (let n = 2; n <= limit; n++) {
        const candidate = buildNotePath(folder, `${basename} (${n})`);
        if (!exists(candidate)) return candidate;
    }
    // Astronomically unlikely; fall back to a timestamp rather than throwing.
    return buildNotePath(folder, `${basename} ${Date.now()}`);
}

/** Human-readable note name (no folder, no extension) from a full path. */
export function basenameOf(path: string): string {
    const file = path.split('/').pop() ?? path;
    return file.replace(/\.md$/i, '');
}

// --- tags -------------------------------------------------------------------

/**
 * Make a catalogue subject usable as an Obsidian tag.
 *
 * Obsidian tags cannot contain spaces, and a tag of digits alone is invalid.
 * Writing raw subjects such as "City planning" or "Biography & Autobiography"
 * into the `tags` property produces entries the Properties panel marks as
 * broken, which is worse than not having them.
 *
 * Returns undefined when nothing usable survives.
 */
export function sanitiseTag(raw: string): string | undefined {
    let tag = raw
        .normalize('NFC')
        .trim()
        // An ampersand joins two ideas; a hyphen keeps them readable rather
        // than running the words together. Slashes are NOT touched: they are
        // how Obsidian expresses nested tags.
        .replace(/&/g, '-')
        .replace(/[^\p{L}\p{N}_\-/]+/gu, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^[-_]+/, '')
        .replace(/[-_]+$/, '');

    if (tag === '') return undefined;
    // A tag made only of digits is not valid in Obsidian.
    if (!/[\p{L}_]/u.test(tag)) return undefined;
    if (tag.length > 100) tag = tag.slice(0, 100).replace(/[-_]+$/, '');
    return tag;
}

/** Sanitise a list of subjects, dropping anything unusable and duplicates. */
export function sanitiseTags(raw: string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
        const tag = sanitiseTag(item);
        if (!tag) continue;
        const key = tag.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(tag);
    }
    return out;
}
