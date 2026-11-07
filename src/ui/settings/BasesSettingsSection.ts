/**
 * Bases Settings Section
 * Settings for Obsidian Bases integration
 */

import { Notice, Setting } from 'obsidian';
import { BaseSettingSection } from './BaseSettingSection';
import { AIO_STATUS_KEY, aiStatusKey } from '../../core/aiStatus';
import { AiStatusMoveModal } from '../modals/AiStatusMoveModal';

export class BasesSettingsSection extends BaseSettingSection {
    display(): void {
        // === Obsidian Bases (subsection under Integrations) ===
        this.createSectionHeader(this.plugin.t.settings.bases.title, 'database', 2);

        // Enable structured metadata
        new Setting(this.containerEl)
            .setName(this.plugin.t.settings.bases.enableStructuredMetadata)
            .setDesc(this.plugin.t.settings.bases.enableStructuredMetadataDesc)
            .addToggle(toggle => {
                toggle
                    .setValue(this.plugin.settings.enableStructuredMetadata)
                    .onChange((value) => {
                        this.plugin.settings.enableStructuredMetadata = value;
                        void this.plugin.saveSettings();
                    });
            });

        // Include model in metadata
        new Setting(this.containerEl)
            .setName(this.plugin.t.settings.bases.includeModelInMetadata)
            .setDesc(this.plugin.t.settings.bases.includeModelInMetadataDesc)
            .addToggle(toggle => {
                toggle
                    .setValue(this.plugin.settings.includeModelInMetadata)
                    .onChange((value) => {
                        this.plugin.settings.includeModelInMetadata = value;
                        void this.plugin.saveSettings();
                    });
            });

        // Auto-detect content type
        new Setting(this.containerEl)
            .setName(this.plugin.t.settings.bases.autoDetectContentType)
            .setDesc(this.plugin.t.settings.bases.autoDetectContentTypeDesc)
            .addToggle(toggle => {
                toggle
                    .setValue(this.plugin.settings.autoDetectContentType)
                    .onChange((value) => {
                        this.plugin.settings.autoDetectContentType = value;
                        void this.plugin.saveSettings();
                    });
            });

        // Where the AI's processing mark is kept (opt-in move to the plugin-owned `aio-status`)
        const t = this.plugin.t.settings.bases;
        new Setting(this.containerEl)
            .setName(t.aiStatusProperty)
            .setDesc(t.aiStatusPropertyDesc)
            .addDropdown(dropdown => {
                dropdown
                    .addOption('status', t.aiStatusShared)
                    .addOption(AIO_STATUS_KEY, t.aiStatusOwn)
                    .setValue(aiStatusKey(this.plugin.settings))
                    .onChange((value) => {
                        this.plugin.settings.aiStatusProperty = value === AIO_STATUS_KEY ? AIO_STATUS_KEY : 'status';
                        void this.plugin.saveSettings();
                        if (value === AIO_STATUS_KEY) new Notice(t.aiStatusSwitchedNotice, 10000);
                        moveRow.settingEl.toggleClass('ai-organiser-hidden', value !== AIO_STATUS_KEY);
                    });
            });
        const moveRow = new Setting(this.containerEl)
            .setName(t.moveMarksAction)
            .setDesc(t.moveMarksActionDesc)
            .addButton(button => {
                button
                    .setIcon('arrow-right-left')
                    .setButtonText(t.moveMarksButton)
                    .onClick(() => { new AiStatusMoveModal(this.plugin.app, this.plugin).open(); });
            });
        moveRow.settingEl.toggleClass('ai-organiser-hidden', aiStatusKey(this.plugin.settings) !== AIO_STATUS_KEY);

        // Migration action
        new Setting(this.containerEl)
            .setName(this.plugin.t.settings.bases.migrateAction)
            .setDesc(this.plugin.t.settings.bases.migrateActionDesc)
            .addButton(button => {
                button
                    .setIcon('database')
                    .setButtonText(this.plugin.t.settings.bases.migrateButton)
                    .onClick(() => {
                        // Trigger migration command
                        (this.plugin.app as import('obsidian').App & { commands: { executeCommandById: (id: string) => void } }).commands.executeCommandById('ai-organiser:upgrade-metadata');
                    });
            });
    }
}
