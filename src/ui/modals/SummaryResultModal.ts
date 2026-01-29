/**
 * Summary Result Modal
 * Shows a preview of generated summary content with insert/copy/discard options
 */

import { App, Modal, Setting, MarkdownRenderer, Component } from 'obsidian';
import type AIOrganiserPlugin from '../../main';

export type SummaryResultAction = 'cursor' | 'copy' | 'discard';

export class SummaryResultModal extends Modal {
    private plugin: AIOrganiserPlugin;
    private content: string;
    private onAction: (action: SummaryResultAction) => void;
    private component: Component;
    private actionFired = false;

    constructor(
        app: App,
        plugin: AIOrganiserPlugin,
        content: string,
        onAction: (action: SummaryResultAction) => void
    ) {
        super(app);
        this.plugin = plugin;
        this.content = content;
        this.onAction = onAction;
        this.component = new Component();
    }

    onOpen(): void {
        const { contentEl } = this;
        const sr = this.plugin.t.modals.summaryResult;
        contentEl.empty();
        contentEl.addClass('ai-organiser-modal-content');
        contentEl.addClass('ai-organiser-summary-result-modal');

        contentEl.createEl('h2', { text: sr.title });

        // Scrollable preview area
        const previewEl = contentEl.createDiv({ cls: 'ai-organiser-summary-preview' });
        this.component.load();
        MarkdownRenderer.render(
            this.app,
            this.content,
            previewEl,
            '',
            this.component
        );

        // Action buttons
        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(sr.discard)
                .onClick(() => {
                    this.fireAction('discard');
                }))
            .addButton(btn => btn
                .setButtonText(sr.copyToClipboard)
                .onClick(() => {
                    this.fireAction('copy');
                }))
            .addButton(btn => btn
                .setButtonText(sr.insertAtCursor)
                .setCta()
                .onClick(() => {
                    this.fireAction('cursor');
                }));
    }

    private fireAction(action: SummaryResultAction): void {
        this.actionFired = true;
        this.close();
        this.onAction(action);
    }

    onClose(): void {
        this.component.unload();
        this.contentEl.empty();
        // ESC / X dismissal — treat as discard so the wrapping Promise resolves
        if (!this.actionFired) {
            this.actionFired = true;
            this.onAction('discard');
        }
    }
}
