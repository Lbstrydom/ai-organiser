/**
 * NotebookLM Export Modal
 *
 * Displays export preview and handles the PDF export workflow for NotebookLM.
 * Shows progress during export and warns about Latin-only font limitation.
 */

import { App, Modal, Setting, ProgressBarComponent } from 'obsidian';
import type { Translations } from '../../i18n/types';
import type {
    SourcePackConfig,
    ExportPreview
} from '../../services/notebooklm/types';

export interface NotebookLMExportResult {
    proceed: boolean;
    config: SourcePackConfig;
}

export type ExportProgressCallback = (current: number, total: number, message: string) => void;

export class NotebookLMExportModal extends Modal {
    private preview: ExportPreview;
    private config: SourcePackConfig;
    private onSubmit: (result: NotebookLMExportResult) => void;
    private t: Translations;

    // Progress UI elements
    private progressContainer: HTMLElement | null = null;
    private progressBar: ProgressBarComponent | null = null;
    private progressMessage: HTMLElement | null = null;
    private exportButton: HTMLButtonElement | null = null;
    private cancelButton: HTMLButtonElement | null = null;
    private isExporting = false;

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
        const mt = this.t.modals.notebookLMExport;
        contentEl.createEl('h2', { text: mt.title });

        // Description
        contentEl.createEl('p', {
            text: mt.description,
            cls: 'setting-item-description'
        });

        // Stats section
        const statsDiv = contentEl.createDiv({ cls: 'notebooklm-stats' });
        statsDiv.createEl('h4', { text: mt.statsTitle });

        statsDiv.createEl('p', {
            text: `${mt.noteCount}: ${this.preview.selection.files.length}`
        });
        statsDiv.createEl('p', {
            text: `${mt.scope}: ${this.preview.selection.scopeValue}`
        });
        statsDiv.createEl('p', {
            text: `Estimated size: ${this.formatBytes(this.preview.estimatedSizeBytes)}`
        });

        // Linked documents
        if (this.preview.linkedDocuments && this.preview.linkedDocuments.length > 0) {
            const countText = this.t.notebooklm?.linkedDocumentsDetected
                ? this.t.notebooklm.linkedDocumentsDetected.replace('{count}', String(this.preview.linkedDocuments.length))
                : `Linked documents: ${this.preview.linkedDocuments.length}`;
            statsDiv.createEl('p', { text: countText });

            const noticeText = this.t.notebooklm?.documentExportNotice || 'Linked documents will be included as separate files';
            statsDiv.createEl('p', { text: noticeText, cls: 'setting-item-description' });
        }

        // Latin-only warning
        const latinWarningDiv = contentEl.createDiv({ cls: 'notebooklm-latin-warning' });
        latinWarningDiv.setCssProps({ '--bg': 'var(--background-modifier-message)' }); latinWarningDiv.addClass('ai-organiser-bg-custom');
        latinWarningDiv.setCssProps({ '--pad': '8px 12px' }); latinWarningDiv.addClass('ai-organiser-pad-custom');
        latinWarningDiv.addClass('ai-organiser-rounded');
        latinWarningDiv.addClass('ai-organiser-mt-12');
        latinWarningDiv.setCssProps({ '--border-left': '3px solid var(--text-warning)' }); latinWarningDiv.addClass('ai-organiser-border-left-custom');

        const warningText = this.t.notebooklm?.latinOnlyWarning ||
            'Note: PDF export currently supports Latin characters only. Non-Latin text (CJK, Arabic, Cyrillic, etc.) may not render correctly.';
        latinWarningDiv.createEl('p', {
            text: warningText,
            cls: 'setting-item-description'
        });

        // Source count / size warnings
        if (this.preview.warnings.sourceCountWarning || this.preview.warnings.totalSizeWarning) {
            const warningsDiv = contentEl.createDiv({ cls: 'notebooklm-warnings' });
            warningsDiv.addClass('ai-organiser-bg-error');
            warningsDiv.setCssProps({ '--pad': '8px 12px' }); warningsDiv.addClass('ai-organiser-pad-custom');
            warningsDiv.addClass('ai-organiser-rounded');
            warningsDiv.addClass('ai-organiser-mt-12');

            if (this.preview.warnings.sourceCountWarning) {
                warningsDiv.createEl('p', { text: this.preview.warnings.sourceCountWarning });
            }
            if (this.preview.warnings.totalSizeWarning) {
                warningsDiv.createEl('p', { text: this.preview.warnings.totalSizeWarning });
            }
        }

        // Post-export action setting
        const settingsDiv = contentEl.createDiv({ cls: 'notebooklm-settings' });
        settingsDiv.addClass('ai-organiser-mt-16');

        new Setting(settingsDiv)
            .setName(mt.postExportLabel)
            .setDesc(mt.postExportDesc)
            .addDropdown(dropdown => dropdown
                .addOption('keep', mt.actionKeep)
                .addOption('clear', mt.actionClear)
                .addOption('archive', mt.actionArchive)
                .setValue(this.config.postExportTagAction)
                .onChange(value => {
                    this.config.postExportTagAction = value as 'keep' | 'clear' | 'archive';
                })
            );

        // Progress container (hidden initially)
        this.progressContainer = contentEl.createDiv({ cls: 'notebooklm-progress' });
        this.progressContainer.addClass('ai-organiser-mt-16');
        this.progressContainer.addClass('ai-organiser-hidden');

        this.progressMessage = this.progressContainer.createEl('p', {
            text: '',
            cls: 'setting-item-description'
        });

        const progressBarDiv = this.progressContainer.createDiv();
        this.progressBar = new ProgressBarComponent(progressBarDiv);
        this.progressBar.setValue(0);

        // Buttons
        const buttonsDiv = contentEl.createDiv({ cls: 'modal-button-container' });
        buttonsDiv.addClass('ai-organiser-mt-20');

        new Setting(buttonsDiv)
            .addButton(btn => {
                this.cancelButton = btn.buttonEl;
                btn
                    .setButtonText(this.t.notebooklm?.cancelButton || 'Cancel')
                    .onClick(() => {
                        this.onSubmit({ proceed: false, config: this.config });
                        this.close();
                    });
            })
            .addButton(btn => {
                this.exportButton = btn.buttonEl;
                btn
                    .setButtonText(mt.exportButton)
                    .setCta()
                    .onClick(() => {
                        if (!this.isExporting) {
                            this.startExport();
                        }
                    });
            });
    }

    /**
     * Start the export process - show progress UI and trigger callback
     */
    private startExport(): void {
        this.isExporting = true;

        // Show progress UI
        if (this.progressContainer) {
            this.progressContainer.addClass('ai-organiser-block');
        }

        // Disable buttons
        if (this.exportButton) {
            this.exportButton.disabled = true;
            this.exportButton.setText('Exporting...');
        }
        if (this.cancelButton) {
            this.cancelButton.disabled = true;
        }

        // Trigger export via callback
        this.onSubmit({ proceed: true, config: this.config });
    }

    /**
     * Update progress UI during export
     */
    updateProgress(current: number, total: number, message: string): void {
        if (this.progressBar) {
            const progress = total > 0 ? (current / total) * 100 : 0;
            this.progressBar.setValue(progress);
        }

        if (this.progressMessage) {
            const progressText = this.t.notebooklm?.exportProgress
                ? this.t.notebooklm.exportProgress
                    .replace('{current}', String(current))
                    .replace('{total}', String(total))
                : `${current} of ${total}`;

            this.progressMessage.setText(`${progressText} - ${message}`);
        }
    }

    /**
     * Show export completion
     */
    showComplete(success: boolean, message?: string): void {
        this.isExporting = false;

        if (this.progressMessage) {
            const completeText = success
                ? (this.t.notebooklm?.exportComplete || 'Export complete!')
                : (message || 'Export failed');
            this.progressMessage.setText(completeText);
        }

        if (this.progressBar) {
            this.progressBar.setValue(100);
        }

        // Re-enable cancel button as "Close"
        if (this.cancelButton) {
            this.cancelButton.disabled = false;
            this.cancelButton.setText('Close');
        }

        // Hide export button
        if (this.exportButton) {
            this.exportButton.addClass('ai-organiser-hidden');
        }
    }

    onClose(): void {
        const { contentEl } = this;
        contentEl.empty();
        this.progressContainer = null;
        this.progressBar = null;
        this.progressMessage = null;
        this.exportButton = null;
        this.cancelButton = null;
    }

    private formatBytes(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
}
