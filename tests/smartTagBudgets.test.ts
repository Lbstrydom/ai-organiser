import { describe, it, expect } from 'vitest';
import { computeSmartTagBudget } from '../src/services/smartTagBudgets';

describe('computeSmartTagBudget — linear scaling with base + hard ceiling', () => {
    it('single file: 1×6+60=66s soft / 1×12+120=132s hard', () => {
        const b = computeSmartTagBudget(1);
        expect(b.softBudgetMs).toBe(66_000);
        expect(b.hardBudgetMs).toBe(132_000);
    });

    it('10 files: 120s soft / 240s hard', () => {
        const b = computeSmartTagBudget(10);
        expect(b.softBudgetMs).toBe(120_000);
        expect(b.hardBudgetMs).toBe(240_000);
    });

    it('100 files: 660s soft / 1320s hard (22min)', () => {
        const b = computeSmartTagBudget(100);
        expect(b.softBudgetMs).toBe(660_000);
        expect(b.hardBudgetMs).toBe(1_320_000);
    });

    it('500 files (typical vault): 3060s soft / 3600s hard (hits 60min ceiling)', () => {
        const b = computeSmartTagBudget(500);
        // raw hard = 500×12 + 120 = 6120s → clamped to 3600
        expect(b.hardBudgetMs).toBe(3_600_000);
        // soft clamped to hard − 30s so invariant holds
        expect(b.softBudgetMs).toBeLessThanOrEqual(3_570_000);
    });

    it('pathological 10_000 files stays at 60min ceiling', () => {
        const b = computeSmartTagBudget(10_000);
        expect(b.hardBudgetMs).toBe(3_600_000);
        expect(b.softBudgetMs).toBeLessThan(b.hardBudgetMs);
    });

    it('zero files (defensive): base floors only', () => {
        const b = computeSmartTagBudget(0);
        expect(b.softBudgetMs).toBe(60_000);
        expect(b.hardBudgetMs).toBe(120_000);
    });

    it('invariant: soft < hard for every reasonable count', () => {
        for (const n of [0, 1, 10, 50, 100, 300, 500, 1000, 10_000]) {
            const b = computeSmartTagBudget(n);
            expect(b.softBudgetMs).toBeLessThan(b.hardBudgetMs);
        }
    });

    it('result is frozen', () => {
        expect(Object.isFrozen(computeSmartTagBudget(50))).toBe(true);
    });

    it('floors non-integer count', () => {
        const b = computeSmartTagBudget(10.9);
        expect(b.softBudgetMs).toBe(120_000);
    });
});
