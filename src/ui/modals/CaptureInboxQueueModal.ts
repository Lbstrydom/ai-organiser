/**
 * The capture queue: a compact list, not a view. Each row says what the capture is, where it is, and offers
 * only the actions that make sense for that state (Review, Open note, Retry, Skip). The footer processes the
 * inbox (after the usual estimate) and says plainly when processing is paused for lack of reviews.
 */
import { App, ButtonComponent, Modal } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { CaptureController } from '../../services/captureInbox/captureController';
import { buildQueue, formatAge, processedCount, queueCounts, skippedSummary, splitQueue, type QueueRow } from '../../services/captureInbox/captureQueueModel';
import { plural } from '../../utils/plural';

/** Skipped captures listed one by one; the rest are counted. */
const MAX_SKIPPED_SHOWN = 8;

export class CaptureInboxQueueModal extends Modal {
    private unsubscribe: (() => void) | null = null;
    private showProcessed = false;

    constructor(app: App, private readonly plugin: AIOrganiserPlugin, private readonly ctl: CaptureController) {
        super(app);
    }

    onOpen(): void {
        this.containerEl.addClass('ai-organiser-modal-container');
        this.contentEl.addClass('ai-organiser-capture-queue');
        this.unsubscribe = this.ctl.store.subscribe(() => this.draw());
        this.draw();
    }

    private label(row: QueueRow): string {
        const t = this.plugin.t.captureInbox;
        if (row.processed) return t.rowProcessed;
        const state = t.stateLabels[row.state].replace('{stage}', row.failedStage ?? '');
        return row.source ? `${state} · ${t.sourceLabels[row.source]}` : state;
    }

    /** The one line under a row that says what is going on and what to do. */
    private detail(row: QueueRow): string | null {
        const t = this.plugin.t.captureInbox;
        if (row.state === 'failed') {
            const help = row.failedStage ? t.failedHelp[row.failedStage] : '';
            return [row.errorText, help].filter(Boolean).join(' ') || null;
        }
        if (row.audioNotTranscribed) return t.audioNotTranscribed;
        if (row.settleSeconds !== undefined) return t.settleLine.replace('{seconds}', String(Math.max(1, row.settleSeconds)));
        return null;
    }

    private drawRow(list: HTMLElement, row: QueueRow): void {
        const t = this.plugin.t.captureInbox;
        const item = list.createEl('li', { cls: 'ai-organiser-capture-row' });
        const text = item.createDiv({ cls: 'ai-organiser-capture-row-text' });
        text.createDiv({ text: row.title, cls: 'ai-organiser-capture-row-title' });
        text.createDiv({ text: `${this.label(row)} · ${formatAge(row.ageMs)}`, cls: 'ai-organiser-capture-row-meta' });
        const detail = this.detail(row);
        if (detail) text.createDiv({ text: detail, cls: 'ai-organiser-capture-row-meta' });
        const actions = item.createDiv({ cls: 'ai-organiser-capture-row-actions' });
        if (row.reviewable) new ButtonComponent(actions).setButtonText(t.rowReview).setCta().onClick(() => { this.close(); this.ctl.openReview(row.id); });
        if (row.retriable) new ButtonComponent(actions).setButtonText(t.rowRetry).onClick(() => { void this.ctl.retry(row.id); });
        new ButtonComponent(actions).setButtonText(t.rowOpen).onClick(() => this.ctl.openNote(row.id));
        if (row.skippable) new ButtonComponent(actions).setButtonText(t.rowSkip).onClick(() => { void this.ctl.skip(row.id); });
    }

    /** Why captures were set aside, and what to do about each, so nothing disappears without a word. */
    private drawSkipped(): void {
        const t = this.plugin.t.captureInbox;
        const { rows, excluded } = skippedSummary(this.ctl.store.get(), Date.now());
        if (rows.length === 0 && excluded === 0) return;
        const { contentEl } = this;
        contentEl.createEl('h3', { text: t.skippedTitle });
        const list = contentEl.createEl('ul', { cls: 'ai-organiser-capture-list', attr: { 'aria-label': t.skippedTitle } });
        for (const row of rows.slice(0, MAX_SKIPPED_SHOWN)) {
            const item = list.createEl('li', { cls: 'ai-organiser-capture-row' });
            const text = item.createDiv({ cls: 'ai-organiser-capture-row-text' });
            text.createDiv({ text: row.name, cls: 'ai-organiser-capture-row-title' });
            const help = t.skipHelp[row.reason];
            text.createDiv({ text: row.reason === 'unsupported' && row.extension ? `.${row.extension}: ${help}` : help, cls: 'ai-organiser-capture-row-meta' });
            const actions = item.createDiv({ cls: 'ai-organiser-capture-row-actions' });
            if (row.retryable) new ButtonComponent(actions).setButtonText(t.skipRetry).onClick(() => { void this.ctl.retrySkipped(row.id); });
            new ButtonComponent(actions).setButtonText(t.rowOpen).onClick(() => this.ctl.openNote(row.id));
        }
        if (rows.length > MAX_SKIPPED_SHOWN) contentEl.createEl('p', { text: t.skipMore.replace('{count}', String(rows.length - MAX_SKIPPED_SHOWN)), cls: 'ai-organiser-capture-reason' });
        if (excluded > 0) contentEl.createEl('p', { text: plural(t.skippedExcluded, excluded, 'count').replace('{count}', String(excluded)), cls: 'ai-organiser-capture-reason' });
    }

    private draw(): void {
        const t = this.plugin.t.captureInbox;
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: t.queueTitle });
        const journal = this.ctl.store.get();
        const rows = buildQueue(journal, Date.now(), { includeProcessed: this.showProcessed, stabilityMs: this.ctl.stabilityMs() });
        const processedTotal = processedCount(journal);
        const counts = queueCounts(journal);
        const { act, waiting, waitingHidden } = splitQueue(rows);

        if (rows.length === 0) {
            contentEl.createEl('p', { text: t.queueEmpty, cls: 'ai-organiser-capture-empty' });
        } else {
            const list = contentEl.createEl('ul', { cls: 'ai-organiser-capture-list', attr: { 'aria-label': t.queueTitle } });
            for (const row of [...act, ...waiting]) this.drawRow(list, row);
            if (waitingHidden > 0) contentEl.createEl('p', { text: t.waitingMore.replace('{count}', String(waitingHidden)), cls: 'ai-organiser-capture-reason' });
        }
        if (counts.backpressure) contentEl.createEl('p', { text: t.backpressureNote, cls: 'ai-organiser-capture-reason' });
        if (counts.settling > 0) contentEl.createEl('p', { text: plural(t.waitingNote, counts.settling), cls: 'ai-organiser-capture-reason' });
        if (counts.ready > 0) contentEl.createEl('p', { text: plural(t.readyNote, counts.ready), cls: 'ai-organiser-capture-reason' });
        this.drawSkipped();

        const footer = contentEl.createDiv('ai-organiser-modal-buttons');
        if (processedTotal > 0) {
            new ButtonComponent(footer)
                .setButtonText(this.showProcessed ? t.hideProcessed : t.showProcessed.replace('{n}', String(processedTotal)))
                .onClick(() => { this.showProcessed = !this.showProcessed; this.draw(); });
        }
        new ButtonComponent(footer).setButtonText(t.processNow).setCta().onClick(() => { this.close(); void this.ctl.processNow(); });
        new ButtonComponent(footer).setButtonText(t.close).onClick(() => this.close());
    }

    onClose(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.contentEl.empty();
    }
}
