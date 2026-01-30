import { Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { AIOrganiserSettingTab } from './AIOrganiserSettingTab';
import { BaseSettingSection } from './BaseSettingSection';

export class ExportSettingsSection extends BaseSettingSection {
    constructor(plugin: AIOrganiserPlugin, containerEl: HTMLElement, settingTab: AIOrganiserSettingTab) {
        super(plugin, containerEl, settingTab);
    }

    display(): void {
        const t = this.plugin.t;
        this.createSectionHeader(t.settings.export?.title || 'Document Export', 'file-output');

        if (t.settings.export?.description) {
            this.containerEl.createEl('p', {
                text: t.settings.export.description,
                cls: 'setting-item-description'
            });
        }

        new Setting(this.containerEl)
            .setName(t.settings.export?.outputFolder || 'Output folder')
            .setDesc(t.settings.export?.outputFolderDesc || 'Where to save exported documents')
            .addText(text => text
                .setPlaceholder('Exports')
                .setValue(this.plugin.settings.exportOutputFolder)
                .onChange(async (value) => {
                    this.plugin.settings.exportOutputFolder = value.trim() || 'Exports';
                    await this.plugin.saveSettings();
                }));
    }
}
