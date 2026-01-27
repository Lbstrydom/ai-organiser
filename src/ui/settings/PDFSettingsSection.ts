/**
 * PDF Settings Section
 * Settings for PDF processing (requires multimodal models: Claude or Gemini)
 */

import { Setting } from 'obsidian';
import { BaseSettingSection } from './BaseSettingSection';
import { PLUGIN_SECRET_IDS, PROVIDER_TO_SECRET_ID } from '../../core/secretIds';

export class PDFSettingsSection extends BaseSettingSection {
    display(): void {
        const t = this.plugin.t.settings.pdf;
        const mainProvider = this.plugin.settings.cloudServiceType;
        const isPdfCapableMainProvider = mainProvider === 'claude' || mainProvider === 'gemini';
        const secretStorage = this.plugin.secretStorageService;
        const hasSecretStorage = secretStorage.isAvailable();

        this.createSectionHeader(t?.title || 'PDF Processing', 'file-text', 2);

        // Info about how PDF processing works
        const infoEl = this.containerEl.createDiv({ cls: 'ai-organiser-settings-info' });
        infoEl.createEl('p', {
            text: t?.description || 'PDF summarization requires multimodal AI models (Claude or Gemini). If your main provider does not support PDFs, configure a dedicated provider here.',
            cls: 'setting-item-description'
        });

        // Show status if main provider supports PDFs
        if (isPdfCapableMainProvider) {
            const providerLabel = mainProvider.charAt(0).toUpperCase() + mainProvider.slice(1);
            const statusText = t?.usingMainProvider?.replace('{provider}', providerLabel)
                || `Using your main ${providerLabel} provider`;

            const statusEl = this.containerEl.createDiv({ cls: 'ai-organiser-settings-status' });

            if (hasSecretStorage) {
                const providerSecretId = PROVIDER_TO_SECRET_ID[mainProvider];
                if (providerSecretId) {
                    secretStorage.hasSecret(providerSecretId).then((hasKey) => {
                        if (hasKey) {
                            statusEl.createEl('span', {
                                text: statusText,
                                cls: 'ai-organiser-status-success'
                            });
                        }
                    });
                }
            } else if (this.plugin.settings.cloudApiKey) {
                statusEl.createEl('span', {
                    text: statusText,
                    cls: 'ai-organiser-status-success'
                });
            }
        }

        // PDF Provider selection (only show if main provider doesn't support PDFs)
        if (!isPdfCapableMainProvider) {
            new Setting(this.containerEl)
                .setName(t?.provider || 'PDF Provider')
                .setDesc(t?.providerDesc || 'Choose which multimodal provider to use for PDF processing')
                .addDropdown(dropdown => {
                    dropdown
                        .addOption('auto', t?.providerAuto || 'Auto (prompt when needed)')
                        .addOption('claude', 'Claude (Anthropic)')
                        .addOption('gemini', 'Gemini (Google)')
                        .setValue(this.plugin.settings.pdfProvider)
                        .onChange(async (value) => {
                            this.plugin.settings.pdfProvider = value as 'auto' | 'claude' | 'gemini';
                            await this.plugin.saveSettings();
                            // Refresh to show/hide API key field
                            this.settingTab.display();
                        });
                });

            // API Key for PDF provider (only show if a specific provider is selected)
            if (this.plugin.settings.pdfProvider !== 'auto') {
                const providerName = this.plugin.settings.pdfProvider === 'claude' ? 'Claude' : 'Gemini';

                this.renderApiKeyField({
                    name: t?.apiKey?.replace('{provider}', providerName) || `${providerName} API Key`,
                    desc: t?.apiKeyDesc?.replace('{provider}', providerName) || `API key for ${providerName} PDF processing`,
                    secretId: PLUGIN_SECRET_IDS.PDF,
                    currentValue: this.plugin.settings.pdfApiKey,
                    placeholder: this.plugin.settings.pdfProvider === 'claude' ? 'sk-ant-...' : 'AIza...',
                    onChange: async (value) => {
                        this.plugin.settings.pdfApiKey = value;
                        await this.plugin.saveSettings();
                    }
                });

                // Link to get API key
                const linkEl = this.containerEl.createDiv({ cls: 'ai-organiser-settings-link' });
                if (this.plugin.settings.pdfProvider === 'claude') {
                    linkEl.createEl('a', {
                        text: t?.getClaudeKey || 'Get a Claude API key from Anthropic Console',
                        href: 'https://console.anthropic.com/settings/keys'
                    });
                } else {
                    linkEl.createEl('a', {
                        text: t?.getGeminiKey || 'Get a free Gemini API key from Google AI Studio',
                        href: 'https://aistudio.google.com/apikey'
                    });
                }

                // Model selection
                new Setting(this.containerEl)
                    .setName(t?.model || 'Model')
                    .setDesc(t?.modelDesc || 'Model to use for PDF analysis')
                    .addDropdown(dropdown => {
                        if (this.plugin.settings.pdfProvider === 'claude') {
                            dropdown
                                .addOption('', 'Default (claude-sonnet-4-5-20250929)')
                                .addOption('claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5 (Recommended)')
                                .addOption('claude-opus-4-5-20251101', 'Claude Opus 4.5 (Highest quality)')
                                .addOption('claude-haiku-4-5-20251001', 'Claude Haiku 4.5 (Fastest)');
                        } else {
                            dropdown
                                .addOption('', 'Default (gemini-3-flash-preview)')
                                .addOption('gemini-3-flash-preview', 'Gemini 3 Flash (Recommended)')
                                .addOption('gemini-3-pro-preview', 'Gemini 3 Pro (Higher quality)');
                        }
                        dropdown
                            .setValue(this.plugin.settings.pdfModel)
                            .onChange(async (value) => {
                                this.plugin.settings.pdfModel = value;
                                await this.plugin.saveSettings();
                            });
                    });
            }
        }
    }
}
