import { Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { AIOrganiserSettingTab } from './AIOrganiserSettingTab';
import { BaseSettingSection } from './BaseSettingSection';
import { GlobalMemoryService } from '../../services/chat/globalMemoryService';
import { GlobalMemoryModal } from '../modals/GlobalMemoryModal';

export class AIChatSettingsSection extends BaseSettingSection {
    constructor(plugin: AIOrganiserPlugin, containerEl: HTMLElement, settingTab: AIOrganiserSettingTab) {
        super(plugin, containerEl, settingTab);
    }

    async display(): Promise<void> {
        const { containerEl, plugin } = this;
        const t = plugin.t.settings.aichat;

        this.createSectionHeader(t.chatRootFolderTitle, 'message-square');

        // Chat root folder
        new Setting(containerEl)
            .setName(t.chatRootFolderTitle)
            .setDesc(t.chatRootFolderDesc)
            .addText(text => text
                .setPlaceholder('AI Chat') // eslint-disable-line obsidianmd/ui/sentence-case -- feature name
                .setValue(plugin.settings.chatRootFolder || 'AI Chat')
                .onChange(value => {
                    plugin.settings.chatRootFolder = value.trim() || 'AI Chat';
                    void plugin.saveSettings();
                }));

        // Enable persistence
        new Setting(containerEl)
            .setName(t.enablePersistenceTitle)
            .setDesc(t.enablePersistenceDesc)
            .addToggle(toggle => toggle
                .setValue(plugin.settings.enableChatPersistence)
                .onChange(value => {
                    plugin.settings.enableChatPersistence = value;
                    void plugin.saveSettings();
                }));

        // Smart compaction
        new Setting(containerEl)
            .setName(t.enableCompactionTitle)
            .setDesc(t.enableCompactionDesc)
            .addToggle(toggle => toggle
                .setValue(plugin.settings.chatAutoCompaction)
                .onChange(value => {
                    plugin.settings.chatAutoCompaction = value;
                    void plugin.saveSettings();
                }));

        // Retention days
        new Setting(containerEl)
            .setName(t.chatRetentionTitle)
            .setDesc(t.chatRetentionDesc)
            .addText(text => {
                text
                    .setPlaceholder('90')
                    .setValue(String(plugin.settings.chatRetentionDays));
                text.inputEl.type = 'number';
                text.inputEl.min = '0';
                text.onChange(value => {
                    const days = parseInt(value, 10);
                    plugin.settings.chatRetentionDays = isNaN(days) || days < 0 ? 0 : days;
                    void plugin.saveSettings();
                });
            });

        // Global memory
        const service = new GlobalMemoryService(plugin.app, plugin.settings);
        const items = await service.loadMemory();
        const countDesc = items.length > 0
            ? t.globalMemoryCount.replace('{count}', String(items.length))
            : t.globalMemoryCountEmpty;

        new Setting(containerEl)
            .setName(t.globalMemoryTitle)
            .setDesc(`${t.globalMemoryDesc} — ${countDesc}`)
            .addButton(btn => btn
                .setButtonText(t.globalMemoryEdit)
                .onClick(() => {
                    const memSvc = new GlobalMemoryService(plugin.app, plugin.settings);
                    new GlobalMemoryModal(
                        plugin.app,
                        memSvc,
                        plugin.t.modals.unifiedChat,
                        () => { void this.display(); },
                    ).open();
                }));

        // === Presentation Settings ===
        this.createSectionHeader(t.presentationOutputFolderTitle, 'presentation', 2);

        new Setting(containerEl)
            .setName(t.presentationOutputFolderTitle)
            .setDesc(t.presentationOutputFolderDesc)
            .addText(text => text
                .setPlaceholder('Presentations')
                .setValue(plugin.settings.presentationOutputFolder || 'Presentations')
                .onChange(value => {
                    plugin.settings.presentationOutputFolder = value.trim() || 'Presentations';
                    void plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(t.presentationBrandGuidelinesTitle)
            .setDesc(t.presentationBrandGuidelinesDesc)
            .addText(text => text
                .setPlaceholder('AI-Organiser/Config/brand-guidelines.md')
                .setValue(plugin.settings.presentationBrandGuidelinesPath || '')
                .onChange(value => {
                    plugin.settings.presentationBrandGuidelinesPath = value.trim();
                    void plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(t.refinementPassesTitle)
            .setDesc(t.refinementPassesDesc)
            .addDropdown(dd => dd
                .addOption('1', '1 (Quick)') // eslint-disable-line obsidianmd/ui/sentence-case
                .addOption('2', '2 (Thorough)') // eslint-disable-line obsidianmd/ui/sentence-case
                .setValue(String(plugin.settings.aichatRefinementPasses))
                .onChange(value => {
                    plugin.settings.aichatRefinementPasses = value === '2' ? 2 : 1;
                    void plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(t.brandToggleDefaultTitle)
            .setDesc(t.brandToggleDefaultDesc)
            .addToggle(toggle => toggle
                .setValue(plugin.settings.aichatBrandToggleDefault)
                .onChange(value => {
                    plugin.settings.aichatBrandToggleDefault = value;
                    void plugin.saveSettings();
                }));
    }
}
