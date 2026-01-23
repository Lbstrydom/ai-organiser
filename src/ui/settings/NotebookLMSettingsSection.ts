/**
 * NotebookLM Settings Section
 * Settings UI for configuring NotebookLM source pack exports (PDF-based)
 */

import { Setting, TFolder } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { BaseSettingSection } from './BaseSettingSection';
import type { AIOrganiserSettingTab } from './AIOrganiserSettingTab';

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
            // Get all folders in vault
            const folders = this.getVaultFolders();

            // Add "Create in AI-Organiser/" option
            dropdown.addOption('AI-Organiser/NotebookLM', 'AI-Organiser/NotebookLM (default)');

            // Add existing folders
            for (const folder of folders) {
                if (folder !== 'AI-Organiser/NotebookLM') {
                    dropdown.addOption(folder, folder);
                }
            }

            // Add custom option
            dropdown.addOption('__custom__', '— Custom path —');

            const currentFolder = plugin.settings.notebooklmExportFolder || 'AI-Organiser/NotebookLM';
            const isCustom = !folders.includes(currentFolder) && currentFolder !== 'AI-Organiser/NotebookLM';

            dropdown.setValue(isCustom ? '__custom__' : currentFolder);
            dropdown.onChange(async value => {
                if (value === '__custom__') {
                    // Show text input for custom path
                    this.settingTab.display();
                } else {
                    plugin.settings.notebooklmExportFolder = value;
                    await plugin.saveSettings();
                }
            });
        });

        // Show text input if custom is selected or folder not in list
        const currentFolder = plugin.settings.notebooklmExportFolder || 'AI-Organiser/NotebookLM';
        const folders = this.getVaultFolders();
        const isCustom = !folders.includes(currentFolder) && currentFolder !== 'AI-Organiser/NotebookLM';

        if (isCustom) {
            exportFolderSetting.addText(text =>
                text
                    .setPlaceholder('path/to/export/folder')
                    .setValue(plugin.settings.notebooklmExportFolder)
                    .onChange(async value => {
                        plugin.settings.notebooklmExportFolder = value || 'AI-Organiser/NotebookLM';
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
