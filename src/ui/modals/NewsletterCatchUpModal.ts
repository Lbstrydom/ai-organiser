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
import { err, ok, type Result } from '../../core/result';
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
import { createCatchUpPorts, createDailyTidyDeps, previewCost } from '../../services/newsletter/catchUp/catchUpRuntime';
import { runDailyAudioTidy } from '../../services/newsletter/catchUp/catchUpTidy';
import { prepareReplace, replaceAndRunCatchUp, type RefuseReason, type ReplacePrep, type RetiredEpisode } from '../../services/newsletter/catchUp/catchUpReplace';
import { markEpisodeListened } from '../../services/newsletter/catchUp/catchUpListen';
import { availabilityOf, deriveModalView, type ModalView, type Waiting } from '../../services/newsletter/catchUp/catchUpModalState';
import { formatBytes } from '../../services/notebooklm/notebooklmUtils';
import { datesBetween, formatDateList, formatDates, formatEpisodeDone, formatPendingSummary, isContiguous } from '../../services/newsletter/catchUp/catchUpFormat';
import { CATCHUP_BIG_THRESHOLD_DAYS, type EpisodeMeta, type TidyPlan } from '../../services/newsletter/catchUp/catchUpTypes';
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
    /** Discard of an unfinished episode asks first: the written script has already been paid for. */
    private confirmingDiscard = false;
    private closed = false;
    private refreshSeq = 0;
    /** The Replace flow: checking, blocked, or waiting for the person to confirm. Null when not in it. */
    private replace: { phase: 'assessing' } | { phase: 'blocked'; prep: Extract<ReplacePrep, { kind: 'blocked' }> } | { phase: 'confirm'; prep: Extract<ReplacePrep, { kind: 'ready' }> } | null = null;
    /** What happened to the old episodes after a replacement, appended to the result banner. */
    private afterRun: { text: string; clean: boolean } | null = null;
    /** Whether to also remove the superseded daily audio after the episode is saved (on by default when there is any). */
    private tidyChoice = true;
    /** Bumped whenever the Replace flow is left, so an older assessment can never land in a newer one. */
    private replaceSeq = 0;

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
            this.view = deriveModalView({ availability: availabilityOf(this.plugin.settings), snapshot, operation, settings: this.plugin.settings });
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
        if (this.replace && view.kind !== 'unavailable' && view.kind !== 'resume') return this.renderReplace(this.replace);

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
        if (view.noStoredDates.length > 0) this.note(m.noStored.replace('{dates}', formatDates(this.plugin.t, view.noStoredDates)));
        if (view.expiringDates.length > 0) this.note(m.expiring.replace('{dates}', formatDates(this.plugin.t, view.expiringDates)), 'is-warn');
        if (view.evidenceDegraded) this.note(this.plugin.t.modals.newsletterCatchUp.evidenceDegraded, 'is-warn');
        this.renderSkipped(view);
        if (opts.unheardWarning && view.waiting) this.renderWaiting(view.waiting);
        else if (opts.unheardWarning && view.unheard) this.renderUnheard(view.unheard.episode);
    }

    /** Days the plan leaves out on purpose, said plainly, with a way to bring the heard ones back. */
    private renderSkipped(view: Exclude<ModalView, { kind: 'unavailable' }>): void {
        const m = this.plugin.t.modals.newsletterCatchUp;
        const heard = view.skipped.filter((s) => s.reason === 'heard-daily-audio').map((s) => s.date);
        const open = view.skipped.filter((s) => s.reason === 'open-day').map((s) => s.date);
        if (open.length > 0) this.note(m.skippedOpen.replace('{dates}', formatDateList(this.plugin.t, open)));
        if (heard.length === 0) return;
        const text = (heard.length === 1 ? m.skippedHeardOne : m.skippedHeard).replace('{n}', String(heard.length)).replace('{dates}', formatDateList(this.plugin.t, heard));
        this.note(text);
        const row = this.contentEl.createDiv({ cls: 'ai-organiser-catchup-actions' });
        this.button(row, m.includeSkipped, () => {
            this.includeAgainDates = [...new Set([...(this.includeAgainDates ?? []), ...heard])];
            this.banner = null;
            void this.refresh();
        });
    }

    /**
     * Smart daily is holding back: say so, name each episode that holds it, and what ends the wait.
     * The same two ways out as the plain unheard warning (open it, mark it listened), plus replace.
     */
    private renderWaiting(waiting: Waiting): void {
        const m = this.plugin.t.modals.newsletterCatchUp;
        const box = this.contentEl.createDiv({ cls: 'ai-organiser-catchup-unheard ai-organiser-catchup-waiting' });
        box.setAttribute('role', 'status');
        const pending = (waiting.days === 1 ? m.daysOne : m.daysMany).replace('{n}', String(waiting.days));
        const many = waiting.episodes.length > 1;
        box.createEl('strong', {
            text: (many ? m.waitingTitleMany : m.waitingTitleOne).replace('{count}', String(waiting.episodes.length)).replace('{pending}', m.waitingPending.replace('{days}', pending)),
        });
        box.createEl('p', { text: many ? m.waitingEndsMany : m.waitingEndsOne });
        for (const episode of waiting.episodes) {
            const range = episode.from === episode.to ? episode.to : `${episode.from} → ${episode.to}`;
            box.createEl('p', { text: range, cls: 'ai-organiser-catchup-waiting-episode' });
            const row = box.createDiv({ cls: 'ai-organiser-catchup-actions' });
            this.button(row, m.openEpisode, () => { void this.app.workspace.openLinkText(episode.notePath, '', false); });
            this.button(row, m.markListened, () => { void this.markListened(episode); });
        }
        this.renderReplaceButton(box, waiting.episodes.length);
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
        this.renderReplaceButton(box, this.view && 'unheard' in this.view && this.view.unheard ? this.view.unheard.count : 1);
    }

    private renderPending(view: Extract<ModalView, { kind: 'pending' }>): void {
        const m = this.plugin.t.modals.newsletterCatchUp;
        const summary = formatPendingSummary(this.plugin.t, view.days, view.newsletters);
        this.contentEl.createEl('p', { text: m.pendingLine.replace('{summary}', summary), cls: 'ai-organiser-catchup-summary' });
        // A range only when it hides no gap: "A to B" over skipped days would claim days the episode does not include.
        this.note(view.dates.length === 1
            ? m.coversOne.replace('{date}', view.from)
            : isContiguous(view.dates) ? m.covers.replace('{from}', view.from).replace('{to}', view.to) : m.coversList.replace('{dates}', formatDateList(this.plugin.t, view.dates)));
        if (view.unresolvedDates.length > 0) this.note(m.unresolved.replace('{dates}', formatDates(this.plugin.t, view.unresolvedDates)), 'is-warn');
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
        this.renderTidyOption(view.tidy);

        const footer = this.footer();
        const generate = this.button(footer, m.generate, () => { void this.generate(view.planHash, view.tidy); }, true);
        this.button(footer, m.close, () => this.close());
        queueMicrotask(() => generate.focus());
    }

    // ── Replace ──────────────────────────────────────────────────────────────

    private renderReplaceButton(parent: HTMLElement, count: number): void {
        const m = this.plugin.t.modals.newsletterCatchUp;
        const row = parent.createDiv({ cls: 'ai-organiser-catchup-actions' });
        this.button(row, count > 1 ? m.replaceMany.replace('{count}', String(count)) : m.replaceOne, () => { void this.startReplace(); });
    }

    /** Assess everything that would go, read-only, and show either why not or exactly what will happen. */
    private async startReplace(): Promise<void> {
        if (this.running || this.replace) return;
        const seq = ++this.replaceSeq;
        this.replace = { phase: 'assessing' };
        this.banner = null;
        this.render();
        const res = await prepareReplace({ app: this.app, plugin: this.plugin, settings: this.plugin.settings });
        if (this.closed || seq !== this.replaceSeq || this.replace?.phase !== 'assessing') return;
        if (!res.ok) {
            this.replace = null;
            this.banner = { text: formatGuidance(describeError(this.plugin.t, res.error)), tone: 'warn' };
            await this.refresh();
            return;
        }
        this.replace = res.value.kind === 'blocked' ? { phase: 'blocked', prep: res.value } : { phase: 'confirm', prep: res.value };
        this.render();
    }

    private reasonText(reason: RefuseReason): string {
        const m = this.plugin.t.modals.newsletterCatchUp;
        switch (reason) {
            case 'playing-now': return m.replaceWhyPlaying;
            case 'protected': return m.replaceWhyProtected;
            case 'index-not-ready': case 'index-unavailable': case 'acks-unreadable': case 'playback-unknown': case 'record-unknown': return m.replaceWhyChecking;
            case 'record-in-flight': return m.replaceWhyInFlight;
            case 'acked': return m.replaceWhyAcked;
            default: return m.replaceWhyOther;
        }
    }

    private renderReplace(state: NonNullable<NewsletterCatchUpModal['replace']>): void {
        const m = this.plugin.t.modals.newsletterCatchUp;
        const leave = (): void => { this.replaceSeq++; this.replace = null; this.render(); };

        if (state.phase === 'assessing') {
            const p = this.note(m.replaceChecking);
            p.setAttribute('role', 'status');
            p.setAttribute('aria-live', 'polite');
            this.button(this.footer(), m.cancel, leave);
            return;
        }

        if (state.phase === 'blocked') {
            this.contentEl.createEl('h3', { text: m.replaceBlockedTitle });
            if (state.prep.nothingToMake) {
                this.note(m.replaceWhyNothing);
            } else {
                this.note(m.replaceBlockedIntro);
                const list = this.contentEl.createEl('ul');
                for (const why of new Set(state.prep.refused.map((r) => this.reasonText(r.reason)))) list.createEl('li', { text: why });
            }
            this.button(this.footer(), m.close, leave, true);
            return;
        }

        const { prep } = state;
        const heading = this.contentEl.createEl('h3', { text: prep.candidates.length > 1 ? m.replaceConfirmMany.replace('{count}', String(prep.candidates.length)) : m.replaceConfirmOne });
        heading.setAttribute('tabindex', '-1');
        this.note(m.replaceTrashIntro);
        const list = this.contentEl.createEl('ul', { cls: 'ai-organiser-catchup-replace-list' });
        for (const c of prep.candidates) {
            list.createEl('li', { text: m.replaceTrashItem.replace('{note}', c.noteName).replace('{audio}', c.audioName).replace('{size}', c.audioBytes === null ? m.sizeUnknown : formatBytes(c.audioBytes)) });
        }
        const plan = prep.preview.plan;
        if (plan) {
            const summary = formatPendingSummary(this.plugin.t, plan.entries.length, plan.entries.reduce((n, e) => n + e.newsletters, 0));
            this.note(m.replaceMakes.replace('{summary}', summary).replace('{dates}', formatDateList(this.plugin.t, plan.entries.map((e) => e.date))));
            this.note((plan.entries.length >= CATCHUP_BIG_THRESHOLD_DAYS ? m.lengthLineBig : m.lengthLine).replace('{mins}', String(plan.length.capMinutes)).replace('{days}', String(CATCHUP_BIG_THRESHOLD_DAYS)));
            const cost = previewCost(this.plugin, plan.length.capMinutes);
            this.note(cost.ttsUsd === null ? m.costAzure : m.costTts.replace('{usd}', cost.ttsUsd.toFixed(2)));
        }
        this.renderTidyOption(prep.preview.tidy);
        if (prep.lostDays.length > 0) this.note(m.replaceLost.replace('{n}', String(prep.lostDays.length)).replace('{dates}', formatDateList(this.plugin.t, prep.lostDays)), 'is-warn');
        const linked = prep.candidates.reduce((n, c) => n + c.inboundLinks, 0);
        if (linked > 0) this.note((linked === 1 ? m.replaceLinkedOne : m.replaceLinked).replace('{n}', String(linked)), 'is-warn');

        const footer = this.footer();
        this.button(footer, m.discardKeep, leave, true);
        this.button(footer, m.replaceGo, () => { void this.confirmReplace(prep); }, 'warning');
        queueMicrotask(() => heading.focus());
    }

    private async confirmReplace(prep: Extract<ReplacePrep, { kind: 'ready' }>): Promise<void> {
        const planHash = prep.preview.plan?.planHash;
        if (!planHash) return;
        this.replaceSeq++;
        this.replace = null;
        this.afterRun = null;
        await this.execute(async (ports, opts) => {
            const res = await replaceAndRunCatchUp(ports, {
                episodeIds: prep.episodeIds, previewHash: planHash, acceptLostDays: prep.lostDays.length > 0, purpose: 'manual', run: opts,
            });
            if (!res.ok) return res;
            this.afterRun = this.retirementNote(res.value.retired);
            await this.tidyAfter(res.value.episode, prep.preview.tidy);
            return ok(res.value.episode);
        });
    }

    /** What to tell the person about the old episodes, and whether it is plain good news (`clean`). */
    private retirementNote(retired: readonly RetiredEpisode[]): { text: string; clean: boolean } {
        const m = this.plugin.t.modals.newsletterCatchUp;
        if (retired.every((r) => r.note === 'trashed' && r.audio === 'trashed')) return { text: retired.length > 1 ? m.replaceRetiredMany : m.replaceRetired, clean: true };
        const done = (r: RetiredEpisode): boolean => r.note === 'trashed' && r.audio === 'trashed';
        const kept = retired.filter((r) => r.note === 'kept' && r.audio === 'kept');
        const partial = retired.filter((r) => !done(r) && !(r.note === 'kept' && r.audio === 'kept'));
        const parts: string[] = [];
        if (kept.length > 0) {
            // Every distinct reason, not just the first one.
            const why = [...new Set(kept.map((r) => this.reasonText((r.reason ?? 'other') as RefuseReason)))].join(' ');
            parts.push(m.replaceKept.replace('{why}', why));
        }
        if (partial.length > 0) {
            const files = partial.flatMap((r) => [r.note !== 'trashed' ? r.noteName : null, r.audio !== 'trashed' ? r.audioName : null]).filter(Boolean).join(', ');
            parts.push(m.replacePartial.replace('{files}', files));
        }
        return { text: parts.join(' '), clean: false };
    }

    private renderResume(view: Extract<ModalView, { kind: 'resume' }>): void {
        const m = this.plugin.t.modals.newsletterCatchUp;
        this.contentEl.createEl('h3', { text: m.resumeTitle });
        this.note(view.phase === 'audio-ready' ? m.resumeAudioReady : m.resumeScripted);
        this.note(m.resumeRange.replace('{from}', view.from).replace('{to}', view.to));
        if (this.confirmingDiscard) {
            this.note(m.discardConfirm, 'is-warn');
            const confirmRow = this.footer();
            this.button(confirmRow, m.discardKeep, () => { this.confirmingDiscard = false; this.render(); }, true);
            this.button(confirmRow, m.discard, () => { this.confirmingDiscard = false; void this.discard({ notice: true }); }, 'warning');
            return;
        }
        const footer = this.footer();
        this.button(footer, view.action === 'finish-saving' ? m.finishSaving : m.resume, () => { void this.resume(); }, true);
        // Start over remakes the SAME days: they may no longer be pending (an "Include again" episode,
        // or one made before a reload), so the range of the unfinished episode is re-offered in full.
        this.button(footer, m.startOver, () => { void this.discard({ restartDates: datesBetween(view.from, view.to) }); });
        this.button(footer, m.discard, () => { this.confirmingDiscard = true; this.render(); });
    }

    private renderCaughtUp(view: Extract<ModalView, { kind: 'caught-up' }>): void {
        const m = this.plugin.t.modals.newsletterCatchUp;
        this.note(m.caughtUp.replace('{date}', view.through));
        this.renderCommon(view, { unheardWarning: true });
        this.renderReplayRow(view.latestEpisode, view.windowDates);
    }

    private renderGap(view: Extract<ModalView, { kind: 'gap' }>): void {
        const m = this.plugin.t.modals.newsletterCatchUp;
        this.note(m.gap.replace('{date}', view.lastEpisodeTo));
        this.renderCommon(view, { unheardWarning: true });
        this.renderReplayRow(view.latestEpisode, view.windowDates);
    }

    private renderUnresolvedOnly(view: Extract<ModalView, { kind: 'unresolved-only' }>): void {
        const m = this.plugin.t.modals.newsletterCatchUp;
        this.note(m.unresolvedOnly.replace('{dates}', formatDates(this.plugin.t, view.unresolvedDates)), 'is-warn');
        this.renderCommon(view, { unheardWarning: true });
        this.renderReplayRow(view.latestEpisode, view.windowDates);
    }

    /** Nothing pending: Generate is absent, but replaying and remaking stay reachable. */
    private renderReplayRow(latest: { notePath: string; coverage: Record<string, unknown> } | null, windowDates: readonly string[] = []): void {
        const m = this.plugin.t.modals.newsletterCatchUp;
        const footer = this.footer();
        // Any day in the window can be brought back, not only the last episode's own range.
        if (windowDates.length > 0) {
            this.button(footer, (windowDates.length === 1 ? m.includeAllOne : m.includeAll).replace('{n}', String(windowDates.length)), () => {
                this.includeAgainDates = [...windowDates];
                this.banner = null;
                void this.refresh();
            });
        }
        if (latest) {
            this.button(footer, m.replayLatest, () => { void this.app.workspace.openLinkText(latest.notePath, '', false); });
            this.button(footer, m.includeAgain, () => {
                // The episode's own days, exactly: a range could name days the episode never covered.
                this.includeAgainDates = Object.keys(latest.coverage).sort();
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

    private button(parent: HTMLElement, text: string, onClick: () => void, emphasis: boolean | 'warning' = false): HTMLButtonElement {
        const btn = parent.createEl('button', { text, cls: emphasis === 'warning' ? 'mod-warning' : emphasis ? 'mod-cta' : '' });
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

    /** `restartDates`: Start over - the days to offer again once the record is gone. */
    private async discard(opts: { notice?: boolean; restartDates?: string[] } = {}): Promise<void> {
        const res = await discardOperation(createCatchUpPorts(this.plugin));
        if (!res.ok) {
            // Keep the operation on screen: it is still there, and saying otherwise would be false.
            this.banner = { text: this.plugin.t.modals.newsletterCatchUp.discardFailed, tone: 'warn' };
            await this.refresh();
            return;
        }
        this.banner = opts.notice ? { text: this.plugin.t.modals.newsletterCatchUp.discarded, tone: 'info' } : null;
        this.includeAgainDates = opts.restartDates ?? null;
        this.plugin.refreshCatchUpStatus?.();
        await this.refresh();
    }

    private async generate(previewHash: string, tidy: TidyPlan | null): Promise<void> {
        this.afterRun = null;
        await this.execute(async (ports, opts) => {
            const res = await runCatchUp(ports, { ...opts, previewHash, includeAgainDates: this.includeAgainDates ?? undefined });
            if (res.ok) await this.tidyAfter(res.value, tidy);
            return res;
        });
    }

    /** The checkbox: also remove the daily audio this episode makes redundant. Shown only when there is any. */
    private renderTidyOption(tidy: TidyPlan | null): void {
        if (!tidy) return;
        const m = this.plugin.t.modals.newsletterCatchUp;
        const row = this.contentEl.createDiv({ cls: 'ai-organiser-catchup-tidy' });
        const label = row.createEl('label');
        const box = label.createEl('input');
        box.type = 'checkbox';
        box.checked = this.tidyChoice;
        label.createSpan({ text: ' ' + (tidy.files.length === 1 ? m.tidyLabelOne : m.tidyLabel).replace('{count}', String(tidy.files.length)).replace('{size}', formatBytes(tidy.bytes)) });
        this.cleanups.push(listen(box, 'change', () => { this.tidyChoice = box.checked; }));
    }

    /** After the episode is SAVED: remove the consented daily audio, and say what happened. Never fails the run. */
    private async tidyAfter(episode: EpisodeResult, tidy: TidyPlan | null): Promise<void> {
        if (!tidy || !this.tidyChoice) return;
        const m = this.plugin.t.modals.newsletterCatchUp;
        let note: { text: string; clean: boolean };
        try {
            const res = await runDailyAudioTidy(createDailyTidyDeps(this.plugin), { files: tidy.files, episodeId: episode.opId });
            const report = res.ok && res.value.kind === 'done' ? res.value.report : null;
            // Success means EVERY consented file is gone and nothing stopped the run early.
            if (report && report.skipped.length === 0 && !report.halted && report.removedFiles === tidy.files.length && report.removedFiles > 0) {
                const days = report.daysDone.length;
                note = { text: (days === 1 ? m.tidyDoneOne : m.tidyDone).replace('{n}', String(days)).replace('{size}', formatBytes(report.removedBytes)), clean: true };
            } else if (!report && !(res.ok && res.value.kind === 'skipped')) {
                // An error result: how far it got is unknown, so no count is claimed.
                note = { text: m.tidyUnknown, clean: false };
            } else {
                const why = new Set<string>();
                for (const s of report?.skipped ?? []) {
                    if (s.reason === 'protected') why.add(m.tidyWhyProtected);
                    else if (s.reason === 'linked-elsewhere') why.add(m.tidyWhyLinked);
                    else if (s.reason !== 'trash-failed' && s.reason !== 'write-failed') why.add(m.tidyWhyChanged);
                }
                if (report?.halted) why.add(m.tidyWhyHalted);
                if (res.ok && res.value.kind === 'skipped' && res.value.reason !== 'off') why.add(m.tidyWhyChecking);
                note = { text: [m.tidyPartial.replace('{left}', String(tidy.files.length - (report?.removedFiles ?? 0))).replace('{total}', String(tidy.files.length)), ...why].join(' '), clean: false };
            }
        } catch (e) {
            logger.warn('Newsletter', 'Daily audio tidy failed', e);
            note = { text: m.tidyUnknown, clean: false };
        }
        this.appendAfterRun(note);
    }

    private appendAfterRun(note: { text: string; clean: boolean }): void {
        this.afterRun = this.afterRun ? { text: `${this.afterRun.text} ${note.text}`, clean: this.afterRun.clean && note.clean } : note;
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
                text: [formatEpisodeDone(this.plugin.t, v.minutes, formatPendingSummary(this.plugin.t, v.days, v.sources)), this.afterRun?.text].filter(Boolean).join(' '),
                tone: this.afterRun && !this.afterRun.clean ? 'warn' : 'info',
            };
            this.afterRun = null;
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
