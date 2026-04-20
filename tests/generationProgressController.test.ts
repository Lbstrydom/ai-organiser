/**
 * Generation Progress Controller Tests
 *
 * Covers budget timers, slide-count updates, dispose idempotency,
 * extend-card cancel hook, and the prompt parser.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    GenerationProgressController,
    parseExpectedSlideCount,
} from '../src/services/chat/generationProgressController';

describe('GenerationProgressController', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    function makeAbort(): AbortController {
        return new AbortController();
    }

    it('records checkpoints and calls onSlideUpdate only on slideCount change', () => {
        const abort = makeAbort();
        const onSlideUpdate = vi.fn();
        const ctrl = new GenerationProgressController({
            softBudgetMs: 1000,
            hardBudgetMs: 2000,
            expected: 8,
            abortController: abort,
            onSlideUpdate,
        });

        ctrl.recordCheckpoint(1);
        ctrl.recordCheckpoint(1); // duplicate — should NOT fire
        ctrl.recordCheckpoint(2);

        expect(onSlideUpdate).toHaveBeenCalledTimes(2);
        expect(onSlideUpdate).toHaveBeenNthCalledWith(1, 1, 8, expect.any(Number));
        expect(onSlideUpdate).toHaveBeenNthCalledWith(2, 2, 8, expect.any(Number));
        ctrl.dispose();
    });

    it('passes undefined expected when caller did not provide one', () => {
        const abort = makeAbort();
        const onSlideUpdate = vi.fn();
        const ctrl = new GenerationProgressController({
            softBudgetMs: 1000,
            hardBudgetMs: 2000,
            abortController: abort,
            onSlideUpdate,
        });

        ctrl.recordCheckpoint(1);
        expect(onSlideUpdate).toHaveBeenCalledWith(1, undefined, expect.any(Number));
        ctrl.dispose();
    });

    it('fires onSoftBudget exactly once at softBudgetMs', () => {
        const abort = makeAbort();
        const onSoftBudget = vi.fn();
        const ctrl = new GenerationProgressController({
            softBudgetMs: 300,
            hardBudgetMs: 500,
            abortController: abort,
            onSoftBudget,
        });

        vi.advanceTimersByTime(299);
        expect(onSoftBudget).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(onSoftBudget).toHaveBeenCalledTimes(1);
        expect(ctrl.isSoftBudgetFired()).toBe(true);

        // No re-entry: advancing more time doesn't re-fire
        vi.advanceTimersByTime(1000);
        expect(onSoftBudget).toHaveBeenCalledTimes(1);
        ctrl.dispose();
    });

    it('fires onHardBudget and aborts the supplied controller at hardBudgetMs', () => {
        const abort = makeAbort();
        const onHardBudget = vi.fn();
        const onDispose = vi.fn();
        new GenerationProgressController({
            softBudgetMs: 300,
            hardBudgetMs: 500,
            abortController: abort,
            onHardBudget,
            onDispose,
        });

        vi.advanceTimersByTime(500);
        expect(onHardBudget).toHaveBeenCalledTimes(1);
        expect(abort.signal.aborted).toBe(true);
        // Hard cap auto-disposes — onDispose fires in the same tick
        expect(onDispose).toHaveBeenCalledTimes(1);
    });

    it('hard cap calls extendCardCancelHook before onDispose so card auto-closes', () => {
        const abort = makeAbort();
        const cancelHook = vi.fn();
        const onDispose = vi.fn(() => {
            // When onDispose runs the hook must already have fired
            expect(cancelHook).toHaveBeenCalled();
        });
        const ctrl = new GenerationProgressController({
            softBudgetMs: 300,
            hardBudgetMs: 500,
            abortController: abort,
            onDispose,
        });
        ctrl.setExtendCardCancelHook(cancelHook);

        vi.advanceTimersByTime(500);
        expect(cancelHook).toHaveBeenCalledTimes(1);
        expect(onDispose).toHaveBeenCalledTimes(1);
    });

    it('dispose is idempotent — multiple calls do not double-fire onDispose', () => {
        const abort = makeAbort();
        const onDispose = vi.fn();
        const cancelHook = vi.fn();
        const ctrl = new GenerationProgressController({
            softBudgetMs: 1000,
            hardBudgetMs: 2000,
            abortController: abort,
            onDispose,
        });
        ctrl.setExtendCardCancelHook(cancelHook);

        ctrl.dispose();
        ctrl.dispose();
        ctrl.dispose();
        expect(onDispose).toHaveBeenCalledTimes(1);
        expect(cancelHook).toHaveBeenCalledTimes(1);
    });

    it('dispose before soft budget clears both timers (no callbacks fire)', () => {
        const abort = makeAbort();
        const onSoftBudget = vi.fn();
        const onHardBudget = vi.fn();
        const ctrl = new GenerationProgressController({
            softBudgetMs: 300,
            hardBudgetMs: 500,
            abortController: abort,
            onSoftBudget,
            onHardBudget,
        });

        ctrl.dispose();
        vi.advanceTimersByTime(1000);
        expect(onSoftBudget).not.toHaveBeenCalled();
        expect(onHardBudget).not.toHaveBeenCalled();
        expect(abort.signal.aborted).toBe(false);
    });

    it('checkpoints after dispose are ignored', () => {
        const abort = makeAbort();
        const onSlideUpdate = vi.fn();
        const ctrl = new GenerationProgressController({
            softBudgetMs: 300,
            hardBudgetMs: 500,
            abortController: abort,
            onSlideUpdate,
        });

        ctrl.dispose();
        ctrl.recordCheckpoint(5);
        expect(onSlideUpdate).not.toHaveBeenCalled();
    });

    it('getElapsedMs reports time since construction', () => {
        const abort = makeAbort();
        let now = 1_000_000;
        const ctrl = new GenerationProgressController({
            softBudgetMs: 10_000,
            hardBudgetMs: 20_000,
            abortController: abort,
            now: () => now,
        });
        expect(ctrl.getElapsedMs()).toBe(0);
        now += 1234;
        expect(ctrl.getElapsedMs()).toBe(1234);
        ctrl.dispose();
    });

    it('throws when softBudgetMs is not a positive finite number', () => {
        const abort = makeAbort();
        expect(() => new GenerationProgressController({
            softBudgetMs: 0, hardBudgetMs: 100, abortController: abort,
        })).toThrow(/softBudgetMs/);
        expect(() => new GenerationProgressController({
            softBudgetMs: -1, hardBudgetMs: 100, abortController: abort,
        })).toThrow(/softBudgetMs/);
        expect(() => new GenerationProgressController({
            softBudgetMs: Infinity, hardBudgetMs: 100, abortController: abort,
        })).toThrow(/softBudgetMs/);
    });

    it('throws when hardBudgetMs is not a positive finite number', () => {
        const abort = makeAbort();
        expect(() => new GenerationProgressController({
            softBudgetMs: 100, hardBudgetMs: 0, abortController: abort,
        })).toThrow(/hardBudgetMs/);
        expect(() => new GenerationProgressController({
            softBudgetMs: 100, hardBudgetMs: Number.NaN, abortController: abort,
        })).toThrow(/hardBudgetMs/);
    });

    it('throws when softBudgetMs >= hardBudgetMs (misordered budgets)', () => {
        const abort = makeAbort();
        expect(() => new GenerationProgressController({
            softBudgetMs: 500, hardBudgetMs: 500, abortController: abort,
        })).toThrow(/softBudgetMs must be < hardBudgetMs/);
        expect(() => new GenerationProgressController({
            softBudgetMs: 600, hardBudgetMs: 500, abortController: abort,
        })).toThrow(/softBudgetMs must be < hardBudgetMs/);
    });

    it('hard cap still aborts + disposes when onHardBudget throws (exception safety)', () => {
        const abort = makeAbort();
        const onDispose = vi.fn();
        const cancelHook = vi.fn();
        const ctrl = new GenerationProgressController({
            softBudgetMs: 300,
            hardBudgetMs: 500,
            abortController: abort,
            onHardBudget: () => { throw new Error('observer blew up'); },
            onDispose,
        });
        ctrl.setExtendCardCancelHook(cancelHook);

        expect(() => vi.advanceTimersByTime(500)).not.toThrow();
        expect(abort.signal.aborted).toBe(true);   // abort still fires
        expect(cancelHook).toHaveBeenCalledTimes(1); // card auto-closes
        expect(onDispose).toHaveBeenCalledTimes(1); // dispose still fires
    });

    it('soft-timer suppresses observer exceptions (async callback rejection)', () => {
        const abort = makeAbort();
        const ctrl = new GenerationProgressController({
            softBudgetMs: 300,
            hardBudgetMs: 500,
            abortController: abort,
            // eslint-disable-next-line @typescript-eslint/require-await
            onSoftBudget: async () => { throw new Error('async observer blew up'); },
        });

        expect(() => vi.advanceTimersByTime(300)).not.toThrow();
        expect(ctrl.isSoftBudgetFired()).toBe(true);
        ctrl.dispose();
    });

    it('soft-timer suppresses sync observer exceptions', () => {
        const abort = makeAbort();
        const ctrl = new GenerationProgressController({
            softBudgetMs: 300,
            hardBudgetMs: 500,
            abortController: abort,
            onSoftBudget: () => { throw new Error('sync observer blew up'); },
        });

        expect(() => vi.advanceTimersByTime(300)).not.toThrow();
        expect(ctrl.isSoftBudgetFired()).toBe(true);
        ctrl.dispose();
    });

    it('self-disposes when external AbortController is aborted (M1)', () => {
        const abort = makeAbort();
        const onDispose = vi.fn();
        const onSoftBudget = vi.fn();
        const onHardBudget = vi.fn();
        new GenerationProgressController({
            softBudgetMs: 300,
            hardBudgetMs: 500,
            abortController: abort,
            onSoftBudget, onHardBudget, onDispose,
        });

        abort.abort();
        // After external abort: dispose fires, timers cleared, no further callbacks
        expect(onDispose).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(1000);
        expect(onSoftBudget).not.toHaveBeenCalled();
        expect(onHardBudget).not.toHaveBeenCalled();
    });

    it('does NOT start timers when AbortController is already aborted', async () => {
        const abort = makeAbort();
        abort.abort(); // pre-aborted
        const onDispose = vi.fn();
        const onSoftBudget = vi.fn();
        const ctrl = new GenerationProgressController({
            softBudgetMs: 300,
            hardBudgetMs: 500,
            abortController: abort,
            onSoftBudget, onDispose,
        });

        // onDispose is deferred to a microtask in the pre-aborted path
        // so the caller's `const ctrl = new X(...)` completes first. (R3 M6)
        expect(onDispose).not.toHaveBeenCalled();
        await Promise.resolve();
        vi.advanceTimersByTime(1000);
        expect(onSoftBudget).not.toHaveBeenCalled();
        expect(onDispose).toHaveBeenCalledTimes(1);
        // idempotent
        ctrl.dispose();
        expect(onDispose).toHaveBeenCalledTimes(1);
    });

    it('recordCheckpoint swallows onSlideUpdate exceptions (M2)', () => {
        const abort = makeAbort();
        const onSlideUpdate = vi.fn(() => { throw new Error('UI blew up'); });
        const ctrl = new GenerationProgressController({
            softBudgetMs: 300,
            hardBudgetMs: 500,
            abortController: abort,
            onSlideUpdate,
        });

        expect(() => ctrl.recordCheckpoint(1)).not.toThrow();
        expect(onSlideUpdate).toHaveBeenCalledTimes(1);
        // Still usable after observer exception
        expect(() => ctrl.recordCheckpoint(2)).not.toThrow();
        expect(onSlideUpdate).toHaveBeenCalledTimes(2);
        ctrl.dispose();
    });

    it('setExtendCardCancelHook fires (via microtask) if controller already disposed (M3 + R3 M6)', async () => {
        const abort = makeAbort();
        const ctrl = new GenerationProgressController({
            softBudgetMs: 300,
            hardBudgetMs: 500,
            abortController: abort,
        });
        ctrl.dispose();
        const hook = vi.fn();
        ctrl.setExtendCardCancelHook(hook);
        // Deferred to microtask (R3 M6 — caller's setup must complete first).
        expect(hook).not.toHaveBeenCalled();
        await Promise.resolve();
        expect(hook).toHaveBeenCalledTimes(1);
    });

    it('recordCheckpoint clamps non-integer / negative counts (R3 M4)', () => {
        const abort = makeAbort();
        const onSlideUpdate = vi.fn();
        const ctrl = new GenerationProgressController({
            softBudgetMs: 300,
            hardBudgetMs: 500,
            abortController: abort,
            onSlideUpdate,
        });
        ctrl.recordCheckpoint(-5);         // rejected
        ctrl.recordCheckpoint(Number.NaN); // rejected
        ctrl.recordCheckpoint(Infinity);   // rejected
        ctrl.recordCheckpoint(3.7);        // floored to 3
        expect(onSlideUpdate).toHaveBeenCalledTimes(1);
        expect(onSlideUpdate).toHaveBeenCalledWith(3, undefined, expect.any(Number));
        ctrl.dispose();
    });

    it('throws when expected is not a positive finite integer (R3 M4)', () => {
        const abort = makeAbort();
        expect(() => new GenerationProgressController({
            softBudgetMs: 300, hardBudgetMs: 500, abortController: abort, expected: 0,
        })).toThrow(/expected/);
        expect(() => new GenerationProgressController({
            softBudgetMs: 300, hardBudgetMs: 500, abortController: abort, expected: -5,
        })).toThrow(/expected/);
        expect(() => new GenerationProgressController({
            softBudgetMs: 300, hardBudgetMs: 500, abortController: abort, expected: Number.NaN,
        })).toThrow(/expected/);
    });

    it('expected is floored to an integer when provided (R3 M4)', () => {
        const abort = makeAbort();
        const onSlideUpdate = vi.fn();
        const ctrl = new GenerationProgressController({
            softBudgetMs: 300, hardBudgetMs: 500, abortController: abort,
            expected: 8.7, onSlideUpdate,
        });
        ctrl.recordCheckpoint(1);
        expect(onSlideUpdate).toHaveBeenCalledWith(1, 8, expect.any(Number));
        ctrl.dispose();
    });

    it('pre-aborted onDispose fires in a microtask, not synchronously (R3 M6)', async () => {
        const abort = makeAbort();
        abort.abort();
        let disposeRanBeforeAssignment = false;
        let assigned = false;
        new GenerationProgressController({
            softBudgetMs: 300, hardBudgetMs: 500, abortController: abort,
            onDispose: () => { disposeRanBeforeAssignment = !assigned; },
        });
        assigned = true;
        // Flush microtasks
        await Promise.resolve();
        expect(disposeRanBeforeAssignment).toBe(false);
    });

    it('post-dispose setExtendCardCancelHook fires in a microtask (R3 M6)', async () => {
        const abort = makeAbort();
        const ctrl = new GenerationProgressController({
            softBudgetMs: 300, hardBudgetMs: 500, abortController: abort,
        });
        ctrl.dispose();
        const hook = vi.fn();
        ctrl.setExtendCardCancelHook(hook);
        expect(hook).not.toHaveBeenCalled(); // deferred
        await Promise.resolve();             // flush microtask
        expect(hook).toHaveBeenCalledTimes(1);
    });

    it('onSoftBudget receives elapsed ms (not wall-clock time)', () => {
        const abort = makeAbort();
        const onSoftBudget = vi.fn();
        new GenerationProgressController({
            softBudgetMs: 300,
            hardBudgetMs: 500,
            abortController: abort,
            onSoftBudget,
        });
        vi.advanceTimersByTime(300);
        expect(onSoftBudget).toHaveBeenCalledWith(expect.any(Number));
        const elapsedArg = onSoftBudget.mock.calls[0][0];
        expect(elapsedArg).toBeGreaterThanOrEqual(299);
        expect(elapsedArg).toBeLessThanOrEqual(350);
    });
});

describe('BudgetPreset + getExtendDisplayMs', () => {
    it('GENERATION_BUDGET and REFINEMENT_BUDGET are frozen (R4 M1)', async () => {
        const { GENERATION_BUDGET, REFINEMENT_BUDGET } =
            await import('../src/services/chat/presentationConstants');
        expect(Object.isFrozen(GENERATION_BUDGET)).toBe(true);
        expect(Object.isFrozen(REFINEMENT_BUDGET)).toBe(true);
    });

    it('flat exports match their preset source (R4 M2)', async () => {
        const mod = await import('../src/services/chat/presentationConstants');
        expect(mod.GENERATION_SOFT_BUDGET_MS).toBe(mod.GENERATION_BUDGET.softBudgetMs);
        expect(mod.GENERATION_HARD_BUDGET_MS).toBe(mod.GENERATION_BUDGET.hardBudgetMs);
        expect(mod.REFINEMENT_SOFT_BUDGET_MS).toBe(mod.REFINEMENT_BUDGET.softBudgetMs);
        expect(mod.REFINEMENT_HARD_BUDGET_MS).toBe(mod.REFINEMENT_BUDGET.hardBudgetMs);
    });

    it('getExtendDisplayMs returns soft→hard gap', async () => {
        const { getExtendDisplayMs } = await import('../src/services/chat/presentationConstants');
        expect(getExtendDisplayMs({ softBudgetMs: 300_000, hardBudgetMs: 500_000 })).toBe(200_000);
    });

    it('getExtendDisplayMs throws on invalid preset (R3 L5)', async () => {
        const { getExtendDisplayMs } = await import('../src/services/chat/presentationConstants');
        expect(() => getExtendDisplayMs({ softBudgetMs: 500, hardBudgetMs: 300 }))
            .toThrow(/0 < softBudgetMs < hardBudgetMs/);
        expect(() => getExtendDisplayMs({ softBudgetMs: 0, hardBudgetMs: 300 }))
            .toThrow(/0 < softBudgetMs < hardBudgetMs/);
        expect(() => getExtendDisplayMs({ softBudgetMs: 300, hardBudgetMs: 300 }))
            .toThrow(/0 < softBudgetMs < hardBudgetMs/);
    });
});

describe('parseExpectedSlideCount', () => {
    it('matches "8 slides"', () => {
        expect(parseExpectedSlideCount('make 8 slides about X')).toBe(8);
    });

    it('matches "12-slide"', () => {
        expect(parseExpectedSlideCount('a 12-slide deck')).toBe(12);
    });

    it('matches "8slide"', () => {
        expect(parseExpectedSlideCount('8slides please')).toBe(8);
    });

    it('matches "3 slide" (singular)', () => {
        expect(parseExpectedSlideCount('need a 3 slide intro')).toBe(3);
    });

    it('falls back to default when no match', () => {
        expect(parseExpectedSlideCount('a presentation about marketing')).toBe(8);
        expect(parseExpectedSlideCount('')).toBe(8);
    });

    it('falls back to "eight slides" (non-digit numerals not parsed)', () => {
        // Graceful fallback per plan §7 — document, don't over-engineer
        expect(parseExpectedSlideCount('eight slides please')).toBe(8);
    });

    it('clamps below 1 to 1', () => {
        expect(parseExpectedSlideCount('a 0 slide deck')).toBe(1);
    });

    it('clamps above 50 to 50', () => {
        expect(parseExpectedSlideCount('250 slides pathological')).toBe(50);
    });

    it('respects a custom fallback', () => {
        expect(parseExpectedSlideCount('no count here', 5)).toBe(5);
    });

    it('is case insensitive', () => {
        expect(parseExpectedSlideCount('6 SLIDES')).toBe(6);
        expect(parseExpectedSlideCount('6 Slides')).toBe(6);
    });
});
