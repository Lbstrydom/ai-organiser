/**
 * Improve Preview Modal
 * Shows a rendered markdown preview of improved content with placement-aware actions.
 * CTA button text and style change based on the chosen placement strategy.
 */

import { App, Modal, Setting, MarkdownRenderer, Component } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { ImproveNotePlacement } from './ImproveNoteModal';

export type ImprovePreviewAction = 'confirm' | 'copy' | 'discard';

export class ImprovePreviewModal extends Modal {
    private plugin: AIOrganiserPlugin;
    private content: string;
    private placement: ImproveNotePlacement;
    private onAction: (action: ImprovePreviewAction) => void;
    private component: Component;
    private actionFired = false;

    constructor(
        app: App,
        plugin: AIOrganiserPlugin,
        content: string,
        placement: ImproveNotePlacement,
        onAction: (action: ImprovePreviewAction) => void
    ) {
        super(app);
        this.plugin = plugin;
        this.content = content;
        this.placement = placement;
        this.onAction = onAction;
        this.component = new Component();
    }

    onOpen(): void {
        const { contentEl } = this;
        const t = this.plugin.t.modals.improveNote;
        contentEl.empty();
        contentEl.addClass('ai-organiser-modal-content');
        contentEl.addClass('ai-organiser-improve-preview-modal');

        contentEl.createEl('h2', { text: t?.previewTitle || 'Preview' });

        // Scrollable preview area
        const previewEl = contentEl.createDiv({ cls: 'ai-organiser-summary-preview' });
        this.component.load();
        void MarkdownRenderer.render(
            this.app,
            this.content,
            previewEl,
            '',
            this.component
        );

        // Placement-aware CTA text and style
        const ctaText = this.getCTAText(t);
        const isDestructive = this.placement === 'replace';

        // Action buttons
        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(t?.previewDiscard || 'Discard')
                .onClick(() => {
                    this.fireAction('discard');
                }))
            .addButton(btn => btn
                .setButtonText(t?.previewCopy || 'Copy to clipboard')
                .onClick(() => {
                    this.fireAction('copy');
                }))
            .addButton(btn => {
                btn.setButtonText(ctaText)
                    .onClick(() => {
                        this.fireAction('confirm');
                    });
                if (isDestructive) {
                    btn.setWarning();
                } else {
                    btn.setCta();
                }
            });
    }

    private getCTAText(t: typeof this.plugin.t.modals.improveNote): string {
        switch (this.placement) {
            case 'replace':
                return t?.previewReplace || 'Replace note';
            case 'cursor':
                return t?.previewInsert || 'Insert at cursor';
            case 'new-note':
                return t?.previewCreate || 'Create note';
            default:
                return t?.previewReplace || 'Replace note';
        }
    }

    private fireAction(action: ImprovePreviewAction): void {
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
