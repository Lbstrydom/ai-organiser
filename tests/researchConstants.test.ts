/**
 * Research Web — budget constant invariant tests (Phase 3)
 */

import { describe, it, expect } from 'vitest';
import {
    RESEARCH_SOFT_BUDGET_MS,
    RESEARCH_HARD_BUDGET_MS,
    RESEARCH_BUDGET,
} from '../src/services/research/researchConstants';
import { getExtendDisplayMs } from '../src/services/chat/presentationConstants';

describe('Research budget constants', () => {
    it('soft < hard (required for two-tier semantics)', () => {
        expect(RESEARCH_SOFT_BUDGET_MS).toBeLessThan(RESEARCH_HARD_BUDGET_MS);
    });

    it('budget preset is frozen (protects from mutation at runtime)', () => {
        expect(Object.isFrozen(RESEARCH_BUDGET)).toBe(true);
    });

    it('preset matches individual constants', () => {
        expect(RESEARCH_BUDGET.softBudgetMs).toBe(RESEARCH_SOFT_BUDGET_MS);
        expect(RESEARCH_BUDGET.hardBudgetMs).toBe(RESEARCH_HARD_BUDGET_MS);
    });

    it('getExtendDisplayMs accepts the preset', () => {
        const extendMs = getExtendDisplayMs(RESEARCH_BUDGET);
        expect(extendMs).toBe(RESEARCH_HARD_BUDGET_MS - RESEARCH_SOFT_BUDGET_MS);
        expect(extendMs).toBeGreaterThan(0);
    });

    it('soft cap is reasonable for research (≥2min, ≤5min)', () => {
        expect(RESEARCH_SOFT_BUDGET_MS).toBeGreaterThanOrEqual(120_000);
        expect(RESEARCH_SOFT_BUDGET_MS).toBeLessThanOrEqual(300_000);
    });

    it('hard cap is reasonable for research (≥4min, ≤10min)', () => {
        expect(RESEARCH_HARD_BUDGET_MS).toBeGreaterThanOrEqual(240_000);
        expect(RESEARCH_HARD_BUDGET_MS).toBeLessThanOrEqual(600_000);
    });
});
