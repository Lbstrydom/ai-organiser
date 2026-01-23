/**
 * Flashcard Export Modal
 * Modal for selecting flashcard export format and optional context
 */

import { App, Modal, Notice, Setting } from 'obsidian';
import type { Translations } from '../../i18n/types';
import { FLASHCARD_FORMATS, FLASHCARD_STYLES, type FlashcardFormat, type FlashcardStyle } from '../../services/prompts/flashcardPrompts';

export interface FlashcardExportResult {
    format: FlashcardFormat;
    style: FlashcardStyle;
    context: string;
}

export class FlashcardExportModal extends Modal {
    private selectedFormatId: string = 'anki';
    private selectedStyle: FlashcardStyle = 'standard';
    private context: string = '';
    private onSubmit: (result: FlashcardExportResult) => void | Promise<void>;
    private t: Translations;

    constructor(
        app: App,
        translations: Translations,
        onSubmit: (result: FlashcardExportResult) => void | Promise<void>
    ) {
        super(app);
        this.t = translations;
        this.onSubmit = onSubmit;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.addClass('ai-organiser-modal-content');

        const modalT = this.t.modals.flashcardExport;

        contentEl.createEl('h2', { text: modalT?.title || 'Export Flashcards' });

        // Description
        contentEl.createEl('p', {
            text: modalT?.description || 'Generate flashcards from the current note and export to your preferred format.',
            cls: 'setting-item-description'
        });

        // Card style selection dropdown
        new Setting(contentEl)
            .setName(modalT?.styleLabel || 'Card Style')
            .setDesc(modalT?.styleDesc || 'Choose between standard Q&A or multiple choice format')
            .addDropdown(dropdown => {
                for (const style of FLASHCARD_STYLES) {
                    dropdown.addOption(style.id, `${style.name} - ${style.description}`);
                }
                dropdown.setValue(this.selectedStyle);
                dropdown.onChange(value => {
                    this.selectedStyle = value as FlashcardStyle;
                });
            });

        // Format selection dropdown
        new Setting(contentEl)
            .setName(modalT?.formatLabel || 'Export Format')
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
        const mathNoticeEl = contentEl.createDiv({ cls: 'ai-organiser-math-notice' });
        this.updateMathNotice(contentEl);

        // Optional context textarea
        new Setting(contentEl)
            .setName(modalT?.contextLabel || 'Additional Context (Optional)')
            .setDesc(modalT?.contextDesc || 'Provide focus areas or specific instructions for card generation')
            .addTextArea(text => {
                text.setPlaceholder(modalT?.contextPlaceholder || 'e.g., "Focus on key definitions and formulas" or "Create cards for exam preparation"')
                    .setValue(this.context)
                    .onChange(value => this.context = value);
                text.inputEl.rows = 3;
                text.inputEl.style.width = '100%';
            });

        // Buttons
        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(this.t.modals.cancel || 'Cancel')
                .onClick(() => this.close())
            )
            .addButton(btn => btn
                .setButtonText(modalT?.exportButton || 'Generate Flashcards')
                .setCta()
                .onClick(() => this.submit())
            );
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
                text: modalT?.mathNoticeAnki || 'Math will use MathJax notation (\\(...\\) for inline, \\[...\\] for display). Ensure Anki has MathJax support enabled.'
            });
        } else if (format?.mathSupport === 'plain') {
            noticeEl.createEl('div', {
                cls: 'ai-organiser-notice ai-organiser-notice-warning',
                text: modalT?.mathNoticeBrainscape || 'Math will be converted to plain text (Brainscape does not support LaTeX rendering).'
            });
        }
    }

    private async submit(): Promise<void> {
        const format = FLASHCARD_FORMATS.find(f => f.id === this.selectedFormatId);
        if (format) {
            this.close();
            try {
                await this.onSubmit({
                    format,
                    style: this.selectedStyle,
                    context: this.context.trim()
                });
            } catch (error) {
                console.error('[AI Organiser] Flashcard export error:', error);
                new Notice(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
        }
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
