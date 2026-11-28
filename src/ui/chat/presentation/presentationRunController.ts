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

/** Proof of holding the lock: an operation releases only the lock it took. */
export type RunToken = object;

export class PresentationRunController {
    private locked = false;
    private owner: RunToken | null = null;
    private abortController: AbortController | null = null;
    private thinkingUpdater: ((msg: string) => void) | null = null;
    private cancelHook: (() => void) | null = null;
    private t: UnifiedChatT | null = null;
    /** Fired on every lock→unlock transition (end() / unlock()) so the handler
     *  can flush work that was queued while a mutating op held the lock — e.g. a
     *  brand re-render requested mid-generation. Registered once; guarded. */
    private onReleaseFn: (() => void) | null = null;

    /** Register the release listener (idempotent — last registration wins). */
    onRelease(fn: () => void): void {
        this.onReleaseFn = fn;
    }

    /** Fire the release listener on a genuine locked→unlocked transition. */
    private fireRelease(wasLocked: boolean): void {
        if (!wasLocked || !this.onReleaseFn) return;
        try { this.onReleaseFn(); } catch { /* release listener must not throw */ }
    }

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

    /** True while `token` is the current holder: false once cancelled or replaced. */
    owns(token: RunToken): boolean {
        return this.owner === token;
    }

    /** Begin an LLM operation: take the lock, mint a fresh AbortController, wire
     *  the thinking sink + i18n. Returns the AbortController so the caller can
     *  pass its signal downstream, and hand back to {@link end}. */
    begin(thinkingUpdater: (msg: string) => void, t: UnifiedChatT): AbortController {
        // TODO(presentation): consider asserting `!this.locked` here + in lock()
        // (re-entrancy guard, Gemini code-gate LOW). Deferred — it's a shared
        // primitive; all callers pre-check via assertNotBusy()/isLocked(), and a
        // throw changes the contract for every presentation flow. Address in a
        // focused follow-up, not the demo-fixes change.
        this.locked = true;
        this.abortController = new AbortController();
        this.owner = this.abortController;
        this.thinkingUpdater = thinkingUpdater;
        this.t = t;
        return this.abortController;
    }

    /**
     * End the operation: release the lock + clear the abort/thinking/i18n handles.
     * An operation passes what `begin` returned, so one that was cancelled and
     * finishes late cannot release its successor's lock. Without an argument it
     * force-releases (user teardown of a wedged run). Idempotent.
     */
    end(owner?: RunToken): void {
        if (owner && owner !== this.owner) return;
        const wasLocked = this.locked;
        this.locked = false;
        this.owner = null;
        this.abortController = null;
        this.thinkingUpdater = null;
        this.t = null;
        this.fireRelease(wasLocked);
    }

    /** Lightweight lock for operations that need mutual exclusion but no
     *  abort/thinking/i18n (export, polish). */
    lock(): RunToken {
        this.locked = true;
        this.owner = {};
        return this.owner;
    }

    /** Release a lock taken by {@link lock}; a stale token releases nothing. */
    unlock(token?: RunToken): void {
        if (token && token !== this.owner) return;
        const wasLocked = this.locked;
        this.locked = false;
        this.owner = null;
        this.fireRelease(wasLocked);
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
