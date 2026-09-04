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
    caughtUpOk: 'Caught up through {through} — {buckets} day(s), {stories} stories',
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
        expect(out).toBe('Caught up through 2026-09-04 — 3 day(s), 17 stories');
        expect(out).not.toContain('{');
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
        for (const outcome of [
            { kind: 'ok', buckets: 1, stories: 1, through: '2026-09-04' },
            { kind: 'noop' },
            { kind: 'disabled' },
            { kind: 'error', error: 'x' },
        ] as CaughtUpOutcome[]) {
            const out = formatCaughtUpOutcome(outcome, undefined);
            expect(out.length).toBeGreaterThan(0);
            expect(out).not.toContain('{');
        }
    });

    it('an error whose text is literally "disabled" is still an error', () => {
        // The regression the union exists to prevent: with an error-string
        // sentinel this would have been silently reclassified as "feature off".
        expect(formatCaughtUpOutcome({ kind: 'error', error: 'disabled' }, nl))
            .toBe('Could not mark caught up: disabled');
    });
});
