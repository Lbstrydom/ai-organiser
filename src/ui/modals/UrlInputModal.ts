/**
 * URL Input Modal
 * Modal for entering a URL to summarize with persona selection
 */

import { App, Modal, Setting } from 'obsidian';
import type { Translations } from '../../i18n/types';
import { BUILTIN_PERSONAS, SummaryPersona } from '../../services/prompts/summaryPersonas';

export interface UrlInputResult {
    url: string;
    personaId: string;
}

export class UrlInputModal extends Modal {
    private url: string = '';
    private personaId: string;
    private onSubmit: (result: UrlInputResult) => void;
    private t: Translations;
    private readonly personas: SummaryPersona[];

    constructor(
        app: App,
        translations: Translations,
        defaultPersonaId: string,
        onSubmit: (result: UrlInputResult) => void
    ) {
        super(app);
        this.t = translations;
        this.personaId = defaultPersonaId;
        this.onSubmit = onSubmit;
        this.personas = BUILTIN_PERSONAS;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.addClass('ai-organiser-modal-content');

        contentEl.createEl('h2', { text: this.t.modals.urlInput.title });

        new Setting(contentEl)
            .setName(this.t.modals.urlInput.urlLabel)
            .setDesc(this.t.modals.urlInput.urlDesc)
            .addText(text => {
                text.setPlaceholder(this.t.modals.urlInput.urlPlaceholder)
                    .onChange(value => this.url = value);

                // Handle Enter key
                text.inputEl.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        this.submit();
                    }
                });

                // Focus the input
                setTimeout(() => text.inputEl.focus(), 50);
            });

        // Persona selection dropdown
        new Setting(contentEl)
            .setName(this.t.modals.urlInput.personaLabel || 'Summary Style')
            .setDesc(this.t.modals.urlInput.personaDesc || 'Choose how to format the summary')
            .addDropdown(dropdown => {
                for (const persona of this.personas) {
                    dropdown.addOption(persona.id, persona.name);
                }
                dropdown.setValue(this.personaId);
                dropdown.onChange(value => this.personaId = value);
            });

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(this.t.modals.urlInput.submitButton)
                .setCta()
                .onClick(() => this.submit())
            );
    }

    private submit(): void {
        const trimmedUrl = this.url.trim();
        if (trimmedUrl) {
            this.close();
            this.onSubmit({ url: trimmedUrl, personaId: this.personaId });
        }
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
