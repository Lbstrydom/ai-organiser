import { App, Modal, Setting, setIcon } from 'obsidian';
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
                icon: 'file-text'
            },
            {
                value: 'url',
                label: this.plugin.t.modals.summarizeSource.pasteUrl,
                description: this.plugin.t.modals.summarizeSource.pasteUrlDesc || 'Fetch and summarize a web page',
                icon: 'link'
            },
            {
                value: 'youtube',
                label: this.plugin.t.modals.summarizeSource.youtubeVideo,
                description: this.plugin.t.modals.summarizeSource.youtubeDesc || 'Summarize from video transcript',
                icon: 'youtube'
            },
            {
                value: 'pdf',
                label: this.plugin.t.modals.summarizeSource.selectPdf,
                description: this.plugin.t.modals.summarizeSource.selectPdfDesc || 'Summarize a PDF from your vault',
                icon: 'file-type'
            },
            {
                value: 'audio',
                label: this.plugin.t.modals.summarizeSource.audioFile,
                description: this.plugin.t.modals.summarizeSource.audioDesc || 'Transcribe and summarize audio',
                icon: 'mic'
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
        setIcon(iconEl, option.icon);

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
