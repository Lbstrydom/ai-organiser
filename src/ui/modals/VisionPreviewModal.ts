/**
 * Vision Preview Modal — Display digitisation results (Phase 3)
 * Shows source image + edit/preview tabs over the digitised markdown so
 * OCR errors can be corrected before insertion (UX-06).
 */
import { Modal, Notice, MarkdownRenderer, Platform, Component, MarkdownView } from 'obsidian';
import { logger } from '../../utils/logger';
import AIOrganiserPlugin from '../../main';
import type { DigitiseResult } from '../../services/visionService';
import { insertAtCursor } from '../../utils/editorUtils';
import { buildDigitiseMarkdown } from '../../utils/digitiseUtils';
import { ConfirmationModal } from './ConfirmationModal';

/** @deprecated Use buildDigitiseMarkdown from digitiseUtils.ts — re-exported for backward compat */
export { buildDigitiseMarkdown as buildFullMarkdown } from '../../utils/digitiseUtils';

type EditMode = 'edit' | 'preview';
type DigitiseAction = 'insert' | 'copy' | 'discard';

export class VisionPreviewModal extends Modal {
    private readonly component: Component;
    private actionFired = false;
    private readonly onActionCallback?: (action: DigitiseAction) => void;

    /** Single source of truth for edits — Insert/Copy consume this. */
    private draftMarkdown = '';
    /** Pristine result string — used to compute the dirty flag. */
    private originalMarkdown = '';
    private mode: EditMode = 'edit';

    private editTab: HTMLButtonElement | null = null;
    private previewTab: HTMLButtonElement | null = null;
    private textareaEl: HTMLTextAreaElement | null = null;
    private previewEl: HTMLElement | null = null;
    private insertButtonEl: HTMLButtonElement | null = null;
    /** Generation counter — bumped per refresh; renders whose token is stale
     *  by the time MarkdownRenderer.render resolves are discarded to prevent
     *  overlapping appends on rapid tab toggles. */
    private renderToken = 0;
    /** Per-render child component owning whatever Mermaid/math/Dataview
     *  children MarkdownRenderer.render attaches. Unloaded before each new
     *  render so orphaned children don't accumulate on repeated toggles. */
    private previewComponent: Component | null = null;

    constructor(
        private plugin: AIOrganiserPlugin,
        private result: DigitiseResult,
        private imageDataUrl: string,
        onAction?: (action: DigitiseAction) => void
    ) {
        super(plugin.app);
        this.component = new Component();
        this.onActionCallback = onAction;
    }

    private get isDirty(): boolean {
        return this.draftMarkdown !== this.originalMarkdown;
    }

    onOpen() {
        const { contentEl } = this;
        const t = this.plugin.t.digitisation;

        // Activate the modal-scoped Component so child components added via
        // refreshPreview's addChild() inherit a loaded state — without this,
        // MarkdownRenderer's lifecycle hooks (Mermaid mount, math typeset)
        // never fire because Component.addChild only propagates load() when
        // the parent is already loaded.
        this.component.load();

        contentEl.empty();
        contentEl.addClass('ai-organiser-vision-preview');

        // Header
        const header = contentEl.createEl('div', { cls: 'modal-title' });
        header.createEl('h2', { text: t.previewTitle || 'Digitisation results' });

        // Main container — split layout (CSS: .ai-organiser-vision-split)
        const splitCls = Platform.isMobile ? 'ai-organiser-vision-split mobile' : 'ai-organiser-vision-split';
        const container = contentEl.createEl('div', { cls: splitCls });

        // Left pane: Source image
        const imagePane = container.createEl('div', { cls: 'ai-organiser-vision-image-pane' });
        imagePane.createEl('h3', { text: t.sourceImage || 'Source image' });
        imagePane.createEl('img', {
            attr: { src: this.imageDataUrl, alt: 'Digitised image' }
        });

        // Right pane: editable output with edit/preview tabs (UX-06)
        const outputPane = container.createEl('div', { cls: 'ai-organiser-vision-output-pane' });
        outputPane.createEl('h3', { text: t.digitisedContent || 'Digitised content' });

        // Initial draft = pristine VLM result. Insert/Copy read from draftMarkdown.
        this.originalMarkdown = buildDigitiseMarkdown(this.result);
        this.draftMarkdown = this.originalMarkdown;

        this.renderTabs(outputPane);
        this.renderEditPane(outputPane);
        this.renderPreviewPane(outputPane);
        this.updateMode();

        // Action buttons
        const buttonContainer = contentEl.createEl('div', { cls: 'modal-button-container' });

        const discardButton = buttonContainer.createEl('button', {
            cls: 'mod-warning',
            text: t.discard || 'Discard'
        });
        discardButton.onclick = () => this.handleDiscard();

        const copyButton = buttonContainer.createEl('button', {
            text: t.copyToClipboard || 'Copy to Clipboard'
        });
        copyButton.onclick = () => { void this.handleCopy(); };

        this.insertButtonEl = buttonContainer.createEl('button', {
            cls: 'mod-cta',
            text: t.insertBelow || 'Insert Below'
        });
        this.insertButtonEl.onclick = () => this.handleInsert();
        this.refreshInsertButtonState();
    }

    private renderTabs(parent: HTMLElement): void {
        const t = this.plugin.t.digitisation;
        const tabs = parent.createEl('div', { cls: 'ai-organiser-vision-edit-tabs' });

        this.editTab = tabs.createEl('button', {
            text: t.editTab || 'Edit',
            cls: 'ai-organiser-vision-edit-tab is-active'
        });
        this.editTab.onclick = () => this.setMode('edit');

        this.previewTab = tabs.createEl('button', {
            text: t.previewTab || 'Preview',
            cls: 'ai-organiser-vision-edit-tab'
        });
        this.previewTab.onclick = () => this.setMode('preview');
    }

    /** Idempotent mode setter — no-ops when already in the target mode so
     *  rapid tab clicks don't trigger overlapping preview renders. */
    private setMode(target: EditMode): void {
        if (this.mode === target) return;
        this.mode = target;
        this.updateMode();
    }

    private renderEditPane(parent: HTMLElement): void {
        this.textareaEl = parent.createEl('textarea', {
            cls: 'ai-organiser-vision-edit-textarea',
        });
        this.textareaEl.value = this.draftMarkdown;
        this.textareaEl.addEventListener('input', () => {
            this.draftMarkdown = this.textareaEl?.value ?? '';
            this.refreshInsertButtonState();
        });
    }

    private renderPreviewPane(parent: HTMLElement): void {
        this.previewEl = parent.createEl('div', { cls: 'ai-organiser-vision-edit-preview' });
    }

    private updateMode(): void {
        if (!this.textareaEl || !this.previewEl || !this.editTab || !this.previewTab) return;
        if (this.mode === 'edit') {
            this.editTab.addClass('is-active');
            this.previewTab.removeClass('is-active');
            this.textareaEl.removeClass('ai-organiser-hidden');
            this.previewEl.addClass('ai-organiser-hidden');
        } else {
            this.editTab.removeClass('is-active');
            this.previewTab.addClass('is-active');
            this.textareaEl.addClass('ai-organiser-hidden');
            this.previewEl.removeClass('ai-organiser-hidden');
            void this.refreshPreview();
        }
    }

    private async refreshPreview(): Promise<void> {
        if (!this.previewEl) return;
        // Bump generation BEFORE clearing — any in-flight render finishing
        // after this point sees a stale token and bails before appending.
        const myToken = ++this.renderToken;

        // Unload any previous render's child Component. MarkdownRenderer
        // attaches Mermaid/math/Dataview children to the Component we pass
        // in; without explicit unload they'd keep their event listeners and
        // leak memory on every tab toggle. unload() is idempotent in Obsidian
        // so the modal's onClose this.component.unload() can safely fire it
        // again on already-unloaded children at teardown.
        const previous = this.previewComponent;
        if (previous) {
            this.previewComponent = null;
            previous.unload();
        }

        this.previewEl.empty();

        // Fresh component for this render. Adding it as a child of the modal-
        // scoped this.component means modal close (this.component.unload())
        // still tears down the current render's children even if we never
        // called refreshPreview again. addChild also handles load().
        const renderComponent = new Component();
        this.previewComponent = renderComponent;
        this.component.addChild(renderComponent);

        try {
            await MarkdownRenderer.render(
                this.plugin.app,
                this.draftMarkdown,
                this.previewEl,
                '',
                renderComponent
            );
            // Stale render — a newer refreshPreview superseded us during await.
            // MarkdownRenderer.render appends to the container, so on staleness
            // the safe action is to clear ours; the newer render has already
            // emptied + populated (or is about to). Without this guard, rapid
            // tab clicks would stack overlapping markdown/Mermaid copies.
            if (myToken !== this.renderToken) {
                this.previewEl.empty();
                return;
            }
        } catch (error) {
            if (myToken !== this.renderToken) return;
            logger.error('Digitise', 'Markdown render error:', error);
            // Mermaid syntax error or render failure — fall back to raw text
            // pane (matches prior behaviour) so the user still sees the
            // markdown they're editing.
            this.previewEl.empty();
            const pre = this.previewEl.createEl('pre', { cls: 'vision-preview-error' });
            pre.createEl('div', {
                cls: 'callout callout-warning',
                text: 'Render error — showing raw output below:'
            });
            pre.createEl('code', { text: this.draftMarkdown });
        }
    }

    private refreshInsertButtonState(): void {
        if (!this.insertButtonEl) return;
        const empty = this.draftMarkdown.trim().length === 0;
        this.insertButtonEl.disabled = empty;
        if (empty) {
            this.insertButtonEl.setAttribute('title', 'Nothing to insert');
        } else {
            this.insertButtonEl.removeAttribute('title');
        }
    }

    private handleInsert(): void {
        if (this.draftMarkdown.trim().length === 0) return;
        // Only finalize on confirmed insertion — if no active markdown view
        // we leave the modal open with a toast so the user can correct state
        // (e.g. focus a note) and retry rather than silently dropping the work.
        const ok = this.insertIntoNote(this.draftMarkdown);
        if (!ok) {
            new Notice(this.plugin.t.digitisation.noActiveView || 'Open a note first, then click insert.');
            return;
        }
        this.fireAction('insert');
        this.close();
    }

    private async handleCopy(): Promise<void> {
        try {
            await navigator.clipboard.writeText(this.draftMarkdown);
        } catch (error) {
            logger.warn('Digitise', 'Clipboard write failed', error);
            new Notice(this.plugin.t.digitisation.copyFailed || 'Could not copy to clipboard.');
            return;
        }
        this.fireAction('copy');
        this.close();
    }

    private handleDiscard(): void {
        if (!this.isDirty) {
            this.fireAction('discard');
            this.close();
            return;
        }
        const t = this.plugin.t.digitisation;
        new ConfirmationModal(
            this.app,
            t.discard || 'Discard',
            t.discardConfirm || 'Discard changes? Your edits will be lost.',
            () => {
                this.fireAction('discard');
                this.close();
            },
            this.plugin,
        ).open();
    }

    private insertIntoNote(markdown: string): boolean {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!activeView) {
            logger.warn('Digitise', 'No active markdown view for insertion');
            return false;
        }
        insertAtCursor(activeView.editor, markdown);
        return true;
    }

    private fireAction(action: DigitiseAction) {
        if (this.actionFired) return;
        this.actionFired = true;
        this.onActionCallback?.(action);
    }

    onClose() {
        const { contentEl } = this;

        // ESC safety: fire discard if no action taken. Note: ESC bypasses the
        // dirty-state confirm because Obsidian's modal infrastructure closes
        // the modal before our handler can intervene; this is the same
        // trade-off the rest of the codebase makes for ESC-driven dismissal.
        if (!this.actionFired) {
            this.fireAction('discard');
        }

        this.component.unload();
        contentEl.empty();
    }
}
