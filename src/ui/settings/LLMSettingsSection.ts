import { Setting, ButtonComponent, Notice, requestUrl } from 'obsidian';
import { ConnectionTestResult } from '../../services';
import { BaseSettingSection } from './BaseSettingSection';
import { PROVIDER_ENDPOINT, PROVIDER_DEFAULT_MODEL, buildProviderOptions } from '../../services/adapters/providerRegistry';
import { getProviderModels, hasModelList } from '../../services/adapters/modelRegistry';
import { claudeSupportsAdaptiveThinking } from '../../services/adapters/modelCapabilities';
import {
    getCachedModels,
    getLiveModels,
    providerSupportsLiveFetch,
} from '../../services/adapters/dynamicModelService';
import { PROVIDER_TO_SECRET_ID } from '../../core/secretIds';
import { MigrationConfirmModal } from '../modals/MigrationConfirmModal';
import { isAzureMode } from '../../services/azure/endpointResolver';

export class LLMSettingsSection extends BaseSettingSection {
    private statusContainer: HTMLElement = null!;
    private statusEl: HTMLElement = null!;
    /** Escape-hatch: when true, reveal the full provider dropdown even in
     *  streamlined Azure mode. Resets each settings-tab open (instance-local). */
    private azureShowFullProvider = false;

    /**
     * Streamlined Azure UX is active when Azure-first mode is on, the main
     * provider is an Azure surface, and the user hasn't clicked the
     * "Use a different provider" escape hatch. In this state the generic full
     * provider dropdown + getting-started box are suppressed (redundant with
     * the Azure section, which owns the azure-claude vs azure-openai choice).
     */
    private isStreamlinedAzure(): boolean {
        return (
            !!this.plugin.settings.azureFirstMode &&
            isAzureMode(this.plugin.settings) &&
            !this.azureShowFullProvider
        );
    }

    display(): void {
        this.createSectionHeader(this.plugin.t.settings.llm.title, 'bot');
        this.renderAzureFirstToggle();
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

    /**
     * Azure-first mode toggle + section (Plan A — Azure providers).
     *
     * Azure-first is UX-ONLY (plan AD-6): it surfaces the Azure config fields up
     * front but does NOT route requests. The user still explicitly selects the
     * `azure-claude` / `azure-openai` provider in the cloud-provider dropdown.
     * Fields are vault-local (stored in data.json, never shipped as defaults).
     */
    private renderAzureFirstToggle(): void {
        const az = this.plugin.t.settings.llm.azure;
        new Setting(this.containerEl)
            .setName(az.firstMode)
            .setDesc(az.firstModeDesc)
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.azureFirstMode ?? false)
                .onChange((value) => {
                    // The toggle is a CORPORATE ↔ PERSONAL switch: ON selects Azure for
                    // all routing; OFF restores the personal provider the user had before
                    // (e.g. direct Anthropic). We snapshot on enter and restore on exit so
                    // a private-PC user flips back to their own provider, not stranded on Azure.
                    const s = this.plugin.settings;
                    if (value) {
                        if (!isAzureMode(s)) {
                            s.preAzureFirstProvider = s.cloudServiceType; // remember personal (e.g. 'claude')
                            if (!s.providerSettings) s.providerSettings = {};
                            const ps = s.providerSettings[s.cloudServiceType] ?? (s.providerSettings[s.cloudServiceType] = {});
                            if (s.cloudModel) ps.model = s.cloudModel;
                            s.cloudServiceType = 'azure-claude';
                            s.cloudEndpoint = '';
                            s.cloudModel = s.taskModels?.chat || 'claude-sonnet-4-6';
                        }
                        s.azureFirstMode = true;
                    } else {
                        s.azureFirstMode = false;
                        if (s.cloudServiceType.startsWith('azure')) {
                            const target = (s.preAzureFirstProvider && !s.preAzureFirstProvider.startsWith('azure'))
                                ? s.preAzureFirstProvider : 'claude';
                            const t = target as typeof s.cloudServiceType;
                            const saved = s.providerSettings?.[t];
                            s.cloudServiceType = t;
                            s.cloudEndpoint = PROVIDER_ENDPOINT[t] ?? '';
                            s.cloudModel = saved?.model || PROVIDER_DEFAULT_MODEL[t] || 'latest-sonnet';
                            const secretId = PROVIDER_TO_SECRET_ID[t];
                            s.cloudApiKey = (this.plugin.secretStorageService.isAvailable() && secretId)
                                ? '' : (saved?.apiKey || '');
                        }
                        s.preAzureFirstProvider = '';
                    }
                    void this.plugin.saveSettings();
                    this.settingTab.display();
                })
            );

        if (this.plugin.settings.azureFirstMode) {
            const banner = this.containerEl.createDiv({ cls: 'ai-organiser-azure-banner' });
            banner.createSpan({ text: az.banner });
            this.renderAzureSection();
        }
    }

    /** Azure config fields, shown when Azure-first mode is on. */
    private renderAzureSection(): void {
        const az = this.plugin.t.settings.llm.azure;
        this.containerEl.createEl('h4', { text: az.foundryHeading });

        // Main-provider choice (azure-claude vs azure-openai) lives INSIDE the
        // Azure section in streamlined mode — the generic full dropdown is
        // suppressed below. Both surfaces are still served automatically.
        if (this.isStreamlinedAzure()) {
            const current = isAzureMode(this.plugin.settings)
                ? this.plugin.settings.cloudServiceType
                : 'azure-claude';
            new Setting(this.containerEl)
                .setName(az.mainProviderChoice)
                .setDesc(az.mainProviderChoiceDesc)
                .addDropdown(dropdown => dropdown
                    .addOption('azure-claude', az.providerAzureClaude)
                    .addOption('azure-openai', az.providerAzureOpenAI)
                    .setValue(current)
                    .onChange((value) => {
                        this.plugin.settings.cloudServiceType = value as typeof this.plugin.settings.cloudServiceType;
                        this.plugin.settings.cloudEndpoint = PROVIDER_ENDPOINT[value as keyof typeof PROVIDER_ENDPOINT] || '';
                        void this.plugin.saveSettings();
                        this.settingTab.display();
                    }));
        }

        // API key — plain password field (transient; migrated to SecretStorage on save).
        new Setting(this.containerEl)
            .setName(az.apiKey)
            .setDesc(az.apiKeyDesc)
            .addText(text => {
                text.setPlaceholder(az.apiKeyPlaceholder)
                    .setValue(this.plugin.settings.azureApiKey ? '••••••••' : '')
                    .onChange((value) => {
                        if (value !== '••••••••') {
                            this.plugin.settings.azureApiKey = value;
                            void this.plugin.saveSettings();
                        }
                    });
                text.inputEl.type = 'password';
                return text;
            });

        new Setting(this.containerEl)
            .setName(az.aiEndpoint)
            .setDesc(az.aiEndpointDesc)
            .addText(text => text
                .setPlaceholder('https://<your-resource>.services.ai.azure.com')
                .setValue(this.plugin.settings.azureAIEndpoint)
                .onChange((value) => {
                    this.plugin.settings.azureAIEndpoint = value;
                    void this.plugin.saveSettings();
                }));

        new Setting(this.containerEl)
            .setName(az.openAIEndpoint)
            .setDesc(az.openAIEndpointDesc)
            .addText(text => text
                .setPlaceholder('https://<your-resource>.openai.azure.com')
                .setValue(this.plugin.settings.azureOpenAIEndpoint)
                .onChange((value) => {
                    this.plugin.settings.azureOpenAIEndpoint = value;
                    void this.plugin.saveSettings();
                }));

        new Setting(this.containerEl)
            .setName(az.whisperDeployment)
            .setDesc(az.whisperDeploymentDesc)
            .addText(text => text
                .setPlaceholder(az.whisperDeploymentPlaceholder)
                .setValue(this.plugin.settings.azureWhisperDeployment)
                .onChange((value) => {
                    this.plugin.settings.azureWhisperDeployment = value;
                    void this.plugin.saveSettings();
                }));

        // Default model for general tasks.
        new Setting(this.containerEl)
            .setName(az.defaultModel)
            .setDesc(az.defaultModelDesc)
            .addDropdown(dropdown => {
                dropdown
                    .addOption('claude-sonnet-4-6', az.modelSonnet)
                    .addOption('claude-opus-4-6', az.modelOpus)
                    .setValue(this.plugin.settings.taskModels?.tagging || 'claude-sonnet-4-6')
                    .onChange((value) => {
                        if (!this.plugin.settings.taskModels) return;
                        this.plugin.settings.taskModels.tagging = value;
                        this.plugin.settings.taskModels.summarization = value;
                        this.plugin.settings.taskModels.chat = value;
                        this.plugin.settings.taskModels.mermaid = value;
                        void this.plugin.saveSettings();
                    });
            });

        // GPT model — used by azure-openai chat + the live test.
        new Setting(this.containerEl)
            .setName(az.gptModel)
            .setDesc(az.gptModelDesc)
            .addText(text => text
                .setPlaceholder(az.gptModelPlaceholder)
                .setValue(this.plugin.settings.azureGPTModel)
                .onChange((value) => {
                    this.plugin.settings.azureGPTModel = value;
                    void this.plugin.saveSettings();
                }));

        // Embedding model — so semantic-search embeddings are configurable.
        new Setting(this.containerEl)
            .setName(az.embeddingModel)
            .setDesc(az.embeddingModelDesc)
            .addText(text => text
                .setPlaceholder(az.embeddingModelPlaceholder)
                .setValue(this.plugin.settings.embeddingModel)
                .onChange((value) => {
                    this.plugin.settings.embeddingModel = value;
                    void this.plugin.saveSettings();
                }));

        // Routing mode — deployment-based reveals named deployment fields.
        new Setting(this.containerEl)
            .setName(az.routingMode)
            .setDesc(az.routingModeDesc)
            .addDropdown(dropdown => dropdown
                .addOption('model-based', az.routingModel)
                .addOption('deployment-based', az.routingDeployment)
                .setValue(this.plugin.settings.azureRoutingMode)
                .onChange((value) => {
                    this.plugin.settings.azureRoutingMode = value as 'model-based' | 'deployment-based';
                    void this.plugin.saveSettings();
                    this.settingTab.display();
                }));

        if (this.plugin.settings.azureRoutingMode === 'deployment-based') {
            new Setting(this.containerEl)
                .setName(az.chatDeployment)
                .setDesc(az.chatDeploymentDesc)
                .addText(text => text
                    .setValue(this.plugin.settings.azureDeployments?.chat || '')
                    .onChange((value) => {
                        if (!this.plugin.settings.azureDeployments) this.plugin.settings.azureDeployments = {};
                        this.plugin.settings.azureDeployments.chat = value;
                        void this.plugin.saveSettings();
                    }));

            new Setting(this.containerEl)
                .setName(az.embeddingsDeployment)
                .setDesc(az.embeddingsDeploymentDesc)
                .addText(text => text
                    .setValue(this.plugin.settings.azureDeployments?.embeddings || '')
                    .onChange((value) => {
                        if (!this.plugin.settings.azureDeployments) this.plugin.settings.azureDeployments = {};
                        this.plugin.settings.azureDeployments.embeddings = value;
                        void this.plugin.saveSettings();
                    }));
        }

        // Live connection test — pre-flight validates config, then makes real
        // minimal round-trips to each configured Azure surface. Results render
        // per-surface (✓/✗ + redacted message) under the button.
        const resultsEl = this.containerEl.createDiv({ cls: 'ai-organiser-azure-test-results' });
        new Setting(this.containerEl)
            .setName(az.testConfig)
            .setDesc(az.testConfigDesc)
            .addButton(button => button
                .setButtonText(az.testButton)
                .onClick(async () => {
                    button.setButtonText(az.testingButton);
                    button.setDisabled(true);
                    resultsEl.empty();
                    try {
                        const { testAzureConnection } = await import('../../services/azure/azureConnectionTest');
                        const report = await testAzureConnection(this.plugin);
                        this.renderAzureTestReport(resultsEl, report);
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        resultsEl.createDiv({ cls: 'ai-organiser-azure-test-row error', text: `✗ ${msg}` });
                    } finally {
                        button.setButtonText(az.testButton);
                        button.setDisabled(false);
                    }
                }));

        // Escape hatch — reveal the full provider dropdown for users who want a
        // non-Azure provider while keeping Azure-first mode on.
        if (this.isStreamlinedAzure()) {
            const hatch = this.containerEl.createDiv({ cls: 'setting-item-description ai-organiser-mt-4' });
            const link = hatch.createEl('a', {
                text: az.useDifferentProvider,
                cls: 'ai-organiser-cursor-pointer',
            });
            link.addEventListener('click', () => {
                this.azureShowFullProvider = true;
                this.settingTab.display();
            });
        }
    }

    /** Render a live Azure test report as a per-surface result list. */
    private renderAzureTestReport(
        container: HTMLElement,
        report: import('../../services/azure/azureConnectionTest').AzureTestReport,
    ): void {
        const az = this.plugin.t.settings.llm.azure;
        container.empty();

        if (!report.preflightOk) {
            container.createDiv({
                cls: 'ai-organiser-azure-test-row error',
                text: `✗ ${az.configInvalid} ${report.preflightErrors.join('; ')}`,
            });
            return;
        }

        container.createEl('h4', { text: az.liveTestHeading });
        const labels: Record<string, string> = {
            'azure-claude': az.surfaceClaude,
            'azure-openai-chat': az.surfaceOpenAIChat,
            'azure-openai-embeddings': az.surfaceEmbeddings,
            'azure-openai-whisper': az.surfaceWhisper,
        };
        for (const s of report.surfaces) {
            const label = labels[s.surface] ?? s.surface;
            container.createDiv({
                cls: `ai-organiser-azure-test-row ${s.ok ? 'success' : 'error'}`,
                text: `${s.ok ? '✓' : '✗'} ${label}: ${s.message}`,
            });
        }
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

        // In streamlined Azure mode the azure-claude/azure-openai choice lives
        // inside the Azure section — suppress the redundant full dropdown here.
        if (this.plugin.settings.serviceType === 'cloud' && !this.isStreamlinedAzure()) {
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

                            // Picking a NON-Azure provider exits Azure-first mode so the
                            // two never diverge (else the load-time reconcile would flip
                            // the provider back to Azure and fight the user's choice).
                            if (this.plugin.settings.azureFirstMode && !newType.startsWith('azure')) {
                                this.plugin.settings.azureFirstMode = false;
                            }

                            void this.plugin.saveSettings();
                            this.settingTab.display();
                        })
                );
        }
    }

    private getProviderOptions(): Record<string, string> {
        return buildProviderOptions(this.plugin.t.dropdowns);
    }

    private displayLocalSettings(): void {
        new Setting(this.containerEl)
            .setName(this.plugin.t.settings.llm.localEndpoint)
            .setDesc(this.plugin.t.settings.llm.localEndpointDesc)
            .addText(text => {
                const endpointPlaceholder = 'http://localhost:11434/v1/chat/completions';
                return text
                    .setPlaceholder(endpointPlaceholder)
                    .setValue(this.plugin.settings.localEndpoint)
                    .onChange((value) => {
                        this.plugin.settings.localEndpoint = value;
                        void this.plugin.saveSettings();

                        // Refresh the settings to update the model dropdown
                        this.settingTab.display();
                    });
            });

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

        // Azure providers are configured ENTIRELY via the Azure section (its own
        // key, endpoints, models, and live connection test). The generic cloud
        // config below (API endpoint / key / model / generic test) doesn't apply
        // to Azure — its endpoint lives in the Azure fields, so the generic test
        // fails with "API endpoint is not configured". Suppress it here. Provider
        // SWITCHING still works via the cloud-provider dropdown in
        // createServiceTypeDropdown (shown when the "use a different provider"
        // escape hatch is expanded) — pick a non-Azure provider and this generic
        // config renders for it.
        if (isAzureMode(this.plugin.settings)) return;

        // Getting Started info box — suppressed in streamlined Azure mode
        // (the Azure section already owns the provider guidance).
        if (!this.isStreamlinedAzure()) {
            this.renderGettingStartedBox(serviceType);
        }

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

            // Merge any live-fetched models into the static list (live wins
            // on label; new IDs are appended). Lets users pick models that
            // shipped after the bundled registry snapshot.
            const cachedLive = getCachedModels(serviceType);
            const mergedModels: Record<string, string> = { ...models };
            if (cachedLive) {
                for (const m of cachedLive) {
                    if (!(m.id in mergedModels)) {
                        mergedModels[m.id] = m.label ?? m.id;
                    } else if (m.label) {
                        mergedModels[m.id] = m.label;
                    }
                }
            }

            new Setting(this.containerEl)
                .setName(this.plugin.t.settings.llm.modelName)
                .setDesc(this.plugin.t.settings.llm.modelNameDesc
                    + (cachedLive ? ` (${cachedLive.length} live models cached)` : ''))
                .addDropdown(dropdown => {
                    for (const [modelId, displayName] of Object.entries(mergedModels)) {
                        dropdown.addOption(modelId, displayName);
                    }
                    const currentModel = this.plugin.settings.cloudModel;
                    if (mergedModels[currentModel]) {
                        dropdown.setValue(currentModel);
                    } else {
                        dropdown.setValue(defaultModel);
                    }
                    dropdown.onChange((value) => {
                        this.plugin.settings.cloudModel = value;
                        void this.plugin.saveSettings();
                        this.settingTab.display();
                    });
                });

            // "Refresh models from provider" — fetches live catalog, merges,
            // and re-renders. Only shown for providers whose API exposes a
            // /models endpoint (Claude, OpenAI, Gemini, Groq, DeepSeek,
            // OpenRouter).
            if (providerSupportsLiveFetch(serviceType)) {
                new Setting(this.containerEl)
                    .setName('Refresh models from provider')
                    .setDesc('Fetch the live catalog from the provider\'s API. Newer models published after this plugin shipped will appear in the dropdown. `latest-*` selections pick up new releases automatically on the next refresh.')
                    .addButton(btn => btn
                        .setButtonText('Refresh now')
                        .onClick(async () => {
                            btn.setDisabled(true).setButtonText('Fetching…');
                            try {
                                const key = this.plugin.settings.cloudApiKey;
                                const live = await getLiveModels(serviceType, key, { forceRefresh: true });
                                new Notice(`Fetched ${live.length} models from ${serviceType}.`, 4000);
                                this.settingTab.display();
                            } catch (err) {
                                const msg = err instanceof Error ? err.message : String(err);
                                new Notice(`Model refresh failed: ${msg}`, 6000);
                            } finally {
                                btn.setDisabled(false).setButtonText('Refresh now');
                            }
                        }));
            }
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

        // Show thinking mode dropdown for Claude models that support adaptive
        // thinking. Capability gated by family+version pattern — new releases
        // (Opus 4.8, 5.0, …) are picked up automatically.
        if (serviceType === 'claude' && claudeSupportsAdaptiveThinking(this.plugin.settings.cloudModel)) {
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
        if (provider.startsWith('azure')) {
            // In Azure mode, audio (Whisper), PDF (Azure Claude) and embeddings
            // (Azure OpenAI) are auto-handled by Azure — only YouTube genuinely
            // needs a separate Gemini key (Azure has no YouTube/Gemini path).
            missing.push(t.youtube);
        } else {
            if (!caps.youtube.includes(provider)) missing.push(t.youtube);
            if (!caps.audio.includes(provider)) missing.push(t.audio);
            if (!caps.pdf.includes(provider)) missing.push(t.pdf);
            if (provider === 'claude') missing.push(t.embeddings);
        }

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
        } catch {
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
