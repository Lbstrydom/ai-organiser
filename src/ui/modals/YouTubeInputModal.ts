/**
 * YouTube Input Modal
 * Modal for entering a YouTube URL to summarize with persona selection and optional context
 */

import { App, Modal, Setting } from 'obsidian';
import type { Translations } from '../../i18n/types';
import type { Persona } from '../../services/configurationService';

export interface YouTubeInputResult {
    url: string;
    personaId: string;
    context?: string;  // Optional user context to guide summarization
}

export class YouTubeInputModal extends Modal {
    private url: string = '';
    private personaId: string;
    private context: string = '';
    private readonly onSubmit: (result: YouTubeInputResult) => void;
    private readonly t: Translations;
    private readonly personas: Persona[];

    constructor(
        app: App,
        translations: Translations,
        defaultPersonaId: string,
        personas: Persona[],
        onSubmit: (result: YouTubeInputResult) => void
    ) {
        super(app);
        this.t = translations;
        this.personaId = defaultPersonaId;
        this.onSubmit = onSubmit;
        this.personas = personas;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.addClass('ai-organiser-modal-content');

        contentEl.createEl('h2', { text: this.t.modals.youtubeInput?.title || 'Summarize YouTube Video' });

        // Info notice about captions requirement
        const noticeEl = contentEl.createEl('div', { cls: 'ai-organiser-notice' });
        noticeEl.createEl('p', {
            text: this.t.modals.youtubeInput?.captionNotice ||
                'Note: This feature requires the video to have captions (auto-generated or manual). Videos without captions cannot be summarized.',
            cls: 'setting-item-description'
        });

        new Setting(contentEl)
            .setName(this.t.modals.youtubeInput?.urlLabel || 'YouTube URL')
            .setDesc(this.t.modals.youtubeInput?.urlDesc || 'Enter the YouTube video URL')
            .addText(text => {
                text.setPlaceholder(this.t.modals.youtubeInput?.urlPlaceholder || 'https://www.youtube.com/watch?v=...')
                    .onChange(value => this.url = value);

                // Handle Enter key
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
            .setName(this.t.modals.youtubeInput?.personaLabel || 'Summary Style')
            .setDesc(this.t.modals.youtubeInput?.personaDesc || 'Choose how to format the summary')
            .addDropdown(dropdown => {
                for (const persona of this.personas) {
                    dropdown.addOption(persona.id, persona.name);
                }
                dropdown.setValue(this.personaId);
                dropdown.onChange(value => this.personaId = value);
            });

        // Optional context field
        new Setting(contentEl)
            .setName(this.t.modals.youtubeInput?.contextLabel || 'Additional Context')
            .setDesc(this.t.modals.youtubeInput?.contextDesc || 'Optional: Guide the summary focus (e.g., "focus on the main argument" or "extract actionable tips")')
            .addTextArea(text => {
                text.setPlaceholder(this.t.modals.youtubeInput?.contextPlaceholder || 'e.g., I\'m interested in the coding examples...')
                    .onChange(value => this.context = value);
                text.inputEl.rows = 2;
                text.inputEl.addClass('summary-context-textarea');
            });

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(this.t.modals.youtubeInput?.submitButton || 'Summarize')
                .setCta()
                .onClick(() => this.submit())
            )
            .addButton(btn => btn
                .setButtonText(this.t.modals.cancel)
                .onClick(() => this.close())
            );
    }

    private submit(): void {
        const trimmedUrl = this.url.trim();
        if (trimmedUrl) {
            this.close();
            this.onSubmit({
                url: trimmedUrl,
                personaId: this.personaId,
                context: this.context.trim() || undefined
            });
        }
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
