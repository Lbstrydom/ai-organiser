/**
 * Bases Settings Section
 * Settings for Obsidian Bases integration
 */

import { Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { BaseSettingSection } from './BaseSettingSection';

export class BasesSettingsSection extends BaseSettingSection {
    display(): void {
        // === Obsidian Bases Integration ===
        this.containerEl.createEl('h1', { text: this.plugin.t.settings.bases.title });

        const description = this.containerEl.createEl('p', {
            cls: 'setting-item-description',
            text: this.plugin.t.settings.bases.description
        });

        // Enable structured metadata
        new Setting(this.containerEl)
            .setName(this.plugin.t.settings.bases.enableStructuredMetadata)
            .setDesc(this.plugin.t.settings.bases.enableStructuredMetadataDesc)
            .addToggle(toggle => {
                toggle
                    .setValue(this.plugin.settings.enableStructuredMetadata)
                    .onChange(async (value) => {
                        this.plugin.settings.enableStructuredMetadata = value;
                        await this.plugin.saveSettings();
                    });
            });

        // Include model in metadata
        new Setting(this.containerEl)
            .setName(this.plugin.t.settings.bases.includeModelInMetadata)
            .setDesc(this.plugin.t.settings.bases.includeModelInMetadataDesc)
            .addToggle(toggle => {
                toggle
                    .setValue(this.plugin.settings.includeModelInMetadata)
                    .onChange(async (value) => {
                        this.plugin.settings.includeModelInMetadata = value;
                        await this.plugin.saveSettings();
                    });
            });

        // Auto-detect content type
        new Setting(this.containerEl)
            .setName(this.plugin.t.settings.bases.autoDetectContentType)
            .setDesc(this.plugin.t.settings.bases.autoDetectContentTypeDesc)
            .addToggle(toggle => {
                toggle
                    .setValue(this.plugin.settings.autoDetectContentType)
                    .onChange(async (value) => {
                        this.plugin.settings.autoDetectContentType = value;
                        await this.plugin.saveSettings();
                    });
            });

        // Info box
        const infoBox = this.containerEl.createDiv({ cls: 'ai-organiser-info-box' });
        infoBox.createEl('h3', { text: this.plugin.t.settings.bases.infoTitle });
        infoBox.createEl('p', { text: this.plugin.t.settings.bases.info1 });
        infoBox.createEl('p', { text: this.plugin.t.settings.bases.info2 });
        infoBox.createEl('p', { text: this.plugin.t.settings.bases.info3 });

        // Action buttons
        const actionsContainer = this.containerEl.createDiv({ cls: 'ai-organiser-bases-actions' });

        // Migration button
        new Setting(actionsContainer)
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

        // Dashboard button
        new Setting(actionsContainer)
            .setName(this.plugin.t.settings.bases.dashboardAction)
            .setDesc(this.plugin.t.settings.bases.dashboardActionDesc)
            .addButton(button => {
                button
                    .setButtonText(this.plugin.t.settings.bases.dashboardButton)
                    .setIcon('layout-dashboard')
                    .onClick(() => {
                        // Trigger dashboard command
                        (this.plugin.app as any).commands.executeCommandById('ai-organiser:create-bases-dashboard');
                    });
            });
    }
}
