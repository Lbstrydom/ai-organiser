/**
 * NotebookLM Settings Section
 * Settings UI for configuring NotebookLM source pack exports
 */

import { Setting, TFolder } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { BaseSettingSection } from './BaseSettingSection';
import type { AIOrganiserSettingTab } from './AIOrganiserSettingTab';
import { getNotebookLMExportFullPath, getEffectiveOutputRoot } from '../../core/settings';

export class NotebookLMSettingsSection extends BaseSettingSection {
    constructor(
        plugin: AIOrganiserPlugin,
        containerEl: HTMLElement,
        settingTab: AIOrganiserSettingTab
    ) {
        super(plugin, containerEl, settingTab);
    }

    display(): void {
        const { containerEl, plugin } = this;
        const t = plugin.t.settings.notebookLM;

        this.createSectionHeader(t?.title || 'NotebookLM export', 'book-open', 2);

        // Selection tag
        new Setting(containerEl)
            .setName(t?.selectionTag || 'Selection tag')
            .setDesc(t?.selectionTagDesc || 'Tag to mark notes for export. Use Ctrl+P → "NotebookLM: Toggle Selection" to tag notes.')
            .addText(text =>
                text
                    .setPlaceholder('Tag name')
                    .setValue(plugin.settings.notebooklmSelectionTag)
                    .onChange(value => {
                        plugin.settings.notebooklmSelectionTag = value || 'notebooklm';
                        void plugin.saveSettings();
                    })
            );

        // Export folder — dropdown + optional custom path text
        const exportFolderSetting = new Setting(containerEl)
            .setName(t?.exportFolder || 'Export folder')
            .setDesc(t?.exportFolderDesc || 'Folder for exports');

        exportFolderSetting.addDropdown(dropdown => {
            const folders = this.getVaultFolders();
            const pluginPrefix = `${getEffectiveOutputRoot(plugin.settings)}/`;
            const resolvedDefault = getNotebookLMExportFullPath(plugin.settings);
            const currentResolved = getNotebookLMExportFullPath(plugin.settings);

            dropdown.addOption(resolvedDefault, `${resolvedDefault} (default)`);
            for (const folder of folders) {
                if (folder !== resolvedDefault) dropdown.addOption(folder, folder);
            }
            dropdown.addOption('__custom__', '— custom path —');

            const isCustom = !folders.includes(currentResolved) && currentResolved !== resolvedDefault;
            dropdown.setValue(isCustom ? '__custom__' : currentResolved);

            dropdown.onChange(value => {
                if (value === '__custom__') {
                    this.settingTab.display();
                } else {
                    const normalized = value.startsWith(pluginPrefix)
                        ? value.slice(pluginPrefix.length)
                        : value;
                    plugin.settings.notebooklmExportFolder = normalized || 'NotebookLM';
                    void plugin.saveSettings();
                }
            });
        });

        const currentResolved = getNotebookLMExportFullPath(plugin.settings);
        const folders = this.getVaultFolders();
        const resolvedDefault = getNotebookLMExportFullPath(plugin.settings);
        const pluginPrefix = `${getEffectiveOutputRoot(plugin.settings)}/`;
        const isCustom = !folders.includes(currentResolved) && currentResolved !== resolvedDefault;

        if (isCustom) {
            exportFolderSetting.addText(text =>
                text
                    .setPlaceholder('Folder name')
                    .setValue(plugin.settings.notebooklmExportFolder)
                    .onChange(value => {
                        const sanitized = (value || 'NotebookLM').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
                        const normalized = sanitized.startsWith(pluginPrefix)
                            ? sanitized.slice(pluginPrefix.length)
                            : sanitized;
                        plugin.settings.notebooklmExportFolder = normalized || 'NotebookLM';
                        void plugin.saveSettings();
                    })
            );
        }

        // === EXPORT FORMAT ===
        containerEl.createEl('h4', { text: t?.exportFormatTitle || 'Export format' });

        new Setting(containerEl)
            .setName(t?.exportFormat || 'Format')
            .setDesc(t?.exportFormatDesc || 'Text is recommended: it preserves math, code, and Mermaid diagrams. PDF strips these.')
            .addDropdown(dropdown =>
                dropdown
                    .addOption('text', t?.formatText || 'Text (.txt) — recommended')
                    .addOption('pdf', t?.formatPdf || 'PDF (.pdf) — legacy')
                    .setValue(plugin.settings.notebooklmExportFormat)
                    .onChange(async value => {
                        plugin.settings.notebooklmExportFormat = value as 'text' | 'pdf';
                        await plugin.saveSettings();
                        this.settingTab.display(); // re-render to show/hide PDF callout
                    })
            );

        // PDF legacy warning callout (only when PDF selected)
        if (plugin.settings.notebooklmExportFormat === 'pdf') {
            const pdfCallout = containerEl.createDiv({ cls: 'ai-organiser-notebooklm-pdf-callout' });
            pdfCallout.createEl('strong', { text: '⚠ PDF export limitations' });
            pdfCallout.createEl('br');
            pdfCallout.appendText('PDF export strips math equations, Mermaid diagrams, and code blocks. Switch to text format for full content fidelity.');
        }

        // === CONTENT SETTINGS ===
        containerEl.createEl('h4', { text: t?.contentSettingsTitle || 'Content' });

        new Setting(containerEl)
            .setName(t?.includeFrontmatter || 'Include frontmatter')
            .setDesc(t?.includeFrontmatterDesc || 'Include YAML frontmatter in exported files')
            .addToggle(toggle =>
                toggle
                    .setValue(plugin.settings.notebooklmIncludeFrontmatter)
                    .onChange(value => {
                        plugin.settings.notebooklmIncludeFrontmatter = value;
                        void plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName(t?.includeTitle || 'Include title')
            .setDesc(t?.includeTitleDesc || 'Add note title as H1 heading at top of exported file')
            .addToggle(toggle =>
                toggle
                    .setValue(plugin.settings.notebooklmIncludeTitle)
                    .onChange(value => {
                        plugin.settings.notebooklmIncludeTitle = value;
                        void plugin.saveSettings();
                    })
            );

        // === PDF GENERATION SETTINGS (only shown when PDF selected) ===
        if (plugin.settings.notebooklmExportFormat === 'pdf') {
            containerEl.createEl('h4', { text: t?.pdfSettingsTitle || 'PDF generation settings' });

            new Setting(containerEl)
                .setName(t?.pdfPageSize || 'Page size')
                .setDesc(t?.pdfPageSizeDesc || 'PDF page dimensions')
                .addDropdown(dropdown =>
                    dropdown
                        .addOption('A4', 'A4 (210 × 297 mm)')
                        .addOption('Letter', 'Letter (8.5 × 11 in)')
                        .addOption('Legal', 'Legal (8.5 × 14 in)')
                        .setValue(plugin.settings.notebooklmPdfPageSize)
                        .onChange(value => {
                            plugin.settings.notebooklmPdfPageSize = value as 'A4' | 'Letter' | 'Legal';
                            void plugin.saveSettings();
                        })
                );

            new Setting(containerEl)
                .setName(t?.pdfFontName || 'Font name')
                .setDesc(t?.pdfFontNameDesc || 'Font family for PDF text. Supported: helvetica, times, courier')
                .addDropdown(dropdown =>
                    dropdown
                        .addOption('helvetica', 'Helvetica (sans-serif)')
                        .addOption('times', 'Times (serif)')
                        .addOption('courier', 'Courier (monospace)')
                        .setValue(plugin.settings.notebooklmPdfFontName)
                        .onChange(value => {
                            plugin.settings.notebooklmPdfFontName = value;
                            void plugin.saveSettings();
                        })
                );

            new Setting(containerEl)
                .setName(t?.pdfFontSize || 'Font size')
                .setDesc(t?.pdfFontSizeDesc || 'Base font size in points (9–14 recommended)')
                .addSlider(slider =>
                    slider
                        .setLimits(9, 14, 1)
                        .setValue(plugin.settings.notebooklmPdfFontSize)
                        .setDynamicTooltip()
                        .onChange(value => {
                            plugin.settings.notebooklmPdfFontSize = value;
                            void plugin.saveSettings();
                        })
                );
        }

        // Post-export action
        new Setting(containerEl)
            .setName(t?.postExport || 'After export')
            .setDesc(t?.postExportDesc || 'What to do with selection tags after export')
            .addDropdown(dropdown =>
                dropdown
                    .addOption('clear', t?.actionClear || 'Clear tags')
                    .addOption('archive', t?.actionArchive || 'Archive')
                    .setValue(plugin.settings.notebooklmPostExportTagAction)
                    .onChange(value => {
                        plugin.settings.notebooklmPostExportTagAction = value as 'clear' | 'archive';
                        void plugin.saveSettings();
                    })
            );
    }

    private getVaultFolders(): string[] {
        const folders: string[] = [];
        for (const file of this.plugin.app.vault.getAllLoadedFiles()) {
            if (file instanceof TFolder && file.path !== '/') {
                folders.push(file.path);
            }
        }
        return folders.sort((a, b) => a.localeCompare(b));
    }
}
