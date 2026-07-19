// Dogear — presentation helpers.
//
// Pure formatting logic, kept out of the UI modules so it can be unit tested
// without a DOM or the Obsidian runtime.

/**
 * Today as YYYY-MM-DD in the reader's LOCAL timezone.
 *
 * `new Date().toISOString()` would be wrong here: it converts to UTC, so
 * anyone logging progress in the evening west of Greenwich would have it
 * filed under tomorrow's date.
 */
export function todayIso(now: Date = new Date()): string {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/** "3.5" -> "3 and a half stars", so screen readers say something human. */
export function describeRating(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return 'Not rated';
    const whole = Math.floor(value);
    const frac = Math.round((value - whole) * 100) / 100;
    const fracWord =
        frac === 0.25
            ? ' and a quarter'
            : frac === 0.5
              ? ' and a half'
              : frac === 0.75
                ? ' and three quarters'
                : '';
    if (whole === 0) return `${fracWord.replace(' and ', '').trim()} of a star`;
    const noun = whole === 1 && frac === 0 ? 'star' : 'stars';
    return `${whole}${fracWord} ${noun}`;
}

/** Percentage for display, without trailing noise. */
export function formatPercent(fraction: number): string {
    if (!Number.isFinite(fraction)) return '0%';
    const clamped = Math.min(Math.max(fraction, 0), 1);
    return `${Math.round(clamped * 100)}%`;
}
