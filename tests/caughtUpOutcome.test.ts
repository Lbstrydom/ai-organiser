import { describe, it, expect } from 'vitest';
import { formatCaughtUpOutcome } from '../src/commands/newsletterCommands';
import type { CaughtUpOutcome } from '../src/services/newsletter/newsletterMemoryTypes';

/**
 * The outcome is a discriminated union rather than `Result<T>` with an error
 * string sentinel, because "story memory is off" and "nothing to do" are
 * ordinary expected states, not failures. One formatter covers the command and
 * the settings button so the two surfaces cannot tell the user different things.
 */
const nl = {
    caughtUpOk: 'Marked {stories} stor[y|ies] through {through} as already known.',
    caughtUpOkNone: 'Every story through {through} was already known.',
    caughtUpNoop: 'Already up to date — nothing to mark',
    caughtUpDisabled: 'Turn on story memory first',
    caughtUpError: 'Could not mark caught up: {error}',
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial i18n fixture
} as any;

describe('formatCaughtUpOutcome', () => {
    it('substitutes every placeholder on success', () => {
        const out = formatCaughtUpOutcome(
            { kind: 'ok', buckets: 3, stories: 17, through: '2026-09-04' }, nl,
        );
        expect(out).toBe('Marked 17 stories through 2026-09-04 as already known.');
        expect(out).not.toContain('{');
    });

    it('speaks of stories, never of day buckets, and keeps one story singular', () => {
        expect(formatCaughtUpOutcome({ kind: 'ok', buckets: 1, stories: 1, through: '2026-09-04' }, nl))
            .toBe('Marked 1 story through 2026-09-04 as already known.');
        expect(formatCaughtUpOutcome({ kind: 'ok', buckets: 1, stories: 0, through: '2026-09-04' }, nl))
            .toBe('Every story through 2026-09-04 was already known.');
    });

    it('distinguishes nothing-to-do from success', () => {
        expect(formatCaughtUpOutcome({ kind: 'noop' }, nl))
            .toBe('Already up to date — nothing to mark');
    });

    it('tells the user WHY when the feature is off, rather than silently doing nothing', () => {
        expect(formatCaughtUpOutcome({ kind: 'disabled' }, nl))
            .toBe('Turn on story memory first');
    });

    it('surfaces the underlying error text', () => {
        expect(formatCaughtUpOutcome({ kind: 'error', error: 'disk full' }, nl))
            .toBe('Could not mark caught up: disk full');
    });

    it('falls back to English when the i18n bundle is missing the keys', () => {
        const cases: Array<[CaughtUpOutcome, string]> = [
            [{ kind: 'ok', buckets: 1, stories: 1, through: '2026-09-04' }, 'Marked 1 story through 2026-09-04 as already known.'],
            [{ kind: 'ok', buckets: 2, stories: 5, through: '2026-09-04' }, 'Marked 5 stories through 2026-09-04 as already known.'],
            [{ kind: 'ok', buckets: 1, stories: 0, through: '2026-09-04' }, 'Every story through 2026-09-04 was already known.'],
            [{ kind: 'noop' }, 'Already up to date — nothing to mark'],
            [{ kind: 'disabled' }, 'Turn on story memory first'],
            [{ kind: 'error', error: 'x' }, 'Could not mark caught up: x'],
        ];
        for (const [outcome, expected] of cases) expect(formatCaughtUpOutcome(outcome, undefined)).toBe(expected);
    });

    it('an error whose text is literally "disabled" is still an error', () => {
        // The regression the union exists to prevent: with an error-string
        // sentinel this would have been silently reclassified as "feature off".
        expect(formatCaughtUpOutcome({ kind: 'error', error: 'disabled' }, nl))
            .toBe('Could not mark caught up: disabled');
    });
});
