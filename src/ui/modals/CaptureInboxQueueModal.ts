/**
 * The capture queue: a compact list, not a view. Each row says what the capture is, where it is, and offers
 * only the actions that make sense for that state (Review, Open note, Retry, Skip). The footer processes the
 * inbox (after the usual estimate) and says plainly when processing is paused for lack of reviews.
 */
import { App, ButtonComponent, Modal } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { CaptureController } from '../../services/captureInbox/captureController';
import { buildQueue, formatAge, processedCount, queueCounts, type QueueRow } from '../../services/captureInbox/captureQueueModel';
import { plural } from '../../utils/plural';

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

    private draw(): void {
        const t = this.plugin.t.captureInbox;
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: t.queueTitle });
        const journal = this.ctl.store.get();
        const rows = buildQueue(journal, Date.now(), { includeProcessed: this.showProcessed });
        const processedTotal = processedCount(journal);
        const counts = queueCounts(journal);

        if (rows.length === 0) {
            contentEl.createEl('p', { text: t.queueEmpty, cls: 'ai-organiser-capture-empty' });
        } else {
            const list = contentEl.createEl('ul', { cls: 'ai-organiser-capture-list', attr: { 'aria-label': t.queueTitle } });
            for (const row of rows) {
                const item = list.createEl('li', { cls: 'ai-organiser-capture-row' });
                const text = item.createDiv({ cls: 'ai-organiser-capture-row-text' });
                text.createDiv({ text: row.title, cls: 'ai-organiser-capture-row-title' });
                text.createDiv({ text: `${this.label(row)} · ${formatAge(row.ageMs)}`, cls: 'ai-organiser-capture-row-meta' });
                const actions = item.createDiv({ cls: 'ai-organiser-capture-row-actions' });
                if (row.reviewable) new ButtonComponent(actions).setButtonText(t.rowReview).setCta().onClick(() => { this.close(); this.ctl.openReview(row.id); });
                if (row.retriable) new ButtonComponent(actions).setButtonText(t.rowRetry).onClick(() => { void this.ctl.retry(row.id); });
                new ButtonComponent(actions).setButtonText(t.rowOpen).onClick(() => this.ctl.openNote(row.id));
                if (row.skippable) new ButtonComponent(actions).setButtonText(t.rowSkip).onClick(() => { void this.ctl.skip(row.id); });
            }
        }
        if (counts.backpressure) contentEl.createEl('p', { text: t.backpressureNote, cls: 'ai-organiser-capture-reason' });
        if (counts.waiting > 0) contentEl.createEl('p', { text: plural(t.waitingNote, counts.waiting), cls: 'ai-organiser-capture-reason' });

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
