import { Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { AIOrganiserSettingTab } from './AIOrganiserSettingTab';
import { BaseSettingSection } from './BaseSettingSection';

export class CanvasSettingsSection extends BaseSettingSection {
    constructor(plugin: AIOrganiserPlugin, containerEl: HTMLElement, settingTab: AIOrganiserSettingTab) {
        super(plugin, containerEl, settingTab);
    }

    display(): void {
        const t = this.plugin.t;
        this.createSectionHeader(t.canvas.settingsTitle, 'layout-grid', 2);
        this.containerEl.createEl('p', {
            text: t.canvas.settingsDescription,
            cls: 'setting-item-description'
        });

        new Setting(this.containerEl)
            .setName(t.canvas.outputFolder)
            .setDesc(t.canvas.outputFolderDesc)
            .addText(text => text
                .setPlaceholder('Canvas')
                .setValue(this.plugin.settings.canvasOutputFolder)
                .onChange(async (value) => {
                    this.plugin.settings.canvasOutputFolder = value.trim() || 'Canvas';
                    await this.plugin.saveSettings();
                }));

        new Setting(this.containerEl)
            .setName(t.canvas.openAfterCreate)
            .setDesc(t.canvas.openAfterCreateDesc)
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.canvasOpenAfterCreate)
                .onChange(async (value) => {
                    this.plugin.settings.canvasOpenAfterCreate = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(this.containerEl)
            .setName(t.canvas.enableEdgeLabels)
            .setDesc(t.canvas.enableEdgeLabelsDesc)
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.canvasEnableEdgeLabels)
                .onChange(async (value) => {
                    this.plugin.settings.canvasEnableEdgeLabels = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(this.containerEl)
            .setName(t.canvas.useLLMClustering)
            .setDesc(t.canvas.useLLMClusteringDesc)
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.canvasUseLLMClustering)
                .onChange(async (value) => {
                    this.plugin.settings.canvasUseLLMClustering = value;
                    await this.plugin.saveSettings();
                }));
    }
}
