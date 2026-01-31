/**
 * Audio Transcription Settings Section
 * Settings for Whisper API audio transcription (OpenAI or Groq)
 */

import { Setting } from 'obsidian';
import { BaseSettingSection } from './BaseSettingSection';
import { PLUGIN_SECRET_IDS, PROVIDER_TO_SECRET_ID } from '../../core/secretIds';

export class AudioTranscriptionSettingsSection extends BaseSettingSection {
    async display(): Promise<void> {
        const t = this.plugin.t.settings.audioTranscription;
        const secretStorage = this.plugin.secretStorageService;
        const hasSecretStorage = secretStorage.isAvailable();
        const selectedProvider = this.plugin.settings.audioTranscriptionProvider || 'openai';

        // Check all possible key sources
        const mainProvider = this.plugin.settings.cloudServiceType;
        const mainKey = this.plugin.settings.cloudApiKey;
        const providerOpenAIKey = this.plugin.settings.providerSettings?.openai?.apiKey;
        const providerGroqKey = this.plugin.settings.providerSettings?.groq?.apiKey;

        // Check SecretStorage for keys (async)
        let hasOpenAISecret = false;
        let hasGroqSecret = false;
        let hasDedicatedAudioKey = false;

        if (hasSecretStorage) {
            const openaiSecretId = PROVIDER_TO_SECRET_ID.openai;
            const groqSecretId = PROVIDER_TO_SECRET_ID.groq;
            [hasDedicatedAudioKey, hasOpenAISecret, hasGroqSecret] = await Promise.all([
                secretStorage.hasSecret(PLUGIN_SECRET_IDS.AUDIO),
                openaiSecretId ? secretStorage.hasSecret(openaiSecretId) : Promise.resolve(false),
                groqSecretId ? secretStorage.hasSecret(groqSecretId) : Promise.resolve(false)
            ]);
        }

        // Determine if we have a usable key for the selected provider
        const hasOpenAIKey = hasOpenAISecret || (mainProvider === 'openai' && mainKey) || providerOpenAIKey;
        const hasGroqKey = hasGroqSecret || (mainProvider === 'groq' && mainKey) || providerGroqKey;
        const hasInheritedKey = (selectedProvider === 'openai' && hasOpenAIKey) ||
                               (selectedProvider === 'groq' && hasGroqKey);

        this.createSectionHeader(t?.title || 'Audio Transcription', 'mic', 2);

        // Info about how transcription works
        const infoEl = this.containerEl.createDiv({ cls: 'ai-organiser-settings-info' });
        infoEl.createEl('p', {
            text: t?.description || 'Audio files are transcribed using Whisper API (OpenAI or Groq). Requires an API key from either provider.',
            cls: 'setting-item-description'
        });

        // Show status of available key
        if (hasInheritedKey || hasDedicatedAudioKey) {
            const statusEl = this.containerEl.createDiv({ cls: 'ai-organiser-settings-status' });
            if (selectedProvider === 'openai') {
                statusEl.createEl('span', {
                    text: t?.usingOpenAIKey || 'Using your OpenAI API key',
                    cls: 'ai-organiser-status-success'
                });
            } else {
                statusEl.createEl('span', {
                    text: t?.usingGroqKey || 'Using your Groq API key',
                    cls: 'ai-organiser-status-success'
                });
            }
        }

        // Provider selection
        new Setting(this.containerEl)
            .setName(t?.provider || 'Transcription Provider')
            .setDesc(t?.providerDesc || 'Choose which Whisper API to use for audio transcription')
            .addDropdown(dropdown => {
                dropdown
                    .addOption('openai', 'OpenAI Whisper')
                    .addOption('groq', 'Groq Whisper')
                    .setValue(selectedProvider)
                    .onChange(async (value) => {
                        this.plugin.settings.audioTranscriptionProvider = value as 'openai' | 'groq';
                        await this.plugin.saveSettings();
                        // Refresh to update key status display
                        this.settingTab.display();
                    });
            });

        // Only show dedicated API key input if no inherited key is available
        if (!hasInheritedKey && !hasDedicatedAudioKey) {
            const mainProviderName = mainProvider.charAt(0).toUpperCase() + mainProvider.slice(1);
            const whisperProviderName = selectedProvider === 'openai' ? 'OpenAI' : 'Groq';
            const descText = `Separate from your ${mainProviderName} key. Enter an ${whisperProviderName} key to enable Whisper transcription.`;

            this.renderApiKeyField({
                name: t?.apiKey || `${whisperProviderName} API Key`,
                desc: descText,
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

        // === Recording sub-section ===
        const tr = this.plugin.t.recording;

        this.containerEl.createEl('h4', { text: 'Recording' });

        new Setting(this.containerEl)
            .setName(tr?.settingsAutoTranscribe || 'Auto-transcribe recordings')
            .setDesc(tr?.settingsAutoTranscribeDesc || 'Automatically transcribe recordings under 25 MB')
            .addToggle(toggle => {
                toggle.setValue(this.plugin.settings.autoTranscribeRecordings !== false);
                toggle.onChange(async (value) => {
                    this.plugin.settings.autoTranscribeRecordings = value;
                    await this.plugin.saveSettings();
                });
            });

        new Setting(this.containerEl)
            .setName(tr?.settingsEmbed || 'Embed audio in note')
            .setDesc(tr?.settingsEmbedDesc || 'Include audio file link in note alongside transcript')
            .addToggle(toggle => {
                toggle.setValue(this.plugin.settings.embedAudioInNote !== false);
                toggle.onChange(async (value) => {
                    this.plugin.settings.embedAudioInNote = value;
                    await this.plugin.saveSettings();
                });
            });

        new Setting(this.containerEl)
            .setName(tr?.settingsQuality || 'Recording quality')
            .setDesc(tr?.settingsQualityDesc || 'Speech optimized saves space (~52 min). High quality for music or detailed audio (~26 min).')
            .addDropdown(dropdown => {
                dropdown
                    .addOption('speech', tr?.qualitySpeech || 'Speech optimized (64 kbps)')
                    .addOption('high', tr?.qualityHigh || 'High quality (128 kbps)')
                    .setValue(this.plugin.settings.recordingQuality || 'speech')
                    .onChange(async (value) => {
                        this.plugin.settings.recordingQuality = value as 'speech' | 'high';
                        await this.plugin.saveSettings();
                    });
            });

        const recordingInfoEl = this.containerEl.createDiv({ cls: 'ai-organiser-settings-info' });
        recordingInfoEl.textContent = tr?.settingsInfo || 'Recordings saved to AI-Organiser/Recordings/';
    }
}
