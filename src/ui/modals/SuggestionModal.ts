/**
 * Suggestion Modal
 * Displays AI-suggested title and folder for the note
 */

import { App, Modal, Setting, TFile } from 'obsidian';
import type { Translations } from '../../i18n/types';

export interface SuggestionResult {
    applyTitle: boolean;
    applyFolder: boolean;
    title: string;
    folder: string;
}

export class SuggestionModal extends Modal {
    private suggestedTitle: string;
    private suggestedFolder: string;
    private currentTitle: string;
    private currentFolder: string;
    private applyTitle: boolean = true;
    private applyFolder: boolean = true;
    private readonly onSubmit: (result: SuggestionResult | null) => void;
    private readonly t: Translations;

    constructor(
        app: App,
        translations: Translations,
        file: TFile,
        suggestedTitle: string,
        suggestedFolder: string,
        onSubmit: (result: SuggestionResult | null) => void
    ) {
        super(app);
        this.t = translations;
        this.suggestedTitle = suggestedTitle;
        this.suggestedFolder = suggestedFolder;
        this.currentTitle = file.basename;
        this.currentFolder = file.parent?.path || '';
        this.onSubmit = onSubmit;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.addClass('ai-organiser-modal-content');

        contentEl.createEl('h2', { text: this.t.modals.suggestion?.title || 'AI Suggestions' });

        const descEl = contentEl.createEl('p', { cls: 'setting-item-description' });
        descEl.setText(this.t.modals.suggestion?.description || 'The AI has suggested the following title and folder for this note. Select which suggestions to apply.');

        // Title suggestion
        if (this.suggestedTitle && this.suggestedTitle !== this.currentTitle) {
            const titleContainer = contentEl.createDiv({ cls: 'ai-organiser-suggestion-item' });

            new Setting(titleContainer)
                .setName(this.t.modals.suggestion?.titleLabel || 'Suggested title')
                .setDesc(`${this.t.modals.suggestion?.currentLabel || 'Current'}: ${this.currentTitle}`)
                .addToggle(toggle => toggle
                    .setValue(this.applyTitle)
                    .onChange(value => this.applyTitle = value)
                )
                .addText(text => text
                    .setValue(this.suggestedTitle)
                    .onChange(value => this.suggestedTitle = value)
                );
        } else {
            this.applyTitle = false;
        }

        // Folder suggestion
        if (this.suggestedFolder && this.suggestedFolder !== this.currentFolder) {
            const folderContainer = contentEl.createDiv({ cls: 'ai-organiser-suggestion-item' });

            new Setting(folderContainer)
                .setName(this.t.modals.suggestion?.folderLabel || 'Suggested folder')
                .setDesc(`${this.t.modals.suggestion?.currentLabel || 'Current'}: ${this.currentFolder || '(root)'}`)
                .addToggle(toggle => toggle
                    .setValue(this.applyFolder)
                    .onChange(value => this.applyFolder = value)
                )
                .addText(text => text
                    .setValue(this.suggestedFolder)
                    .onChange(value => this.suggestedFolder = value)
                );
        } else {
            this.applyFolder = false;
        }

        // If neither title nor folder changed, show a message
        if (!this.suggestedTitle && !this.suggestedFolder) {
            contentEl.createEl('p', {
                text: this.t.modals.suggestion?.noSuggestions || 'No title or folder suggestions for this note.',
                cls: 'ai-organiser-no-suggestions'
            });
        }

        // Buttons
        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(this.t.modals.suggestion?.applyButton || 'Apply selected')
                .setCta()
                .onClick(() => {
                    this.close();
                    this.onSubmit({
                        applyTitle: this.applyTitle,
                        applyFolder: this.applyFolder,
                        title: this.suggestedTitle,
                        folder: this.suggestedFolder
                    });
                })
            )
            .addButton(btn => btn
                .setButtonText(this.t.modals.suggestion?.skipButton || 'Skip')
                .onClick(() => {
                    this.close();
                    this.onSubmit(null);
                })
            );
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
