import { Setting, ButtonComponent, Notice, requestUrl } from 'obsidian';
import { ConnectionTestResult } from '../../services';
import { BaseSettingSection } from './BaseSettingSection';
import { PROVIDER_ENDPOINT, PROVIDER_DEFAULT_MODEL } from '../../services/adapters/providerRegistry';
import { getProviderModels, hasModelList } from '../../services/adapters/modelRegistry';
import { PROVIDER_TO_SECRET_ID } from '../../core/secretIds';
import { MigrationConfirmModal } from '../modals/MigrationConfirmModal';

export class LLMSettingsSection extends BaseSettingSection {
    private statusContainer: HTMLElement = null!;
    private statusEl: HTMLElement = null!;

    display(): void {
        this.createSectionHeader(this.plugin.t.settings.llm.title, 'bot');
        this.createServiceTypeDropdown();
        if (this.plugin.settings.serviceType === 'local') {
            this.displayLocalSettings();
        } else {
            this.displayCloudSettings();
        }

        // Check local service status when loading settings if local service is selected
        if (this.plugin.settings.serviceType === 'local') {
            void this.checkLocalService(this.plugin.settings.localEndpoint);
        }

        this.renderSecretStorageMigrationNotice();

        // Debug mode toggle
        new Setting(this.containerEl)
            .setName(this.plugin.t.settings.llm.debugMode)
            .setDesc(this.plugin.t.settings.llm.debugModeDesc)
            .addToggle(toggle =>
                toggle
                    .setValue(this.plugin.settings.debugMode)
                    .onChange((value) => {
                        this.plugin.settings.debugMode = value;
                        void this.plugin.saveSettings();
                        new Notice(value ? this.plugin.t.settings.llm.debugEnabled : this.plugin.t.settings.llm.debugDisabled);
                    })
            );
    }

    private createServiceTypeDropdown(): void {
        if (!this.plugin.settings.serviceType) {
            this.plugin.settings.serviceType = 'cloud';
        }
        new Setting(this.containerEl)
            .setName(this.plugin.t.settings.llm.serviceType)
            .setDesc(this.plugin.t.settings.llm.serviceTypeDesc)
            .addDropdown(dropdown =>
                dropdown
                    .addOptions({
                        'local': this.plugin.t.dropdowns.localLLM,
                        'cloud': this.plugin.t.dropdowns.cloudService
                    })
                    .setValue(this.plugin.settings.serviceType)
                    .onChange((value) => {
                        this.plugin.settings.serviceType = value as 'local' | 'cloud';
                        void this.plugin.saveSettings();
                        this.settingTab.display();
                    })
            );

        if (this.plugin.settings.serviceType === 'cloud') {
            new Setting(this.containerEl)
                .setName(this.plugin.t.settings.llm.cloudProvider)
                .setDesc(this.plugin.t.settings.llm.cloudProviderDesc)
                .addDropdown(dropdown =>
                    dropdown
                        .addOptions(this.getProviderOptions())
                        .setValue(this.plugin.settings.cloudServiceType)
                        .onChange((value) => {
                            const oldType = this.plugin.settings.cloudServiceType;
                            const newType = value as typeof this.plugin.settings.cloudServiceType;

                            // Initialize providerSettings if needed
                            if (!this.plugin.settings.providerSettings) {
                                this.plugin.settings.providerSettings = {};
                            }

                            // Save current API key and model to provider-specific storage before switching
                            if (!this.plugin.settings.providerSettings[oldType]) {
                                this.plugin.settings.providerSettings[oldType] = {};
                            }
                            const secretStorage = this.plugin.secretStorageService;
                            const oldSecretId = PROVIDER_TO_SECRET_ID[oldType];
                            const shouldPersistPlainKey = !secretStorage.isAvailable() || !oldSecretId;

                            if (this.plugin.settings.cloudApiKey && shouldPersistPlainKey) {
                                this.plugin.settings.providerSettings[oldType].apiKey = this.plugin.settings.cloudApiKey;
                            }
                            if (this.plugin.settings.cloudModel) {
                                this.plugin.settings.providerSettings[oldType].model = this.plugin.settings.cloudModel;
                            }

                            this.plugin.settings.cloudServiceType = newType;

                            // Restore API key and model for the new provider (if previously saved)
                            const savedSettings = this.plugin.settings.providerSettings[newType];
                            const newSecretId = PROVIDER_TO_SECRET_ID[newType];
                            if (!secretStorage.isAvailable() || !newSecretId) {
                                if (savedSettings?.apiKey) {
                                    this.plugin.settings.cloudApiKey = savedSettings.apiKey;
                                } else {
                                    this.plugin.settings.cloudApiKey = '';
                                }
                            } else {
                                this.plugin.settings.cloudApiKey = '';
                            }

                            this.plugin.settings.cloudEndpoint = PROVIDER_ENDPOINT[newType];

                            // Restore saved model or use default
                            if (savedSettings?.model) {
                                this.plugin.settings.cloudModel = savedSettings.model;
                            } else {
                                this.plugin.settings.cloudModel = PROVIDER_DEFAULT_MODEL[newType] || 'gpt-4.1';
                            }

                            void this.plugin.saveSettings();
                            this.settingTab.display();
                        })
                );
        }
    }

    private getProviderOptions(): Record<string, string> {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- Code-splitting: provider options loaded on demand
        const { buildProviderOptions } = require('../../services/adapters/providerRegistry');
        return buildProviderOptions(this.plugin.t.dropdowns);
    }

    private displayLocalSettings(): void {
        new Setting(this.containerEl)
            .setName(this.plugin.t.settings.llm.localEndpoint)
            .setDesc(this.plugin.t.settings.llm.localEndpointDesc)
            .addText(text => text
                .setPlaceholder('http://localhost:11434/v1/chat/completions') // eslint-disable-line obsidianmd/ui/sentence-case -- URL
                .setValue(this.plugin.settings.localEndpoint)
                .onChange((value) => {
                    this.plugin.settings.localEndpoint = value;
                    void this.plugin.saveSettings();

                    // Refresh the settings to update the model dropdown
                    this.settingTab.display();
                }));

        new Setting(this.containerEl)
            .setName(this.plugin.t.settings.llm.modelName)
            .setDesc(this.plugin.t.settings.llm.modelNameDesc)
            .addText(text => text
                .setPlaceholder('Model name (e.g., mistral, llama2, gpt-3.5-turbo)')
                .setValue(this.plugin.settings.localModel)
                .onChange((value) => {
                    this.plugin.settings.localModel = value;
                    void this.plugin.saveSettings();
                }));

        // Add a tips section about common local LLM tools
        const tipsEl = this.containerEl.createEl('div', {
            cls: 'ai-organiser-tips-block'
        });

        tipsEl.createEl('h3', { text: this.plugin.t.settings.llm.tipsPopularTools });

        const tipsList = tipsEl.createEl('ul');
        tipsList.createEl('li', { text: `${this.plugin.t.dropdowns.ollama}: http://localhost:11434/v1/chat/completions` });
        tipsList.createEl('li', { text: `${this.plugin.t.dropdowns.localai}: http://localhost:8080/v1/chat/completions` });
        tipsList.createEl('li', { text: `${this.plugin.t.dropdowns.lmStudio}: http://localhost:1234/v1/chat/completions` });
        tipsList.createEl('li', { text: `${this.plugin.t.dropdowns.jan}: http://localhost:1337/v1/chat/completions` });
        tipsList.createEl('li', { text: `${this.plugin.t.dropdowns.koboldcpp}: http://localhost:5001/v1/chat/completions` });

        // Style the tips block
        tipsEl.setCssProps({ '--bg': 'rgba(100, 100, 100, 0.1)' }); tipsEl.addClass('ai-organiser-bg-custom');
        tipsEl.setCssProps({ '--pad': '8px 12px' }); tipsEl.addClass('ai-organiser-pad-custom');
        tipsEl.addClass('ai-organiser-rounded');
        tipsEl.addClass('ai-organiser-mb-16');
        tipsEl.addClass('ai-organiser-text-ui-small');

        this.createTestButton();
    }

    private createTestButton(): void {
        const testContainer = this.containerEl.createDiv('ai-organiser-connection-test-container');

        const testSetting = new Setting(testContainer)
            .setName(this.plugin.t.settings.llm.connectionTest)
            .setDesc(this.plugin.t.settings.llm.connectionTestDesc);

        const buttonContainer = testSetting.settingEl.createDiv('setting-item-control');
        const button = new ButtonComponent(buttonContainer)
            .setButtonText(this.plugin.t.settings.llm.testConnection)
            .onClick(async () => {
                // Disable button during test
                button.setButtonText(this.plugin.t.settings.llm.testing);
                button.setDisabled(true);

                // Clear previous status
                if (this.statusContainer) {
                    this.statusContainer.addClass('ai-organiser-block');
                    this.statusEl.textContent = '';
                    this.statusEl.className = '';
                }

                try {
                    const testResult = await this.plugin.llmService.testConnection();

                    if (testResult.result === ConnectionTestResult.Success) {
                        this.setStatusMessage(this.plugin.t.settings.llm.connectionSuccessful, 'success');
                    } else {
                        this.setStatusMessage(`${this.plugin.t.settings.llm.connectionFailed}: ${testResult.error?.message || 'Unknown error'}`, 'error');
                    }
                } catch (error) {
                    this.setStatusMessage(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
                } finally {
                    // Re-enable button
                    button.setButtonText(this.plugin.t.settings.llm.testConnection);
                    button.setDisabled(false);
                }
            });

        this.statusContainer = testContainer.createDiv('ai-organiser-connection-test-status');
        this.statusEl = this.statusContainer.createSpan();

        // Hide status container initially
        if (this.statusContainer) {
            this.statusContainer.addClass('ai-organiser-hidden');
        }
    }

    // Predefined model lists for providers with known models
    // Model lists are now centralized in modelRegistry.ts (DRY/SOLID)
    // See: src/services/adapters/modelRegistry.ts

    private displayCloudSettings(): void {
        const serviceType = this.plugin.settings.cloudServiceType;

        // Getting Started info box
        this.renderGettingStartedBox(serviceType);

        new Setting(this.containerEl)
            .setName(this.plugin.t.settings.llm.apiEndpoint)
            .setDesc(this.plugin.t.settings.llm.apiEndpointDesc)
            .addText(text => {
                const placeholder = this.plugin.settings.cloudEndpoint || PROVIDER_ENDPOINT[serviceType] ||
                    (serviceType === 'openai-compatible' ? 'http://your-api-endpoint/v1/chat/completions' : '');

                text.setPlaceholder(placeholder)
                    .setValue(this.plugin.settings.cloudEndpoint);

                text.onChange((value) => {
                    this.plugin.settings.cloudEndpoint = value;
                    void this.plugin.saveSettings();
                });

                return text;
            });

        this.renderProviderCapabilityBanner();

        const apiKeyPlaceholder =
            this.plugin.settings.cloudServiceType === 'openai' ? 'sk-...' :
            this.plugin.settings.cloudServiceType === 'gemini' ? 'AIza...' :
            this.plugin.settings.cloudServiceType === 'deepseek' ? 'deepseek-...' :
            this.plugin.settings.cloudServiceType === 'aliyun' ? 'sk-...' :
            this.plugin.settings.cloudServiceType === 'claude' ? 'sk-ant-...' :
            this.plugin.settings.cloudServiceType === 'groq' ? 'gsk_...' :
            this.plugin.settings.cloudServiceType === 'openrouter' ? 'sk-or-...' :
            this.plugin.settings.cloudServiceType === 'bedrock' ? 'aws-credentials' :
            this.plugin.settings.cloudServiceType === 'requesty' ? 'rq-...' :
            this.plugin.settings.cloudServiceType === 'cohere' ? 'co-...' :
            this.plugin.settings.cloudServiceType === 'grok' ? 'grok-...' :
            this.plugin.settings.cloudServiceType === 'mistral' ? 'mist-...' :
            this.plugin.settings.cloudServiceType === 'openai-compatible' ? 'your-api-key' :
            'your-api-key';

        const secretId = PROVIDER_TO_SECRET_ID[serviceType];
        const secretStorageAvailable = this.plugin.secretStorageService.isAvailable();

        if (secretId && secretStorageAvailable) {
            this.renderApiKeyField({
                name: this.plugin.t.settings.llm.apiKey,
                desc: this.plugin.t.settings.llm.apiKeyDesc,
                secretId,
                currentValue: this.plugin.settings.cloudApiKey,
                placeholder: apiKeyPlaceholder,
                onChange: (value) => {
                    this.plugin.settings.cloudApiKey = value;
                    void this.plugin.saveSettings();
                }
            });
        } else {
            new Setting(this.containerEl)
                .setName(this.plugin.t.settings.llm.apiKey)
                .setDesc(this.plugin.t.settings.llm.apiKeyDesc)
                .addText(text => {
                    const currentKey = this.plugin.settings.cloudApiKey || '';
                    const maskedKey = currentKey && currentKey.length > 6
                        ? currentKey.substring(0, 6) + '*'.repeat(Math.min(20, currentKey.length - 6))
                        : currentKey;

                    text.setPlaceholder(apiKeyPlaceholder)
                        .setValue(maskedKey)
                        .onChange((value) => {
                            if (value !== maskedKey) {
                                this.plugin.settings.cloudApiKey = value;
                                void this.plugin.saveSettings();
                            }
                        });

                    text.inputEl.type = 'password';
                    return text;
                });
        }

// For providers with known models (from centralized registry), show a dropdown
        const providerModels = getProviderModels(serviceType);
        const hasModels = hasModelList(serviceType);

        if (hasModels) {
            const models = providerModels;
            const defaultModel = PROVIDER_DEFAULT_MODEL[serviceType];
            new Setting(this.containerEl)
                .setName(this.plugin.t.settings.llm.modelName)
                .setDesc(this.plugin.t.settings.llm.modelNameDesc)
                .addDropdown(dropdown => {
                    // Add all models to dropdown
                    for (const [modelId, displayName] of Object.entries(models)) {
                        dropdown.addOption(modelId, displayName);
                    }

                    // Set current value (default if not in list)
                    const currentModel = this.plugin.settings.cloudModel;
                    if (models[currentModel]) {
                        dropdown.setValue(currentModel);
                    } else {
                        dropdown.setValue(defaultModel);
                    }

                    dropdown.onChange((value) => {
                        this.plugin.settings.cloudModel = value;
                        void this.plugin.saveSettings();
                        // Re-render to show/hide thinking mode dropdown
                        this.settingTab.display();
                    });
                });
        } else {
            // For other providers, use text input with placeholder hints
            // Use centralized default model placeholders

            new Setting(this.containerEl)
                .setName(this.plugin.t.settings.llm.modelName)
                .setDesc(this.plugin.t.settings.llm.modelNameDesc)
                .addText(text => text
                    .setPlaceholder(PROVIDER_DEFAULT_MODEL[serviceType] || 'model-name')
                    .setValue(this.plugin.settings.cloudModel)
                    .onChange((value) => {
                        this.plugin.settings.cloudModel = value;
                        void this.plugin.saveSettings();
                    }));
        }

        // Show thinking mode dropdown for Claude models that support adaptive thinking (Opus 4.6, Sonnet 4.6)
        if (serviceType === 'claude' && (this.plugin.settings.cloudModel.startsWith('claude-opus-4-6') || this.plugin.settings.cloudModel.startsWith('claude-sonnet-4-6'))) {
            new Setting(this.containerEl)
                .setName(this.plugin.t.settings.llm.thinkingMode)
                .setDesc(this.plugin.t.settings.llm.thinkingModeDesc)
                .addDropdown(dropdown =>
                    dropdown
                        .addOption('adaptive', this.plugin.t.settings.llm.thinkingAdaptive)
                        .addOption('standard', this.plugin.t.settings.llm.thinkingStandard)
                        .setValue(this.plugin.settings.claudeThinkingMode)
                        .onChange((value) => {
                            this.plugin.settings.claudeThinkingMode = value as 'standard' | 'adaptive';
                            void this.plugin.saveSettings();
                        })
                );
        }

        this.createTestButton();
    }

    private renderGettingStartedBox(serviceType: string): void {
        const t = this.plugin.t.settings.llm.gettingStarted;
        const boxEl = this.containerEl.createDiv({ cls: 'ai-organiser-settings-info' });

        boxEl.createEl('strong', { text: t.title });

        // Provider-specific API key guidance
        if (serviceType === 'claude') {
            const claudeP = boxEl.createEl('p', { cls: 'setting-item-description' });
            claudeP.appendText(t.claudeDesc + ' ');
            claudeP.createEl('a', {
                text: t.apiKeyLink,
                href: 'https://console.anthropic.com/',
            });
        }

        // "Other providers work too" message
        boxEl.createEl('p', {
            text: t.otherProviders,
            cls: 'setting-item-description'
        });

        // Collapsible list of all 14 supported providers
        const detailsEl = boxEl.createEl('details');
        detailsEl.addClass('ai-organiser-mt-4');
        detailsEl.createEl('summary', {
            text: t.viewAllProviders,
            cls: 'setting-item-description ai-organiser-cursor-pointer'
        });

        const providerOptions = this.getProviderOptions();
        const providerList = detailsEl.createEl('ul');
        providerList.setCssProps({ '--margin': '4px 0 0 0' }); providerList.addClass('ai-organiser-margin-custom');
        providerList.setCssProps({ '--pl': '20px' }); providerList.addClass('ai-organiser-pl-custom');
        for (const name of Object.values(providerOptions)) {
            providerList.createEl('li', { text: name, cls: 'setting-item-description' });
        }

        // Local recommendation
        this.renderLocalRecommendation(boxEl);
    }

    private renderLocalRecommendation(parentEl: HTMLElement): void {
        const t = this.plugin.t.settings.llm.localRecommendation;
        const plugin = this.plugin;

        const localDiv = parentEl.createDiv();
        localDiv.addClass('ai-organiser-mt-8');
        localDiv.addClass('ai-organiser-border-t');
        localDiv.addClass('ai-organiser-pt-4');

        localDiv.createEl('strong', { text: t.title });
        localDiv.createEl('p', {
            text: t.description,
            cls: 'setting-item-description'
        });

        const wizardBtn = localDiv.createEl('button', { text: t.setupWizard });
        wizardBtn.classList.add('mod-cta');
        wizardBtn.addClass('ai-organiser-mt-4');
        wizardBtn.addEventListener('click', () => { void (async () => {
            const { LocalSetupWizardModal } = await import('../modals/LocalSetupWizardModal');
            new LocalSetupWizardModal(plugin.app, plugin).open();
        })(); });
    }

    private renderProviderCapabilityBanner(): void {
        const provider = this.plugin.settings.cloudServiceType;
        const t = this.plugin.t.settings.llm.providerCapabilities;

        const caps = {
            youtube: ['gemini'],
            audio: ['openai', 'groq'],
            pdf: ['claude', 'gemini'],
            embeddings: ['openai', 'gemini', 'cohere', 'voyage', 'openrouter', 'ollama']
        };

        const missing: string[] = [];
        if (!caps.youtube.includes(provider)) missing.push(t.youtube);
        if (!caps.audio.includes(provider)) missing.push(t.audio);
        if (!caps.pdf.includes(provider)) missing.push(t.pdf);
        if (provider === 'claude') missing.push(t.embeddings);

        if (missing.length === 0) return;

        const bannerEl = this.containerEl.createDiv({ cls: 'ai-organiser-settings-info' });
        bannerEl.createEl('strong', { text: t.title });
        const list = bannerEl.createEl('ul');
        list.setCssProps({ '--margin': '4px 0 0 0' }); list.addClass('ai-organiser-margin-custom');
        list.setCssProps({ '--pl': '20px' }); list.addClass('ai-organiser-pl-custom');
        for (const item of missing) {
            list.createEl('li', { text: item, cls: 'setting-item-description' });
        }
    }

    private setStatusMessage(message: string, status: 'success' | 'error'): void {
        if (!this.statusContainer || !this.statusEl) return;

        this.statusContainer.addClass('ai-organiser-block');
        this.statusContainer.className = 'ai-organiser-connection-test-status ' + status;
        this.statusEl.textContent = message;
    }

    private async checkLocalService(endpoint: string): Promise<void> {
        const baseUrl = endpoint.trim().replace(/\/$/, '').replace(/\/v1\/chat\/completions$/, '');
        let checkUrl = `${baseUrl}/v1/models`;  // Default check URL for most services

        try {
            const response = await requestUrl({
                url: checkUrl,
                method: 'GET',
                headers: { 'Content-Type': 'application/json' }
            });

            if (response.status >= 400) {
                new Notice(this.plugin.t.messages.localServiceNotRunning, 10000);
            }
        } catch (_error) {
            new Notice(this.plugin.t.messages.localServiceNotAvailable, 10000);
        }
    }

    private hasPlainTextKeys(): boolean {
        const settings = this.plugin.settings;
        if (settings.cloudApiKey ||
            settings.embeddingApiKey ||
            settings.youtubeGeminiApiKey ||
            settings.pdfApiKey ||
            settings.audioTranscriptionApiKey) {
            return true;
        }

        if (settings.providerSettings) {
            return Object.values(settings.providerSettings)
                .some((config) => !!config?.apiKey);
        }

        return false;
    }

    private renderSecretStorageMigrationNotice(): void {
        const secretStorage = this.plugin.secretStorageService;
        const t = this.plugin.t.settings.secretStorage;

        if (!secretStorage.isAvailable() || this.plugin.settings.secretStorageMigrated || !this.hasPlainTextKeys()) {
            return;
        }

        new Setting(this.containerEl)
            .setName(t.migrationTitle)
            .setDesc(t.migrationDesc)
            .addButton(btn => btn
                .setButtonText(t.migrateNow)
                .setCta()
                .onClick(async () => {
                    const confirmed = await new Promise<boolean>((resolve) => {
                        const modal = new MigrationConfirmModal(this.plugin.app, this.plugin, resolve);
                        modal.open();
                    });

                    if (!confirmed) {
                        new Notice(t.migrationDeclined);
                        return;
                    }

                    const result = await secretStorage.migrateFromPlainText();
                    if (result.migrated) {
                        new Notice(t.migrationComplete);
                        this.settingTab.display();
                    } else {
                        new Notice(result.reason || this.plugin.t.messages.unknownError || 'Migration failed');
                    }
                }));
    }
}
