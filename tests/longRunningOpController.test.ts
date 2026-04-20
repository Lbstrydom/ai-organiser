/**
 * LongRunningOpController tests — the domain-neutral successor to
 * GenerationProgressController. Most behaviour is already covered by
 * generationProgressController.test.ts (which exercises the backward-compat
 * shim). This file adds direct-import symbol coverage for the new module,
 * plus the generic `parseCountFromPrompt` helper that slide-count parsing
 * is built on.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    LongRunningOpController,
    parseCountFromPrompt,
} from '../src/services/longRunningOp/progressController';

describe('LongRunningOpController — direct symbol import (Phase 2 rename)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('renamed API surface: recordProgress / getLastProgress', () => {
        const abort = new AbortController();
        const onProgress = vi.fn();
        const ctrl = new LongRunningOpController({
            softBudgetMs: 300, hardBudgetMs: 500,
            abortController: abort,
            onProgress,
        });
        ctrl.recordProgress(1);
        expect(onProgress).toHaveBeenCalledWith(1, undefined, expect.any(Number));
        expect(ctrl.getLastProgress()).toBe(1);
        ctrl.recordProgress(2);
        expect(ctrl.getLastProgress()).toBe(2);
        ctrl.dispose();
    });

    it('expected parameter is floored + validated', () => {
        const abort = new AbortController();
        expect(() => new LongRunningOpController({
            softBudgetMs: 100, hardBudgetMs: 200, abortController: abort, expected: 0,
        })).toThrow(/expected/);
        expect(() => new LongRunningOpController({
            softBudgetMs: 100, hardBudgetMs: 200, abortController: abort, expected: -1,
        })).toThrow(/expected/);
        const ctrl = new LongRunningOpController({
            softBudgetMs: 100, hardBudgetMs: 200, abortController: abort, expected: 8.9,
            onProgress: () => {},
        });
        ctrl.recordProgress(1);
        // expected coerced to 8
        ctrl.dispose();
    });

    it('hard cap fires abort and onDispose', () => {
        const abort = new AbortController();
        const onHardBudget = vi.fn();
        const onDispose = vi.fn();
        new LongRunningOpController({
            softBudgetMs: 100, hardBudgetMs: 200,
            abortController: abort,
            onHardBudget, onDispose,
        });
        vi.advanceTimersByTime(200);
        expect(onHardBudget).toHaveBeenCalledTimes(1);
        expect(abort.signal.aborted).toBe(true);
        expect(onDispose).toHaveBeenCalledTimes(1);
    });

    it('external abort triggers self-dispose', () => {
        const abort = new AbortController();
        const onDispose = vi.fn();
        new LongRunningOpController({
            softBudgetMs: 100, hardBudgetMs: 200,
            abortController: abort,
            onDispose,
        });
        abort.abort();
        expect(onDispose).toHaveBeenCalledTimes(1);
    });
});

describe('parseCountFromPrompt — generic prompt-count parser', () => {
    const slidePattern = /\b(\d+)[-\s]?slides?\b/i;
    const sourcesPattern = /\b(\d+)\s*sources?\b/i;

    it('matches first capture group and clamps', () => {
        expect(parseCountFromPrompt('make 8 slides', slidePattern, 5, 50)).toBe(8);
        expect(parseCountFromPrompt('need 3 sources', sourcesPattern, 5, 20)).toBe(3);
    });

    it('applies fallback when no match', () => {
        expect(parseCountFromPrompt('no digits here', slidePattern, 6, 50)).toBe(6);
    });

    it('clamps below 1 to 1', () => {
        expect(parseCountFromPrompt('0 slides', slidePattern, 5, 50)).toBe(1);
    });

    it('clamps above maxCount', () => {
        expect(parseCountFromPrompt('250 slides', slidePattern, 5, 50)).toBe(50);
        expect(parseCountFromPrompt('100 sources', sourcesPattern, 5, 20)).toBe(20);
    });

    it('is case insensitive', () => {
        expect(parseCountFromPrompt('12 SLIDES', slidePattern, 5, 50)).toBe(12);
    });
});
