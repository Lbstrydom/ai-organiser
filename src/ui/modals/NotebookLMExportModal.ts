/**
 * NotebookLM Export Modal
 * Preview modal for NotebookLM source pack export with stats, warnings, and configuration
 */

import { App, Modal, Setting, TFile } from 'obsidian';
import type { Translations } from '../../i18n/types';
import type {
    SourcePackConfig,
    SelectionResult,
    ExportPreview,
    ValidationWarnings
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

        const modalT = this.t.modals.notebookLMExport;

        // Title
        contentEl.createEl('h2', { text: modalT?.title || 'Export Source Pack' });

        // Description
        contentEl.createEl('p', {
            text: modalT?.description || 'Review selection and configure export settings for NotebookLM.',
            cls: 'setting-item-description'
        });

        // Stats section
        this.renderStatsSection(contentEl);

        // Warnings section (if any)
        this.renderWarningsSection(contentEl);

        // Configuration section
        this.renderConfigSection(contentEl);

        // Note list section (collapsible)
        this.renderNoteListSection(contentEl);

        // Buttons
        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(this.t.modals.cancel || 'Cancel')
                .onClick(() => this.close())
            )
            .addButton(btn => btn
                .setButtonText(modalT?.exportButton || 'Export')
                .setCta()
                .onClick(() => this.submit())
            );
    }

    private renderStatsSection(contentEl: HTMLElement): void {
        const modalT = this.t.modals.notebookLMExport;
        const { selection, estimatedModuleCount } = this.preview;

        const statsContainer = contentEl.createDiv({ cls: 'notebooklm-stats-section' });
        statsContainer.createEl('h3', { text: modalT?.statsTitle || 'Selection Summary' });

        const statsGrid = statsContainer.createDiv({ cls: 'notebooklm-stats-grid' });

        // Note count
        this.createStatItem(statsGrid,
            modalT?.noteCount || 'Notes',
            selection.files.length.toString()
        );

        // Word count
        this.createStatItem(statsGrid,
            modalT?.wordCount || 'Words',
            this.formatNumber(selection.estimatedWords)
        );

        // Estimated modules
        this.createStatItem(statsGrid,
            modalT?.moduleCount || 'Modules',
            estimatedModuleCount.toString()
        );

        // Scope
        this.createStatItem(statsGrid,
            modalT?.scope || 'Scope',
            `${selection.selectionMethod}: ${selection.scopeValue}`
        );
    }

    private createStatItem(container: HTMLElement, label: string, value: string): void {
        const item = container.createDiv({ cls: 'notebooklm-stat-item' });
        item.createEl('span', { text: label, cls: 'stat-label' });
        item.createEl('span', { text: value, cls: 'stat-value' });
    }

    private formatNumber(num: number): string {
        return num.toLocaleString();
    }

    private renderWarningsSection(contentEl: HTMLElement): void {
        const { warnings } = this.preview;
        const modalT = this.t.modals.notebookLMExport;

        const hasWarnings = warnings.moduleCountWarning ||
                           warnings.moduleWordLimitWarning ||
                           warnings.moduleSizeLimitWarning ||
                           warnings.totalSizeWarning;

        if (!hasWarnings) return;

        const warningsContainer = contentEl.createDiv({ cls: 'notebooklm-warnings-section' });
        warningsContainer.createEl('h3', { text: modalT?.warningsTitle || 'Warnings' });

        const warningsList = warningsContainer.createEl('ul', { cls: 'notebooklm-warnings-list' });

        if (warnings.moduleCountWarning) {
            this.createWarningItem(warningsList, warnings.moduleCountWarning, 'warning');
        }
        if (warnings.moduleWordLimitWarning) {
            this.createWarningItem(warningsList, warnings.moduleWordLimitWarning, 'warning');
        }
        if (warnings.moduleSizeLimitWarning) {
            this.createWarningItem(warningsList, warnings.moduleSizeLimitWarning, 'warning');
        }
        if (warnings.totalSizeWarning) {
            this.createWarningItem(warningsList, warnings.totalSizeWarning, 'info');
        }
    }

    private createWarningItem(list: HTMLElement, message: string, type: 'warning' | 'info'): void {
        const item = list.createEl('li', { cls: `warning-item warning-${type}` });
        item.createEl('span', { text: message });
    }

    private renderConfigSection(contentEl: HTMLElement): void {
        const modalT = this.t.modals.notebookLMExport;

        const configContainer = contentEl.createDiv({ cls: 'notebooklm-config-section' });
        configContainer.createEl('h3', { text: modalT?.configTitle || 'Export Settings' });

        // Export mode
        new Setting(configContainer)
            .setName(modalT?.exportModeLabel || 'Export Mode')
            .setDesc(modalT?.exportModeDesc || 'How to split notes into modules')
            .addDropdown(dropdown => {
                dropdown
                    .addOption('auto', modalT?.modeAuto || 'Auto (recommended)')
                    .addOption('modular', modalT?.modeModular || 'Modular (split by word budget)')
                    .addOption('single', modalT?.modeSingle || 'Single file')
                    .setValue(this.config.exportMode)
                    .onChange(value => {
                        this.config.exportMode = value as 'auto' | 'modular' | 'single';
                    });
            });

        // Word budget (only show if not single mode)
        new Setting(configContainer)
            .setName(modalT?.wordBudgetLabel || 'Words per Module')
            .setDesc(modalT?.wordBudgetDesc || 'Target word count per module file (max: 500,000)')
            .addText(text => {
                text
                    .setValue(this.config.maxWordsPerModule.toString())
                    .onChange(value => {
                        const num = parseInt(value, 10);
                        if (!isNaN(num) && num > 0 && num <= 500000) {
                            this.config.maxWordsPerModule = num;
                        }
                    });
                text.inputEl.type = 'number';
                text.inputEl.min = '1000';
                text.inputEl.max = '500000';
            });

        // Post-export action
        new Setting(configContainer)
            .setName(modalT?.postExportLabel || 'After Export')
            .setDesc(modalT?.postExportDesc || 'What to do with selection tags after export')
            .addDropdown(dropdown => {
                dropdown
                    .addOption('keep', modalT?.actionKeep || 'Keep tags')
                    .addOption('clear', modalT?.actionClear || 'Clear tags')
                    .addOption('archive', modalT?.actionArchive || 'Archive (rename to notebooklm/exported)')
                    .setValue(this.config.postExportTagAction)
                    .onChange(value => {
                        this.config.postExportTagAction = value as 'keep' | 'clear' | 'archive';
                    });
            });
    }

    private renderNoteListSection(contentEl: HTMLElement): void {
        const modalT = this.t.modals.notebookLMExport;
        const { selection } = this.preview;

        const listContainer = contentEl.createDiv({ cls: 'notebooklm-notes-section' });

        // Collapsible header
        const headerEl = listContainer.createDiv({ cls: 'notes-section-header' });
        headerEl.createEl('h3', {
            text: `${modalT?.notesTitle || 'Notes to Export'} (${selection.files.length})`
        });

        const toggleEl = headerEl.createEl('span', {
            text: modalT?.showNotes || 'Show',
            cls: 'notes-toggle clickable-icon'
        });

        const noteListEl = listContainer.createDiv({ cls: 'notes-list hidden' });

        // Toggle functionality
        toggleEl.addEventListener('click', () => {
            const isHidden = noteListEl.hasClass('hidden');
            if (isHidden) {
                noteListEl.removeClass('hidden');
                toggleEl.setText(modalT?.hideNotes || 'Hide');
            } else {
                noteListEl.addClass('hidden');
                toggleEl.setText(modalT?.showNotes || 'Show');
            }
        });

        // Render note list (max 50 shown)
        const maxShow = 50;
        const files = selection.files as TFile[];

        files.slice(0, maxShow).forEach(file => {
            const noteItem = noteListEl.createDiv({ cls: 'note-list-item' });
            noteItem.createEl('span', { text: file.basename, cls: 'note-name' });
            noteItem.createEl('span', { text: file.path, cls: 'note-path' });
        });

        if (files.length > maxShow) {
            noteListEl.createEl('div', {
                text: `... and ${files.length - maxShow} more notes`,
                cls: 'notes-overflow-message'
            });
        }
    }

    private submit(): void {
        this.close();
        this.onSubmit({
            proceed: true,
            config: this.config
        });
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
