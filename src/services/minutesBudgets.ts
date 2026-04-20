/**
 * Meeting Minutes — Budget Helpers
 *
 * Phase 4 port of the soft/hard budget pattern. Minutes uses chunked
 * transcript processing — each chunk is one LLM call, so the budget
 * scales with chunk count. A 2-chunk meeting wraps up in ~2min normally
 * but a 10-chunk enterprise planning session can legitimately take
 * 10+ minutes.
 *
 * Per plan §12: `softBudget = chunkCount × 60s`, `hardBudget = chunkCount × 120s`.
 * We add sensible floors so single-chunk runs still have a reasonable
 * soft/hard split (60s / 120s would be too tight on a cold cache),
 * plus a ceiling to protect against pathological transcripts.
 */

import type { BudgetPreset } from './chat/presentationConstants';

const PER_CHUNK_SOFT_MS = 60_000;
const PER_CHUNK_HARD_MS = 120_000;
const FLOOR_SOFT_MS = 120_000;    // 2 min minimum
const FLOOR_HARD_MS = 240_000;    // 4 min minimum
const CEILING_SOFT_MS = 900_000;  // 15 min — beyond this, just abort
const CEILING_HARD_MS = 1_800_000; // 30 min

/**
 * Compute a per-run BudgetPreset from chunk count. Clamps to floor/ceiling
 * so edge cases (1 chunk, 50 chunks) still produce sensible budgets.
 */
export function computeMinutesBudget(chunkCount: number): BudgetPreset {
    // Normalize invalid inputs (NaN, Infinity, negative, float) to a safe
    // non-negative integer. Defensive guard — callers should only pass
    // positive integers, but transcript-splitting bugs upstream could send
    // garbage that would otherwise produce broken budgets.
    const safeCount = Number.isFinite(chunkCount) && chunkCount > 0
        ? Math.floor(chunkCount)
        : 0;
    const rawSoft = safeCount * PER_CHUNK_SOFT_MS;
    const rawHard = safeCount * PER_CHUNK_HARD_MS;
    const soft = Math.max(FLOOR_SOFT_MS, Math.min(rawSoft, CEILING_SOFT_MS));
    const hard = Math.max(FLOOR_HARD_MS, Math.min(rawHard, CEILING_HARD_MS));
    // Guarantee soft < hard even at clamp boundaries.
    return Object.freeze({
        softBudgetMs: soft,
        hardBudgetMs: Math.max(hard, soft + 60_000),
    });
}
