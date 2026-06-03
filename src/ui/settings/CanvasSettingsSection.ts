import { Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { AIOrganiserSettingTab } from './AIOrganiserSettingTab';
import { BaseSettingSection } from './BaseSettingSection';
import { addFolderPicker } from './components/FolderSuggest';

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

        addFolderPicker(
            new Setting(this.containerEl)
                .setName(t.canvas.outputFolder)
                .setDesc(t.canvas.outputFolderDesc),
            this.plugin.app,
            () => this.plugin.settings.canvasOutputFolder,
            (value) => {
                this.plugin.settings.canvasOutputFolder = value.trim() || 'Canvas';
                void this.plugin.saveSettings();
            },
            'Canvas',
        );

        new Setting(this.containerEl)
            .setName(t.canvas.openAfterCreate)
            .setDesc(t.canvas.openAfterCreateDesc)
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.canvasOpenAfterCreate)
                .onChange((value) => {
                    this.plugin.settings.canvasOpenAfterCreate = value;
                    void this.plugin.saveSettings();
                }));

        new Setting(this.containerEl)
            .setName(t.canvas.enableEdgeLabels)
            .setDesc(t.canvas.enableEdgeLabelsDesc)
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.canvasEnableEdgeLabels)
                .onChange((value) => {
                    this.plugin.settings.canvasEnableEdgeLabels = value;
                    void this.plugin.saveSettings();
                }));

        new Setting(this.containerEl)
            .setName(t.canvas.useLLMClustering)
            .setDesc(t.canvas.useLLMClusteringDesc)
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.canvasUseLLMClustering)
                .onChange((value) => {
                    this.plugin.settings.canvasUseLLMClustering = value;
                    void this.plugin.saveSettings();
                }));
    }
}
