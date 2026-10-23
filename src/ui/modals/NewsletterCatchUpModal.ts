/**
 * NewsletterCatchUpModal — one window for "catch me up".
 *
 * A thin renderer: every decision about WHICH state to show lives in the pure
 * `deriveModalView`, every decision about WHAT happens when a button is pressed lives in
 * `catchUpService`. This class owns only the DOM and the buttons.
 *
 * Spend is always previewed: the window shows days, newsletters, the length limit and the
 * voice estimate before Generate does anything. Closing the window does not cancel a run that
 * has started (the progress reporter keeps showing it and keeps Cancel reachable).
 */

import { Modal, Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { err, type Result } from '../../core/result';
import { describeError, formatGuidance } from '../../core/friendlyErrors';
import { withProgressResult } from '../../services/progress';
import type { ProgressHost } from '../../services/progress/types';
import { buildCatchUpSnapshot, type CatchUpSnapshot } from '../../services/newsletter/catchUp/catchUpSelection';
import {
    classifyOperation,
    discardOperation,
    resumeCatchUp,
    runCatchUp,
    type EpisodeResult,
    type OverrunChoice,
    type RunOptions,
    type RunPhase,
} from '../../services/newsletter/catchUp/catchUpService';
import { createCatchUpPorts, previewCost } from '../../services/newsletter/catchUp/catchUpRuntime';
import { markEpisodeListened } from '../../services/newsletter/catchUp/catchUpListen';
import { availabilityOf, deriveModalView, type ModalView } from '../../services/newsletter/catchUp/catchUpModalState';
import { datesBetween, formatDates, formatPendingSummary } from '../../services/newsletter/catchUp/catchUpFormat';
import { CATCHUP_BIG_THRESHOLD_DAYS, type EpisodeMeta } from '../../services/newsletter/catchUp/catchUpTypes';
import { listen } from '../utils/domUtils';
import { logger } from '../../utils/logger';

type PhaseKey = 'freezing' | 'writingScript' | 'shorteningScript' | 'synthesising' | 'saving';

export class NewsletterCatchUpModal extends Modal implements ProgressHost {
    private view: ModalView | null = null;
    private snapshot: CatchUpSnapshot | null = null;
    private running = false;
    private cleanups: Array<() => void> = [];
    private detachCallbacks: Array<() => void> = [];
    private progressEl: HTMLElement | null = null;
    private cancelSlot: HTMLElement | null = null;
    private banner: { text: string; tone: 'info' | 'warn' } | null = null;
    private overrunResolver: ((choice: OverrunChoice) => void) | null = null;
    private includeAgainDates: string[] | null = null;
    private closed = false;
    private refreshSeq = 0;

    constructor(private readonly plugin: AIOrganiserPlugin) {
        super(plugin.app);
    }

    // ── ProgressHost ─────────────────────────────────────────────────────────

    getProgressContainer(): HTMLElement {
        return this.progressEl ?? this.contentEl;
    }

    onHostDetach(cb: () => void): () => void {
        this.detachCallbacks.push(cb);
        return () => { this.detachCallbacks = this.detachCallbacks.filter((c) => c !== cb); };
    }

    getCancelSlot(): HTMLElement | null {
        return this.cancelSlot;
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    onOpen(): void {
        this.closed = false;
        this.modalEl.addClass('ai-organiser-catchup-modal');
        this.modalEl.setAttribute('role', 'dialog');
        this.modalEl.setAttribute('aria-label', this.plugin.t.modals.newsletterCatchUp.title);
        this.renderLoading();
        void this.refresh();
    }

    onClose(): void {
        this.closed = true;
        // A pending overrun question is answered "cancel": nobody is left to answer it.
        this.overrunResolver?.('cancel');
        this.overrunResolver = null;
        for (const cb of this.detachCallbacks) cb();
        this.detachCallbacks = [];
        this.disposeListeners();
        this.contentEl.empty();
    }

    private disposeListeners(): void {
        for (const c of this.cleanups) c();
        this.cleanups = [];
    }

    // ── Data ─────────────────────────────────────────────────────────────────

    /** One validity rule for a read's success AND failure: closed, superseded or mid-operation reads are dropped. */
    private isCurrentRefresh(request: number): boolean {
        return !this.closed && request === this.refreshSeq && !this.running;
    }

    private async refresh(): Promise<void> {
        const request = ++this.refreshSeq;
        try {
            const ports = createCatchUpPorts(this.plugin);
            const [snapshot, operation] = await Promise.all([
                buildCatchUpSnapshot({
                    app: this.app, plugin: this.plugin, settings: this.plugin.settings,
                    forceDates: this.includeAgainDates ?? undefined,
                }),
                classifyOperation(ports),
            ]);
            // A slower, older read must never replace a newer one, or an operation in flight.
            if (!this.isCurrentRefresh(request)) return;
            this.snapshot = snapshot;
            this.view = deriveModalView({ availability: availabilityOf(this.plugin.settings), snapshot, operation });
            this.render();
        } catch (e) {
            logger.error('Newsletter', 'Catch-up window failed to load', e);
            if (!this.isCurrentRefresh(request)) return;
            this.banner = { text: formatGuidance(describeError(this.plugin.t, 'unknown')), tone: 'warn' };
            this.contentEl.empty();
            this.renderHeader();
            this.renderBanner();
            this.renderCloseOnly();
        }
    }

    // ── Rendering ────────────────────────────────────────────────────────────

    private renderLoading(): void {
        this.contentEl.empty();
        this.renderHeader();
        const p = this.contentEl.createEl('p', { text: this.plugin.t.modals.newsletterCatchUp.loading });
        p.setAttribute('aria-live', 'polite');
    }

    private renderHeader(): void {
        this.contentEl.createEl('h2', { text: this.plugin.t.modals.newsletterCatchUp.title });
    }

    private renderBanner(): void {
        if (!this.banner) return;
        const el = this.contentEl.createDiv({ cls: `ai-organiser-catchup-banner is-${this.banner.tone}` });
        el.setAttribute('role', 'status');
        el.setText(this.banner.text);
    }

    private render(): void {
        this.disposeListeners();
        this.contentEl.empty();
        this.renderHeader();
        this.renderBanner();
        const view = this.view;
        if (!view) return;

        switch (view.kind) {
            case 'unavailable': return this.renderUnavailable(view.reason);
            case 'resume': return this.renderResume(view);
            case 'pending': return this.renderPending(view);
            case 'caught-up': return this.renderCaughtUp(view);
            case 'gap': return this.renderGap(view);
            case 'unresolved-only': return this.renderUnresolvedOnly(view);
        }
    }

    private note(text: string, cls = ''): HTMLElement {
        return this.contentEl.createEl('p', { text, cls: `ai-organiser-catchup-note ${cls}`.trim() });
    }

    private renderUnavailable(reason: 'audio-off' | 'wrong-mode'): void {
        const m = this.plugin.t.modals.newsletterCatchUp;
        if (reason === 'wrong-mode') this.contentEl.createEl('h3', { text: m.wrongModeTitle });
        this.note(reason === 'wrong-mode' ? m.wrongModeBody : m.audioOffBody);
        const footer = this.footer();
        this.button(footer, m.switchMode, () => { this.close(); this.openSettings(); }, true);
        this.button(footer, m.close, () => this.close());
    }

    private openSettings(): void {
        const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
        try {
            setting?.open();
            setting?.openTabById(this.plugin.manifest.id);
        } catch (e) {
            logger.warn('Newsletter', 'Could not open settings from the catch-up window', e);
        }
    }

    /** Notes common to every state: days with nothing stored, expiry, the unheard warning. */
    private renderCommon(view: Exclude<ModalView, { kind: 'unavailable' }>, opts: { unheardWarning: boolean }): void {
        const m = this.plugin.t.modals.newsletterCatchUp;
        if (view.noStoredDates.length > 0) this.note(m.noStored.replace('{dates}', formatDates(view.noStoredDates)));
        if (view.expiringDates.length > 0) this.note(m.expiring.replace('{dates}', formatDates(view.expiringDates)), 'is-warn');
        if (opts.unheardWarning && view.unheard) this.renderUnheard(view.unheard.episode);
    }

    private renderUnheard(episode: EpisodeMeta): void {
        const m = this.plugin.t.modals.newsletterCatchUp;
        const box = this.contentEl.createDiv({ cls: 'ai-organiser-catchup-unheard' });
        box.createEl('strong', { text: m.unheardTitle });
        const range = episode.from === episode.to ? episode.to : `${episode.from} → ${episode.to}`;
        box.createEl('p', { text: m.unheardBody.replace('{range}', range) });
        const row = box.createDiv({ cls: 'ai-organiser-catchup-actions' });
        this.button(row, m.openEpisode, () => { void this.app.workspace.openLinkText(episode.notePath, '', false); });
        this.button(row, m.markListened, () => { void this.markListened(episode); });
    }

    private renderPending(view: Extract<ModalView, { kind: 'pending' }>): void {
        const m = this.plugin.t.modals.newsletterCatchUp;
        const summary = formatPendingSummary(this.plugin.t, view.days, view.newsletters);
        this.contentEl.createEl('p', { text: m.pendingLine.replace('{summary}', summary), cls: 'ai-organiser-catchup-summary' });
        this.note(view.from === view.to ? m.coversOne.replace('{date}', view.from) : m.covers.replace('{from}', view.from).replace('{to}', view.to));
        if (view.unresolvedDates.length > 0) this.note(m.unresolved.replace('{dates}', formatDates(view.unresolvedDates)), 'is-warn');
        this.renderCommon(view, { unheardWarning: true });

        // Length and cost: previewed before any spend.
        const lengthText = (view.big ? m.lengthLineBig : m.lengthLine).replace('{mins}', String(view.capMinutes)).replace('{days}', String(CATCHUP_BIG_THRESHOLD_DAYS));
        this.note(lengthText);
        new Setting(this.contentEl)
            .setName(m.ceilingLabel)
            .addDropdown((drop) => {
                for (const v of [5, 10, 15, 20]) drop.addOption(String(v), `${v} min`);
                drop.setValue(String(nearestCeiling(this.plugin.settings.newsletterCatchUpMaxMins)));
                drop.onChange((value) => {
                    this.plugin.settings.newsletterCatchUpMaxMins = Number(value);
                    void this.plugin.saveSettings().then(() => this.refresh());
                });
            });
        const cost = previewCost(this.plugin, view.capMinutes);
        this.note(cost.ttsUsd === null ? m.costAzure : m.costTts.replace('{usd}', cost.ttsUsd.toFixed(2)));
        this.note(m.costNote, 'is-muted');

        const footer = this.footer();
        const generate = this.button(footer, m.generate, () => { void this.generate(view.planHash); }, true);
        this.button(footer, m.close, () => this.close());
        queueMicrotask(() => generate.focus());
    }

    private renderResume(view: Extract<ModalView, { kind: 'resume' }>): void {
        const m = this.plugin.t.modals.newsletterCatchUp;
        this.contentEl.createEl('h3', { text: m.resumeTitle });
        this.note(view.phase === 'audio-ready' ? m.resumeAudioReady : m.resumeScripted);
        this.note(m.resumeRange.replace('{from}', view.from).replace('{to}', view.to));
        const footer = this.footer();
        this.button(footer, view.action === 'finish-saving' ? m.finishSaving : m.resume, () => { void this.resume(); }, true);
        this.button(footer, m.startOver, () => { void this.discard(); });
        this.button(footer, m.discard, () => { void this.discard(true); });
    }

    private renderCaughtUp(view: Extract<ModalView, { kind: 'caught-up' }>): void {
        const m = this.plugin.t.modals.newsletterCatchUp;
        this.note(m.caughtUp.replace('{date}', view.through));
        this.renderCommon(view, { unheardWarning: true });
        this.renderReplayRow(view.latestEpisode);
    }

    private renderGap(view: Extract<ModalView, { kind: 'gap' }>): void {
        const m = this.plugin.t.modals.newsletterCatchUp;
        this.note(m.gap.replace('{date}', view.lastEpisodeTo));
        this.renderCommon(view, { unheardWarning: true });
        this.renderReplayRow(view.latestEpisode);
    }

    private renderUnresolvedOnly(view: Extract<ModalView, { kind: 'unresolved-only' }>): void {
        const m = this.plugin.t.modals.newsletterCatchUp;
        this.note(m.unresolvedOnly.replace('{dates}', formatDates(view.unresolvedDates)), 'is-warn');
        this.renderCommon(view, { unheardWarning: true });
        this.renderReplayRow(view.latestEpisode);
    }

    /** Nothing pending: Generate is absent, but replaying and remaking stay reachable. */
    private renderReplayRow(latest: { notePath: string; from: string; to: string } | null): void {
        const m = this.plugin.t.modals.newsletterCatchUp;
        const footer = this.footer();
        if (latest) {
            this.button(footer, m.replayLatest, () => { void this.app.workspace.openLinkText(latest.notePath, '', false); });
            this.button(footer, m.includeAgain, () => {
                this.includeAgainDates = datesBetween(latest.from, latest.to);
                this.banner = null;
                void this.refresh();
            });
        }
        this.button(footer, m.close, () => this.close());
    }

    private renderCloseOnly(): void {
        const footer = this.footer();
        this.button(footer, this.plugin.t.modals.newsletterCatchUp.close, () => this.close());
    }

    private renderRunning(): void {
        const m = this.plugin.t.modals.newsletterCatchUp;
        this.disposeListeners();
        this.contentEl.empty();
        this.renderHeader();
        this.progressEl = this.contentEl.createDiv({ cls: 'ai-organiser-catchup-progress' });
        this.progressEl.setAttribute('aria-live', 'polite');
        this.progressEl.setText(m.running);
        this.cancelSlot = this.contentEl.createDiv({ cls: 'ai-organiser-catchup-actions' });
    }

    private renderOverrun(info: { estimatedMinutes: number; capMinutes: number }): Promise<OverrunChoice> {
        if (this.closed) return Promise.resolve('cancel');
        const m = this.plugin.t.modals.newsletterCatchUp;
        this.disposeListeners();
        this.contentEl.empty();
        this.renderHeader();
        this.contentEl.createEl('h3', { text: m.overrunTitle });
        this.note(m.overrunBody.replace('{estimated}', String(info.estimatedMinutes)).replace('{cap}', String(info.capMinutes)));
        return new Promise<OverrunChoice>((resolve) => {
            this.overrunResolver = (choice) => { this.overrunResolver = null; resolve(choice); };
            const footer = this.footer();
            this.button(footer, m.shortenAgain, () => { this.overrunResolver?.('shorten'); this.renderRunning(); }, true);
            this.button(footer, m.continueAnyway, () => { this.overrunResolver?.('continue'); this.renderRunning(); });
            this.button(footer, m.cancel, () => { this.overrunResolver?.('cancel'); });
        });
    }

    // ── Small DOM helpers ────────────────────────────────────────────────────

    private footer(): HTMLElement {
        return this.contentEl.createDiv({ cls: 'ai-organiser-catchup-actions' });
    }

    private button(parent: HTMLElement, text: string, onClick: () => void, cta = false): HTMLButtonElement {
        const btn = parent.createEl('button', { text, cls: cta ? 'mod-cta' : '' });
        btn.type = 'button';
        this.cleanups.push(listen(btn, 'click', onClick));
        return btn;
    }

    // ── Actions ──────────────────────────────────────────────────────────────

    private async markListened(episode: EpisodeMeta): Promise<void> {
        const res = await markEpisodeListened({ app: this.app, plugin: this.plugin, settings: this.plugin.settings }, episode);
        if (!res.ok) {
            this.banner = { text: formatGuidance(describeError(this.plugin.t, 'unknown')), tone: 'warn' };
        } else {
            this.banner = { text: this.plugin.t.modals.newsletterCatchUp.markedListened, tone: 'info' };
        }
        this.plugin.refreshCatchUpStatus?.();
        await this.refresh();
    }

    private async discard(withNotice = false): Promise<void> {
        const res = await discardOperation(createCatchUpPorts(this.plugin));
        if (!res.ok) {
            // Keep the operation on screen: it is still there, and saying otherwise would be false.
            this.banner = { text: this.plugin.t.modals.newsletterCatchUp.discardFailed, tone: 'warn' };
            await this.refresh();
            return;
        }
        this.banner = withNotice ? { text: this.plugin.t.modals.newsletterCatchUp.discarded, tone: 'info' } : null;
        this.includeAgainDates = null;
        this.plugin.refreshCatchUpStatus?.();
        await this.refresh();
    }

    private async generate(previewHash: string): Promise<void> {
        await this.execute((ports, opts) => runCatchUp(ports, { ...opts, previewHash, includeAgainDates: this.includeAgainDates ?? undefined }));
    }

    private async resume(): Promise<void> {
        await this.execute((ports, opts) => resumeCatchUp(ports, opts));
    }

    /**
     * Run an operation under the shared progress reporter. The reporter owns every toast, so a
     * failure is returned as READABLE guidance text (never a raw code), and the code is kept
     * aside to choose what this window shows afterwards.
     */
    private async execute(
        op: (ports: ReturnType<typeof createCatchUpPorts>, opts: RunOptions) => Promise<Result<EpisodeResult>>,
    ): Promise<void> {
        if (this.running) return;
        this.running = true;
        this.banner = null;
        const t = this.plugin.t;
        const tp = t.progress.newsletter;
        const abort = new AbortController();
        let failureCode: string | null = null;
        let cancelledByUser = false;
        this.renderRunning();

        const resolvePhase = (p: { key: PhaseKey; params?: Readonly<Record<string, string | number>> }): string => {
            const text = {
                freezing: tp.catchUpFreezing,
                writingScript: tp.catchUpWritingScript,
                shorteningScript: tp.catchUpShortening,
                synthesising: tp.catchUpSynthesising,
                saving: tp.catchUpSaving,
            }[p.key];
            return Object.entries(p.params ?? {}).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), text);
        };

        const result = await withProgressResult<EpisodeResult, PhaseKey>(
            { plugin: this.plugin, initialPhase: { key: 'freezing' }, resolvePhase, host: this, abortController: abort },
            async (reporter) => {
                const onPhase = (p: RunPhase): void => {
                    reporter.setPhase(p.key === 'synthesising'
                        ? { key: 'synthesising', params: { done: p.done, total: p.total } }
                        : { key: p.key });
                };
                const res = await op(createCatchUpPorts(this.plugin), {
                    signal: reporter.signal,
                    onPhase,
                    setCancellable: (c) => reporter.setCancellable(c),
                    interactive: true,
                    confirmOverrun: (info) => this.renderOverrun(info),
                });
                if (res.ok) return res;
                if (res.error === 'cancelled') { cancelledByUser = true; return res; }
                failureCode = res.error;
                return err(formatGuidance(describeError(t, res.error)));
            },
        );

        this.running = false;
        this.progressEl = null;
        this.cancelSlot = null;
        this.plugin.refreshCatchUpStatus?.();
        // A new episode may have just made older ones eligible; the sweep runs shortly after the lock is free.
        if (result.ok) this.plugin.scheduleCatchUpCleanup?.();
        if (this.closed) return;

        const m = t.modals.newsletterCatchUp;
        if (result.ok) {
            this.includeAgainDates = null;
            const v = result.value;
            this.banner = {
                text: m.done.replace('{minutes}', String(v.minutes)).replace('{days}', formatPendingSummary(this.plugin.t, v.days, v.sources)),
                tone: 'info',
            };
            await this.refresh();
            this.addEpisodeLink(v.notePath);
            return;
        }

        if (cancelledByUser) {
            // The message follows the DURABLE state: a kept script is only claimed if one exists.
            const kept = (await classifyOperation(createCatchUpPorts(this.plugin))).kind !== 'none';
            this.banner = { text: kept ? m.cancelledWithRecord : m.cancelledNoRecord, tone: 'info' };
        } else if (failureCode === 'catchup-changed') {
            this.banner = { text: m.changedNotice, tone: 'warn' };
        } else if (!cancelledByUser) {
            // The reporter suppresses its own toast while this window hosts it, so say it here.
            this.banner = { text: result.error, tone: 'warn' };
        }
        await this.refresh();
    }

    private addEpisodeLink(notePath: string): void {
        const m = this.plugin.t.modals.newsletterCatchUp;
        const row = this.contentEl.querySelector('.ai-organiser-catchup-actions');
        if (!row) return;
        this.button(row as HTMLElement, m.openNote, () => { void this.app.workspace.openLinkText(notePath, '', false); }, true);
    }
}

/** Snap a stored ceiling to the dropdown choices. */
function nearestCeiling(value: unknown): number {
    const n = Number(value);
    const choices = [5, 10, 15, 20];
    if (!Number.isFinite(n)) return 20;
    return choices.reduce((best, c) => (Math.abs(c - n) < Math.abs(best - n) ? c : best), 20);
}
