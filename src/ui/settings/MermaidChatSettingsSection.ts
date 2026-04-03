import { Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { AIOrganiserSettingTab } from './AIOrganiserSettingTab';
import { BaseSettingSection } from './BaseSettingSection';

export class MermaidChatSettingsSection extends BaseSettingSection {
    constructor(
        plugin: AIOrganiserPlugin,
        containerEl: HTMLElement,
        settingTab: AIOrganiserSettingTab,
    ) {
        super(plugin, containerEl, settingTab);
    }

    display(): void {
        const t = this.plugin.t.modals.mermaidChat;

        this.createSectionHeader(t.settingsTitle, 'share-2', 2);
        this.containerEl.createEl('p', {
            text: t.settingsDescription,
            cls: 'setting-item-description',
        });

        // ── Context Sources ───────────────────────────────────────────────

        this.containerEl.createEl('h4', { text: t.settingsContextTitle });

        new Setting(this.containerEl)
            .setName(t.includeNoteContext)
            .setDesc(t.includeNoteContextDesc)
            .addToggle(toggle =>
                toggle
                    .setValue(this.plugin.settings.mermaidChatIncludeNoteContext)
                    .onChange(value => {
                        this.plugin.settings.mermaidChatIncludeNoteContext = value;
                        void this.plugin.saveSettings();
                    }),
            );

        new Setting(this.containerEl)
            .setName(t.includeBacklinks)
            .setDesc(t.includeBacklinksDesc)
            .addToggle(toggle =>
                toggle
                    .setValue(this.plugin.settings.mermaidChatIncludeBacklinks)
                    .onChange(value => {
                        this.plugin.settings.mermaidChatIncludeBacklinks = value;
                        void this.plugin.saveSettings();
                    }),
            );

        new Setting(this.containerEl)
            .setName(t.includeRAG)
            .setDesc(t.includeRAGDesc)
            .addToggle(toggle =>
                toggle
                    .setValue(this.plugin.settings.mermaidChatIncludeRAG)
                    .onChange(value => {
                        this.plugin.settings.mermaidChatIncludeRAG = value;
                        void this.plugin.saveSettings();
                    }),
            );

        new Setting(this.containerEl)
            .setName(t.ragChunks)
            .setDesc(t.ragChunksDesc)
            .addSlider(slider =>
                slider
                    .setLimits(1, 10, 1)
                    .setValue(this.plugin.settings.mermaidChatRAGChunks)
                    .setDynamicTooltip()
                    .onChange(value => {
                        this.plugin.settings.mermaidChatRAGChunks = value;
                        void this.plugin.saveSettings();
                    }),
            );

        // ── Export ────────────────────────────────────────────────────────

        this.containerEl.createEl('h4', { text: t.settingsExportTitle });

        new Setting(this.containerEl)
            .setName(t.exportTheme)
            .setDesc(t.exportThemeDesc)
            .addDropdown(drop =>
                drop
                    .addOption('default', t.exportThemeDefault)
                    .addOption('dark', t.exportThemeDark)
                    .addOption('forest', t.exportThemeForest)
                    .addOption('neutral', t.exportThemeNeutral)
                    .setValue(this.plugin.settings.mermaidChatExportTheme)
                    .onChange(value => {
                        this.plugin.settings.mermaidChatExportTheme = value as 'default' | 'dark' | 'forest' | 'neutral';
                        void this.plugin.saveSettings();
                    }),
            );

        new Setting(this.containerEl)
            .setName(t.exportScale)
            .setDesc(t.exportScaleDesc)
            .addSlider(slider =>
                slider
                    .setLimits(1, 4, 1)
                    .setValue(this.plugin.settings.mermaidChatExportScale)
                    .setDynamicTooltip()
                    .onChange(value => {
                        this.plugin.settings.mermaidChatExportScale = value;
                        void this.plugin.saveSettings();
                    }),
            );

        // ── Experimental ──────────────────────────────────────────────────

        this.containerEl.createEl('h4', { text: t.settingsExperimentalTitle });

        new Setting(this.containerEl)
            .setName(t.stalenessNoticeSetting)
            .setDesc(t.stalenessNoticeDesc)
            .addToggle(toggle =>
                toggle
                    .setValue(this.plugin.settings.mermaidChatStalenessNotice)
                    .onChange(value => {
                        this.plugin.settings.mermaidChatStalenessNotice = value;
                        void this.plugin.saveSettings();
                    }),
            );

        new Setting(this.containerEl)
            .setName(t.stalenessGutter)
            .setDesc(t.stalenessGutterDesc)
            .addToggle(toggle =>
                toggle
                    .setValue(this.plugin.settings.mermaidChatStalenessGutter)
                    .onChange(value => {
                        this.plugin.settings.mermaidChatStalenessGutter = value;
                        void this.plugin.saveSettings();
                    }),
            );

        new Setting(this.containerEl)
            .setName(t.generateAltText)
            .setDesc(t.generateAltTextDesc)
            .addToggle(toggle =>
                toggle
                    .setValue(this.plugin.settings.mermaidChatGenerateAltText)
                    .onChange(value => {
                        this.plugin.settings.mermaidChatGenerateAltText = value;
                        void this.plugin.saveSettings();
                    }),
            );
    }
}
