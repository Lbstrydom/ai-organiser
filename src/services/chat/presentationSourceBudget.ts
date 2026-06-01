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
import { truncateAtBoundary, getMaxContentCharsForModel } from '../tokenLimits';

/** Legacy/fallback total when no model-aware budget is supplied. Also the
 *  small-model floor reference. */
export const TOTAL_SOURCE_BUDGET_CHARS = 40_000;
export const FOLDER_FILE_FLOOR = 500;

// Model-aware budget tuning. We use a slice of the provider/model context
// window rather than a flat char cap, so substantial sources (a full board
// meeting + a full web result) reach generation untruncated on cloud models
// — while a floor keeps small/local models safe and a ceiling avoids dumping
// a full 1M-token window (cost + lost-in-the-middle dilution).
const SOURCE_BUDGET_FRACTION = 0.6;          // reserve ~40% for system prompt + deck-IR completion
const MIN_SOURCE_BUDGET_CHARS = 24_000;      // ~6K tokens — usable even on local
const MAX_SOURCE_BUDGET_CHARS = 600_000;     // ~150K tokens — generous ceiling

/**
 * Model-aware total budget (chars) for presentation source content. Scales to
 * the provider/model context window, floored for small models and ceilinged so
 * we never firehose a full 1M window. The caller resolves provider+model from
 * settings and passes the result into `allocateBudget` / `resolveForSubmit`.
 */
export function computeSourceBudgetChars(provider: string, model?: string): number {
    const windowChars = getMaxContentCharsForModel(provider, model);
    const usable = Math.floor(windowChars * SOURCE_BUDGET_FRACTION);
    return Math.min(MAX_SOURCE_BUDGET_CHARS, Math.max(MIN_SOURCE_BUDGET_CHARS, usable));
}

/**
 * Allocate the prompt budget across resolved sources. When the combined
 * content fits within `totalBudgetChars` it is returned **untruncated** (the
 * common case on cloud models — full notes + web results reach generation).
 * Only when over budget does it truncate, by priority: folder-derived notes
 * first (shared evenly), then web-search, then standalone notes (last resort).
 * Truncation uses `truncateAtBoundary` so every result still parses as Markdown
 * (audit Gemini-r4-G3 — no severed code blocks / broken links).
 */
export function allocateBudget(
    sources: PromptSource[],
    totalBudgetChars: number = TOTAL_SOURCE_BUDGET_CHARS,
): PromptSource[] {
    if (sources.length === 0) return [];
    const out = sources.map(s => ({ ...s }));

    // Fast path: everything fits → no truncation. This is the behaviour that
    // lets full sources through for knowledge work on large-context models.
    let total = out.reduce((a, s) => a + s.content.length, 0);
    if (total <= totalBudgetChars) return out;

    // Over budget — classify and shrink by priority.
    const standalone: number[] = [];
    const folder: number[] = [];
    const web: number[] = [];
    out.forEach((src, i) => {
        if (src.kind === 'web-search') web.push(i);
        else if (src.fromFolder) folder.push(i);
        else standalone.push(i);
    });

    // Folder files share whatever the budget leaves after standalone + web
    // claim their full sizes — fair across many files, floored per file.
    if (folder.length > 0) {
        const nonFolderTotal =
            standalone.reduce((a, i) => a + out[i].content.length, 0) +
            web.reduce((a, i) => a + out[i].content.length, 0);
        const folderRemaining = Math.max(0, totalBudgetChars - nonFolderTotal);
        const perFile = Math.max(FOLDER_FILE_FLOOR, Math.floor(folderRemaining / folder.length));
        for (const i of folder) {
            if (out[i].content.length > perFile) {
                out[i] = { ...out[i], content: truncateAtBoundary(out[i].content, perFile) };
            }
        }
    }

    total = out.reduce((a, s) => a + s.content.length, 0);
    if (total <= totalBudgetChars) return out;

    const shrink = (idxs: number[], floor: number): void => {
        for (const i of idxs) {
            if (total <= totalBudgetChars) return;
            const cur = out[i].content.length;
            const overflow = total - totalBudgetChars;
            const targetLen = Math.max(floor, cur - overflow);
            if (targetLen < cur) {
                out[i] = { ...out[i], content: truncateAtBoundary(out[i].content, targetLen) };
                total -= cur - targetLen;
            }
        }
    };
    shrink(web, FOLDER_FILE_FLOOR);
    shrink(standalone, FOLDER_FILE_FLOOR);

    return out;
}
