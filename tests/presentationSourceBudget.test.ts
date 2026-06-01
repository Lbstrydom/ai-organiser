/**
 * presentationSourceBudget unit tests.
 * Plan: docs/completed/slide-authoring-followup-implementation.md (Phase H);
 * model-aware budget (2026-06-01) — full sources pass through under budget.
 */

import { describe, it, expect } from 'vitest';
import {
    allocateBudget,
    computeSourceBudgetChars,
    TOTAL_SOURCE_BUDGET_CHARS,
    FOLDER_FILE_FLOOR,
} from '../src/services/chat/presentationSourceBudget';
import type { PromptSource } from '../src/services/chat/presentationTypes';

const note = (ref: string, len: number, fromFolder?: string): PromptSource => ({
    kind: 'note',
    ref,
    content: 'a'.repeat(len),
    ...(fromFolder ? { fromFolder } : {}),
});
const web = (ref: string, len: number): PromptSource => ({
    kind: 'web-search',
    ref,
    content: 'q'.repeat(len),
});
const totalLen = (out: PromptSource[]): number => out.reduce((a, s) => a + s.content.length, 0);

describe('allocateBudget', () => {
    it('returns empty for empty input', () => {
        expect(allocateBudget([])).toEqual([]);
    });

    it('passes small sources through unchanged', () => {
        const out = allocateBudget([note('a.md', 100), note('b.md', 200)]);
        expect(out[0].content.length).toBe(100);
        expect(out[1].content.length).toBe(200);
    });

    it('passes a large note through UNTRUNCATED when under budget (knowledge-work fix)', () => {
        const out = allocateBudget([note('big.md', 100_000)], 200_000);
        expect(out[0].content.length).toBe(100_000); // full content — no per-kind cap any more
    });

    it('passes a large web-search result through untruncated when under budget', () => {
        const out = allocateBudget([web('q', 30_000)], 200_000);
        expect(out[0].content.length).toBe(30_000);
    });

    it('truncates to fit when over the supplied budget', () => {
        const out = allocateBudget([note('a.md', 50_000)], 10_000);
        expect(totalLen(out)).toBeLessThanOrEqual(10_000);
    });

    it('shrinks folder before web before standalone when over budget', () => {
        const sources = [
            note('a.md', 8_000),
            web('q', 8_000),
            note('folder/a.md', 8_000, 'folder'),
            note('folder/b.md', 8_000, 'folder'),
        ];
        const budget = 12_000;
        const out = allocateBudget(sources, budget);
        expect(totalLen(out)).toBeLessThanOrEqual(budget);
        const [standalone, webOut, folderA] = out;
        // Standalone is the last to shrink → kept fuller than the folder files.
        expect(standalone.content.length).toBeGreaterThanOrEqual(folderA.content.length);
        expect(webOut.content.length).toBeGreaterThanOrEqual(folderA.content.length);
    });

    it('honours FOLDER_FILE_FLOOR even when budget is tight', () => {
        const sources: PromptSource[] = [];
        for (let i = 0; i < 200; i++) sources.push(note(`folder/${i}.md`, 8_000, 'folder'));
        const out = allocateBudget(sources, 10_000);
        for (const s of out) expect(s.content.length).toBeGreaterThanOrEqual(FOLDER_FILE_FLOOR);
    });

    it('uses the flat fallback budget when none is supplied', () => {
        const out = allocateBudget([note('a.md', TOTAL_SOURCE_BUDGET_CHARS * 2)]);
        expect(totalLen(out)).toBeLessThanOrEqual(TOTAL_SOURCE_BUDGET_CHARS);
    });
});

describe('computeSourceBudgetChars', () => {
    it('scales with the provider/model window, floored and ceilinged', () => {
        const claude = computeSourceBudgetChars('claude');
        const local = computeSourceBudgetChars('local');
        expect(claude).toBeGreaterThan(local);          // bigger window → bigger budget
        expect(local).toBeGreaterThanOrEqual(24_000);   // MIN floor
        expect(claude).toBeLessThanOrEqual(600_000);    // MAX ceiling
    });

    it('floors tiny/unknown providers to a usable minimum', () => {
        expect(computeSourceBudgetChars('local')).toBeGreaterThanOrEqual(24_000);
        expect(computeSourceBudgetChars('some-unknown-provider')).toBeGreaterThanOrEqual(24_000);
    });
});
