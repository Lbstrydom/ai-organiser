/**
 * ProgressReporter types
 * ----------------------
 * See docs/plans/progress-reporter.md §4 for full contract.
 *
 * Three delivery surfaces coordinated by one class:
 *   1. Status bar ticket (ambient, passive)  — via StatusBarBroker
 *   2. Notice (persistent, interactive)      — Obsidian's Notice
 *   3. Modal-inline label (host-supplied)    — ProgressHost.getProgressContainer()
 *
 * Terminal states: succeed() | fail(err) | cancel() | timedOut(ms).
 * Reporter owns ALL user-facing toasts; callers MUST NOT fire their own
 * Notice on !r.ok — doing so double-toasts (Gemini-v2-H1).
 */

import type AIOrganiserPlugin from '../../main';
import type { LongRunningOpController } from '../longRunningOp/progressController';

/** Typed phase identifier. Narrow union per flow enforced at call sites. */
export interface ProgressPhase<TKey extends string> {
    key: TKey;
    /** Template substitutions ({name}, {current}, {total}, …). Runtime-validated
     *  by resolvePhase; compile-time param-name safety is out of scope. */
    params?: Readonly<Record<string, string | number>>;
}

/** Map a typed phase to the human-readable i18n string. */
export type PhaseResolver<TKey extends string> = (phase: ProgressPhase<TKey>) => string;

/**
 * A modal that hosts a ProgressReporter's inline surface must implement this.
 * Fixes H5: modal owns the container + its lifecycle; handlers receive the
 * host via constructor/method arg, not via DOM spelunking.
 */
export interface ProgressHost {
    /** Return the container element the reporter renders its inline label
     *  into. Must be a child of the modal's contentEl. */
    getProgressContainer(): HTMLElement;

    /** Register a callback the host fires when the modal closes / detaches.
     *  Reporter uses this to force-switch to the Notice surface so the user
     *  still sees progress if they dismiss mid-operation (H3). Typically
     *  wired into Modal.onClose. Returns an unregister fn. */
    onHostDetach(cb: () => void): () => void;

    /** Optional: return an element where the reporter can mount its Cancel
     *  button (typically the modal footer). When provided + abortController
     *  is set, Cancel is inline in the modal — no Notice Cancel needed.
     *  When omitted/returns null, reporter falls back to rendering a
     *  compact cancel-only Notice so users retain a reachable affordance
     *  (R3-H1). */
    getCancelSlot?(): HTMLElement | null;
}

/** Constructor options for ProgressReporter. */
export interface ProgressReporterOptions<TKey extends string> {
    plugin: AIOrganiserPlugin;
    initialPhase: ProgressPhase<TKey>;
    resolvePhase: PhaseResolver<TKey>;
    /** Optional deterministic total; enables the percent bar. */
    total?: number;
    /** Optional modal host. When provided, reporter uses
     *  host.getProgressContainer() for the inline surface and suppresses
     *  Notice (except as cancel fallback). */
    host?: ProgressHost;
    /** Optional abort controller. Reporter does NOT own it; caller owns
     *  lifecycle. When provided, Cancel button fires abort; abort event
     *  drives reporter to cancelled state. */
    abortController?: AbortController;
    /** Optional soft/hard-budget controller. Reporter listens to
     *  onSoftBudget for advisory line and onHardBudget for timed-out
     *  terminal. Reporter does NOT dispose the budget (M1). */
    budget?: LongRunningOpController;
    /** Default true on desktop, auto-false on mobile / when
     *  plugin.busyStatusBarEl is null. */
    showStatusBar?: boolean;
}
