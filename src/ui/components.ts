// Dogear — shared UI components.
//
// Accessibility notes, since these are custom controls:
//
//   - The status selector is a real radiogroup with roving tabindex: arrow
//     keys move between options, Tab enters and leaves the group as one stop.
//     That is the WAI-ARIA pattern for a segmented control.
//   - The rating control is a native <input type="range">. A row of clickable
//     stars is prettier to build but reimplements keyboard support badly;
//     a range input gets arrow keys, Home/End and screen-reader announcement
//     for free. We render stars on top and expose aria-valuetext so it is
//     announced as "3 and a half stars" rather than "3.5".
//   - Icon-only buttons carry aria-label, and their icons are aria-hidden,
//     so assistive technology announces the action once, not twice.
//
// No inline styles anywhere: every visual decision lives in styles.css and is
// expressed with Obsidian's CSS variables so themes can restyle it.

import { setIcon } from 'obsidian';
import { describeRating } from '../format';

// --- segmented radio group --------------------------------------------------

export interface SegmentedOption<T extends string> {
    value: T;
    label: string;
    /** Optional Lucide icon id. */
    icon?: string;
}

export interface SegmentedControl<T extends string> {
    setValue(value: T): void;
    getValue(): T;
}

export function createSegmented<T extends string>(
    parent: HTMLElement,
    options: {
        label: string;
        choices: SegmentedOption<T>[];
        value: T;
        onChange: (value: T) => void;
    },
): SegmentedControl<T> {
    const group = parent.createDiv({ cls: 'dogear-segmented' });
    group.setAttr('role', 'radiogroup');
    group.setAttr('aria-label', options.label);

    let current = options.value;
    const buttons = new Map<T, HTMLElement>();

    const sync = () => {
        for (const [value, el] of buttons) {
            const selected = value === current;
            el.setAttr('aria-checked', String(selected));
            el.toggleClass('is-active', selected);
            // Roving tabindex: only the selected option is a tab stop.
            el.setAttr('tabindex', selected ? '0' : '-1');
        }
    };

    const select = (value: T, focus: boolean) => {
        if (value === current) return;
        current = value;
        sync();
        if (focus) buttons.get(value)?.focus();
        options.onChange(value);
    };

    options.choices.forEach((choice) => {
        const btn = group.createEl('button', { cls: 'dogear-segmented__option' });
        btn.setAttr('type', 'button');
        btn.setAttr('role', 'radio');

        if (choice.icon) {
            const iconEl = btn.createSpan({ cls: 'dogear-segmented__icon' });
            setIcon(iconEl, choice.icon);
            // The label beside it already names the option.
            iconEl.setAttr('aria-hidden', 'true');
        }
        btn.createSpan({ cls: 'dogear-segmented__label', text: choice.label });

        btn.addEventListener('click', () => select(choice.value, false));
        btn.addEventListener('keydown', (evt: KeyboardEvent) => {
            const order = options.choices.map((c) => c.value);
            const idx = order.indexOf(current);
            let nextIdx: number | null = null;

            if (evt.key === 'ArrowRight' || evt.key === 'ArrowDown') nextIdx = (idx + 1) % order.length;
            else if (evt.key === 'ArrowLeft' || evt.key === 'ArrowUp') nextIdx = (idx - 1 + order.length) % order.length;
            else if (evt.key === 'Home') nextIdx = 0;
            else if (evt.key === 'End') nextIdx = order.length - 1;
            else if (evt.key === ' ' || evt.key === 'Enter') {
                evt.preventDefault();
                select(choice.value, true);
                return;
            }

            if (nextIdx !== null) {
                evt.preventDefault();
                select(order[nextIdx], true);
            }
        });

        buttons.set(choice.value, btn);
    });

    sync();

    return {
        getValue: () => current,
        setValue: (value: T) => {
            current = value;
            sync();
        },
    };
}

// --- star rating ------------------------------------------------------------

const RATING_STEP = 0.25;
const MAX_RATING = 5;

export interface RatingControl {
    setValue(value: number | undefined): void;
    getValue(): number | undefined;
}

export function createRating(
    parent: HTMLElement,
    options: { value?: number; onChange: (value: number | undefined) => void },
): RatingControl {
    const wrap = parent.createDiv({ cls: 'dogear-rating' });

    const slider = wrap.createEl('input', { cls: 'dogear-rating__input' });
    slider.type = 'range';
    slider.min = '0';
    slider.max = String(MAX_RATING);
    slider.step = String(RATING_STEP);
    slider.value = String(options.value ?? 0);
    slider.setAttr('aria-label', 'Rating');

    const stars = wrap.createDiv({ cls: 'dogear-rating__stars' });
    stars.setAttr('aria-hidden', 'true');

    // Fractional stars are drawn as two full rows: a muted row underneath and
    // an accent row on top, clipped to the fill width. Masking the icon itself
    // does not work because setIcon injects an <svg> element, not a background.
    const baseLayer = stars.createDiv({ cls: 'dogear-rating__layer' });
    const clip = stars.createDiv({ cls: 'dogear-rating__clip' });
    const fillLayer = clip.createDiv({ cls: 'dogear-rating__layer is-fill' });

    for (let i = 0; i < MAX_RATING; i++) {
        const base = baseLayer.createSpan({ cls: 'dogear-rating__star' });
        setIcon(base, 'star');
        const fill = fillLayer.createSpan({ cls: 'dogear-rating__star' });
        setIcon(fill, 'star');
    }

    const clear = wrap.createEl('button', {
        cls: 'dogear-icon-button dogear-rating__clear',
    });
    clear.setAttr('type', 'button');
    clear.setAttr('aria-label', 'Clear rating');
    const clearIcon = clear.createSpan();
    setIcon(clearIcon, 'x');
    clearIcon.setAttr('aria-hidden', 'true');

    const render = (value: number) => {
        const pct = Math.min(Math.max(value / MAX_RATING, 0), 1) * 100;
        // A CSS custom property carrying a runtime value; styles.css decides
        // what to do with it.
        clip.style.setProperty('--dogear-rating-fill', `${pct}%`);
        slider.setAttr('aria-valuetext', describeRating(value));
        clear.toggleClass('is-hidden', value <= 0);
    };

    const emit = () => {
        const value = Number(slider.value);
        render(value);
        options.onChange(value <= 0 ? undefined : value);
    };

    slider.addEventListener('input', emit);
    clear.addEventListener('click', () => {
        slider.value = '0';
        emit();
        slider.focus();
    });

    render(options.value ?? 0);

    return {
        getValue: () => {
            const v = Number(slider.value);
            return v <= 0 ? undefined : v;
        },
        setValue: (value) => {
            slider.value = String(value ?? 0);
            render(value ?? 0);
        },
    };
}

// --- cover image ------------------------------------------------------------

/**
 * Render a cover, degrading to a labelled placeholder.
 *
 * Covers come from a third party and frequently 404 or return a 1px blank, so
 * a missing cover must look deliberate rather than broken.
 */
export function createCover(
    parent: HTMLElement,
    options: { url?: string; title: string; cls?: string },
): HTMLElement {
    const wrap = parent.createDiv({ cls: `dogear-cover ${options.cls ?? ''}`.trim() });

    if (!options.url) {
        wrap.addClass('is-placeholder');
        // Decorative: the title is always shown next to the cover.
        wrap.setAttr('aria-hidden', 'true');
        const icon = wrap.createSpan();
        setIcon(icon, 'book');
        return wrap;
    }

    const img = wrap.createEl('img', { cls: 'dogear-cover__img' });
    img.src = options.url;
    img.alt = `Cover of ${options.title}`;
    img.loading = 'lazy';
    img.addEventListener('error', () => {
        wrap.empty();
        wrap.addClass('is-placeholder');
        wrap.setAttr('aria-hidden', 'true');
        const icon = wrap.createSpan();
        setIcon(icon, 'book');
    });
    return wrap;
}

// --- misc -------------------------------------------------------------------

/** An icon-only button with a proper accessible name. */
export function createIconButton(
    parent: HTMLElement,
    options: { icon: string; label: string; onClick: () => void; cls?: string },
): HTMLButtonElement {
    const btn = parent.createEl('button', {
        cls: `dogear-icon-button ${options.cls ?? ''}`.trim(),
    });
    btn.setAttr('type', 'button');
    btn.setAttr('aria-label', options.label);
    const icon = btn.createSpan();
    setIcon(icon, options.icon);
    icon.setAttr('aria-hidden', 'true');
    btn.addEventListener('click', options.onClick);
    return btn;
}

/** An inline message. `tone` maps to a colour AND an icon, never colour alone. */
export function createMessage(
    parent: HTMLElement,
    text: string,
    tone: 'info' | 'error' | 'success' = 'info',
): HTMLElement {
    const el = parent.createDiv({ cls: `dogear-message is-${tone}` });
    const icon = el.createSpan({ cls: 'dogear-message__icon' });
    setIcon(icon, tone === 'error' ? 'alert-circle' : tone === 'success' ? 'check' : 'info');
    icon.setAttr('aria-hidden', 'true');
    el.createSpan({ text });
    // Errors should be announced when they appear.
    if (tone === 'error') el.setAttr('role', 'alert');
    return el;
}
