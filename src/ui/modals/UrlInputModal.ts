/**
 * URL Input Modal
 * Modal for entering a URL to summarize with persona selection and optional context
 */

import { App, Modal, Setting } from 'obsidian';
import type { Translations } from '../../i18n/types';
import type { Persona } from '../../services/configurationService';

export interface UrlInputResult {
    url: string;
    personaId: string;
    context?: string;  // Optional user context to guide summarization
    includeCompanion?: boolean;  // Study companion toggle state
}

export class UrlInputModal extends Modal {
    private url: string = '';
    private personaId: string;
    private context: string = '';
    private includeCompanion = true;
    private onSubmit: (result: UrlInputResult) => void;
    private t: Translations;
    private readonly personas: Persona[];
    private readonly enableStudyCompanion: boolean;
    private companionToggleEl!: HTMLElement;

    constructor(
        app: App,
        translations: Translations,
        defaultPersonaId: string,
        personas: Persona[],
        enableStudyCompanion: boolean,
        onSubmit: (result: UrlInputResult) => void
    ) {
        super(app);
        this.t = translations;
        this.personaId = defaultPersonaId;
        this.onSubmit = onSubmit;
        this.personas = personas;
        this.enableStudyCompanion = enableStudyCompanion;
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

                // Handle Enter key (but not when context field exists)
                text.inputEl.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
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
                dropdown.onChange(value => {
                    this.personaId = value;
                    this.companionToggleEl.toggleClass('ai-organiser-hidden',
                        !(this.enableStudyCompanion && value === 'study'));
                });
            });

        // Companion toggle (visible only when Study persona is selected)
        const companionSetting = new Setting(contentEl)
            .setName(this.t.settings.summarization.enableCompanion || 'Study Companion Notes')
            .setDesc(this.t.settings.summarization.enableCompanionDesc || 'Create a companion note that explains the material in conversational language')
            .addToggle(toggle => toggle
                .setValue(this.includeCompanion)
                .onChange(value => this.includeCompanion = value));
        this.companionToggleEl = companionSetting.settingEl;
        this.companionToggleEl.toggleClass('ai-organiser-hidden',
            !(this.enableStudyCompanion && this.personaId === 'study'));

        // Optional context field
        new Setting(contentEl)
            .setName(this.t.modals.urlInput.contextLabel || 'Additional Context')
            .setDesc(this.t.modals.urlInput.contextDesc || 'Optional: Guide the summary focus (e.g., "focus on the technical details" or "I\'m interested in the business implications")')
            .addTextArea(text => {
                text.setPlaceholder(this.t.modals.urlInput.contextPlaceholder || 'e.g., Focus on the financial implications...')
                    .onChange(value => this.context = value);
                text.inputEl.rows = 2;
                text.inputEl.addClass('summary-context-textarea');
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
            this.onSubmit({
                url: trimmedUrl,
                personaId: this.personaId,
                context: this.context.trim() || undefined,
                includeCompanion: (this.enableStudyCompanion && this.personaId === 'study') ? this.includeCompanion : undefined
            });
        }
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
