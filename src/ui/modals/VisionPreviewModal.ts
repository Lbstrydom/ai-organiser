/**
 * Vision Preview Modal — Display digitisation results (Phase 3)
 * Shows source image + rendered Markdown/Mermaid with action buttons
 */
import { Modal, MarkdownRenderer, Platform, Component, MarkdownView } from 'obsidian';
import { logger } from '../../utils/logger';
import AIOrganiserPlugin from '../../main';
import type { DigitiseResult } from '../../services/visionService';
import { insertAtCursor } from '../../utils/editorUtils';
import { buildDigitiseMarkdown } from '../../utils/digitiseUtils';

/** @deprecated Use buildDigitiseMarkdown from digitiseUtils.ts — re-exported for backward compat */
export { buildDigitiseMarkdown as buildFullMarkdown } from '../../utils/digitiseUtils';

export class VisionPreviewModal extends Modal {
    private component: Component;
    private actionFired = false;
    private onActionCallback?: (action: 'insert' | 'copy' | 'discard') => void;

    constructor(
        private plugin: AIOrganiserPlugin,
        private result: DigitiseResult,
        private imageDataUrl: string, // Full data URL for preview (data:image/jpeg;base64,...)
        onAction?: (action: 'insert' | 'copy' | 'discard') => void
    ) {
        super(plugin.app);
        this.component = new Component();
        this.onActionCallback = onAction;
    }

    onOpen() {
        const { contentEl } = this;
        const t = this.plugin.t.digitisation; // i18n strings

        contentEl.empty();
        contentEl.addClass('ai-organiser-vision-preview');

        // Header
        const header = contentEl.createEl('div', { cls: 'modal-title' });
        header.createEl('h2', { text: t.previewTitle || 'Digitisation Results' });

        // Main container — split layout (CSS: .ai-organiser-vision-split)
        const splitCls = Platform.isMobile ? 'ai-organiser-vision-split mobile' : 'ai-organiser-vision-split';
        const container = contentEl.createEl('div', { cls: splitCls });

        // Left pane: Source image
        const imagePane = container.createEl('div', { cls: 'ai-organiser-vision-image-pane' });
        imagePane.createEl('h3', { text: t.sourceImage || 'Source Image' });
        imagePane.createEl('img', {
            attr: {
                src: this.imageDataUrl,
                alt: 'Digitised image'
            }
        });

        // Right pane: Rendered output
        const outputPane = container.createEl('div', { cls: 'ai-organiser-vision-output-pane' });
        outputPane.createEl('h3', { text: t.digitisedContent || 'Digitised Content' });

        // Build full markdown content
        const fullMarkdown = buildDigitiseMarkdown(this.result);

        // Render markdown (async but we don't await — modal shows immediately)
        void this.renderMarkdown(outputPane, fullMarkdown);

        // Action buttons
        const buttonContainer = contentEl.createEl('div', { cls: 'modal-button-container' });

        // Discard button (left, warning style)
        const discardButton = buttonContainer.createEl('button', {
            cls: 'mod-warning',
            text: t.discard || 'Discard'
        });
        discardButton.onclick = () => {
            this.fireAction('discard');
            this.close();
        };

        // Copy to clipboard button (middle, default style)
        const copyButton = buttonContainer.createEl('button', {
            text: t.copyToClipboard || 'Copy to Clipboard'
        });
        copyButton.onclick = async () => {
            await navigator.clipboard.writeText(fullMarkdown);
            this.fireAction('copy');
            this.close();
        };

        // Insert button (right, primary style)
        const insertButton = buttonContainer.createEl('button', {
            cls: 'mod-cta',
            text: t.insertBelow || 'Insert Below'
        });
        insertButton.onclick = () => {
            this.insertIntoNote(fullMarkdown);
            this.fireAction('insert');
            this.close();
        };
    }

    /**
     * Render markdown content with Mermaid support
     */
    private async renderMarkdown(container: HTMLElement, markdown: string) {
        try {
            await MarkdownRenderer.render(
                this.plugin.app,
                markdown,
                container,
                '', // sourcePath
                this.component
            );
        } catch (error) {
            logger.error('Digitise', 'Markdown render error:', error);
            // Fallback to plain text display
            const pre = container.createEl('pre', { cls: 'vision-preview-error' });
            pre.createEl('div', { 
                cls: 'callout callout-warning',
                text: 'Render error — showing raw output below:'
            });
            pre.createEl('code', { text: markdown });
        }
    }

    /**
     * Insert markdown into active note at cursor
     */
    private insertIntoNote(markdown: string) {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!activeView) {
            logger.warn('Digitise', 'No active markdown view for insertion');
            return;
        }

        const editor = activeView.editor;
        insertAtCursor(editor, markdown);
    }

    /**
     * Fire action callback
     */
    private fireAction(action: 'insert' | 'copy' | 'discard') {
        if (this.actionFired) return;
        this.actionFired = true;
        this.onActionCallback?.(action);
    }

    onClose() {
        const { contentEl } = this;

        // ESC safety: fire discard if no action taken
        if (!this.actionFired) {
            this.fireAction('discard');
        }

        // Clean up component to prevent memory leaks
        this.component.unload();
        contentEl.empty();
    }
}
