// Dogear — minimal YAML handling for note frontmatter.
//
// Deliberately NOT a general YAML implementation. Dogear's frontmatter is a
// flat map of scalars and string lists, and keeping it that way is a design
// choice: deeply nested frontmatter renders badly in Obsidian's Properties UI
// and is miserable to hand-edit. Anything structural (reading sessions) lives
// in the note body instead.
//
// Writing our own avoids a runtime dependency in a plugin that must load on
// mobile, and keeps this module testable in plain node.
//
// Round-trip safety is the priority: unknown keys are preserved verbatim so a
// future schema version — or a field the reader added themselves — is never
// silently destroyed.

export type YamlScalar = string | number | boolean;
export type YamlValue = YamlScalar | string[];
export type YamlMap = Record<string, YamlValue>;

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export interface SplitNote {
    /** Raw frontmatter text, without the --- fences. Empty if none. */
    frontmatter: string;
    /** Everything after the frontmatter block. */
    body: string;
    /** Whether a frontmatter block was actually present. */
    hasFrontmatter: boolean;
}

/** Split a note into its frontmatter block and body. */
export function splitNote(content: string): SplitNote {
    const m = FRONTMATTER_RE.exec(content);
    if (!m) return { frontmatter: '', body: content, hasFrontmatter: false };
    return {
        frontmatter: m[1],
        body: content.slice(m[0].length),
        hasFrontmatter: true,
    };
}

/** Reassemble a note from frontmatter and body. */
export function joinNote(frontmatter: string, body: string): string {
    const fm = frontmatter.replace(/\s+$/, '');
    if (fm === '') return body;
    return `---\n${fm}\n---\n${body}`;
}

// --- scalars ----------------------------------------------------------------

/** Values that must be quoted to survive a round trip unambiguously. */
function needsQuoting(value: string): boolean {
    if (value === '') return true;
    // Anything that would otherwise parse as a non-string, or that contains
    // YAML-significant punctuation.
    if (/^(true|false|null|yes|no|on|off|~)$/i.test(value)) return true;
    if (/^-?\d+(\.\d+)?$/.test(value)) return true;
    if (/^[\s]|[\s]$/.test(value)) return true;
    if (/[:#\[\]{},&*!|>'"%@`\n\r]/.test(value)) return true;
    if (/^[-?]/.test(value)) return true;
    return false;
}

export function quoteScalar(value: string): string {
    if (!needsQuoting(value)) return value;
    const escaped = value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '');
    return `"${escaped}"`;
}

export function unquoteScalar(raw: string): string {
    const value = raw.trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        return value
            .slice(1, -1)
            .replace(/\\n/g, '\n')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\');
    }
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
        return value.slice(1, -1).replace(/''/g, "'");
    }
    return value;
}

function emitValue(value: YamlValue): string[] {
    if (Array.isArray(value)) {
        if (value.length === 0) return [];
        return value.map((v) => `  - ${quoteScalar(String(v))}`);
    }
    if (typeof value === 'number') return [String(value)];
    if (typeof value === 'boolean') return [String(value)];
    return [quoteScalar(value)];
}

/**
 * Serialise a flat map to YAML.
 *
 * `keyOrder` pins the order of known keys so diffs stay small and readable;
 * anything not listed is appended in insertion order.
 */
export function stringifyYaml(map: YamlMap, keyOrder: string[] = []): string {
    const lines: string[] = [];
    const seen = new Set<string>();

    const emitKey = (key: string) => {
        if (seen.has(key)) return;
        if (!(key in map)) return;
        seen.add(key);
        const value = map[key];
        if (value === undefined || value === null) return;
        if (Array.isArray(value)) {
            if (value.length === 0) return;
            lines.push(`${key}:`);
            lines.push(...emitValue(value));
            return;
        }
        lines.push(`${key}: ${emitValue(value)[0]}`);
    };

    for (const key of keyOrder) emitKey(key);
    for (const key of Object.keys(map)) emitKey(key);
    return lines.join('\n');
}

/**
 * Parse the flat YAML subset we emit.
 *
 * Tolerant by design: lines it cannot understand are skipped rather than
 * throwing, because this runs against files people edit by hand.
 */
export function parseYaml(text: string): YamlMap {
    const out: YamlMap = {};
    const lines = text.split(/\r?\n/);
    let currentKey: string | null = null;
    let currentList: string[] | null = null;

    const flush = () => {
        if (currentKey !== null && currentList !== null) {
            out[currentKey] = currentList;
        }
        currentKey = null;
        currentList = null;
    };

    for (const rawLine of lines) {
        const line = rawLine.replace(/\s+$/, '');
        if (line.trim() === '') continue;
        if (/^\s*#/.test(line)) continue;

        // List item belonging to the key above.
        const item = /^\s*-\s+(.*)$/.exec(line);
        if (item && currentList !== null) {
            currentList.push(unquoteScalar(item[1]));
            continue;
        }

        const kv = /^([A-Za-z0-9_][A-Za-z0-9_\-.]*)\s*:\s*(.*)$/.exec(line);
        if (!kv) continue;
        flush();

        const key = kv[1];
        const rest = kv[2].trim();

        if (rest === '') {
            // Either an empty value or the head of a block list.
            currentKey = key;
            currentList = [];
            out[key] = '';
            continue;
        }

        // Inline flow list: [a, b, c]
        if (rest.startsWith('[') && rest.endsWith(']')) {
            const inner = rest.slice(1, -1).trim();
            out[key] = inner === '' ? [] : splitFlowList(inner).map(unquoteScalar);
            continue;
        }

        const scalar = unquoteScalar(rest);
        // Preserve numbers as numbers only when unquoted in the source.
        if (!/^["']/.test(rest) && /^-?\d+(\.\d+)?$/.test(rest)) {
            out[key] = Number(rest);
        } else if (!/^["']/.test(rest) && /^(true|false)$/i.test(rest)) {
            out[key] = rest.toLowerCase() === 'true';
        } else {
            out[key] = scalar;
        }
    }
    flush();

    // A key introduced as a block-list head but never populated should be an
    // empty string, not an empty list — matches how it was written.
    for (const [k, v] of Object.entries(out)) {
        if (Array.isArray(v) && v.length === 0) out[k] = '';
    }
    return out;
}

/** Split `a, "b, c", d` respecting quotes. */
function splitFlowList(inner: string): string[] {
    const out: string[] = [];
    let cur = '';
    let quote: string | null = null;
    for (let i = 0; i < inner.length; i++) {
        const ch = inner[i];
        if (quote) {
            if (ch === quote) quote = null;
            cur += ch;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            cur += ch;
            continue;
        }
        if (ch === ',') {
            out.push(cur.trim());
            cur = '';
            continue;
        }
        cur += ch;
    }
    if (cur.trim() !== '') out.push(cur.trim());
    return out;
}

// --- typed accessors --------------------------------------------------------

export function asString(v: YamlValue | undefined): string | undefined {
    if (v === undefined) return undefined;
    if (Array.isArray(v)) return v[0];
    const s = String(v).trim();
    return s === '' ? undefined : s;
}

export function asNumber(v: YamlValue | undefined): number | undefined {
    if (v === undefined) return undefined;
    if (Array.isArray(v)) return undefined;
    const n = typeof v === 'number' ? v : Number(String(v).trim());
    return Number.isFinite(n) ? n : undefined;
}

/** Coerce to a string list, accepting a bare scalar as a single-item list. */
export function asList(v: YamlValue | undefined): string[] {
    if (v === undefined) return [];
    if (Array.isArray(v)) return v.filter((s) => s !== '');
    const s = String(v).trim();
    return s === '' ? [] : [s];
}
