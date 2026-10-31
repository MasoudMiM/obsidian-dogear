// Dogear — turning catalogue HTML into note prose.
//
// Book descriptions arrive from Open Library and Google Books as HTML, often
// full of <p> blocks, <br> line breaks, the odd <b> tag, and a scattering of
// entities. A summary is written into the body of the note, where it must read
// as plain Markdown prose — so the markup is stripped before it is saved.
//
// DOM-free and dependency-free: no window, no document, so it runs in plain
// node and on mobile alike.

/**
 * Named character references worth recognising.
 *
 * This is not a full HTML entity table — it is the set that actually shows up
 * in publisher blurbs. Anything unrecognised is left as-is rather than
 * mangled, because a stray "&amp;copy;" is far less harmful than inventing a
 * wrong glyph.
 */
const NAMED_ENTITIES: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    // Typographic marks common in formatted blurbs.
    hellip: '…',
    mdash: '—',
    ndash: '–',
    lsquo: '\u2018',
    rsquo: '\u2019',
    ldquo: '\u201c',
    rdquo: '\u201d',
    // Copyright-style marks occasionally embedded in a blurb.
    copy: '©',
    reg: '®',
    trade: '™',
    // Latin-1 accents, so non-English titles and names read correctly rather
    // than as a string of entities.
    aacute: 'á',
    agrave: 'à',
    acirc: 'â',
    auml: 'ä',
    aring: 'å',
    atilde: 'ã',
    ccedil: 'ç',
    eacute: 'é',
    egrave: 'è',
    ecirc: 'ê',
    euml: 'ë',
    iacute: 'í',
    igrave: 'ì',
    icirc: 'î',
    iuml: 'ï',
    ntilde: 'ñ',
    oacute: 'ó',
    ograve: 'ò',
    ocirc: 'ô',
    ouml: 'ö',
    oslash: 'ø',
    uacute: 'ú',
    ugrave: 'ù',
    ucirc: 'û',
    uuml: 'ü',
    yacute: 'ý',
    yuml: 'ÿ',
    szlig: 'ß',
};

/**
 * Decode a single numeric or named entity body (the part between & and ;).
 * Returns undefined when the reference cannot be trusted.
 */
function decodeEntityBody(body: string): string | undefined {
    if (body.startsWith('#')) {
        const isHex = body[1] === 'x' || body[1] === 'X';
        const digits = body.slice(isHex ? 2 : 1);
        const code = Number.parseInt(digits, isHex ? 16 : 10);
        if (!Number.isFinite(code) || code <= 0) return undefined;
        try {
            return String.fromCodePoint(code);
        } catch {
            return undefined;
        }
    }
    return NAMED_ENTITIES[body.toLowerCase()];
}

/** Decode HTML entities, leaving anything unrecognised untouched. */
export function decodeHtmlEntities(text: string): string {
    return text.replace(/&([#a-zA-Z0-9]+);/g, (match, body: string) => {
        return decodeEntityBody(body) ?? match;
    });
}

/** Tags whose content is never prose and must be dropped wholesale. */
const NON_PROSE_BLOCK =
    /<\s*(script|style|head|title|iframe|object|embed|noscript|svg)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;

/** Closing tags that end a block of prose. */
const BLOCK_CLOSE =
    /<\/\s*(p|div|li|ul|ol|dl|dd|dt|table|thead|tbody|tr|td|th|h[1-6]|blockquote|figure|figcaption|pre|section|article|header|footer)\s*>/gi;

/** Opening block tags (with or without attributes) that start a new block. */
const BLOCK_OPEN =
    /<\s*(p|div|li|ul|ol|dl|dd|dt|table|thead|tbody|tr|td|th|h[1-6]|blockquote|figure|figcaption|pre|section|article|header|footer)(?:\s[^>]*)?\/?>/gi;

/** Line breaks, in every spelling they arrive in. */
const BR_TAG = /<\s*br\s*\/?\s*>/gi;

/** Any remaining tag, inline or otherwise. */
const ANY_TAG = /<[^>]*>/g;

/**
 * Convert an HTML description into clean plain text for a note.
 *
 * The rules, in order:
 *   1. Drop non-prose blocks (scripts, styles, embedded objects) entirely.
 *   2. Turn line breaks and block boundaries into newlines, so paragraphs
 *      survive as paragraphs rather than collapsing into one run-on line.
 *   3. Strip whatever tags remain.
 *   4. Decode entities.
 *   5. Normalise whitespace: no trailing spaces, no more than one blank line
 *      between paragraphs, and no leading or trailing blank lines.
 *
 * It is deliberately conservative. A summary is written into the reader's
 * note and never regenerated silently, so erring on the side of "a little
 * markup left behind" is safer than "prose silently reordered or dropped".
 */
export function stripHtml(input: string): string {
    let text = String(input ?? '');

    text = text.replace(NON_PROSE_BLOCK, '');
    text = text.replace(BR_TAG, '\n');
    text = text.replace(BLOCK_CLOSE, '\n');
    text = text.replace(BLOCK_OPEN, '\n');
    text = text.replace(ANY_TAG, '');
    text = decodeHtmlEntities(text);

    // Trailing spaces before a newline are invisible noise in Markdown.
    text = text.replace(/[ \t]+\n/g, '\n');
    // Runs of spaces collapse to one: a decoded &nbsp; or a source double
    // space would otherwise read as a gap in the middle of a sentence.
    text = text.replace(/[ \t]{2,}/g, ' ');
    // Three or more newlines means at least one blank line; keep at most one.
    text = text.replace(/\n{3,}/g, '\n\n');

    return text.trim();
}
