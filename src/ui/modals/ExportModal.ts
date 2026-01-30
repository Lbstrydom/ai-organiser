import { App, Modal, Notice, Setting, TFile } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { ExportService } from '../../services/export/exportService';
import type { ExportFormat } from '../../services/export/exportService';
import { getExportOutputFullPath } from '../../core/settings';

export class ExportModal extends Modal {
    private plugin: AIOrganiserPlugin;
    private format: ExportFormat = 'pdf';
    private notes: TFile[];
    private outputFolder: string;
    private includeToc: boolean = false;
    private slideLayout: 'title-content' | 'blank' = 'title-content';

    constructor(app: App, plugin: AIOrganiserPlugin, initialNotes: TFile[]) {
        super(app);
        this.plugin = plugin;
        this.notes = initialNotes;
        this.outputFolder = getExportOutputFullPath(plugin.settings);
    }

    onOpen(): void {
        const { contentEl } = this;
        const t = this.plugin.t;

        contentEl.empty();
        contentEl.addClass('ai-organiser-export-modal');

        // Title
        contentEl.createEl('h2', { text: t.modals.exportNote?.title || 'Export Note' });

        // Format selector
        new Setting(contentEl)
            .setName(t.modals.exportNote?.format || 'Format')
            .addDropdown(dropdown => dropdown
                .addOption('pdf', t.modals.exportNote?.formatPdf ?? 'PDF (.pdf)')
                .addOption('docx', t.modals.exportNote?.formatDocx ?? 'Word (.docx)')
                .addOption('pptx', t.modals.exportNote?.formatPptx || 'PowerPoint (.pptx)')
                .setValue(this.format)
                .onChange((value) => {
                    this.format = value as ExportFormat;
                    this.renderFormatOptions();
                }));

        // Notes display
        const noteNames = this.notes.map(n => n.basename).join(', ');
        new Setting(contentEl)
            .setName(t.modals.exportNote?.selectNotes || 'Notes to export')
            .setDesc(noteNames || t.modals.exportNote?.noNotesSelected || 'No notes selected');

        // Add note selection button for multi-note
        new Setting(contentEl)
            .setName(t.modals.exportNote?.multipleNotes || 'Select notes...')
            .addButton(btn => btn
                .setButtonText('+')
                .onClick(() => {
                    this.openNotePicker();
                }));

        // Output folder
        new Setting(contentEl)
            .setName(t.modals.exportNote?.outputFolder || 'Output folder')
            .addText(text => text
                .setPlaceholder('Exports')
                .setValue(this.outputFolder)
                .onChange((value) => {
                    this.outputFolder = value.trim() || 'Exports';
                }));

        // Format-specific options container
        contentEl.createDiv({ cls: 'ai-organiser-export-options' });
        this.renderFormatOptions();

        // Export button
        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(t.modals.exportNote?.exportButton || 'Export')
                .setCta()
                .onClick(async () => {
                    await this.doExport(btn);
                }));
    }

    private renderFormatOptions(): void {
        const target = this.contentEl.querySelector('.ai-organiser-export-options') as HTMLElement;
        if (!target) return;
        target.empty();

        const t = this.plugin.t;

        if (this.format === 'docx') {
            new Setting(target)
                .setName(t.modals.exportNote?.includeToc || 'Include table of contents')
                .setDesc(t.modals.exportNote?.includeTocDesc || 'Add a table of contents at the start of the document')
                .addToggle(toggle => toggle
                    .setValue(this.includeToc)
                    .onChange((value) => {
                        this.includeToc = value;
                    }));
        } else if (this.format === 'pptx') {
            new Setting(target)
                .setName(t.modals.exportNote?.slideLayout || 'Slide layout')
                .addDropdown(dropdown => dropdown
                    .addOption('title-content', t.modals.exportNote?.slideLayoutTitleContent || 'Title + Content')
                    .addOption('blank', t.modals.exportNote?.slideLayoutBlank || 'Blank')
                    .setValue(this.slideLayout)
                    .onChange((value) => {
                        this.slideLayout = value as 'title-content' | 'blank';
                    }));
        }
        // PDF has no extra options
    }

    private openNotePicker(): void {
        const { FuzzySuggestModal } = require('obsidian');

        const modal = new (class extends FuzzySuggestModal<TFile> {
            private parentModal: ExportModal;

            constructor(app: App, parentModal: ExportModal) {
                super(app);
                this.parentModal = parentModal;
            }

            getItems(): TFile[] {
                return this.app.vault.getMarkdownFiles();
            }

            getItemText(item: TFile): string {
                return item.path;
            }

            onChooseItem(item: TFile): void {
                if (!this.parentModal.notes.some(n => n.path === item.path)) {
                    this.parentModal.notes.push(item);
                }
                this.parentModal.onOpen();
            }
        })(this.app, this);

        modal.open();
    }

    private async doExport(btn: any): Promise<void> {
        const t = this.plugin.t;

        if (this.notes.length === 0) {
            new Notice(t.modals.exportNote?.noNotesSelected || 'No notes selected');
            return;
        }

        btn.setDisabled(true);
        btn.setButtonText(t.modals.exportNote?.exporting || 'Exporting...');

        try {
            const exportService = new ExportService(this.app.vault);
            const result = await exportService.exportNotes({
                format: this.format,
                outputFolder: this.outputFolder,
                notes: this.notes,
                includeToc: this.includeToc,
                slideLayout: this.slideLayout,
            });

            const successMsg = (t.modals.exportNote?.success || 'Exported to {path}')
                .replace('{path}', result.filePath);
            new Notice(successMsg, 5000);
            this.close();
        } catch (error) {
            const errorMsg = (t.modals.exportNote?.error || 'Export failed: {error}')
                .replace('{error}', (error as Error).message);
            new Notice(errorMsg, 5000);
            btn.setDisabled(false);
            btn.setButtonText(t.modals.exportNote?.exportButton || 'Export');
        }
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
