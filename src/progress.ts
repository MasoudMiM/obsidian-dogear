// Dogear — progress normalisation.
//
// Readers log progress in whatever unit is in front of them:
//   - a page number from a print book
//   - a percentage from a Kindle
//   - "4h 12m listened" from StoryGraph habits
//   - "2h 48m left" from Audible, Spotify or Kobo
//
// Everything normalises to a fraction in 0..1 so statistics work regardless
// of how it was entered. The raw input is preserved separately for display.
//
// DOM-free and dependency-free: unit testable in plain node.

import type { BookMetrics, Format, PositionUnit, ProgressEntry, RawPosition } from './model';
import { isTimeBased } from './model';

export type NormaliseError =
    | 'unknown-total-pages'
    | 'unknown-duration'
    | 'invalid-number'
    | 'negative'
    | 'exceeds-total';

export interface NormaliseOk {
    ok: true;
    fraction: number;
    raw: RawPosition;
}

export interface NormaliseFail {
    ok: false;
    error: NormaliseError;
    /** Reader-facing explanation. */
    message: string;
}

export type NormaliseResult = NormaliseOk | NormaliseFail;

const MESSAGES: Record<NormaliseError, string> = {
    'unknown-total-pages': 'Set the total page count before logging a page number.',
    'unknown-duration': 'Set the audiobook length before logging a time.',
    'invalid-number': "That doesn't look like a number.",
    negative: 'Progress cannot be negative.',
    'exceeds-total': 'That is past the end of the book.',
};

function fail(error: NormaliseError): NormaliseFail {
    return { ok: false, error, message: MESSAGES[error] };
}

/** Round to 6dp to keep frontmatter tidy and comparisons stable. */
function tidy(fraction: number): number {
    return Math.round(fraction * 1e6) / 1e6;
}

/**
 * Convert a typed position into a 0..1 fraction.
 *
 * `remaining` is the interesting case: players show time LEFT, so we
 * subtract from the total rather than making the reader do arithmetic.
 */
export function normalisePosition(
    unit: PositionUnit,
    value: number,
    metrics: BookMetrics,
): NormaliseResult {
    if (!Number.isFinite(value)) return fail('invalid-number');
    if (value < 0) return fail('negative');

    const raw: RawPosition = { unit, value };

    switch (unit) {
        case 'page': {
            const total = metrics.pages;
            if (!total || total <= 0) return fail('unknown-total-pages');
            if (value > total) return fail('exceeds-total');
            return { ok: true, fraction: tidy(value / total), raw };
        }
        case 'percent': {
            if (value > 100) return fail('exceeds-total');
            return { ok: true, fraction: tidy(value / 100), raw };
        }
        case 'elapsed': {
            const total = metrics.duration;
            if (!total || total <= 0) return fail('unknown-duration');
            if (value > total) return fail('exceeds-total');
            return { ok: true, fraction: tidy(value / total), raw };
        }
        case 'remaining': {
            const total = metrics.duration;
            if (!total || total <= 0) return fail('unknown-duration');
            if (value > total) return fail('exceeds-total');
            // The whole point: convert "time left" into progress made.
            return { ok: true, fraction: tidy((total - value) / total), raw };
        }
    }
}

/** Units that make sense for a given format, in the order to offer them. */
export function unitsForFormat(format: Format, metrics: BookMetrics): PositionUnit[] {
    if (isTimeBased(format)) {
        // Percent first: it always works, even with no duration set.
        const units: PositionUnit[] = ['percent'];
        if (metrics.duration && metrics.duration > 0) {
            units.push('remaining', 'elapsed');
        }
        return units;
    }
    const units: PositionUnit[] = [];
    if (metrics.pages && metrics.pages > 0) units.push('page');
    units.push('percent');
    return units;
}

/** Best default unit for a format — what most readers will want preselected. */
export function defaultUnitForFormat(format: Format, metrics: BookMetrics): PositionUnit {
    return unitsForFormat(format, metrics)[0];
}

// --- duration parsing -------------------------------------------------------

/**
 * Parse a duration into seconds. Deliberately forgiving, because readers
 * copy these straight off a player screen in wildly different shapes.
 *
 * Accepted:
 *   "5:30"      -> 5h 30m   (H:MM, the Goodreads/Bookshelf convention)
 *   "1:02:03"   -> 1h 2m 3s (H:MM:SS)
 *   "45"        -> 45m      (bare number reads as minutes)
 *   "3h 20m"    -> 3h 20m
 *   "3h"        -> 3h
 *   "20m"       -> 20m
 *   "90s"       -> 90s
 *
 * Returns null if it can't be understood.
 */
export function parseDuration(input: string): number | null {
    const text = input.trim().toLowerCase();
    if (text === '') return null;

    // Unit-suffixed form: "3h 20m", "20m", "1h30m", "90s"
    if (/[hms]/.test(text)) {
        const re = /(\d+(?:\.\d+)?)\s*([hms])/g;
        let total = 0;
        let matched = false;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
            matched = true;
            const n = parseFloat(m[1]);
            if (m[2] === 'h') total += n * 3600;
            else if (m[2] === 'm') total += n * 60;
            else total += n;
        }
        // Reject stray characters we didn't consume, e.g. "abc".
        if (!matched) return null;
        const leftover = text.replace(re, '').replace(/[\s,]/g, '');
        if (leftover !== '') return null;
        return Math.round(total);
    }

    // Colon form.
    if (text.includes(':')) {
        const parts = text.split(':');
        if (parts.length > 3) return null;
        const nums = parts.map((p) => (p.trim() === '' ? NaN : Number(p)));
        if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
        if (parts.length === 2) {
            const [h, min] = nums;
            return Math.round(h * 3600 + min * 60);
        }
        const [h, min, s] = nums;
        return Math.round(h * 3600 + min * 60 + s);
    }

    // Bare number = minutes.
    const n = Number(text);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n * 60);
}

/**
 * Render seconds back out.
 * `H:MM` when it lands on a whole minute, `H:MM:SS` otherwise.
 */
export function formatDuration(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const total = Math.round(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = String(m).padStart(2, '0');
    if (s === 0) return `${h}:${mm}`;
    return `${h}:${mm}:${String(s).padStart(2, '0')}`;
}

/** Compact human form for stats and labels: "4h 12m". */
export function humaniseDuration(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) return '0m';
    const total = Math.round(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.round((total % 3600) / 60);
    if (h === 0) return `${m}m`;
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
}

// --- derived reading metrics ------------------------------------------------

/** Pages covered by a fraction, when the total is known. */
export function fractionToPages(fraction: number, metrics: BookMetrics): number | undefined {
    if (!metrics.pages || metrics.pages <= 0) return undefined;
    return Math.round(fraction * metrics.pages);
}

/** Seconds covered by a fraction, when the runtime is known. */
export function fractionToSeconds(fraction: number, metrics: BookMetrics): number | undefined {
    if (!metrics.duration || metrics.duration <= 0) return undefined;
    return Math.round(fraction * metrics.duration);
}

/**
 * Observed pace in fraction-of-book per day, from the first to last entry.
 *
 * Computed rather than self-reported: we already have timestamped positions,
 * so asking the reader to rate "pace" would be redundant and subjective.
 * Returns null when there isn't enough signal (fewer than 2 entries, or all
 * entries on the same day).
 */
export function paceFractionPerDay(entries: ProgressEntry[]): number | null {
    if (entries.length < 2) return null;
    const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date));
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const days = daysBetween(first.date, last.date);
    if (days <= 0) return null;
    const delta = last.fraction - first.fraction;
    if (delta <= 0) return null;
    return delta / days;
}

/** Projected days remaining at the observed pace, or null if unknowable. */
export function projectedDaysRemaining(entries: ProgressEntry[]): number | null {
    const pace = paceFractionPerDay(entries);
    if (pace === null || pace <= 0) return null;
    const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date));
    const current = sorted[sorted.length - 1].fraction;
    const remaining = 1 - current;
    if (remaining <= 0) return 0;
    return Math.ceil(remaining / pace);
}

/** Whole days between two ISO dates (YYYY-MM-DD). */
export function daysBetween(startIso: string, endIso: string): number {
    const a = Date.parse(`${startIso}T00:00:00Z`);
    const b = Date.parse(`${endIso}T00:00:00Z`);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
    return Math.round((b - a) / 86_400_000);
}
