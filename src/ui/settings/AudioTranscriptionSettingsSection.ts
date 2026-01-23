/**
 * Audio Transcription Settings Section
 * Settings for Whisper API audio transcription (OpenAI or Groq)
 */

import { Setting } from 'obsidian';
import { BaseSettingSection } from './BaseSettingSection';

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

        this.containerEl.createEl('h2', { text: t?.title || 'Audio Transcription' });

        // Info about how transcription works
        const infoEl = this.containerEl.createDiv({ cls: 'ai-organiser-settings-info' });
        infoEl.createEl('p', {
            text: t?.description || 'Audio files are transcribed using Whisper API (OpenAI or Groq). Requires an API key from either provider.',
            cls: 'setting-item-description'
        });

        // Show status of available key
        if (hasMainOpenAIKey || providerOpenAIKey) {
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
        const hasKeyForSelectedProvider =
            (selectedProvider === 'openai' && (hasMainOpenAIKey || providerOpenAIKey)) ||
            (selectedProvider === 'groq' && (hasMainGroqKey || providerGroqKey));

        if (!hasKeyForSelectedProvider) {
            new Setting(this.containerEl)
                .setName(t?.apiKey || `${selectedProvider === 'openai' ? 'OpenAI' : 'Groq'} API Key`)
                .setDesc(t?.apiKeyDesc || `Required for audio transcription. Your key is used only for Whisper API calls.`)
                .addText(text => {
                    text
                        .setPlaceholder(selectedProvider === 'openai' ? 'sk-...' : 'gsk_...')
                        .setValue(this.plugin.settings.audioTranscriptionApiKey)
                        .onChange(async (value) => {
                            this.plugin.settings.audioTranscriptionApiKey = value;
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
