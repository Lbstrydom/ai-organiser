/**
 * Review Edits Modal
 * Shows an inline diff view (green/red lines) before any write command modifies the active note.
 * User reviews changes then accepts, copies, or rejects the result.
 */

import { App, Modal, Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { DiffLine, DiffStats } from '../../utils/mermaidDiff';

export type ReviewAction = 'accept' | 'copy' | 'reject';

export class ReviewEditsModal extends Modal {
    private plugin: AIOrganiserPlugin;
    private diff: DiffLine[];
    private stats: DiffStats;
    private newContent: string;
    private onAction: (action: ReviewAction) => void;
    private actionFired = false;

    constructor(
        app: App,
        plugin: AIOrganiserPlugin,
        diff: DiffLine[],
        stats: DiffStats,
        newContent: string,
        onAction: (action: ReviewAction) => void
    ) {
        super(app);
        this.plugin = plugin;
        this.diff = diff;
        this.stats = stats;
        this.newContent = newContent;
        this.onAction = onAction;
    }

    onOpen(): void {
        const { contentEl } = this;
        const t = this.plugin.t.modals.reviewEdits;
        contentEl.empty();
        contentEl.addClass('ai-organiser-modal-content');
        contentEl.addClass('ai-organiser-review-edits-modal');

        contentEl.createEl('h2', { text: t.title });

        // Stats bar — color-coded chips
        const statsEl = contentEl.createDiv({ cls: 'ai-organiser-diff-stats' });
        if (this.stats.added > 0) {
            statsEl.createSpan({ cls: 'ai-organiser-diff-stat-chip ai-organiser-diff-stat-added',
                text: t.statsAdded.replace('{n}', String(this.stats.added)) });
        }
        if (this.stats.removed > 0) {
            statsEl.createSpan({ cls: 'ai-organiser-diff-stat-chip ai-organiser-diff-stat-removed',
                text: t.statsRemoved.replace('{n}', String(this.stats.removed)) });
        }
        if (this.stats.unchanged > 0) {
            statsEl.createSpan({ cls: 'ai-organiser-diff-stat-chip ai-organiser-diff-stat-unchanged',
                text: t.statsUnchanged.replace('{n}', String(this.stats.unchanged)) });
        }

        // Scrollable diff view
        const diffContainer = contentEl.createDiv({ cls: 'ai-organiser-diff-container' });
        const pre = diffContainer.createEl('pre', { cls: 'ai-organiser-diff-pre' });

        const MAX_RENDERED_LINES = 500;
        const visibleLines = this.diff.slice(0, MAX_RENDERED_LINES);
        for (const line of visibleLines) {
            const lineEl = pre.createEl('div', {
                cls: `ai-organiser-diff-line ai-organiser-diff-line-${line.type}`,
            });
            const prefix = line.type === 'added' ? '+' : line.type === 'removed' ? '−' : ' ';
            lineEl.createSpan({ cls: 'ai-organiser-diff-prefix', text: prefix });
            lineEl.createSpan({ cls: 'ai-organiser-diff-content', text: line.content });
        }
        if (this.diff.length > MAX_RENDERED_LINES) {
            pre.createEl('div', {
                cls: 'ai-organiser-diff-line ai-organiser-diff-line-unchanged',
                text: `  … ${this.diff.length - MAX_RENDERED_LINES} more lines (accept or reject to apply all changes)`,
            });
        }

        // Action buttons
        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(t.reject)
                .setWarning()
                .onClick(() => this.fireAction('reject')))
            .addButton(btn => btn
                .setButtonText(t.copy)
                .onClick(() => this.fireAction('copy')))
            .addButton(btn => btn
                .setButtonText(t.accept)
                .setCta()
                .onClick(() => this.fireAction('accept')));
    }

    private fireAction(action: ReviewAction): void {
        this.actionFired = true;
        this.close();
        this.onAction(action);
    }

    onClose(): void {
        this.contentEl.empty();
        if (!this.actionFired) {
            this.actionFired = true;
            this.onAction('reject');
        }
    }

    /** Expose for testing */
    getNewContent(): string {
        return this.newContent;
    }

    /** Test helper — triggers the same path as a button click */
    simulateAction(action: ReviewAction): void {
        this.fireAction(action);
    }
}
