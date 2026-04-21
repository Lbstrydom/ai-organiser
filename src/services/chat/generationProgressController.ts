/**
 * Generation Progress Controller — BACKWARD-COMPAT SHIM
 *
 * As of Phase 2 (plan §10) the real implementation lives in
 * `src/services/longRunningOp/progressController.ts` under the generic
 * name `LongRunningOpController`. This file adapts the presentation-era
 * name/API surface for call sites that haven't migrated yet.
 *
 * New code should import from `longRunningOp/progressController` directly.
 */

import {
    LongRunningOpController,
} from '../longRunningOp/progressController';
import type {
    LongRunningOpOptions,
} from '../longRunningOp/types';

export { parseCountFromPrompt } from '../longRunningOp/progressController';

// ── Name adapters ───────────────────────────────────────────────────────────
// These types/class are retained for any external consumer still on the
// presentation-era names. Internal code uses LongRunningOp directly.

export interface GenerationProgressCallbacks {
    /** Legacy callback — forwarded to `onProgress` on the generic controller.
     *  Kept on this shim because the whole module is a backward-compat layer
     *  for the presentation-era name (see file header). New code should use
     *  `LongRunningOpController.onProgress` directly. */
    onSlideUpdate?: (current: number, expected: number | undefined, elapsedMs: number) => void;
    onSoftBudget?: (elapsedMs: number) => void | Promise<void>;
    onHardBudget?: (elapsedMs: number) => void;
    onDispose?: () => void;
}

export interface GenerationProgressOptions extends GenerationProgressCallbacks {
    softBudgetMs: number;
    hardBudgetMs: number;
    expected?: number;
    abortController: AbortController;
    now?: () => number;
}

/**
 * Forwards to `LongRunningOpController`, translating the old
 * `onSlideUpdate` callback + `recordCheckpoint` method to the new
 * `onProgress` + `recordProgress` names. New code should import
 * `LongRunningOpController` directly.
 */
export class GenerationProgressController {
    private readonly inner: LongRunningOpController;

    constructor(options: GenerationProgressOptions) {
        const adapted: LongRunningOpOptions = {
            softBudgetMs: options.softBudgetMs,
            hardBudgetMs: options.hardBudgetMs,
            expected: options.expected,
            abortController: options.abortController,
            now: options.now,
            onProgress: options.onSlideUpdate,
            onSoftBudget: options.onSoftBudget,
            onHardBudget: options.onHardBudget,
            onDispose: options.onDispose,
        };
        this.inner = new LongRunningOpController(adapted);
    }

    recordCheckpoint(slideCount: number): void { this.inner.recordProgress(slideCount); }
    getElapsedMs(): number { return this.inner.getElapsedMs(); }
    getLastSlideCount(): number { return this.inner.getLastProgress(); }
    isSoftBudgetFired(): boolean { return this.inner.isSoftBudgetFired(); }
    setExtendCardCancelHook(fn: () => void): void { this.inner.setExtendCardCancelHook(fn); }
    dispose(): void { this.inner.dispose(); }
}

/**
 * Presentation-specific prompt parser — retained here for backward compat.
 * Internally built on the generic `parseCountFromPrompt` helper.
 */
export function parseExpectedSlideCount(prompt: string, fallback = 8): number {
    const pattern = /\b(\d+)[-\s]?slides?\b/i;
    // Inline to avoid second import path; identical to
    // longRunningOp/parseCountFromPrompt(prompt, pattern, fallback, 50).
    const m = pattern.exec(prompt);
    const n = m ? Number.parseInt(m[1], 10) : fallback;
    if (!Number.isFinite(n)) return fallback;
    return Math.max(1, Math.min(n, 50));
}
