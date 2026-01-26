/**
 * NotebookLM Settings Section
 * Settings UI for configuring NotebookLM source pack exports (PDF-based)
 */

import { Setting, TFolder } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { BaseSettingSection } from './BaseSettingSection';
import type { AIOrganiserSettingTab } from './AIOrganiserSettingTab';
import { getNotebookLMExportFullPath } from '../../core/settings';

export class NotebookLMSettingsSection extends BaseSettingSection {
    constructor(
        plugin: AIOrganiserPlugin,
        containerEl: HTMLElement,
        settingTab: AIOrganiserSettingTab
    ) {
        super(plugin, containerEl, settingTab);
    }

    async display(): Promise<void> {
        const { containerEl, plugin } = this;
        const t = plugin.t.settings.notebookLM;

        // Subsection header (under Integrations)
        containerEl.createEl('h2', { text: t?.title || 'NotebookLM Export' });

        // Selection tag
        new Setting(containerEl)
            .setName(t?.selectionTag || 'Selection Tag')
            .setDesc(t?.selectionTagDesc || 'Tag to mark notes for export. Use Ctrl+P → "NotebookLM: Toggle Selection" to tag notes.')
            .addText(text =>
                text
                    .setPlaceholder('notebooklm')
                    .setValue(plugin.settings.notebooklmSelectionTag)
                    .onChange(async value => {
                        plugin.settings.notebooklmSelectionTag = value || 'notebooklm';
                        await plugin.saveSettings();
                    })
            );

        // Export folder - with folder picker
        const exportFolderSetting = new Setting(containerEl)
            .setName(t?.exportFolder || 'Export Folder')
            .setDesc(t?.exportFolderDesc || 'Folder for PDF exports');

        // Add dropdown with existing folders
        exportFolderSetting.addDropdown(dropdown => {
            const folders = this.getVaultFolders();
            const pluginPrefix = `${plugin.settings.pluginFolder}/`;
            const resolvedDefault = getNotebookLMExportFullPath(plugin.settings);
            const currentResolved = getNotebookLMExportFullPath(plugin.settings);

            dropdown.addOption(resolvedDefault, `${resolvedDefault} (default)`);

            for (const folder of folders) {
                if (folder !== resolvedDefault) {
                    dropdown.addOption(folder, folder);
                }
            }

            dropdown.addOption('__custom__', '— Custom path —');

            const isCustom = !folders.includes(currentResolved) && currentResolved !== resolvedDefault;
            dropdown.setValue(isCustom ? '__custom__' : currentResolved);

            dropdown.onChange(async value => {
                if (value === '__custom__') {
                    this.settingTab.display();
                } else {
                    const normalized = value.startsWith(pluginPrefix) ? value.slice(pluginPrefix.length) : value;
                    plugin.settings.notebooklmExportFolder = normalized || 'NotebookLM';
                    await plugin.saveSettings();
                }
            });
        });

        const currentResolved = getNotebookLMExportFullPath(plugin.settings);
        const folders = this.getVaultFolders();
        const resolvedDefault = getNotebookLMExportFullPath(plugin.settings);
        const pluginPrefix = `${plugin.settings.pluginFolder}/`;
        const isCustom = !folders.includes(currentResolved) && currentResolved !== resolvedDefault;

        if (isCustom) {
            exportFolderSetting.addText(text =>
                text
                    .setPlaceholder('NotebookLM')
                    .setValue(plugin.settings.notebooklmExportFolder)
                    .onChange(async value => {
                        const sanitized = (value || 'NotebookLM').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
                        const normalized = sanitized.startsWith(pluginPrefix) ? sanitized.slice(pluginPrefix.length) : sanitized;
                        plugin.settings.notebooklmExportFolder = normalized || 'NotebookLM';
                        await plugin.saveSettings();
                    })
            );
        }

        // Info about PDF export
        const infoBox = containerEl.createDiv({ cls: 'setting-item-description' });
        infoBox.style.marginTop = '12px';
        infoBox.style.padding = '12px';
        infoBox.style.backgroundColor = 'var(--background-secondary)';
        infoBox.style.borderRadius = '6px';
        infoBox.innerHTML = `
            <strong>Why PDF?</strong> NotebookLM can analyze images, diagrams, and formatted content in PDFs.<br>
            <br>
            <em>Use Ctrl+P → "NotebookLM: Export Source Pack" to export tagged notes as PDFs.</em>
        `;

        // === PDF GENERATION SETTINGS ===
        containerEl.createEl('h4', { text: t?.pdfSettingsTitle || 'PDF Generation Settings' });

        // Page size
        new Setting(containerEl)
            .setName(t?.pdfPageSize || 'Page Size')
            .setDesc(t?.pdfPageSizeDesc || 'PDF page dimensions')
            .addDropdown(dropdown =>
                dropdown
                    .addOption('A4', 'A4 (210 × 297 mm)')
                    .addOption('Letter', 'Letter (8.5 × 11 in)')
                    .addOption('Legal', 'Legal (8.5 × 14 in)')
                    .setValue(plugin.settings.notebooklmPdfPageSize)
                    .onChange(async value => {
                        plugin.settings.notebooklmPdfPageSize = value as 'A4' | 'Letter' | 'Legal';
                        await plugin.saveSettings();
                    })
            );

        // Font name
        new Setting(containerEl)
            .setName(t?.pdfFontName || 'Font Name')
            .setDesc(t?.pdfFontNameDesc || 'Font family for PDF text. Supported: helvetica, times, courier')
            .addDropdown(dropdown =>
                dropdown
                    .addOption('helvetica', 'Helvetica (sans-serif)')
                    .addOption('times', 'Times (serif)')
                    .addOption('courier', 'Courier (monospace)')
                    .setValue(plugin.settings.notebooklmPdfFontName)
                    .onChange(async value => {
                        plugin.settings.notebooklmPdfFontName = value;
                        await plugin.saveSettings();
                    })
            );

        // Font size
        new Setting(containerEl)
            .setName(t?.pdfFontSize || 'Font Size')
            .setDesc(t?.pdfFontSizeDesc || 'Base font size in points (9-14 recommended)')
            .addSlider(slider =>
                slider
                    .setLimits(9, 14, 1)
                    .setValue(plugin.settings.notebooklmPdfFontSize)
                    .setDynamicTooltip()
                    .onChange(async value => {
                        plugin.settings.notebooklmPdfFontSize = value;
                        await plugin.saveSettings();
                    })
            );

        // Include frontmatter
        new Setting(containerEl)
            .setName(t?.pdfIncludeFrontmatter || 'Include Frontmatter')
            .setDesc(t?.pdfIncludeFrontmatterDesc || 'Show YAML frontmatter as metadata block in PDF')
            .addToggle(toggle =>
                toggle
                    .setValue(plugin.settings.notebooklmPdfIncludeFrontmatter)
                    .onChange(async value => {
                        plugin.settings.notebooklmPdfIncludeFrontmatter = value;
                        await plugin.saveSettings();
                    })
            );

        // Include title
        new Setting(containerEl)
            .setName(t?.pdfIncludeTitle || 'Include Title')
            .setDesc(t?.pdfIncludeTitleDesc || 'Add note title as H1 heading at top of PDF')
            .addToggle(toggle =>
                toggle
                    .setValue(plugin.settings.notebooklmPdfIncludeTitle)
                    .onChange(async value => {
                        plugin.settings.notebooklmPdfIncludeTitle = value;
                        await plugin.saveSettings();
                    })
            );

        // PDF warning for v1
        const pdfWarningBox = containerEl.createDiv({ cls: 'setting-item-description' });
        pdfWarningBox.style.marginTop = '12px';
        pdfWarningBox.style.padding = '12px';
        pdfWarningBox.style.backgroundColor = 'var(--background-modifier-warning)';
        pdfWarningBox.style.borderRadius = '6px';
        pdfWarningBox.innerHTML = `
            <strong>⚠️ v1 Limitations:</strong><br>
            • Latin alphabet only (CJK/RTL not yet supported)<br>
            • Basic formatting: headings, paragraphs, lists<br>
            • Complex blocks (code, HTML, Dataview) are stripped for clean AI parsing
        `;
    }

    /**
     * Get list of folders in vault for the folder picker
     */
    private getVaultFolders(): string[] {
        const folders: string[] = [];
        const allFiles = this.plugin.app.vault.getAllLoadedFiles();

        for (const file of allFiles) {
            if (file instanceof TFolder && file.path !== '/') {
                folders.push(file.path);
            }
        }

        // Sort alphabetically
        folders.sort((a, b) => a.localeCompare(b));

        return folders;
    }
}
