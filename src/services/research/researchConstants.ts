/**
 * Research Web — Budget Constants
 *
 * Phase 3 port of the two-tier budget pattern introduced in Phase 1 for
 * presentation generation. Research synthesis can run multiple search
 * cycles + extraction + synthesis for deep questions, making 60-300s the
 * normal range and 3-5min the tail. Soft/hard split lets users keep the
 * run going mid-flight instead of being killed silently on a fixed cap.
 */

import type { BudgetPreset } from '../chat/presentationConstants';

export const RESEARCH_SOFT_BUDGET_MS = 180_000;  // 3 min — soft prompt
export const RESEARCH_HARD_BUDGET_MS = 360_000;  // 6 min — hard abort

export const RESEARCH_BUDGET: BudgetPreset = Object.freeze({
    softBudgetMs: RESEARCH_SOFT_BUDGET_MS,
    hardBudgetMs: RESEARCH_HARD_BUDGET_MS,
});
