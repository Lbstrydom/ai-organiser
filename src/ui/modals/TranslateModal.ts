/**
 * Translate Modal
 * Modal for selecting target language for translation
 */

import { App, Modal, Setting } from 'obsidian';
import type { Translations } from '../../i18n/types';
import { COMMON_LANGUAGES, getLanguageDisplayName } from '../../services/languages';

export interface TranslateResult {
    targetLanguage: string;
    targetLanguageName: string;
    insertAtCursor: boolean;
}

export class TranslateModal extends Modal {
    private targetLanguage: string = 'en';
    private insertAtCursorEnabled = false;
    private readonly onSubmit: (result: TranslateResult) => void;
    private readonly t: Translations;

    constructor(
        app: App,
        translations: Translations,
        onSubmit: (result: TranslateResult) => void
    ) {
        super(app);
        this.t = translations;
        this.onSubmit = onSubmit;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.addClass('ai-organiser-modal-content');

        contentEl.createEl('h2', { text: this.t.modals.translate?.title || 'Translate Note' });

        contentEl.createEl('p', {
            text: this.t.modals.translate?.description || 'Select the target language for translation. The entire note content will be translated.',
            cls: 'setting-item-description'
        });

        // Language selection dropdown (exclude 'auto' option)
        new Setting(contentEl)
            .setName(this.t.modals.translate?.languageLabel || 'Target Language')
            .setDesc(this.t.modals.translate?.languageDesc || 'The language to translate the note into')
            .addDropdown(dropdown => {
                for (const lang of COMMON_LANGUAGES) {
                    if (lang.code !== 'auto') {
                        dropdown.addOption(lang.code, getLanguageDisplayName(lang));
                    }
                }
                dropdown.setValue(this.targetLanguage);
                dropdown.onChange(value => this.targetLanguage = value);
            });

        // Insert at cursor toggle
        new Setting(contentEl)
            .setName(this.t.modals.translate?.insertAtCursor || 'Insert at cursor')
            .setDesc(this.t.modals.translate?.insertAtCursorDesc || 'Add translation at cursor instead of replacing note')
            .addToggle(toggle => toggle
                .setValue(this.insertAtCursorEnabled)
                .onChange(value => this.insertAtCursorEnabled = value));

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(this.t.modals.translate?.translateButton || 'Translate')
                .setCta()
                .onClick(() => this.submit())
            )
            .addButton(btn => btn
                .setButtonText(this.t.modals.cancel)
                .onClick(() => this.close())
            );
    }

    private submit(): void {
        const lang = COMMON_LANGUAGES.find(l => l.code === this.targetLanguage);
        this.close();
        this.onSubmit({
            targetLanguage: this.targetLanguage,
            targetLanguageName: lang?.name || this.targetLanguage,
            insertAtCursor: this.insertAtCursorEnabled
        });
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
