/**
 * Smart Tag — Budget Helpers
 *
 * Phase 5 port of the two-tier budget pattern. Per plan §13:
 *   softBudget = itemCount × 6s + 60s
 *   hardBudget = itemCount × 12s + 120s
 * Clamped to 60min hard ceiling so pathological invocations (10k-file vault
 * with dense LLM analysis) don't wedge the plugin for hours. Soft floor is
 * 60s so single-file batches still have a reasonable window.
 */

import type { BudgetPreset } from './chat/presentationConstants';

const PER_ITEM_SOFT_MS = 6_000;
const PER_ITEM_HARD_MS = 12_000;
const BASE_SOFT_MS = 60_000;       // 1 min — cold-cache + init overhead
const BASE_HARD_MS = 120_000;      // 2 min — same, with margin
const HARD_CEILING_MS = 3_600_000; // 60 min — absolute cap

/**
 * Compute a per-run BudgetPreset from item count. Linear in item count with
 * a base offset for init overhead and a hard ceiling for sanity.
 */
export function computeSmartTagBudget(itemCount: number): BudgetPreset {
    const safeCount = Math.max(0, Math.floor(itemCount));
    const rawSoft = safeCount * PER_ITEM_SOFT_MS + BASE_SOFT_MS;
    const rawHard = safeCount * PER_ITEM_HARD_MS + BASE_HARD_MS;
    // Hard ceiling applies to both so soft can never exceed hard.
    const hard = Math.min(rawHard, HARD_CEILING_MS);
    // Ensure soft < hard by at least 30s even at clamp boundary.
    const soft = Math.min(rawSoft, Math.max(BASE_SOFT_MS, hard - 30_000));
    return Object.freeze({ softBudgetMs: soft, hardBudgetMs: hard });
}
