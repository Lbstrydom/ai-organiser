import { App, Modal, Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';

export type SummarizeSourceOption = 'note' | 'url' | 'pdf' | 'youtube' | 'audio';

export class SummarizeSourceModal extends Modal {
    private plugin: AIOrganiserPlugin;
    private selectedSource: SummarizeSourceOption;
    private onConfirm: (source: SummarizeSourceOption) => void;

    constructor(
        app: App,
        plugin: AIOrganiserPlugin,
        onConfirm: (source: SummarizeSourceOption) => void
    ) {
        super(app);
        this.plugin = plugin;
        this.onConfirm = onConfirm;
        this.selectedSource = this.normalizeSource(plugin.settings.lastSummarizeSource);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('ai-organiser-modal-content');

        contentEl.createEl('h2', { text: this.plugin.t.modals.summarizeSource.title });

        const options: { value: SummarizeSourceOption; label: string }[] = [
            { value: 'note', label: this.plugin.t.modals.summarizeSource.thisNote },
            { value: 'url', label: this.plugin.t.modals.summarizeSource.pasteUrl },
            { value: 'pdf', label: this.plugin.t.modals.summarizeSource.selectPdf },
            { value: 'youtube', label: this.plugin.t.modals.summarizeSource.youtubeVideo },
            { value: 'audio', label: this.plugin.t.modals.summarizeSource.audioFile }
        ];

        const radioGroup = contentEl.createDiv({ cls: 'ai-organiser-summarize-source-options' });

        for (const option of options) {
            const optionEl = radioGroup.createDiv({ cls: 'ai-organiser-summarize-source-option' });
            const input = optionEl.createEl('input', {
                type: 'radio',
                attr: { name: 'summarize-source', value: option.value }
            });
            if (option.value === this.selectedSource) {
                input.checked = true;
            }

            optionEl.createEl('label', { text: option.label });

            input.addEventListener('change', () => {
                this.selectedSource = option.value;
            });
        }

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(this.plugin.t.modals.cancel)
                .onClick(() => this.close()))
            .addButton(btn => btn
                .setButtonText(this.plugin.t.modals.summarizeSource.continueButton)
                .setCta()
                .onClick(() => void this.handleConfirm()));
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
