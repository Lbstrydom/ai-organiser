/**
 * PDF Settings Section
 * Settings for PDF processing (requires multimodal models: Claude or Gemini)
 */

import { Setting } from 'obsidian';
import { BaseSettingSection } from './BaseSettingSection';
import { PLUGIN_SECRET_IDS, PROVIDER_TO_SECRET_ID } from '../../core/secretIds';

export class PDFSettingsSection extends BaseSettingSection {
    async display(): Promise<void> {
        const t = this.plugin.t.settings.pdf;
        const mainProvider = this.plugin.settings.cloudServiceType;
        const isPdfCapableMainProvider = mainProvider === 'claude' || mainProvider === 'gemini';
        const secretStorage = this.plugin.secretStorageService;
        const hasSecretStorage = secretStorage.isAvailable();
        const selectedPdfProvider = this.plugin.settings.pdfProvider || 'auto';

        // Check all possible PDF-capable key sources
        let hasClaudeSecret = false;
        let hasGeminiSecret = false;
        let hasDedicatedPdfKey = false;

        if (hasSecretStorage) {
            const claudeSecretId = PROVIDER_TO_SECRET_ID.claude;
            const geminiSecretId = PROVIDER_TO_SECRET_ID.gemini;
            [hasDedicatedPdfKey, hasClaudeSecret, hasGeminiSecret] = await Promise.all([
                secretStorage.hasSecret(PLUGIN_SECRET_IDS.PDF),
                claudeSecretId ? secretStorage.hasSecret(claudeSecretId) : Promise.resolve(false),
                geminiSecretId ? secretStorage.hasSecret(geminiSecretId) : Promise.resolve(false)
            ]);
        }

        // Check plain-text fallbacks
        const hasClaudePlainKey = (mainProvider === 'claude' && this.plugin.settings.cloudApiKey) ||
                                  this.plugin.settings.providerSettings?.claude?.apiKey;
        const hasGeminiPlainKey = (mainProvider === 'gemini' && this.plugin.settings.cloudApiKey) ||
                                  this.plugin.settings.providerSettings?.gemini?.apiKey;

        const hasClaudeKey = hasClaudeSecret || hasClaudePlainKey;
        const hasGeminiKey = hasGeminiSecret || hasGeminiPlainKey;
        const hasPdfCapableKey = hasClaudeKey || hasGeminiKey || hasDedicatedPdfKey;

        // Determine which provider we'll use for status display
        const effectiveProvider = isPdfCapableMainProvider ? mainProvider :
                                 (selectedPdfProvider !== 'auto' ? selectedPdfProvider :
                                 (hasClaudeKey ? 'claude' : (hasGeminiKey ? 'gemini' : null)));

        this.createSectionHeader(t?.title || 'PDF Processing', 'file-text', 2);

        // Info about how PDF processing works
        const infoEl = this.containerEl.createDiv({ cls: 'ai-organiser-settings-info' });
        infoEl.createEl('p', {
            text: t?.description || 'PDF summarization requires multimodal AI models (Claude or Gemini). If your main provider does not support PDFs, configure a dedicated provider here.',
            cls: 'setting-item-description'
        });

        // Show status if we have a PDF-capable key from any source
        if (hasPdfCapableKey && effectiveProvider) {
            const providerLabel = effectiveProvider.charAt(0).toUpperCase() + effectiveProvider.slice(1);
            const statusText = t?.usingMainProvider?.replace('{provider}', providerLabel)
                || `Using your ${providerLabel} API key`;

            const statusEl = this.containerEl.createDiv({ cls: 'ai-organiser-settings-status' });
            statusEl.createEl('span', {
                text: statusText,
                cls: 'ai-organiser-status-success'
            });
        }

        // PDF Provider selection (show if main provider doesn't support PDFs)
        if (!isPdfCapableMainProvider) {
            new Setting(this.containerEl)
                .setName(t?.provider || 'PDF Provider')
                .setDesc(t?.providerDesc || 'Choose which multimodal provider to use for PDF processing')
                .addDropdown(dropdown => {
                    dropdown
                        .addOption('auto', t?.providerAuto || 'Auto (use available key)')
                        .addOption('claude', 'Claude (Anthropic)')
                        .addOption('gemini', 'Gemini (Google)')
                        .setValue(selectedPdfProvider)
                        .onChange(async (value) => {
                            this.plugin.settings.pdfProvider = value as 'auto' | 'claude' | 'gemini';
                            await this.plugin.saveSettings();
                            // Refresh to show/hide API key field
                            this.settingTab.display();
                        });
                });

            // Determine if we need to show API key field
            const needsKeyField = selectedPdfProvider !== 'auto' &&
                ((selectedPdfProvider === 'claude' && !hasClaudeKey && !hasDedicatedPdfKey) ||
                 (selectedPdfProvider === 'gemini' && !hasGeminiKey && !hasDedicatedPdfKey));

            // API Key for PDF provider (only show if specific provider selected AND no key available)
            if (needsKeyField) {
                const providerName = selectedPdfProvider === 'claude' ? 'Claude' : 'Gemini';

                this.renderApiKeyField({
                    name: t?.apiKey?.replace('{provider}', providerName) || `${providerName} API Key`,
                    desc: t?.apiKeyDesc?.replace('{provider}', providerName) || `API key for ${providerName} PDF processing`,
                    secretId: PLUGIN_SECRET_IDS.PDF,
                    currentValue: this.plugin.settings.pdfApiKey,
                    placeholder: selectedPdfProvider === 'claude' ? 'sk-ant-...' : 'AIza...',
                    onChange: async (value) => {
                        this.plugin.settings.pdfApiKey = value;
                        await this.plugin.saveSettings();
                    }
                });

                // Link to get API key
                const linkEl = this.containerEl.createDiv({ cls: 'ai-organiser-settings-link' });
                if (selectedPdfProvider === 'claude') {
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
            }

            // Model selection (show if specific provider selected)
            if (selectedPdfProvider !== 'auto') {
                new Setting(this.containerEl)
                    .setName(t?.model || 'Model')
                    .setDesc(t?.modelDesc || 'Model to use for PDF analysis')
                    .addDropdown(dropdown => {
                        if (selectedPdfProvider === 'claude') {
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
