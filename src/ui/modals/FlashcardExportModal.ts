/**
 * Flashcard Export Modal
 * Modal for selecting flashcard source, export format, and options.
 * Supports three source types: current note, multiple notes, and screenshot.
 */

import { App, FuzzySuggestModal, Modal, Notice, Setting, TFile } from 'obsidian';
import { logger } from '../../utils/logger';
import type { Translations } from '../../i18n/types';
import {
    FLASHCARD_FORMATS,
    FLASHCARD_STYLES,
    FLASHCARD_SOURCES,
    type FlashcardFormat,
    type FlashcardStyle,
    type FlashcardSource
} from '../../services/prompts/flashcardPrompts';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'heif', 'tiff', 'tif', 'avif']);

/**
 * Discriminated union — TypeScript narrows on `result.source` so each branch
 * gets compile-time access to its required fields (no optional fields).
 */
interface FlashcardExportBase {
    format: FlashcardFormat;
    context: string;
}

export type FlashcardExportResult =
    | (FlashcardExportBase & { source: 'current-note'; style: FlashcardStyle })
    | (FlashcardExportBase & { source: 'multiple-notes'; style: FlashcardStyle; selectedNotes: TFile[] })
    | (FlashcardExportBase & { source: 'screenshot'; style: 'multiple-choice'; imageFile: TFile });

export type FlashcardValidationError = 'noActiveFile' | 'noNotesSelected' | 'noImageSelected' | 'visionUnsupported';

/**
 * Validate modal form state before submission.
 * Extracted as a pure function for testability.
 * Returns an error code (not a user-facing string) — the caller maps to i18n.
 */
export function validateFlashcardExportForm(state: {
    source: FlashcardSource;
    selectedNotes: TFile[];
    imageFile: TFile | null;
    hasActiveFile: boolean;
    visionSupported: boolean;
}): { valid: boolean; errorCode?: FlashcardValidationError } {
    switch (state.source) {
        case 'current-note':
            if (!state.hasActiveFile) return { valid: false, errorCode: 'noActiveFile' };
            return { valid: true };
        case 'multiple-notes':
            if (state.selectedNotes.length === 0) return { valid: false, errorCode: 'noNotesSelected' };
            return { valid: true };
        case 'screenshot':
            if (!state.imageFile) return { valid: false, errorCode: 'noImageSelected' };
            if (!state.visionSupported) return { valid: false, errorCode: 'visionUnsupported' };
            return { valid: true };
    }
}

export class FlashcardExportModal extends Modal {
    private selectedSource: FlashcardSource = 'current-note';
    private selectedFormatId: string = 'anki';
    private selectedStyle: FlashcardStyle = 'standard';
    private context: string = '';
    private readonly selectedNotes: TFile[] = [];
    private imageFile: TFile | null = null;
    private readonly onSubmit: (result: FlashcardExportResult) => void | Promise<void>;
    private readonly t: Translations;
    private readonly visionSupported: boolean;

    constructor(
        app: App,
        translations: Translations,
        visionSupported: boolean,
        onSubmit: (result: FlashcardExportResult) => void | Promise<void>
    ) {
        super(app);
        this.t = translations;
        this.visionSupported = visionSupported;
        this.onSubmit = onSubmit;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.addClass('ai-organiser-modal-content');
        this.renderModal();
    }

    private renderModal(): void {
        const { contentEl } = this;
        contentEl.empty();

        const modalT = this.t.modals.flashcardExport;

        contentEl.createEl('h2', { text: modalT?.title || 'Export flashcards' });

        // Description
        contentEl.createEl('p', {
            text: modalT?.description || 'Generate flashcards from the current note and export to your preferred format.',
            cls: 'setting-item-description'
        });

        // Source selection dropdown
        new Setting(contentEl)
            .setName(modalT?.sourceLabel || 'Source')
            .setDesc(modalT?.sourceDesc || 'Where to get the content for flashcard generation')
            .addDropdown(dropdown => {
                const sourceLabels: Record<FlashcardSource, string> = {
                    'current-note': modalT?.sourceCurrent || 'Current note',
                    'multiple-notes': modalT?.sourceMultiNote || 'Multiple notes',
                    'screenshot': modalT?.sourceScreenshot || 'Screenshot'
                };
                for (const source of FLASHCARD_SOURCES) {
                    dropdown.addOption(source.id, sourceLabels[source.id]);
                }
                dropdown.setValue(this.selectedSource);
                dropdown.onChange(value => {
                    this.selectedSource = value as FlashcardSource;
                    // Lock style for screenshot
                    if (this.selectedSource === 'screenshot') {
                        this.selectedStyle = 'multiple-choice';
                    }
                    this.renderModal();
                });
            });

        // Source-specific section
        this.renderSourceSection(contentEl);

        // Card style selection dropdown (disabled for screenshot)
        new Setting(contentEl)
            .setName(modalT?.styleLabel || 'Card style')
            .setDesc(this.selectedSource === 'screenshot'
                ? (modalT?.screenshotStyleLocked || 'Screenshot source always uses multiple choice style')
                : (modalT?.styleDesc || 'Choose between standard Q&A or multiple choice format'))
            .addDropdown(dropdown => {
                for (const style of FLASHCARD_STYLES) {
                    dropdown.addOption(style.id, `${style.name} - ${style.description}`);
                }
                dropdown.setValue(this.selectedStyle);
                dropdown.setDisabled(this.selectedSource === 'screenshot');
                dropdown.onChange(value => {
                    this.selectedStyle = value as FlashcardStyle;
                });
            });

        // Format selection dropdown
        new Setting(contentEl)
            .setName(modalT?.formatLabel || 'Export format')
            .setDesc(modalT?.formatDesc || 'Choose the flashcard application format')
            .addDropdown(dropdown => {
                for (const format of FLASHCARD_FORMATS) {
                    dropdown.addOption(format.id, `${format.name} - ${format.description}`);
                }
                dropdown.setValue(this.selectedFormatId);
                dropdown.onChange(value => {
                    this.selectedFormatId = value;
                    this.updateMathNotice(contentEl);
                });
            });

        // Math notation notice
        contentEl.createDiv({ cls: 'ai-organiser-math-notice' });
        this.updateMathNotice(contentEl);

        // Optional context textarea
        new Setting(contentEl)
            .setName(modalT?.contextLabel || 'Additional context (optional)')
            .setDesc(modalT?.contextDesc || 'Provide focus areas or specific instructions for card generation')
            .addTextArea(text => {
                text.setPlaceholder(modalT?.contextPlaceholder || 'e.g., "Focus on key definitions and formulas" or "Create cards for exam preparation"')
                    .setValue(this.context)
                    .onChange(value => this.context = value);
                text.inputEl.rows = 3;
                text.inputEl.spellcheck = true;
                text.inputEl.addClass('ai-organiser-w-full');
            });

        // Buttons
        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(this.t.modals.cancel || 'Cancel')
                .onClick(() => this.close())
            )
            .addButton(btn => btn
                .setButtonText(modalT?.exportButton || 'Generate flashcards')
                .setCta()
                .onClick(() => this.submit())
            );
    }

    private renderSourceSection(contentEl: HTMLElement): void {
        const modalT = this.t.modals.flashcardExport;

        switch (this.selectedSource) {
            case 'multiple-notes': {
                // Selected notes list
                const notesContainer = contentEl.createDiv({ cls: 'ai-organiser-selected-notes' });

                if (this.selectedNotes.length > 0) {
                    notesContainer.createEl('div', {
                        text: `${modalT?.selectedNotes || 'Selected notes'} (${this.selectedNotes.length}):`,
                        cls: 'setting-item-description'
                    });
                    const list = notesContainer.createEl('div', { cls: 'ai-organiser-note-list' });
                    for (let i = 0; i < this.selectedNotes.length; i++) {
                        const note = this.selectedNotes[i];
                        const item = list.createEl('div', { cls: 'ai-organiser-note-item' });
                        item.createEl('span', { text: note.path });
                        item.createEl('button', {
                            text: modalT?.removeNote || '×',
                            cls: 'ai-organiser-remove-note'
                        }).addEventListener('click', () => {
                            this.selectedNotes.splice(i, 1);
                            this.renderModal();
                        });
                    }
                } else {
                    notesContainer.createEl('div', {
                        text: modalT?.noNotesSelected || 'No notes selected',
                        cls: 'setting-item-description'
                    });
                }

                new Setting(contentEl)
                    .addButton(btn => btn
                        .setButtonText(`+ ${modalT?.addNote || 'Add note'}`)
                        .onClick(() => this.openNotePicker()));
                break;
            }

            case 'screenshot': {
                // Vision warning
                if (!this.visionSupported) {
                    contentEl.createEl('div', {
                        cls: 'ai-organiser-notice ai-organiser-notice-warning',
                        text: modalT?.visionNotSupported || 'Your LLM provider does not support image analysis.'
                    });
                }

                // Selected image display
                const imageContainer = contentEl.createDiv({ cls: 'ai-organiser-selected-image' });
                if (this.imageFile) {
                    imageContainer.createEl('div', {
                        text: `${modalT?.selectedImage || 'Selected image'}: ${this.imageFile.path}`,
                        cls: 'setting-item-description'
                    });
                } else {
                    imageContainer.createEl('div', {
                        text: modalT?.noImageSelected || 'No image selected',
                        cls: 'setting-item-description'
                    });
                }

                new Setting(contentEl)
                    .addButton(btn => btn
                        .setButtonText(modalT?.selectImage || 'Choose image')
                        .onClick(() => this.openImagePicker()));
                break;
            }

            // 'current-note' needs no extra UI
        }
    }

    private openNotePicker(): void {
        const modal = new (class extends FuzzySuggestModal<TFile> {
            private readonly parentModal: FlashcardExportModal;

            constructor(app: App, parentModal: FlashcardExportModal) {
                super(app);
                this.parentModal = parentModal;
            }

            getItems(): TFile[] {
                return this.app.vault.getMarkdownFiles();
            }

            getItemText(item: TFile): string {
                return item.path;
            }

            onChooseItem(item: TFile): void {
                if (!this.parentModal.selectedNotes.some(n => n.path === item.path)) {
                    this.parentModal.selectedNotes.push(item);
                }
                this.parentModal.renderModal();
            }
        })(this.app, this);

        modal.open();
    }

    private openImagePicker(): void {
        const modal = new (class extends FuzzySuggestModal<TFile> {
            private readonly parentModal: FlashcardExportModal;

            constructor(app: App, parentModal: FlashcardExportModal) {
                super(app);
                this.parentModal = parentModal;
            }

            getItems(): TFile[] {
                return this.app.vault.getFiles().filter(f =>
                    IMAGE_EXTENSIONS.has(f.extension.toLowerCase())
                );
            }

            getItemText(item: TFile): string {
                return item.path;
            }

            onChooseItem(item: TFile): void {
                this.parentModal.imageFile = item;
                this.parentModal.renderModal();
            }
        })(this.app, this);

        modal.open();
    }

    private updateMathNotice(contentEl: HTMLElement): void {
        const noticeEl = contentEl.querySelector('.ai-organiser-math-notice');
        if (!noticeEl) return;

        const format = FLASHCARD_FORMATS.find(f => f.id === this.selectedFormatId);
        const modalT = this.t.modals.flashcardExport;

        noticeEl.empty();

        if (format?.mathSupport === 'mathjax') {
            noticeEl.createEl('div', {
                cls: 'ai-organiser-notice ai-organiser-notice-info',
                text: modalT?.mathNoticeAnki || String.raw`Math will use MathJax notation (\(...\) for inline, \[...\] for display). Ensure Anki has MathJax support enabled.`
            });
        } else if (format?.mathSupport === 'plain') {
            noticeEl.createEl('div', {
                cls: 'ai-organiser-notice ai-organiser-notice-warning',
                text: modalT?.mathNoticeBrainscape || 'Math will use Unicode symbols (Brainscape does not support LaTeX rendering).'
            });
        }
    }

    private async submit(): Promise<void> {
        const format = FLASHCARD_FORMATS.find(f => f.id === this.selectedFormatId);
        if (!format) return;

        // Validate
        const validation = validateFlashcardExportForm({
            source: this.selectedSource,
            selectedNotes: this.selectedNotes,
            imageFile: this.imageFile,
            hasActiveFile: !!this.app.workspace.getActiveFile(),
            visionSupported: this.visionSupported
        });

        if (!validation.valid) {
            const fe = this.t.modals.flashcardExport;
            const errorMessages: Record<FlashcardValidationError, string> = {
                noActiveFile: this.t.messages.openNoteFirst || 'Please open a note first',
                noNotesSelected: fe?.noNotesSelected || 'Please select at least one note',
                noImageSelected: fe?.noImageSelected || 'Please select an image',
                visionUnsupported: fe?.visionNotSupported || 'Vision not supported by current provider'
            };
            new Notice(validation.errorCode ? errorMessages[validation.errorCode] : 'Invalid form state');
            return;
        }

        this.close();

        try {
            const base: FlashcardExportBase = {
                format,
                context: this.context.trim()
            };

            let result: FlashcardExportResult;

            switch (this.selectedSource) {
                case 'current-note':
                    result = { ...base, source: 'current-note', style: this.selectedStyle };
                    break;
                case 'multiple-notes':
                    result = { ...base, source: 'multiple-notes', style: this.selectedStyle, selectedNotes: [...this.selectedNotes] };
                    break;
                case 'screenshot':
                    result = { ...base, source: 'screenshot', style: 'multiple-choice', imageFile: this.imageFile! };
                    break;
            }

            await this.onSubmit(result);
        } catch (error) {
            logger.error('UI', 'Flashcard export error:', error);
            new Notice(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
