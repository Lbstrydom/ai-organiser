/**
 * Bases Settings Section
 * Settings for Obsidian Bases integration
 */

import { Setting } from 'obsidian';
import { BaseSettingSection } from './BaseSettingSection';

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

        // Migration action
        new Setting(this.containerEl)
            .setName(this.plugin.t.settings.bases.migrateAction)
            .setDesc(this.plugin.t.settings.bases.migrateActionDesc)
            .addButton(button => {
                button
                    .setButtonText(this.plugin.t.settings.bases.migrateButton)
                    .setIcon('database')
                    .onClick(() => {
                        // Trigger migration command
                        (this.plugin.app as any).commands.executeCommandById('ai-organiser:upgrade-metadata');
                    });
            });
    }
}
