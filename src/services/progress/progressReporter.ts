/**
 * ProgressReporter
 * ----------------
 * One class, three surfaces, coordinated lifecycle. See
 * docs/plans/progress-reporter.md §4 for the full contract.
 *
 * Surfaces (Gestalt Common Fate — all re-render together):
 *   - Status bar ticket (passive ambient signal)
 *   - Notice (persistent, interactive, stable-DOM mutated in place)
 *   - Modal-inline (when host is supplied; Notice suppressed except for
 *     cancel-reachability fallback if host has no cancel slot)
 *
 * Terminal states: succeed() | fail(err) | cancel() | timedOut(ms).
 * Dispose is idempotent and drains internal listeners/timers.
 */

import { Notice } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { logger } from '../../utils/logger';
import type { LongRunningOpController } from '../longRunningOp/progressController';
import type {
    ProgressPhase,
    ProgressHost,
    ProgressReporterOptions,
    PhaseResolver,
} from './types';
import { statusBarBroker, type StatusBarTicket } from './statusBarBroker';

const HEARTBEAT_MS = 30 * 1000;
const ELAPSED_TICK_MS = 1000;
const CANCEL_NOTICE_MS = 3000;
const ERROR_NOTICE_MS = 5000;

type TerminalState = 'none' | 'succeeded' | 'failed' | 'cancelled' | 'timedOut' | 'disposed';

/** Normalize any thrown value (Error, string, bare object, null, etc.) to a
 *  non-empty human-readable string. Fallback is i18n-resolved; callers pass
 *  the translated string so users see it in their interface language. */
export function normalizeError(err: unknown, unknownFallback: string): string {
    if (err instanceof Error) return err.message || unknownFallback;
    if (typeof err === 'string' && err.length > 0) return err;
    try {
        const s = String(err);
        return s && s !== 'null' && s !== 'undefined' ? s : unknownFallback;
    } catch {
        return unknownFallback;
    }
}

export class ProgressReporter<TKey extends string> {
    readonly signal: AbortSignal;

    private readonly plugin: AIOrganiserPlugin;
    private readonly resolvePhase: PhaseResolver<TKey>;
    private readonly total: number | undefined;
    private readonly host: ProgressHost | undefined;
    private readonly abortController: AbortController | undefined;
    private readonly budget: LongRunningOpController | undefined;
    private readonly showStatusBar: boolean;

    private currentPhaseValue: ProgressPhase<TKey>;
    private currentProgress = 0;
    private state: TerminalState = 'none';
    private timedOutFlag = false;

    private notice: Notice | null = null;
    private noticeDom: StableNoticeDom | null = null;
    private inlineDom: StableInlineDom | null = null;
    private ticket: StatusBarTicket | null = null;
    private elapsedTicker: ReturnType<typeof setInterval> | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private startedAt: number;

    private disposables: Array<() => void> = [];

    constructor(options: ProgressReporterOptions<TKey>) {
        this.plugin = options.plugin;
        this.resolvePhase = options.resolvePhase;
        this.total = options.total;
        this.host = options.host;
        this.abortController = options.abortController;
        this.budget = options.budget;
        this.showStatusBar = options.showStatusBar !== false;
        this.startedAt = Date.now();
        this.currentPhaseValue = options.initialPhase;

        this.signal = this.abortController?.signal ?? neverAbortSignal();

        if (this.abortController) {
            const onAbort = (): void => this.handleSignalAbort();
            this.abortController.signal.addEventListener('abort', onAbort, { once: true });
            this.disposables.push(() => this.abortController?.signal.removeEventListener('abort', onAbort));
        }

        // Budget integration: LongRunningOpController does not expose
        // setters for onSoftBudget / onHardBudget after construction, so
        // callers must wire these when constructing the controller. The
        // reporter exposes `showSoftBudgetAdvisory(elapsed)` + `markTimedOut()`
        // as public helpers the caller's budget-config closure calls.
        //
        // Convention: caller does something like —
        //   const reporter = new ProgressReporter<Phase>({ ..., budget });
        //   const budget = new LongRunningOpController({
        //       abortController,
        //       softBudgetMs, hardBudgetMs,
        //       onSoftBudget: (ms) => reporter.showSoftBudgetAdvisory(ms),
        //       onHardBudget: () => reporter.markTimedOut(),
        //   });
        // (The circular-initialization is avoided by constructing the
        // reporter first with budget:undefined and budget after with the
        // handlers wired; or by a small factory helper.)
        void this.budget;

        this.mount();
        this.startHeartbeat();
    }

    get currentPhase(): Readonly<ProgressPhase<TKey>> {
        return this.currentPhaseValue;
    }

    setPhase(phase: ProgressPhase<TKey>): void {
        if (this.isTerminal()) {
            logger.debug('ProgressReporter', `setPhase(${phase.key}) ignored after terminal state ${this.state}`);
            return;
        }
        this.currentPhaseValue = phase;
        this.renderPhaseText();
        this.ticket?.update(this.resolveText());
    }

    recordProgress(current: number): void {
        if (this.isTerminal()) return;
        if (!Number.isFinite(current) || current < 0) return;
        const safe = Math.floor(current);
        if (safe === this.currentProgress) return;
        this.currentProgress = safe;
        this.renderProgressBar();
    }

    succeed(): void {
        if (this.isTerminal()) return;
        this.state = 'succeeded';
        this.teardown();
    }

    fail(err: unknown): void {
        if (this.isTerminal()) return;
        this.state = 'failed';
        const t = this.plugin.t?.progress;
        const unknown = t?.unknownError || 'Unknown error';
        const msg = normalizeError(err, unknown);
        this.teardown();
        const failedPrefix = t?.failedPrefix || 'Failed';
        new Notice(`${failedPrefix}: ${msg}`, ERROR_NOTICE_MS);
    }

    cancel(): void {
        if (this.isTerminal()) return;
        this.state = 'cancelled';
        this.teardown();
        const t = this.plugin.t?.progress;
        const msg = t?.cancelled || 'Cancelled';
        new Notice(msg, CANCEL_NOTICE_MS);
    }

    timedOut(elapsedMs: number): void {
        if (this.isTerminal()) return;
        this.state = 'timedOut';
        this.teardown();
        const t = this.plugin.t?.progress;
        const tmpl = t?.timedOut || 'Timed out after {duration}';
        const duration = formatDuration(elapsedMs);
        new Notice(tmpl.replace('{duration}', duration), ERROR_NOTICE_MS);
    }

    dispose(): void {
        if (this.state === 'disposed') return;
        this.teardown();
        this.state = 'disposed';
    }

    /** Called by the caller's budget-config closure on soft-budget fire.
     *  Renders the "Still working…" advisory line on active surfaces. */
    showSoftBudgetAdvisory(elapsedMs: number): void {
        if (this.isTerminal()) return;
        this.renderSoftBudgetAdvisory(elapsedMs);
    }

    /** Called by the caller's budget-config closure on hard-budget fire.
     *  Sets an internal flag so the signal-abort listener routes to
     *  timedOut() instead of cancel() when the budget propagates its
     *  abort. Gemini-v3-M2 fix. */
    markTimedOut(): void {
        this.timedOutFlag = true;
    }

    // ── Internal ────────────────────────────────────────────────────────────

    private isTerminal(): boolean {
        return this.state !== 'none';
    }

    private resolveText(): string {
        try {
            return this.resolvePhase(this.currentPhaseValue);
        } catch (e) {
            logger.error('ProgressReporter', 'resolvePhase threw', e);
            return this.currentPhaseValue.key;
        }
    }

    private mount(): void {
        const useHost = this.host && this.host.getProgressContainer().isConnected;

        if (this.showStatusBar && this.plugin.busyStatusBarEl) {
            this.ticket = statusBarBroker.acquire(this.plugin, this.resolveText());
        }

        if (useHost && this.host) {
            this.mountInline(this.host);
        } else {
            this.mountNotice();
        }
    }

    private mountInline(host: ProgressHost): void {
        const container = host.getProgressContainer();
        container.empty();
        container.addClass('ai-organiser-progress-inline');

        const phaseEl = container.createSpan({ cls: 'ai-organiser-progress-phase-text', text: this.resolveText() });
        phaseEl.setAttr('role', 'status');
        phaseEl.setAttr('aria-live', 'polite');

        const elapsedEl = container.createSpan({ cls: 'ai-organiser-progress-elapsed', text: '· 0:00' });
        elapsedEl.setAttr('aria-live', 'off');

        const advisoryEl = container.createSpan({ cls: 'ai-organiser-progress-advisory' });
        advisoryEl.setAttr('aria-live', 'polite');

        const barEl = this.total !== undefined ? this.buildProgressBar(container) : null;

        const dom: StableInlineDom = { container, phaseEl, elapsedEl, advisoryEl, barEl };
        this.inlineDom = dom;
        container.setAttr('data-ai-organiser-reporter', '1');

        const unregisterDetach = host.onHostDetach(() => this.handleHostDetach());
        this.disposables.push(unregisterDetach);

        const parent = container.parentElement;
        if (parent) {
            const observer = new MutationObserver(() => {
                if (!container.isConnected) this.handleHostDetach();
            });
            observer.observe(parent, { childList: true, subtree: false });
            this.disposables.push(() => observer.disconnect());
        }

        this.elapsedTicker = setInterval(() => this.tickElapsed(), ELAPSED_TICK_MS);
        this.disposables.push(() => {
            if (this.elapsedTicker) clearInterval(this.elapsedTicker);
            this.elapsedTicker = null;
        });

        const cancelSlot = host.getCancelSlot?.();
        if (cancelSlot && this.abortController) {
            this.mountCancelButton(cancelSlot);
        } else if (this.abortController) {
            // Fallback: host has no cancel slot — mount a compact cancel-only
            // Notice so users retain a cancel affordance (§5).
            this.mountCancelOnlyNotice();
        }
    }

    private mountNotice(): void {
        this.notice = new Notice('', 0);
        const messageEl = this.notice.messageEl;
        if (!messageEl) return;
        messageEl.empty();
        messageEl.addClass('ai-organiser-progress-notice');

        const phaseEl = messageEl.createSpan({ cls: 'ai-organiser-progress-phase-text', text: this.resolveText() });
        phaseEl.setAttr('role', 'status');
        phaseEl.setAttr('aria-live', 'polite');

        const advisoryEl = messageEl.createSpan({ cls: 'ai-organiser-progress-advisory' });
        advisoryEl.setAttr('aria-live', 'polite');

        const barEl = this.total !== undefined ? this.buildProgressBar(messageEl) : null;

        let cancelBtn: HTMLButtonElement | null = null;
        if (this.abortController) {
            cancelBtn = messageEl.createEl('button', {
                cls: 'ai-organiser-progress-cancel-btn mod-warning',
                text: this.plugin.t?.progress?.cancelButton || 'Cancel',
            });
            const onClick = (evt: MouseEvent): void => {
                evt.stopPropagation();
                this.abortController?.abort();
            };
            cancelBtn.addEventListener('click', onClick);
            this.disposables.push(() => cancelBtn?.removeEventListener('click', onClick));
        }

        // Protect against accidental dismiss: Obsidian's Notice dismisses on
        // any body click. Stop propagation on the messageEl so missed clicks
        // don't silently lose the UI while the op continues. (Gemini-H1.)
        const onMsgClick = (evt: MouseEvent): void => { evt.stopPropagation(); };
        messageEl.addEventListener('click', onMsgClick);
        this.disposables.push(() => messageEl.removeEventListener('click', onMsgClick));

        // Detect out-of-band dismiss (Obsidian's Notice.hide() or manual
        // removal of the DOM node) and transition to cancelled. We watch
        // messageEl.parentElement (the Notice's root container) since
        // Obsidian deprecated direct `.noticeEl` access in 1.8+.
        const noticeRoot = messageEl.parentElement;
        const noticeContainer = noticeRoot?.parentElement;
        if (noticeRoot && noticeContainer) {
            const observer = new MutationObserver(() => {
                if (!noticeRoot.isConnected && !this.isTerminal()) this.handleOutOfBandDismiss();
            });
            observer.observe(noticeContainer, { childList: true, subtree: false });
            this.disposables.push(() => observer.disconnect());
        }

        this.noticeDom = { messageEl, phaseEl, advisoryEl, barEl, cancelBtn };
    }

    private mountCancelOnlyNotice(): void {
        // Minimal Notice shown when host lacks cancel slot. Not full phase
        // display — just a reachable Cancel action.
        this.notice = new Notice('', 0);
        const messageEl = this.notice.messageEl;
        if (!messageEl) return;
        messageEl.empty();
        messageEl.addClass('ai-organiser-progress-notice');
        messageEl.addClass('ai-organiser-progress-notice-compact');

        const label = messageEl.createSpan({
            text: this.plugin.t?.progress?.cancelPrompt || 'Cancel current operation?',
        });
        void label;

        const cancelBtn = messageEl.createEl('button', {
            cls: 'ai-organiser-progress-cancel-btn mod-warning',
            text: this.plugin.t?.progress?.cancelButton || 'Cancel',
        });
        const onClick = (evt: MouseEvent): void => {
            evt.stopPropagation();
            this.abortController?.abort();
        };
        cancelBtn.addEventListener('click', onClick);
        this.disposables.push(() => cancelBtn.removeEventListener('click', onClick));

        const onMsgClick = (evt: MouseEvent): void => { evt.stopPropagation(); };
        messageEl.addEventListener('click', onMsgClick);
        this.disposables.push(() => messageEl.removeEventListener('click', onMsgClick));
    }

    private mountCancelButton(slot: HTMLElement): void {
        const cancelBtn = slot.createEl('button', {
            cls: 'ai-organiser-progress-cancel-btn mod-warning',
            text: this.plugin.t?.progress?.cancelButton || 'Cancel',
        });
        const onClick = (evt: MouseEvent): void => {
            evt.stopPropagation();
            this.abortController?.abort();
        };
        cancelBtn.addEventListener('click', onClick);
        this.disposables.push(() => {
            cancelBtn.removeEventListener('click', onClick);
            cancelBtn.remove();
        });
    }

    private buildProgressBar(parent: HTMLElement): HTMLElement {
        const barEl = parent.createDiv({ cls: 'ai-organiser-progress-bar' });
        const fill = barEl.createDiv({ cls: 'ai-organiser-progress-bar-fill' });
        fill.setAttr('role', 'progressbar');
        fill.setAttr('aria-valuemin', '0');
        fill.setAttr('aria-valuemax', String(this.total ?? 0));
        fill.setAttr('aria-valuenow', '0');
        return barEl;
    }

    private renderPhaseText(): void {
        const text = this.resolveText();
        if (this.inlineDom) this.inlineDom.phaseEl.setText(text);
        if (this.noticeDom) this.noticeDom.phaseEl.setText(text);
    }

    private renderProgressBar(): void {
        if (this.total === undefined) return;
        const pct = this.total > 0 ? Math.min(100, Math.round((this.currentProgress / this.total) * 100)) : 0;
        const updateBar = (barEl: HTMLElement | null): void => {
            if (!barEl) return;
            const fill = barEl.querySelector<HTMLElement>('.ai-organiser-progress-bar-fill');
            if (!fill) return;
            fill.setCssProps({ '--ai-organiser-progress-width': `${pct}%` });
            fill.setAttr('aria-valuenow', String(this.currentProgress));
        };
        updateBar(this.inlineDom?.barEl ?? null);
        updateBar(this.noticeDom?.barEl ?? null);
    }

    private renderSoftBudgetAdvisory(elapsedMs: number): void {
        const t = this.plugin.t?.progress;
        const tmpl = t?.stillWorking || 'Still working… ({duration} elapsed)';
        const text = tmpl.replace('{duration}', formatDuration(elapsedMs));
        const show = (el: HTMLElement | undefined): void => {
            if (!el) return;
            el.setText(text);
            el.addClass('is-visible');
        };
        show(this.inlineDom?.advisoryEl);
        show(this.noticeDom?.advisoryEl);
    }

    private tickElapsed(): void {
        if (!this.inlineDom) return;
        const elapsed = Date.now() - this.startedAt;
        this.inlineDom.elapsedEl.setText(`· ${formatDuration(elapsed)}`);
    }

    private startHeartbeat(): void {
        this.heartbeatTimer = setInterval(() => {
            if (this.isTerminal()) return;
            this.ticket?.heartbeat();
        }, HEARTBEAT_MS);
        this.disposables.push(() => {
            if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        });
    }

    private handleSignalAbort(): void {
        if (this.isTerminal()) return;
        if (this.timedOutFlag) {
            this.timedOut(Date.now() - this.startedAt);
        } else {
            this.cancel();
        }
    }

    private handleHostDetach(): void {
        if (this.isTerminal()) return;
        if (this.inlineDom) {
            try { this.inlineDom.container.empty(); } catch { /* noop */ }
            try { this.inlineDom.container.removeAttribute('data-ai-organiser-reporter'); } catch { /* noop */ }
            this.inlineDom = null;
        }
        if (!this.notice) this.mountNotice();
    }

    private handleOutOfBandDismiss(): void {
        if (this.abortController && !this.abortController.signal.aborted) {
            this.abortController.abort();
            return;
        }
        this.cancel();
    }

    private teardown(): void {
        for (const fn of this.disposables) {
            try { fn(); } catch (e) { logger.debug('ProgressReporter', 'disposable threw', e); }
        }
        this.disposables = [];

        try { this.notice?.hide(); } catch { /* noop */ }
        this.notice = null;
        this.noticeDom = null;

        if (this.inlineDom) {
            try { this.inlineDom.container.empty(); } catch { /* noop */ }
            try { this.inlineDom.container.removeAttribute('data-ai-organiser-reporter'); } catch { /* noop */ }
            this.inlineDom = null;
        }

        try { this.ticket?.release(); } catch { /* noop */ }
        this.ticket = null;
    }
}

// ── DOM bundles ─────────────────────────────────────────────────────────────

interface StableNoticeDom {
    messageEl: HTMLElement;
    phaseEl: HTMLElement;
    advisoryEl: HTMLElement;
    barEl: HTMLElement | null;
    cancelBtn: HTMLButtonElement | null;
}

interface StableInlineDom {
    container: HTMLElement;
    phaseEl: HTMLElement;
    elapsedEl: HTMLElement;
    advisoryEl: HTMLElement;
    barEl: HTMLElement | null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function neverAbortSignal(): AbortSignal {
    return new AbortController().signal;
}
