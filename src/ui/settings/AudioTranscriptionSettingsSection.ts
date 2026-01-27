/**
 * Audio Transcription Settings Section
 * Settings for Whisper API audio transcription (OpenAI or Groq)
 */

import { Setting } from 'obsidian';
import { BaseSettingSection } from './BaseSettingSection';
import { PLUGIN_SECRET_IDS, PROVIDER_TO_SECRET_ID } from '../../core/secretIds';

export class AudioTranscriptionSettingsSection extends BaseSettingSection {
    display(): void {
        const t = this.plugin.t.settings.audioTranscription;

        // Check if main provider supports transcription
        const mainProvider = this.plugin.settings.cloudServiceType;
        const mainKey = this.plugin.settings.cloudApiKey;
        const hasMainOpenAIKey = mainProvider === 'openai' && mainKey;
        const hasMainGroqKey = mainProvider === 'groq' && mainKey;

        // Also check provider-specific keys
        const providerOpenAIKey = this.plugin.settings.providerSettings?.openai?.apiKey;
        const providerGroqKey = this.plugin.settings.providerSettings?.groq?.apiKey;
        const secretStorage = this.plugin.secretStorageService;
        const hasSecretStorage = secretStorage.isAvailable();

        this.createSectionHeader(t?.title || 'Audio Transcription', 'mic', 2);

        // Info about how transcription works
        const infoEl = this.containerEl.createDiv({ cls: 'ai-organiser-settings-info' });
        infoEl.createEl('p', {
            text: t?.description || 'Audio files are transcribed using Whisper API (OpenAI or Groq). Requires an API key from either provider.',
            cls: 'setting-item-description'
        });

        // Show status of available key
        if (hasSecretStorage) {
            const statusEl = this.containerEl.createDiv({ cls: 'ai-organiser-settings-status' });
            const openaiSecretId = PROVIDER_TO_SECRET_ID.openai;
            const groqSecretId = PROVIDER_TO_SECRET_ID.groq;
            Promise.all([
                secretStorage.hasSecret(PLUGIN_SECRET_IDS.AUDIO),
                openaiSecretId ? secretStorage.hasSecret(openaiSecretId) : Promise.resolve(false),
                groqSecretId ? secretStorage.hasSecret(groqSecretId) : Promise.resolve(false)
            ]).then(([hasAudioKey, hasOpenAISecret, hasGroqSecret]) => {
                const selectedProvider = this.plugin.settings.audioTranscriptionProvider || 'openai';
                const showOpenAI = hasAudioKey ? selectedProvider === 'openai' : hasOpenAISecret;
                const showGroq = hasAudioKey ? selectedProvider === 'groq' : hasGroqSecret;

                if (showOpenAI) {
                    statusEl.createEl('span', {
                        text: t?.usingOpenAIKey || 'Using your OpenAI API key',
                        cls: 'ai-organiser-status-success'
                    });
                } else if (showGroq) {
                    statusEl.createEl('span', {
                        text: t?.usingGroqKey || 'Using your Groq API key',
                        cls: 'ai-organiser-status-success'
                    });
                } else {
                    const warningEl = this.containerEl.createDiv({ cls: 'ai-organiser-settings-warning' });
                    warningEl.createEl('span', {
                        text: t?.noKeyWarning || 'No transcription API key configured. Add an OpenAI or Groq key to enable audio transcription.',
                        cls: 'ai-organiser-status-warning'
                    });
                }
            });
        } else if (hasMainOpenAIKey || providerOpenAIKey) {
            const statusEl = this.containerEl.createDiv({ cls: 'ai-organiser-settings-status' });
            statusEl.createEl('span', {
                text: t?.usingOpenAIKey || 'Using your OpenAI API key',
                cls: 'ai-organiser-status-success'
            });
        } else if (hasMainGroqKey || providerGroqKey) {
            const statusEl = this.containerEl.createDiv({ cls: 'ai-organiser-settings-status' });
            statusEl.createEl('span', {
                text: t?.usingGroqKey || 'Using your Groq API key',
                cls: 'ai-organiser-status-success'
            });
        } else if (!this.plugin.settings.audioTranscriptionApiKey) {
            // No key available - show warning
            const warningEl = this.containerEl.createDiv({ cls: 'ai-organiser-settings-warning' });
            warningEl.createEl('span', {
                text: t?.noKeyWarning || 'No transcription API key configured. Add an OpenAI or Groq key to enable audio transcription.',
                cls: 'ai-organiser-status-warning'
            });
        }

        // Provider selection
        new Setting(this.containerEl)
            .setName(t?.provider || 'Transcription Provider')
            .setDesc(t?.providerDesc || 'Choose which Whisper API to use for audio transcription')
            .addDropdown(dropdown => {
                dropdown
                    .addOption('openai', 'OpenAI Whisper')
                    .addOption('groq', 'Groq Whisper')
                    .setValue(this.plugin.settings.audioTranscriptionProvider)
                    .onChange(async (value) => {
                        this.plugin.settings.audioTranscriptionProvider = value as 'openai' | 'groq';
                        await this.plugin.saveSettings();
                        // Refresh to update key status display
                        this.settingTab.display();
                    });
            });

        // Show dedicated API key input only if main provider doesn't support transcription
        const selectedProvider = this.plugin.settings.audioTranscriptionProvider;
        const hasKeyForSelectedProvider = hasSecretStorage
            ? false
            : (selectedProvider === 'openai' && (hasMainOpenAIKey || providerOpenAIKey)) ||
              (selectedProvider === 'groq' && (hasMainGroqKey || providerGroqKey));

        if (!hasKeyForSelectedProvider) {
            this.renderApiKeyField({
                name: t?.apiKey || `${selectedProvider === 'openai' ? 'OpenAI' : 'Groq'} API Key`,
                desc: t?.apiKeyDesc || 'Required for audio transcription. Your key is used only for Whisper API calls.',
                secretId: PLUGIN_SECRET_IDS.AUDIO,
                currentValue: this.plugin.settings.audioTranscriptionApiKey,
                placeholder: selectedProvider === 'openai' ? 'sk-...' : 'gsk_...',
                onChange: async (value) => {
                    this.plugin.settings.audioTranscriptionApiKey = value;
                    await this.plugin.saveSettings();
                }
            });

            // Link to get API key
            const linkEl = this.containerEl.createDiv({ cls: 'ai-organiser-settings-link' });
            const linkUrl = selectedProvider === 'openai'
                ? 'https://platform.openai.com/api-keys'
                : 'https://console.groq.com/keys';
            linkEl.createEl('a', {
                text: t?.getApiKey || `Get an API key from ${selectedProvider === 'openai' ? 'OpenAI' : 'Groq'}`,
                href: linkUrl
            });
        }
    }
}
