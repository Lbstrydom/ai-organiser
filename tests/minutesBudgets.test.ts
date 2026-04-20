/**
 * Phase 4 — dynamic-per-chunk budget tests.
 */

import { describe, it, expect } from 'vitest';
import { computeMinutesBudget } from '../src/services/minutesBudgets';

describe('computeMinutesBudget — scales with chunk count', () => {
    it('1 chunk hits the floor (120s soft / 240s hard)', () => {
        const b = computeMinutesBudget(1);
        expect(b.softBudgetMs).toBe(120_000);
        expect(b.hardBudgetMs).toBe(240_000);
    });

    it('2 chunks still at the floor (60s × 2 = 120s = floor)', () => {
        const b = computeMinutesBudget(2);
        expect(b.softBudgetMs).toBe(120_000);
        expect(b.hardBudgetMs).toBe(240_000);
    });

    it('5 chunks scales linearly (300s soft / 600s hard)', () => {
        const b = computeMinutesBudget(5);
        expect(b.softBudgetMs).toBe(300_000);
        expect(b.hardBudgetMs).toBe(600_000);
    });

    it('10 chunks = 600s soft / 1200s hard', () => {
        const b = computeMinutesBudget(10);
        expect(b.softBudgetMs).toBe(600_000);
        expect(b.hardBudgetMs).toBe(1_200_000);
    });

    it('20 chunks hits the ceiling (900s soft / 1800s hard)', () => {
        const b = computeMinutesBudget(20);
        expect(b.softBudgetMs).toBe(900_000);
        expect(b.hardBudgetMs).toBe(1_800_000);
    });

    it('pathological 100 chunks stays at ceiling', () => {
        const b = computeMinutesBudget(100);
        expect(b.softBudgetMs).toBe(900_000);
        expect(b.hardBudgetMs).toBe(1_800_000);
    });

    it('all presets satisfy soft < hard', () => {
        for (const n of [1, 2, 5, 10, 20, 100]) {
            const b = computeMinutesBudget(n);
            expect(b.softBudgetMs).toBeLessThan(b.hardBudgetMs);
        }
    });

    it('result is frozen', () => {
        expect(Object.isFrozen(computeMinutesBudget(5))).toBe(true);
    });
});
