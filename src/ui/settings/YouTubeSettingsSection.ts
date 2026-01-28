/**
 * YouTube Settings Section
 * Settings for Gemini-native YouTube processing
 */

import { Setting } from 'obsidian';
import { BaseSettingSection } from './BaseSettingSection';
import { PLUGIN_SECRET_IDS, PROVIDER_TO_SECRET_ID } from '../../core/secretIds';

export class YouTubeSettingsSection extends BaseSettingSection {
    async display(): Promise<void> {
        const t = this.plugin.t.settings.youtube;
        const isGeminiMainProvider = this.plugin.settings.cloudServiceType === 'gemini';
        const secretStorage = this.plugin.secretStorageService;
        const hasSecretStorage = secretStorage.isAvailable();

        // Check all possible Gemini key sources
        let hasGeminiSecret = false;
        let hasDedicatedYouTubeKey = false;

        if (hasSecretStorage) {
            const geminiSecretId = PROVIDER_TO_SECRET_ID.gemini;
            [hasDedicatedYouTubeKey, hasGeminiSecret] = await Promise.all([
                secretStorage.hasSecret(PLUGIN_SECRET_IDS.YOUTUBE),
                geminiSecretId ? secretStorage.hasSecret(geminiSecretId) : Promise.resolve(false)
            ]);
        }

        // Check plain-text fallbacks
        const hasGeminiPlainKey = (isGeminiMainProvider && this.plugin.settings.cloudApiKey) ||
                                  this.plugin.settings.providerSettings?.gemini?.apiKey;
        const hasGeminiKey = hasGeminiSecret || hasGeminiPlainKey || hasDedicatedYouTubeKey;

        this.createSectionHeader(t?.title || 'YouTube', 'youtube', 2);

        // Info about how YouTube processing works
        const infoEl = this.containerEl.createDiv({ cls: 'ai-organiser-settings-info' });
        infoEl.createEl('p', {
            text: t?.description || 'YouTube videos are processed using Gemini\'s native video understanding, which is more reliable than transcript scraping.',
            cls: 'setting-item-description'
        });

        // Show status if we have a Gemini key from any source
        if (hasGeminiKey) {
            const statusEl = this.containerEl.createDiv({ cls: 'ai-organiser-settings-status' });
            const statusText = t?.usingMainKey || 'Using your Gemini API key';
            statusEl.createEl('span', {
                text: statusText,
                cls: 'ai-organiser-status-success'
            });
        }

        // Only show API key field if no Gemini key is available from any source
        if (!hasGeminiKey) {
            this.renderApiKeyField({
                name: t?.apiKey || 'Gemini API Key',
                desc: t?.apiKeyDesc || 'Required for YouTube processing. Get a key from Google AI Studio.',
                secretId: PLUGIN_SECRET_IDS.YOUTUBE,
                currentValue: this.plugin.settings.youtubeGeminiApiKey,
                placeholder: 'AIza...',
                onChange: async (value) => {
                    this.plugin.settings.youtubeGeminiApiKey = value;
                    await this.plugin.saveSettings();
                }
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
