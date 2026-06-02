/**
 * Presentation run controller (TD-SSR-02 Phase 2).
 *
 * Owns the single-flight run lifecycle extracted from PresentationModeHandler:
 * the mutation lock, the per-operation AbortController, the "thinking…" message
 * sink, the active i18n bundle, and the budget-extension cancel hook. Collapses
 * the begin/finally boilerplate that was triplicated across buildPrompt's
 * streaming start, the brand audit, and whole-deck polish.
 *
 * Scope is deliberately the run *lifecycle* only — the progress UI
 * (renderProgress / elapsed ticker / LongRunningOpController) stays with the
 * generation methods it's coupled to, talking to this controller via signal /
 * setThinking / registerCancelHook.
 */

import type { Translations } from '../../../i18n/types';

type UnifiedChatT = Translations['modals']['unifiedChat'];

export class PresentationRunController {
    private locked = false;
    private abortController: AbortController | null = null;
    private thinkingUpdater: ((msg: string) => void) | null = null;
    private cancelHook: (() => void) | null = null;
    private t: UnifiedChatT | null = null;

    /** True while an operation holds the single-flight lock. */
    isLocked(): boolean {
        return this.locked;
    }

    /** The active operation's abort signal, or null when idle. */
    get signal(): AbortSignal | null {
        return this.abortController?.signal ?? null;
    }

    /** The i18n bundle stashed for the active op (so phase labels localise
     *  without threading ctx through every helper). */
    get translations(): UnifiedChatT | null {
        return this.t;
    }

    /** Begin an LLM operation: take the lock, mint a fresh AbortController, wire
     *  the thinking sink + i18n. Returns the AbortController so the caller can
     *  pass its signal downstream. */
    begin(thinkingUpdater: (msg: string) => void, t: UnifiedChatT): AbortController {
        this.locked = true;
        this.abortController = new AbortController();
        this.thinkingUpdater = thinkingUpdater;
        this.t = t;
        return this.abortController;
    }

    /** End the operation: release the lock + clear the abort/thinking/i18n
     *  handles. Idempotent. */
    end(): void {
        this.locked = false;
        this.abortController = null;
        this.thinkingUpdater = null;
        this.t = null;
    }

    /** Lightweight lock for non-streaming operations (export) that need mutual
     *  exclusion but no abort/thinking/i18n. */
    lock(): void {
        this.locked = true;
    }

    unlock(): void {
        this.locked = false;
    }

    /** Bubble a "thinking…" message to the active sink (no-op when idle). */
    setThinking(message: string): void {
        this.thinkingUpdater?.(message);
    }

    /** Register the modal's budget-extension dismiss hook (auto-closed on
     *  completion / hard cap). */
    registerCancelHook(fn: () => void): void {
        this.cancelHook = fn;
    }

    /** Fire + clear the cancel hook, if any. Idempotent. */
    consumeCancelHook(): void {
        if (!this.cancelHook) return;
        const hook = this.cancelHook;
        this.cancelHook = null;
        try { hook(); } catch { /* hook teardown must not throw */ }
    }

    /** Abort the in-flight operation. The caller is responsible for any other
     *  teardown (e.g. closing a modal). Idempotent. */
    abort(): void {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
    }
}
