/**
 * Compression Confirm Modal — Phase 5
 * Promise-based modal for offering vault file replacement with compressed version.
 */
import { Modal, Setting } from 'obsidian';
import AIOrganiserPlugin from '../../main';

export type CompressionAction = 'keep-original' | 'keep-compressed' | 'delete';

export interface CompressionChoice {
    action: CompressionAction;
}

export class CompressionConfirmModal extends Modal {
    private choiceMade = false;
    private resolveChoice!: (choice: CompressionChoice) => void;

    constructor(
        private plugin: AIOrganiserPlugin,
        private originalSizeBytes: number,
        private compressedSizeBytes: number | undefined,
        private fileName: string,
        private formatChanged: boolean
    ) {
        super(plugin.app);
    }

    /** Await this after calling open() to get the user's choice. */
    waitForChoice(): Promise<CompressionChoice> {
        return new Promise(resolve => { this.resolveChoice = resolve; });
    }

    onOpen(): void {
        const { contentEl } = this;
        const t = this.plugin.t.compression;
        const hasCompressed = this.compressedSizeBytes != null && this.compressedSizeBytes > 0;

        contentEl.empty();
        contentEl.addClass('ai-organiser-modal-content');

        contentEl.createEl('h2', {
            text: hasCompressed
                ? (t?.confirmTitle || 'Replace Original File?')
                : (t?.postTranscriptionTitle || 'What to do with the audio file?')
        });

        // Stats
        const statsEl = contentEl.createEl('div', { cls: 'ai-organiser-compression-stats' });
        statsEl.createEl('p', {
            text: `${t?.originalSize || 'Original size'}: ${this.formatBytes(this.originalSizeBytes)}`
        });

        if (hasCompressed) {
            const savings = this.originalSizeBytes > 0
                ? Math.round((1 - this.compressedSizeBytes! / this.originalSizeBytes) * 100)
                : 0;
            statsEl.createEl('p', {
                text: `${t?.compressedSize || 'Compressed size'}: ${this.formatBytes(this.compressedSizeBytes!)}`
            });
            statsEl.createEl('p', {
                text: `${t?.savings || 'Space saved'}: ${savings}%`,
                cls: 'ai-organiser-compression-savings'
            });
        }

        // Backlink migration note (only when format changes and compressed available)
        if (hasCompressed && this.formatChanged) {
            const noteEl = contentEl.createEl('div', { cls: 'ai-organiser-compression-note' });
            noteEl.createEl('p', {
                text: t?.backlinkNote || 'All backlinks and embeds will be automatically updated.'
            });
        }

        // Buttons
        const btnSetting = new Setting(contentEl);

        btnSetting.addButton(btn => btn
            .setButtonText(t?.keepOriginal || 'Keep original')
            .onClick(() => this.choose('keep-original')));

        if (hasCompressed) {
            btnSetting.addButton(btn => btn
                .setButtonText(t?.replaceOriginal || 'Replace with compressed')
                .setCta()
                .onClick(() => this.choose('keep-compressed')));
        }

        btnSetting.addButton(btn => btn
            .setButtonText(t?.deleteAudio || 'Delete audio')
            .setWarning()
            .onClick(() => this.choose('delete')));
    }

    onClose(): void {
        this.contentEl.empty();
        // ESC safety: treat as "keep original"
        if (!this.choiceMade) {
            this.choiceMade = true;
            this.resolveChoice({ action: 'keep-original' });
        }
    }

    private choose(action: CompressionAction): void {
        this.choiceMade = true;
        this.close();
        this.resolveChoice({ action });
    }

    private formatBytes(bytes: number): string {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
    }
}
