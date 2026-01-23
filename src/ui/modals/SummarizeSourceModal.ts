import { App, Modal, Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';

export type SummarizeSourceOption = 'note' | 'url' | 'pdf' | 'youtube' | 'audio';

interface SourceOption {
    value: SummarizeSourceOption;
    label: string;
    description: string;
    icon: string;
}

export class SummarizeSourceModal extends Modal {
    private plugin: AIOrganiserPlugin;
    private selectedSource: SummarizeSourceOption;
    private onConfirm: (source: SummarizeSourceOption) => void;
    private detectedSource?: SummarizeSourceOption;

    constructor(
        app: App,
        plugin: AIOrganiserPlugin,
        onConfirm: (source: SummarizeSourceOption) => void,
        detectedSource?: SummarizeSourceOption
    ) {
        super(app);
        this.plugin = plugin;
        this.onConfirm = onConfirm;
        this.detectedSource = detectedSource;
        // Pre-select detected source, or fall back to last used, or default to 'note'
        this.selectedSource = detectedSource || this.normalizeSource(plugin.settings.lastSummarizeSource);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('ai-organiser-scope-modal');

        // Title
        contentEl.createEl('h2', {
            text: this.plugin.t.modals.summarizeSource.title,
            cls: 'ai-organiser-scope-title'
        });

        const options: SourceOption[] = [
            {
                value: 'note',
                label: this.plugin.t.modals.summarizeSource.thisNote,
                description: this.plugin.t.modals.summarizeSource.thisNoteDesc || 'Summarize the current note content',
                icon: this.getFileIcon()
            },
            {
                value: 'url',
                label: this.plugin.t.modals.summarizeSource.pasteUrl,
                description: this.plugin.t.modals.summarizeSource.pasteUrlDesc || 'Fetch and summarize a web page',
                icon: this.getLinkIcon()
            },
            {
                value: 'youtube',
                label: this.plugin.t.modals.summarizeSource.youtubeVideo,
                description: this.plugin.t.modals.summarizeSource.youtubeDesc || 'Summarize from video transcript',
                icon: this.getYouTubeIcon()
            },
            {
                value: 'pdf',
                label: this.plugin.t.modals.summarizeSource.selectPdf,
                description: this.plugin.t.modals.summarizeSource.selectPdfDesc || 'Summarize a PDF from your vault',
                icon: this.getPdfIcon()
            },
            {
                value: 'audio',
                label: this.plugin.t.modals.summarizeSource.audioFile,
                description: this.plugin.t.modals.summarizeSource.audioDesc || 'Transcribe and summarize audio',
                icon: this.getAudioIcon()
            }
        ];

        const optionsContainer = contentEl.createDiv({ cls: 'ai-organiser-scope-options' });

        for (const option of options) {
            this.renderOptionCard(optionsContainer, option);
        }

        // Buttons
        const buttonContainer = contentEl.createDiv({ cls: 'ai-organiser-scope-buttons' });
        new Setting(buttonContainer)
            .addButton(btn => btn
                .setButtonText(this.plugin.t.modals.cancel)
                .onClick(() => this.close()))
            .addButton(btn => btn
                .setButtonText(this.plugin.t.modals.summarizeSource.continueButton)
                .setCta()
                .onClick(() => void this.handleConfirm()));
    }

    private renderOptionCard(container: HTMLElement, option: SourceOption): void {
        const isDetected = this.detectedSource === option.value;
        const card = container.createDiv({
            cls: `ai-organiser-scope-card ${option.value === this.selectedSource ? 'selected' : ''}`
        });
        card.dataset.value = option.value;

        // Icon
        const iconEl = card.createDiv({ cls: 'ai-organiser-scope-card-icon' });
        iconEl.innerHTML = option.icon;

        // Content
        const contentEl = card.createDiv({ cls: 'ai-organiser-scope-card-content' });
        const labelEl = contentEl.createDiv({ cls: 'ai-organiser-scope-card-label' });
        labelEl.setText(option.label);
        if (isDetected) {
            labelEl.createSpan({ text: ' (detected)', cls: 'ai-organiser-detected-badge' });
        }
        contentEl.createDiv({ cls: 'ai-organiser-scope-card-desc', text: option.description });

        // Hidden radio for accessibility
        const radio = card.createEl('input', {
            type: 'radio',
            cls: 'ai-organiser-scope-radio-hidden',
            attr: { name: 'summarize-source', value: option.value }
        });
        radio.checked = option.value === this.selectedSource;

        // Click handler
        card.addEventListener('click', () => {
            this.selectedSource = option.value;
            // Update visual selection
            container.querySelectorAll('.ai-organiser-scope-card').forEach(c => {
                c.removeClass('selected');
                (c.querySelector('input') as HTMLInputElement).checked = false;
            });
            card.addClass('selected');
            radio.checked = true;
        });
    }

    private getFileIcon(): string {
        return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>`;
    }

    private getLinkIcon(): string {
        return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>`;
    }

    private getYouTubeIcon(): string {
        return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22.54 6.42a2.78 2.78 0 0 0-1.94-2C18.88 4 12 4 12 4s-6.88 0-8.6.46a2.78 2.78 0 0 0-1.94 2A29 29 0 0 0 1 11.75a29 29 0 0 0 .46 5.33A2.78 2.78 0 0 0 3.4 19c1.72.46 8.6.46 8.6.46s6.88 0 8.6-.46a2.78 2.78 0 0 0 1.94-2 29 29 0 0 0 .46-5.25 29 29 0 0 0-.46-5.33z"></path><polygon points="9.75 15.02 15.5 11.75 9.75 8.48 9.75 15.02"></polygon></svg>`;
    }

    private getPdfIcon(): string {
        return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><path d="M9 15v-2h2c.6 0 1 .4 1 1s-.4 1-1 1H9z"></path><path d="M9 18v-3"></path><path d="M13 18v-6h1.5c.8 0 1.5.7 1.5 1.5v3c0 .8-.7 1.5-1.5 1.5H13z"></path></svg>`;
    }

    private getAudioIcon(): string {
        return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" x2="12" y1="19" y2="22"></line></svg>`;
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private normalizeSource(value: unknown): SummarizeSourceOption {
        switch (value) {
            case 'note':
            case 'url':
            case 'pdf':
            case 'youtube':
            case 'audio':
                return value;
            default:
                return 'note';
        }
    }

    private async handleConfirm(): Promise<void> {
        this.plugin.settings.lastSummarizeSource = this.selectedSource;
        await this.plugin.saveData(this.plugin.settings);
        this.close();
        this.onConfirm(this.selectedSource);
    }
}
