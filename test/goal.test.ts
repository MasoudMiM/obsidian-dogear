// Dogear — tests for per-year reading goals.
//
// A goal is a promise the reader makes to themselves, so the arithmetic has to
// survive the edges: no goal set, a goal already passed, a goal with no books
// finished yet, and hand-edited settings.

import { SCHEMA_VERSION, type Book } from '../src/model';
import {
    DEFAULT_SETTINGS,
    normaliseReadingGoals,
    normaliseSettings,
    readingGoalFor,
} from '../src/settings';
import { computeStats, goalProgress } from '../src/stats';
import type { Harness } from './note.test';

function makeBook(overrides: Partial<Book> = {}): Book {
    return {
        schemaVersion: SCHEMA_VERSION,
        title: 'A Book',
        authors: ['An Author'],
        tags: [],
        metrics: {},
        status: 'finished',
        sessions: [],
        ...overrides,
    };
}

function finishedIn(year: number, title: string): { book: Book } {
    return {
        book: makeBook({
            title,
            sessions: [
                {
                    id: `s-${title}`,
                    format: 'print',
                    finished: `${year}-06-01`,
                    entries: [],
                },
            ],
        }),
    };
}

export async function runGoalTests({ describe, ok, eq }: Harness): Promise<void> {
    await describe('goal: no goal exists until one is set', () => {
        eq(DEFAULT_SETTINGS.readingGoals, {}, 'defaults carry no goals');
        eq(normaliseSettings({}).readingGoals, {}, 'older settings load with no goals');
        eq(
            normaliseSettings({ readingGoals: { '2026': 50 } }).readingGoals,
            { '2026': 50 },
            'a stored goal is kept',
        );
    });

    await describe('goal: loaded goals are validated', () => {
        const goals = normaliseReadingGoals({
            '2025': 50,
            '2026': 60.8,
            twenty: 12,
            '0999': 5,
            '2027': 0,
            '2028': -3,
            '2029': '40',
            '2030': Number.NaN,
            '2031': 20000,
        });
        eq(
            goals,
            { '2025': 50, '2026': 60, '2031': 10000 },
            'only whole, positive goals for real years survive',
        );
        eq(normaliseReadingGoals(null), {}, 'null is an empty map');
        eq(normaliseReadingGoals([]), {}, 'an array is not a goals map');
        eq(normaliseReadingGoals({ '2026': Infinity }), {}, 'an infinite goal is not a goal');
    });

    await describe('goal: lookup is exact to the year', () => {
        const goals = { '2025': 50, '2026': 60 };
        eq(readingGoalFor(goals, 2025), 50, 'the earlier year keeps its own target');
        eq(readingGoalFor(goals, 2026), 60, 'raising this year does not rewrite last year');
        eq(readingGoalFor(goals, 2024), undefined, 'a year without a goal has none');
    });

    await describe('goal: progress arithmetic', () => {
        eq(
            goalProgress(0, 50),
            { target: 50, finished: 0, remaining: 50, fraction: 0 },
            'nothing read yet',
        );
        eq(
            goalProgress(32, 50),
            { target: 50, finished: 32, remaining: 18, fraction: 0.64 },
            'part-way through',
        );
        eq(
            goalProgress(55, 50),
            { target: 50, finished: 55, remaining: 0, fraction: 1 },
            'passing the goal never produces a negative remainder',
        );
        eq(goalProgress(5, undefined), null, 'no target, no progress');
        eq(goalProgress(5, 0), null, 'zero is no goal');
        eq(goalProgress(5, -1), null, 'a negative goal is no goal');
        eq(goalProgress(5, Number.NaN), null, 'NaN is no goal');
        eq(
            goalProgress(5, 10.9),
            { target: 10, finished: 5, remaining: 5, fraction: 0.5 },
            'fractional targets are made whole',
        );
    });

    await describe('goal: statistics count only this year’s finished books', () => {
        const entries = [
            finishedIn(2025, 'One'),
            finishedIn(2025, 'Two'),
            finishedIn(2024, 'Older'),
            {
                book: makeBook({
                    title: 'Still reading',
                    status: 'reading',
                    sessions: [
                        {
                            id: 's-reading',
                            format: 'print',
                            started: '2025-01-01',
                            entries: [],
                        },
                    ],
                }),
            },
        ];

        const y2025 = computeStats(entries, 2025, 50);
        eq(y2025.finished, 2, 'two books finished in the year');
        eq(
            y2025.goal,
            { target: 50, finished: 2, remaining: 48, fraction: 0.04 },
            'the goal uses that year’s count',
        );

        const passed = computeStats(entries, 2025, 1);
        eq(
            passed.goal,
            { target: 1, finished: 2, remaining: 0, fraction: 1 },
            'a passed goal is full, not overflowing',
        );

        eq(computeStats(entries, 2025).goal, null, 'no goal set means no progress');
        eq(
            computeStats(entries, null, 50).goal,
            null,
            'a yearly goal has no meaning across all time',
        );
    });

    await describe('goal: a goal is visible before the first book', () => {
        const stats = computeStats([], 2026, 50);
        eq(stats.finished, 0, 'no books finished yet');
        eq(
            stats.goal,
            { target: 50, finished: 0, remaining: 50, fraction: 0 },
            'the challenge still shows its starting line',
        );
    });

    await describe('goal: defaults are not shared between loads', () => {
        const first = normaliseSettings({});
        first.readingGoals['2026'] = 50;
        eq(normaliseSettings({}).readingGoals, {}, 'mutating one load does not poison the next');
        ok(DEFAULT_SETTINGS.readingGoals['2026'] === undefined, 'the default object stays clean');
    });
}
