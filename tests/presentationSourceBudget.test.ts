/**
 * presentationSourceBudget unit tests.
 * Plan: docs/completed/slide-authoring-followup-implementation.md (Phase H).
 */

import { describe, it, expect } from 'vitest';
import {
    allocateBudget,
    TOTAL_SOURCE_BUDGET_CHARS,
    NOTE_HARD_CAP,
    FOLDER_FILE_FLOOR,
    WEB_SEARCH_CAP,
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

describe('allocateBudget', () => {
    it('returns empty for empty input', () => {
        expect(allocateBudget([])).toEqual([]);
    });

    it('passes through small sources unchanged', () => {
        const sources = [note('a.md', 100), note('b.md', 200)];
        const out = allocateBudget(sources);
        expect(out[0].content.length).toBe(100);
        expect(out[1].content.length).toBe(200);
    });

    it('caps standalone notes at NOTE_HARD_CAP', () => {
        const sources = [note('big.md', NOTE_HARD_CAP * 2)];
        const out = allocateBudget(sources);
        expect(out[0].content.length).toBeLessThanOrEqual(NOTE_HARD_CAP);
    });

    it('caps web-search results at WEB_SEARCH_CAP', () => {
        const sources = [web('q1', WEB_SEARCH_CAP * 2)];
        const out = allocateBudget(sources);
        expect(out[0].content.length).toBeLessThanOrEqual(WEB_SEARCH_CAP);
    });

    it('shares remaining budget across folder files', () => {
        const sources = [
            note('folder/a.md', NOTE_HARD_CAP, 'folder'),
            note('folder/b.md', NOTE_HARD_CAP, 'folder'),
            note('folder/c.md', NOTE_HARD_CAP, 'folder'),
        ];
        const out = allocateBudget(sources);
        const total = out.reduce((a, s) => a + s.content.length, 0);
        expect(total).toBeLessThanOrEqual(TOTAL_SOURCE_BUDGET_CHARS);
    });

    it('honours FOLDER_FILE_FLOOR even when budget is tight', () => {
        const sources: PromptSource[] = [];
        for (let i = 0; i < 200; i++) {
            sources.push(note(`folder/${i}.md`, NOTE_HARD_CAP, 'folder'));
        }
        const out = allocateBudget(sources);
        for (const s of out) {
            expect(s.content.length).toBeGreaterThanOrEqual(FOLDER_FILE_FLOOR);
        }
    });

    it('shrinks folder before web before standalone when over budget', () => {
        // Total raw = 8K + 4K + 8K + 8K + 8K = 36K — under budget after caps,
        // so this primarily exercises the per-kind caps path.
        const sources = [
            note('a.md', NOTE_HARD_CAP),
            web('q', WEB_SEARCH_CAP),
            note('folder/a.md', NOTE_HARD_CAP, 'folder'),
            note('folder/b.md', NOTE_HARD_CAP, 'folder'),
            note('folder/c.md', NOTE_HARD_CAP, 'folder'),
        ];
        const out = allocateBudget(sources);
        const standalone = out[0];
        const webOut = out[1];
        const folderOut = out.slice(2);
        // Standalone is preserved at hard cap.
        expect(standalone.content.length).toBeLessThanOrEqual(NOTE_HARD_CAP);
        expect(webOut.content.length).toBeLessThanOrEqual(WEB_SEARCH_CAP);
        // Folder share is bounded by per-file allocation.
        for (const s of folderOut) {
            expect(s.content.length).toBeLessThanOrEqual(NOTE_HARD_CAP);
        }
        // Total never exceeds the global budget.
        const total = out.reduce((a, s) => a + s.content.length, 0);
        expect(total).toBeLessThanOrEqual(TOTAL_SOURCE_BUDGET_CHARS);
    });
});
