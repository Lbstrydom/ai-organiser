/**
 * YouTube Settings Section
 * Settings for Gemini-native YouTube processing
 */

import { Setting } from 'obsidian';
import { BaseSettingSection } from './BaseSettingSection';

export class YouTubeSettingsSection extends BaseSettingSection {
    display(): void {
        const t = this.plugin.t.settings.youtube;
        const isGeminiMainProvider = this.plugin.settings.cloudServiceType === 'gemini';

        this.createSectionHeader(t?.title || 'YouTube', 'youtube', 2);

        // Info about how YouTube processing works
        const infoEl = this.containerEl.createDiv({ cls: 'ai-organiser-settings-info' });
        infoEl.createEl('p', {
            text: t?.description || 'YouTube videos are processed using Gemini\'s native video understanding, which is more reliable than transcript scraping.',
            cls: 'setting-item-description'
        });

        // Show status of Gemini key
        if (isGeminiMainProvider && this.plugin.settings.cloudApiKey) {
            const statusEl = this.containerEl.createDiv({ cls: 'ai-organiser-settings-status' });
            statusEl.createEl('span', {
                text: t?.usingMainKey || 'Using your main Gemini API key',
                cls: 'ai-organiser-status-success'
            });
        }

        // Gemini API Key (only show if main provider is NOT Gemini)
        if (!isGeminiMainProvider) {
            new Setting(this.containerEl)
                .setName(t?.apiKey || 'Gemini API Key')
                .setDesc(t?.apiKeyDesc || 'Required for YouTube processing. Get a key from Google AI Studio.')
                .addText(text => {
                    text
                        .setPlaceholder('AIza...')
                        .setValue(this.plugin.settings.youtubeGeminiApiKey)
                        .onChange(async (value) => {
                            this.plugin.settings.youtubeGeminiApiKey = value;
                            await this.plugin.saveSettings();
                        });
                    // Mask the API key display
                    text.inputEl.type = 'password';
                })
                .addExtraButton(button => {
                    button
                        .setIcon('eye')
                        .setTooltip(t?.showKey || 'Show/hide key')
                        .onClick(() => {
                            const input = button.extraSettingsEl.parentElement?.querySelector('input');
                            if (input) {
                                input.type = input.type === 'password' ? 'text' : 'password';
                            }
                        });
                });

            // Link to get API key
            const linkEl = this.containerEl.createDiv({ cls: 'ai-organiser-settings-link' });
            linkEl.createEl('a', {
                text: t?.getApiKey || 'Get a free Gemini API key from Google AI Studio',
                href: 'https://aistudio.google.com/apikey'
            });
        }

        // Model selection
        new Setting(this.containerEl)
            .setName(t?.model || 'Gemini Model')
            .setDesc(t?.modelDesc || 'Model to use for YouTube video analysis')
            .addDropdown(dropdown => {
                dropdown
                    .addOption('gemini-3-flash-preview', 'Gemini 3 Flash (Recommended)')
                    .addOption('gemini-3-pro-preview', 'Gemini 3 Pro (Higher quality)')
                    .setValue(this.plugin.settings.youtubeGeminiModel)
                    .onChange(async (value) => {
                        this.plugin.settings.youtubeGeminiModel = value;
                        await this.plugin.saveSettings();
                    });
            });
    }
}
