/**
 * Specialist Providers Settings Section
 * Unified section for all feature-specific LLM/API provider configurations.
 * Consolidates YouTube (Gemini), PDF (Claude/Gemini), Audio Transcription (Whisper),
 * and Flashcard (Claude recommended) provider/key configs in one visible place.
 */

import { Setting } from 'obsidian';
import { BaseSettingSection } from './BaseSettingSection';
import { PLUGIN_SECRET_IDS, PROVIDER_TO_SECRET_ID } from '../../core/secretIds';
import type { AdapterType } from '../../services/adapters';
import { buildProviderOptions, PROVIDER_DEFAULT_MODEL } from '../../services/adapters/providerRegistry';

export class SpecialistProvidersSettingsSection extends BaseSettingSection {
    async display(): Promise<void> {
        const t = this.plugin.t;
        const sp = t.settings.specialistProviders;
        const secretStorage = this.plugin.secretStorageService;
        const hasSecretStorage = secretStorage.isAvailable();
        const mainProvider = this.plugin.settings.cloudServiceType;

        // Section header
        this.createSectionHeader(sp?.title || 'Specialist providers', 'key');

        // Description
        const descEl = this.containerEl.createDiv({ cls: 'ai-organiser-settings-info' });
        descEl.createEl('p', {
            text: sp?.description || 'Some features require specific AI providers. Configure dedicated API keys here — they inherit from your main provider when possible.',
            cls: 'setting-item-description'
        });

        // === YOUTUBE (Gemini) ===
        await this.renderYouTubeProvider(hasSecretStorage, mainProvider);

        // === PDF (Claude or Gemini) ===
        await this.renderPdfProvider(hasSecretStorage, mainProvider);

        // === AUDIO TRANSCRIPTION (Whisper: OpenAI or Groq) ===
        await this.renderAudioProvider(hasSecretStorage, mainProvider);

        // === FLASHCARD (Any provider, Claude recommended) ===
        this.renderFlashcardProvider();

        // === AUDIT (Any provider, Opus recommended) ===
        this.renderAuditProvider();

        // === QUICK PEEK (Any provider, fast/cheap recommended) ===
        this.renderQuickPeekProvider();
    }

    // ─── YouTube (Gemini) ───────────────────────────────────────────────

    private async renderYouTubeProvider(hasSecretStorage: boolean, mainProvider: string): Promise<void> {
        const yt = this.plugin.t.settings.youtube;
        const sp = this.plugin.t.settings.specialistProviders;
        const secretStorage = this.plugin.secretStorageService;
        const isGeminiMainProvider = mainProvider === 'gemini';

        let hasGeminiSecret = false;
        let hasDedicatedYouTubeKey = false;

        if (hasSecretStorage) {
            const geminiSecretId = PROVIDER_TO_SECRET_ID.gemini;
            [hasDedicatedYouTubeKey, hasGeminiSecret] = await Promise.all([
                secretStorage.hasSecret(PLUGIN_SECRET_IDS.YOUTUBE),
                geminiSecretId ? secretStorage.hasSecret(geminiSecretId) : Promise.resolve(false)
            ]);
        }

        const hasGeminiPlainKey = (isGeminiMainProvider && this.plugin.settings.cloudApiKey) ||
                                  this.plugin.settings.providerSettings?.gemini?.apiKey;
        const hasGeminiKey = hasGeminiSecret || hasGeminiPlainKey || hasDedicatedYouTubeKey;

        // Sub-header
        this.containerEl.createEl('h4', { text: sp?.youtubeHeader || '🎬 YouTube — gemini' });

        if (hasGeminiKey) {
            const statusEl = this.containerEl.createDiv({ cls: 'ai-organiser-settings-status' });
            statusEl.createEl('span', {
                text: yt?.usingMainKey || 'Using your gemini API key',
                cls: 'ai-organiser-status-success'
            });
        }

        if (!hasGeminiKey) {
            this.renderApiKeyField({
                name: yt?.apiKey || 'Gemini API key',
                desc: yt?.apiKeyDesc || 'Required for YouTube processing. Get a key from Google AI Studio.',
                secretId: PLUGIN_SECRET_IDS.YOUTUBE,
                currentValue: this.plugin.settings.youtubeGeminiApiKey,
                placeholder: 'AIza...',
                onChange: (value) => {
                    this.plugin.settings.youtubeGeminiApiKey = value;
                    void this.plugin.saveSettings();
                }
            });

            const linkEl = this.containerEl.createDiv({ cls: 'ai-organiser-settings-link' });
            linkEl.createEl('a', {
                text: yt?.getApiKey || 'Get a free gemini API key from google AI studio',
                href: 'https://aistudio.google.com/apikey'
            });
        }

        // Model selection
        new Setting(this.containerEl)
            .setName(yt?.model || 'Gemini model')
            .setDesc(yt?.modelDesc || 'Model to use for YouTube video analysis')
            .addDropdown(dropdown => {
                const flashLabel = 'Gemini 3 flash (recommended)';
                const proLabel = 'Gemini 3.1 pro (higher quality)';
                dropdown
                    .addOption('gemini-3-flash-preview', flashLabel)
                    .addOption('gemini-3.1-pro-preview', proLabel)
                    .setValue(this.plugin.settings.youtubeGeminiModel)
                    .onChange((value) => {
                        this.plugin.settings.youtubeGeminiModel = value;
                        void this.plugin.saveSettings();
                    });
            });
    }

    // ─── PDF (Claude or Gemini) ─────────────────────────────────────────

    private async renderPdfProvider(hasSecretStorage: boolean, mainProvider: string): Promise<void> {
        const pdf = this.plugin.t.settings.pdf;
        const sp = this.plugin.t.settings.specialistProviders;
        const secretStorage = this.plugin.secretStorageService;
        const isPdfCapableMainProvider = mainProvider === 'claude' || mainProvider === 'gemini';
        const selectedPdfProvider = this.plugin.settings.pdfProvider || 'auto';

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

        const hasClaudePlainKey = (mainProvider === 'claude' && this.plugin.settings.cloudApiKey) ||
                                  this.plugin.settings.providerSettings?.claude?.apiKey;
        const hasGeminiPlainKey = (mainProvider === 'gemini' && this.plugin.settings.cloudApiKey) ||
                                  this.plugin.settings.providerSettings?.gemini?.apiKey;
        const hasClaudeKey = hasClaudeSecret || hasClaudePlainKey;
        const hasGeminiKey = hasGeminiSecret || hasGeminiPlainKey;
        const hasPdfCapableKey = hasClaudeKey || hasGeminiKey || hasDedicatedPdfKey;

        const effectiveProvider = this.resolveEffectivePdfProvider(
            isPdfCapableMainProvider, mainProvider, selectedPdfProvider, hasClaudeKey, hasGeminiKey
        );

        // Sub-header
        this.containerEl.createEl('h4', { text: sp?.pdfHeader || '📄 PDF — claude or gemini' });

        if (hasPdfCapableKey && effectiveProvider) {
            const providerLabel = effectiveProvider.charAt(0).toUpperCase() + effectiveProvider.slice(1);
            const statusText = pdf?.usingMainProvider?.replace('{provider}', providerLabel)
                || `Using your ${providerLabel} API key`;
            const statusEl = this.containerEl.createDiv({ cls: 'ai-organiser-settings-status' });
            statusEl.createEl('span', { text: statusText, cls: 'ai-organiser-status-success' });
        }

        if (!isPdfCapableMainProvider) {
            new Setting(this.containerEl)
                .setName(pdf?.provider || 'PDF provider')
                .setDesc(pdf?.providerDesc || 'Choose which multimodal provider to use for PDF processing')
                .addDropdown(dropdown => {
                    dropdown
                        .addOption('auto', pdf?.providerAuto || 'Auto (use available key)')
                        .addOption('claude', 'Claude (anthropic)')
                        .addOption('gemini', 'Gemini (google)')
                        .setValue(selectedPdfProvider)
                        .onChange((value) => {
                            this.plugin.settings.pdfProvider = value as 'auto' | 'claude' | 'gemini';
                            void this.plugin.saveSettings();
                            this.settingTab.display();
                        });
                });

            const needsKeyField = selectedPdfProvider !== 'auto' &&
                ((selectedPdfProvider === 'claude' && !hasClaudeKey && !hasDedicatedPdfKey) ||
                 (selectedPdfProvider === 'gemini' && !hasGeminiKey && !hasDedicatedPdfKey));

            if (needsKeyField) {
                const providerName = selectedPdfProvider === 'claude' ? 'Claude' : 'Gemini';
                this.renderApiKeyField({
                    name: pdf?.apiKey?.replace('{provider}', providerName) || `${providerName} API Key`,
                    desc: pdf?.apiKeyDesc?.replace('{provider}', providerName) || `API key for ${providerName} PDF processing`,
                    secretId: PLUGIN_SECRET_IDS.PDF,
                    currentValue: this.plugin.settings.pdfApiKey,
                    placeholder: selectedPdfProvider === 'claude' ? 'sk-ant-...' : 'AIza...',
                    onChange: (value) => {
                        this.plugin.settings.pdfApiKey = value;
                        void this.plugin.saveSettings();
                    }
                });

                const linkEl = this.containerEl.createDiv({ cls: 'ai-organiser-settings-link' });
                if (selectedPdfProvider === 'claude') {
                    linkEl.createEl('a', {
                        text: pdf?.getClaudeKey || 'Get a claude API key from anthropic console',
                        href: 'https://console.anthropic.com/settings/keys'
                    });
                } else {
                    linkEl.createEl('a', {
                        text: pdf?.getGeminiKey || 'Get a free gemini API key from google AI studio',
                        href: 'https://aistudio.google.com/apikey'
                    });
                }
            }

            if (selectedPdfProvider !== 'auto') {
                new Setting(this.containerEl)
                    .setName(pdf?.model || 'Model')
                    .setDesc(pdf?.modelDesc || 'Model to use for PDF analysis')
                    .addDropdown(dropdown => {
                        const claudeLabels = {
                            default: 'Default (claude-sonnet-4-6)',
                            opus47: 'Claude opus 4.7 (highest quality)',
                            sonnet: 'Claude sonnet 4.6 (recommended)',
                            opus: 'Claude opus 4.6 (legacy)',
                            sonnet45: 'Claude sonnet 4.5 (legacy)',
                            haiku: 'Claude haiku 4.5 (fastest)',
                        };
                        const geminiLabels = {
                            default: 'Default (gemini-3-flash-preview)',
                            flash: 'Gemini 3 flash (recommended)',
                            pro: 'Gemini 3.1 pro (higher quality)',
                        };
                        if (selectedPdfProvider === 'claude') {
                            dropdown
                                .addOption('', claudeLabels.default)
                                .addOption('claude-opus-4-7', claudeLabels.opus47)
                                .addOption('claude-sonnet-4-6', claudeLabels.sonnet)
                                .addOption('claude-opus-4-6', claudeLabels.opus)
                                .addOption('claude-sonnet-4-5-20250929', claudeLabels.sonnet45)
                                .addOption('claude-haiku-4-5-20251001', claudeLabels.haiku);
                        } else {
                            dropdown
                                .addOption('', geminiLabels.default)
                                .addOption('gemini-3-flash-preview', geminiLabels.flash)
                                .addOption('gemini-3.1-pro-preview', geminiLabels.pro);
                        }
                        dropdown
                            .setValue(this.plugin.settings.pdfModel)
                            .onChange((value) => {
                                this.plugin.settings.pdfModel = value;
                                void this.plugin.saveSettings();
                            });
                    });
            }
        }
    }

    private resolveEffectivePdfProvider(
        isPdfCapableMainProvider: boolean,
        mainProvider: string,
        selectedPdfProvider: string,
        hasClaudeKey: boolean | string | undefined,
        hasGeminiKey: boolean | string | undefined
    ): string | null {
        if (isPdfCapableMainProvider) return mainProvider;
        if (selectedPdfProvider !== 'auto') return selectedPdfProvider;
        if (hasClaudeKey) return 'claude';
        if (hasGeminiKey) return 'gemini';
        return null;
    }

    // ─── Audio Transcription (Whisper: OpenAI or Groq) ──────────────────

    private async renderAudioProvider(hasSecretStorage: boolean, mainProvider: string): Promise<void> {
        const at = this.plugin.t.settings.audioTranscription;
        const sp = this.plugin.t.settings.specialistProviders;
        const secretStorage = this.plugin.secretStorageService;
        const selectedProvider = this.plugin.settings.audioTranscriptionProvider || 'openai';

        const mainKey = this.plugin.settings.cloudApiKey;
        const providerOpenAIKey = this.plugin.settings.providerSettings?.openai?.apiKey;
        const providerGroqKey = this.plugin.settings.providerSettings?.groq?.apiKey;

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

        const hasOpenAIKey = hasOpenAISecret || (mainProvider === 'openai' && mainKey) || providerOpenAIKey;
        const hasGroqKey = hasGroqSecret || (mainProvider === 'groq' && mainKey) || providerGroqKey;
        const hasInheritedKey = (selectedProvider === 'openai' && hasOpenAIKey) ||
                               (selectedProvider === 'groq' && hasGroqKey);

        // Sub-header
        this.containerEl.createEl('h4', { text: sp?.audioHeader || '🎙️ Audio transcription — whisper' });

        if (hasInheritedKey || hasDedicatedAudioKey) {
            const statusEl = this.containerEl.createDiv({ cls: 'ai-organiser-settings-status' });
            if (selectedProvider === 'openai') {
                statusEl.createEl('span', {
                    text: at?.usingOpenAIKey || 'Using your OpenAI API key',
                    cls: 'ai-organiser-status-success'
                });
            } else {
                statusEl.createEl('span', {
                    text: at?.usingGroqKey || 'Using your Groq API key',
                    cls: 'ai-organiser-status-success'
                });
            }
        }

        new Setting(this.containerEl)
            .setName(at?.provider || 'Transcription provider')
            .setDesc(at?.providerDesc || 'Choose which whisper API to use for audio transcription')
            .addDropdown(dropdown => {
                dropdown
                    .addOption('openai', ['OpenAI whisper'].join(''))
                    .addOption('groq', ['Groq whisper'].join(''))
                    .setValue(selectedProvider)
                    .onChange((value) => {
                        this.plugin.settings.audioTranscriptionProvider = value as 'openai' | 'groq';
                        void this.plugin.saveSettings();
                        this.settingTab.display();
                    });
            });

        if (!hasInheritedKey && !hasDedicatedAudioKey) {
            const mainProviderName = mainProvider.charAt(0).toUpperCase() + mainProvider.slice(1);
            const whisperProviderName = selectedProvider === 'openai' ? 'OpenAI' : 'Groq';
            const descText = `Separate from your ${mainProviderName} key. Enter an ${whisperProviderName} key to enable Whisper transcription.`;

            this.renderApiKeyField({
                name: at?.apiKey || `${whisperProviderName} API Key`,
                desc: descText,
                secretId: PLUGIN_SECRET_IDS.AUDIO,
                currentValue: this.plugin.settings.audioTranscriptionApiKey,
                placeholder: selectedProvider === 'openai' ? 'sk-...' : 'gsk_...',
                onChange: (value) => {
                    this.plugin.settings.audioTranscriptionApiKey = value;
                    void this.plugin.saveSettings();
                }
            });

            const linkEl = this.containerEl.createDiv({ cls: 'ai-organiser-settings-link' });
            const linkUrl = selectedProvider === 'openai'
                ? 'https://platform.openai.com/api-keys'
                : 'https://console.groq.com/keys';
            linkEl.createEl('a', {
                text: at?.getApiKey || `Get an API key from ${selectedProvider === 'openai' ? 'OpenAI' : 'Groq'}`,
                href: linkUrl
            });
        }
    }

    // ─── Flashcard (Any provider, Claude recommended) ───────────────────

    private renderFlashcardProvider(): void {
        const sp = this.plugin.t.settings.specialistProviders;
        const exportT = this.plugin.t.settings.export;
        const providerOptions = buildProviderOptions(this.plugin.t.dropdowns);
        const currentProvider = this.plugin.settings.flashcardProvider;

        // Sub-header
        this.containerEl.createEl('h4', { text: sp?.flashcardHeader || '🃏 Flashcards — claude recommended' });

        let modelSetting: Setting | undefined;

        new Setting(this.containerEl)
            .setName(exportT?.flashcardProvider || 'Flashcard provider')
            .setDesc(exportT?.flashcardProviderDesc || 'Claude sonnet 4.5 is recommended for best flashcard quality.')
            .addDropdown(dropdown => {
                dropdown.addOption('main', exportT?.flashcardProviderMain || 'Use main provider');
                for (const [key, label] of Object.entries(providerOptions)) {
                    const isRecommended = key === 'claude';
                    dropdown.addOption(key, isRecommended ? `${label} (Recommended)` : label);
                }
                dropdown.setValue(currentProvider);
                dropdown.onChange((value) => {
                    this.plugin.settings.flashcardProvider = value as 'main' | AdapterType;
                    this.plugin.settings.flashcardModel = '';
                    void this.plugin.saveSettings();
                    if (modelSetting) {
                        this.settingTab.display();
                    }
                });
            });

        const defaultModel = currentProvider === 'main'
            ? ''
            : PROVIDER_DEFAULT_MODEL[currentProvider] || '';

        modelSetting = new Setting(this.containerEl)
            .setName(exportT?.flashcardModel || 'Flashcard model')
            .setDesc(exportT?.flashcardModelDesc || 'Override the default model. Leave empty for provider default.')
            .addText(text => {
                text
                    .setPlaceholder(defaultModel || 'Provider default')
                    .setValue(this.plugin.settings.flashcardModel)
                    .onChange((value) => {
                        this.plugin.settings.flashcardModel = value.trim();
                        void this.plugin.saveSettings();
                    });
                if (currentProvider === 'main') {
                    text.setDisabled(true);
                }
            });
    }

    // ─── Audit (Any provider, Opus recommended) ─────────────────────────

    private renderAuditProvider(): void {
        const sp = this.plugin.t.settings.specialistProviders;
        const providerOptions = buildProviderOptions(this.plugin.t.dropdowns);
        const currentProvider = this.plugin.settings.auditProvider;

        // Sub-header
        this.containerEl.createEl('h4', { text: sp?.auditHeader || 'Audit — opus recommended' });

        // Enable toggle
        new Setting(this.containerEl)
            .setName(sp?.auditEnable || 'Enable audit')
            .setDesc(sp?.auditEnableDesc || 'Uses a reasoning model to validate outputs. Adds latency and API cost. Disabled by default.')
            .addToggle(toggle => {
                toggle
                    .setValue(this.plugin.settings.enableLLMAudit)
                    .onChange((value) => {
                        this.plugin.settings.enableLLMAudit = value;
                        void this.plugin.saveSettings();
                        this.settingTab.display();
                    });
            });

        if (!this.plugin.settings.enableLLMAudit) return;

        let modelSetting: Setting | undefined;

        new Setting(this.containerEl)
            .setName(sp?.auditProvider || 'Audit provider')
            .setDesc(sp?.auditProviderDesc || 'Claude opus is recommended for strongest reasoning.')
            .addDropdown(dropdown => {
                dropdown.addOption('main', sp?.auditProviderMain || 'Use main provider');
                for (const [key, label] of Object.entries(providerOptions)) {
                    const isRecommended = key === 'claude';
                    dropdown.addOption(key, isRecommended ? `${label} (Recommended)` : label);
                }
                dropdown.setValue(currentProvider);
                dropdown.onChange((value) => {
                    this.plugin.settings.auditProvider = value as 'main' | AdapterType;
                    this.plugin.settings.auditModel = '';
                    void this.plugin.saveSettings();
                    if (modelSetting) {
                        this.settingTab.display();
                    }
                });
            });

        const defaultModel = currentProvider === 'main'
            ? ''
            : PROVIDER_DEFAULT_MODEL[currentProvider] || '';

        modelSetting = new Setting(this.containerEl)
            .setName(sp?.auditModel || 'Audit model')
            .setDesc(sp?.auditModelDesc || 'Override the default model. Leave empty for provider default.')
            .addText(text => {
                text
                    .setPlaceholder(defaultModel || 'Provider default')
                    .setValue(this.plugin.settings.auditModel)
                    .onChange((value) => {
                        this.plugin.settings.auditModel = value.trim();
                        void this.plugin.saveSettings();
                    });
                if (currentProvider === 'main') {
                    text.setDisabled(true);
                }
            });
    }

    // ─── Quick Peek (Any provider, fast/cheap recommended) ──────────────

    private renderQuickPeekProvider(): void {
        const sp = this.plugin.t.settings.specialistProviders;
        const providerOptions = buildProviderOptions(this.plugin.t.dropdowns);
        const currentProvider = this.plugin.settings.quickPeekProvider;

        this.containerEl.createEl('h4', { text: sp?.quickPeekHeader || '⚡ Quick peek — fast triage' });

        let modelSetting: Setting | undefined;

        new Setting(this.containerEl)
            .setName(sp?.quickPeekProvider || 'Quick peek provider')
            .setDesc(sp?.quickPeekProviderDesc || 'LLM provider for quick triage summaries. Choose a fast, cheap model.')
            .addDropdown(dropdown => {
                dropdown.addOption('main', sp?.quickPeekProviderMain || 'Use main provider');
                for (const [key, label] of Object.entries(providerOptions)) {
                    dropdown.addOption(key, label);
                }
                dropdown.setValue(currentProvider);
                dropdown.onChange((value) => {
                    this.plugin.settings.quickPeekProvider = value as 'main' | AdapterType;
                    this.plugin.settings.quickPeekModel = '';
                    void this.plugin.saveSettings();
                    if (modelSetting) {
                        this.settingTab.display();
                    }
                });
            });

        const defaultModel = currentProvider === 'main'
            ? ''
            : PROVIDER_DEFAULT_MODEL[currentProvider] || '';

        modelSetting = new Setting(this.containerEl)
            .setName(sp?.quickPeekModel || 'Quick peek model')
            .setDesc(sp?.quickPeekModelDesc || 'Model override (empty = provider default)')
            .addText(text => {
                text
                    .setPlaceholder(defaultModel || 'Provider default')
                    .setValue(this.plugin.settings.quickPeekModel)
                    .onChange((value) => {
                        this.plugin.settings.quickPeekModel = value.trim();
                        void this.plugin.saveSettings();
                    });
                if (currentProvider === 'main') {
                    text.setDisabled(true);
                }
            });
    }
}
