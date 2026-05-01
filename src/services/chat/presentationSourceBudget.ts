/**
 * Prompt-budget allocator for presentation source content.
 *
 * Audit Gemini-r2-G1 / r4-G3: enforces a total prompt budget across
 * resolved sources, with per-kind sub-budgets and safe markdown-aware
 * truncation. Invoked by `CreationSourceController.resolveForSubmit`
 * after `PresentationSourceService.resolve` returns the merged content.
 *
 * Priority order (audit H8):
 *   1. Standalone notes (no fromFolder) — keep up to NOTE_HARD_CAP per file.
 *   2. Folder-derived notes (fromFolder set) — share the remainder of the
 *      total budget evenly, never below FOLDER_FILE_FLOOR per file.
 *   3. Web-search results — capped per-source at WEB_SEARCH_CAP.
 *
 * If the sum still exceeds TOTAL_SOURCE_BUDGET_CHARS after the per-kind
 * caps, shrink folder-derived notes first, then web-search, then
 * standalone notes (last resort).
 */

import type { PromptSource } from './presentationTypes';
import { truncateAtBoundary } from '../tokenLimits';

export const TOTAL_SOURCE_BUDGET_CHARS = 40_000;
export const NOTE_HARD_CAP = 8_000;
export const FOLDER_FILE_FLOOR = 500;
export const WEB_SEARCH_CAP = 4_000;

/**
 * Allocate the prompt budget across resolved sources. Returns the
 * (possibly truncated) sources in their original order. Truncation uses
 * `truncateContent` so every truncated string still parses as Markdown
 * (audit Gemini-r4-G3 — no severed code blocks / broken links).
 */
export function allocateBudget(sources: PromptSource[]): PromptSource[] {
    if (sources.length === 0) return [];

    // Stage 1: per-kind caps.
    const standalone: number[] = [];
    const folder: number[] = [];
    const web: number[] = [];
    sources.forEach((src, i) => {
        if (src.kind === 'web-search') web.push(i);
        else if (src.fromFolder) folder.push(i);
        else standalone.push(i);
    });

    const out = sources.map(s => ({ ...s }));

    // Standalone notes: cap each at NOTE_HARD_CAP.
    for (const i of standalone) {
        if (out[i].content.length > NOTE_HARD_CAP) {
            out[i] = { ...out[i], content: truncateAtBoundary(out[i].content, NOTE_HARD_CAP) };
        }
    }
    // Web-search: cap each at WEB_SEARCH_CAP.
    for (const i of web) {
        if (out[i].content.length > WEB_SEARCH_CAP) {
            out[i] = { ...out[i], content: truncateAtBoundary(out[i].content, WEB_SEARCH_CAP) };
        }
    }
    // Folder files: share the remaining budget after standalone + web claim
    // their stage-1 sizes. Floor at FOLDER_FILE_FLOOR per file.
    if (folder.length > 0) {
        const standaloneTotal = standalone.reduce((a, i) => a + out[i].content.length, 0);
        const webTotal = web.reduce((a, i) => a + out[i].content.length, 0);
        const folderRemaining = Math.max(0, TOTAL_SOURCE_BUDGET_CHARS - standaloneTotal - webTotal);
        const perFile = Math.max(FOLDER_FILE_FLOOR, Math.floor(folderRemaining / folder.length));
        for (const i of folder) {
            if (out[i].content.length > perFile) {
                out[i] = { ...out[i], content: truncateAtBoundary(out[i].content, perFile) };
            }
        }
    }

    // Stage 2: if still over budget, shrink folder → web → standalone.
    let total = out.reduce((a, s) => a + s.content.length, 0);
    if (total <= TOTAL_SOURCE_BUDGET_CHARS) return out;

    const shrink = (idxs: number[], floor: number): void => {
        if (total <= TOTAL_SOURCE_BUDGET_CHARS) return;
        for (const i of idxs) {
            if (total <= TOTAL_SOURCE_BUDGET_CHARS) return;
            const cur = out[i].content.length;
            const overflow = total - TOTAL_SOURCE_BUDGET_CHARS;
            const targetLen = Math.max(floor, cur - overflow);
            if (targetLen < cur) {
                out[i] = { ...out[i], content: truncateAtBoundary(out[i].content, targetLen) };
                total -= cur - targetLen;
            }
        }
    };
    shrink(folder, FOLDER_FILE_FLOOR);
    shrink(web, FOLDER_FILE_FLOOR);
    shrink(standalone, FOLDER_FILE_FLOOR);

    return out;
}
