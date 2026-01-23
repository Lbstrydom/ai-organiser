/**
 * NotebookLM Export Modal
 *
 * NOTE: This modal is a placeholder for future PDF export functionality.
 * The actual PDF export is not yet implemented.
 */

import { App, Modal, Setting } from 'obsidian';
import type { Translations } from '../../i18n/types';
import type {
    SourcePackConfig,
    ExportPreview
} from '../../services/notebooklm/types';

export interface NotebookLMExportResult {
    proceed: boolean;
    config: SourcePackConfig;
}

export class NotebookLMExportModal extends Modal {
    private preview: ExportPreview;
    private config: SourcePackConfig;
    private onSubmit: (result: NotebookLMExportResult) => void;
    private t: Translations;

    constructor(
        app: App,
        translations: Translations,
        preview: ExportPreview,
        onSubmit: (result: NotebookLMExportResult) => void
    ) {
        super(app);
        this.t = translations;
        this.preview = preview;
        this.config = { ...preview.config };
        this.onSubmit = onSubmit;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.addClass('ai-organiser-modal-content');
        contentEl.addClass('notebooklm-export-modal');

        // Title
        contentEl.createEl('h2', { text: 'Export Source Pack (PDF)' });

        // Description
        contentEl.createEl('p', {
            text: 'Export selected notes as PDFs for NotebookLM upload.',
            cls: 'setting-item-description'
        });

        // Stats
        const statsDiv = contentEl.createDiv({ cls: 'notebooklm-stats' });
        statsDiv.createEl('p', {
            text: `Notes selected: ${this.preview.selection.files.length}`
        });
        statsDiv.createEl('p', {
            text: `Estimated size: ${this.formatBytes(this.preview.estimatedSizeBytes)}`
        });

        // Warnings
        if (this.preview.warnings.sourceCountWarning || this.preview.warnings.totalSizeWarning) {
            const warningsDiv = contentEl.createDiv({ cls: 'notebooklm-warnings' });
            warningsDiv.style.backgroundColor = 'var(--background-modifier-error)';
            warningsDiv.style.padding = '8px';
            warningsDiv.style.borderRadius = '4px';
            warningsDiv.style.marginTop = '12px';

            if (this.preview.warnings.sourceCountWarning) {
                warningsDiv.createEl('p', { text: this.preview.warnings.sourceCountWarning });
            }
            if (this.preview.warnings.totalSizeWarning) {
                warningsDiv.createEl('p', { text: this.preview.warnings.totalSizeWarning });
            }
        }

        // Coming soon notice
        const noticeDiv = contentEl.createDiv({ cls: 'notebooklm-notice' });
        noticeDiv.style.marginTop = '20px';
        noticeDiv.style.padding = '12px';
        noticeDiv.style.backgroundColor = 'var(--background-secondary)';
        noticeDiv.style.borderRadius = '6px';
        noticeDiv.createEl('p', {
            text: 'PDF export is coming soon. For now, use Obsidian\'s "Export to PDF" feature manually.',
            cls: 'setting-item-description'
        });

        // Buttons
        const buttonsDiv = contentEl.createDiv({ cls: 'modal-button-container' });
        buttonsDiv.style.marginTop = '20px';

        new Setting(buttonsDiv)
            .addButton(btn => btn
                .setButtonText('Close')
                .onClick(() => {
                    this.onSubmit({ proceed: false, config: this.config });
                    this.close();
                })
            );
    }

    onClose(): void {
        const { contentEl } = this;
        contentEl.empty();
    }

    private formatBytes(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
}
