import { App, FuzzySuggestModal, Modal, Notice, Setting, TFile, normalizePath } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { ExportService } from '../../services/export/exportService';
import type { ExportFormat } from '../../services/export/exportService';
import { getExportOutputFullPath } from '../../core/settings';
import { resolveTheme } from '../../services/export/markdownPptxGenerator';
import type { ExportTheme } from '../../services/export/exportTheme';
import { resolveBrandRenderContext } from '../../services/export/brand/brandRenderContext';
import { logger } from '../../utils/logger';
import { FolderScopePickerModal } from './FolderScopePickerModal';

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
        // Default to the source note's parent folder so a meeting note in
        // `0 Inbox/Meetings/2026-05-22 Board Meeting/` exports alongside the
        // transcripts + minutes that already live there (user workflow:
        // one folder per meeting). Falls back to the global export folder
        // when the note is at vault root or no notes are selected yet.
        const sourceFolder = initialNotes[0]?.parent?.path;
        this.outputFolder = (sourceFolder && sourceFolder !== '/')
            ? sourceFolder
            : getExportOutputFullPath(plugin.settings);
    }

    onOpen(): void {
        const { contentEl } = this;
        const t = this.plugin.t;

        contentEl.empty();
        contentEl.addClass('ai-organiser-export-modal');

        // Title
        contentEl.createEl('h2', { text: t.modals.exportNote?.title || 'Export note as\u2026' });

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

        // Output folder — picker button (Gestalt proximity + matches the
        // minutes modal's UX). Replaced the free-text field that let users
        // type a half-typed prefix like "0 Inbox/0 Inbox" with no feedback.
        const outputFolderSetting = new Setting(contentEl)
            .setName(t.modals.exportNote?.outputFolder || 'Output folder');
        const folderDisplayEl = outputFolderSetting.controlEl.createSpan({
            text: this.outputFolder || '—',
            cls: 'ai-organiser-folder-display ai-organiser-mr-8 ai-organiser-text-muted',
        });
        outputFolderSetting.addButton(btn => btn
            .setButtonText(t.modals?.folderScopePicker?.selectButton || 'Select')
            .onClick(() => {
                new FolderScopePickerModal(
                    this.app,
                    this.plugin,
                    {
                        title: t.modals.exportNote?.outputFolder || 'Output folder',
                        allowSkip: false,
                        allowNewFolder: true,
                        defaultFolder: this.outputFolder,
                        // Show the user exactly the folder they pick — no
                        // hidden re-rooting under the plugin output root.
                        onSelect: (folder) => {
                            if (folder) {
                                this.outputFolder = normalizePath(folder);
                                folderDisplayEl.textContent = this.outputFolder;
                            }
                        },
                    },
                ).open();
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

    private async doExport(btn: import('obsidian').ButtonComponent): Promise<void> {
        const t = this.plugin.t;

        if (this.notes.length === 0) {
            new Notice(t.modals.exportNote?.noNotesSelected || 'No notes selected');
            return;
        }

        btn.setDisabled(true);
        btn.setButtonText(t.modals.exportNote?.exporting || 'Exporting...');

        try {
            const theme = await this.resolveExportTheme();
            const exportService = new ExportService(this.app.vault);
            const result = await exportService.exportNotes({
                format: this.format,
                outputFolder: this.outputFolder,
                notes: this.notes,
                includeToc: this.includeToc,
                slideLayout: this.slideLayout,
                theme,
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

    /**
     * Resolve the ExportTheme for this export. When the brand "on by default"
     * setting is on, resolve the brand render context (theme = brand colours +
     * font + min-font when a brand file is present, else the generic example);
     * otherwise the export-settings theme (unchanged). Falls back to the
     * export-settings theme on any resolver error.
     *
     * `onBrandByDefault` is added by the parallel settings task — read
     * defensively so this compiles + degrades to off-brand before it lands.
     */
    private async resolveExportTheme(): Promise<ExportTheme> {
        const s = this.plugin.settings;
        const exportSettingsTheme = resolveTheme(
            s.exportColorScheme, s.exportPrimaryColor, s.exportAccentColor, s.exportFontFace, s.exportFontSize,
            s.exportMinFontBody, s.exportMinFontCaption, s.exportMinFontTable,
        );
        const onBrandByDefault = (s as typeof s & { onBrandByDefault?: boolean }).onBrandByDefault ?? false;
        if (!onBrandByDefault) return exportSettingsTheme;
        try {
            // Markdown/rich exports reference no IR icon concepts, so no icons
            // need rasterizing here — pass an empty concept set. The brand theme
            // (colours + font + min-font) is what these generators consume.
            const result = await resolveBrandRenderContext(this.app, s, true, [], exportSettingsTheme);
            if (!result.ok) {
                logger.warn('Export', `brand theme resolve failed: ${result.error}`);
                return exportSettingsTheme;
            }
            for (const w of result.value.warnings) logger.warn('Export', `brand: ${w}`);
            return result.value.theme;
        } catch (e) {
            logger.warn('Export', `brand theme resolution error: ${e instanceof Error ? e.message : String(e)}`);
            return exportSettingsTheme;
        }
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
