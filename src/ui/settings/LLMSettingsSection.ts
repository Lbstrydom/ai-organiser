import { Setting, ButtonComponent, Notice } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { ConnectionTestResult } from '../../services';
import { BaseSettingSection } from './BaseSettingSection';

export class LLMSettingsSection extends BaseSettingSection {
    private statusContainer: HTMLElement = null!;
    private statusEl: HTMLElement = null!;

    display(): void {
        this.createSectionHeader(this.plugin.t.settings.llm.title, 'bot');
        this.createServiceTypeDropdown();
        this.plugin.settings.serviceType === 'local' ?
            this.displayLocalSettings() :
            this.displayCloudSettings();

        // Check local service status when loading settings if local service is selected
        if (this.plugin.settings.serviceType === 'local') {
            this.checkLocalService(this.plugin.settings.localEndpoint);
        }

        // Debug mode toggle
        new Setting(this.containerEl)
            .setName(this.plugin.t.settings.llm.debugMode)
            .setDesc(this.plugin.t.settings.llm.debugModeDesc)
            .addToggle(toggle =>
                toggle
                    .setValue(this.plugin.settings.debugMode)
                    .onChange(async (value) => {
                        this.plugin.settings.debugMode = value;
                        await this.plugin.saveSettings();
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
                    .onChange(async (value) => {
                        this.plugin.settings.serviceType = value as 'local' | 'cloud';
                        await this.plugin.saveSettings();
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
                        .onChange(async (value) => {
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
                            if (this.plugin.settings.cloudApiKey) {
                                this.plugin.settings.providerSettings[oldType]!.apiKey = this.plugin.settings.cloudApiKey;
                            }
                            if (this.plugin.settings.cloudModel) {
                                this.plugin.settings.providerSettings[oldType]!.model = this.plugin.settings.cloudModel;
                            }

                            this.plugin.settings.cloudServiceType = newType;

                            // Restore API key and model for the new provider (if previously saved)
                            const savedSettings = this.plugin.settings.providerSettings[newType];
                            if (savedSettings?.apiKey) {
                                this.plugin.settings.cloudApiKey = savedSettings.apiKey;
                            } else {
                                this.plugin.settings.cloudApiKey = '';
                            }

                            // Use centralized registry for endpoints and default models
                            const { PROVIDER_ENDPOINT, PROVIDER_DEFAULT_MODEL } = await import('../../services/adapters/providerRegistry');

                            this.plugin.settings.cloudEndpoint = PROVIDER_ENDPOINT[newType];

                            // Restore saved model or use default
                            if (savedSettings?.model) {
                                this.plugin.settings.cloudModel = savedSettings.model;
                            } else {
                                this.plugin.settings.cloudModel = PROVIDER_DEFAULT_MODEL[newType] || 'gpt-4.1';
                            }

                            await this.plugin.saveSettings();
                            this.settingTab.display();
                        })
                );
        }
    }

    private getProviderOptions(): Record<string, string> {
        const { buildProviderOptions } = require('../../services/adapters/providerRegistry');
        return buildProviderOptions(this.plugin.t.dropdowns);
    }

    private displayLocalSettings(): void {
        new Setting(this.containerEl)
            .setName(this.plugin.t.settings.llm.localEndpoint)
            .setDesc(this.plugin.t.settings.llm.localEndpointDesc)
            .addText(text => text
                .setPlaceholder('http://localhost:11434/v1/chat/completions')
                .setValue(this.plugin.settings.localEndpoint)
                .onChange(async (value) => {
                    this.plugin.settings.localEndpoint = value;
                    await this.plugin.saveSettings();

                    // Refresh the settings to update the model dropdown
                    this.settingTab.display();
                }));

        new Setting(this.containerEl)
            .setName(this.plugin.t.settings.llm.modelName)
            .setDesc(this.plugin.t.settings.llm.modelNameDesc)
            .addText(text => text
                .setPlaceholder('Model name (e.g., mistral, llama2, gpt-3.5-turbo)')
                .setValue(this.plugin.settings.localModel)
                .onChange(async (value) => {
                    this.plugin.settings.localModel = value;
                    await this.plugin.saveSettings();
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
        tipsEl.style.backgroundColor = 'rgba(100, 100, 100, 0.1)';
        tipsEl.style.padding = '8px 12px';
        tipsEl.style.borderRadius = '4px';
        tipsEl.style.marginBottom = '16px';
        tipsEl.style.fontSize = '0.9em';

        this.createTestButton();
    }

    private createTestButton(): void {
        const testContainer = this.containerEl.createDiv('connection-test-container');

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
                    this.statusContainer.style.display = 'block';
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

        this.statusContainer = testContainer.createDiv('connection-test-status');
        this.statusEl = this.statusContainer.createSpan();

        // Hide status container initially
        if (this.statusContainer) {
            this.statusContainer.style.display = 'none';
        }
    }

    // Predefined model lists for providers with known models
    // Use actual API model IDs - these must match what the provider accepts
    private readonly CLAUDE_MODELS: Record<string, string> = {
        // Claude 4.5 (Latest)
        'claude-sonnet-4-5-20250929': 'Claude Sonnet 4.5 (Recommended)',
        'claude-haiku-4-5-20251001': 'Claude Haiku 4.5 (Fastest)',
        'claude-opus-4-5-20251101': 'Claude Opus 4.5 (Most Capable)',
        // Claude 4 (Legacy)
        'claude-opus-4-1-20250805': 'Claude Opus 4.1',
        'claude-sonnet-4-20250514': 'Claude Sonnet 4',
        'claude-opus-4-20250514': 'Claude Opus 4',
        // Claude 3.7
        'claude-3-7-sonnet-20250219': 'Claude 3.7 Sonnet',
        // Claude 3 (Legacy)
        'claude-3-haiku-20240307': 'Claude 3 Haiku (Cheapest)'
    };

    private readonly OPENAI_MODELS: Record<string, string> = {
        // GPT-5.2 (Latest)
        'gpt-5.2': 'GPT-5.2 (Best Reasoning)',
        'gpt-5.2-pro': 'GPT-5.2 Pro (Hardest Problems)',
        'gpt-5.2-codex': 'GPT-5.2 Codex (Coding)',
        'gpt-5-mini': 'GPT-5 Mini (Balanced)',
        'gpt-5-nano': 'GPT-5 Nano (Cheapest)',
        // GPT-4.1 (Previous)
        'gpt-4.1': 'GPT-4.1',
        'gpt-4.1-mini': 'GPT-4.1 Mini',
        'gpt-4.1-nano': 'GPT-4.1 Nano',
        // Legacy
        'gpt-4o': 'GPT-4o (Legacy)',
        'gpt-4o-mini': 'GPT-4o Mini (Legacy)'
    };

    private readonly GEMINI_MODELS: Record<string, string> = {
        // Gemini 3 (Latest)
        'gemini-3-pro-preview': 'Gemini 3 Pro (Most Capable)',
        'gemini-3-flash-preview': 'Gemini 3 Flash (Fast)',
        // Gemini 2.5
        'gemini-2.5-pro': 'Gemini 2.5 Pro',
        'gemini-2.5-flash': 'Gemini 2.5 Flash (Recommended)',
        'gemini-2.5-flash-lite': 'Gemini 2.5 Flash Lite (Cheapest)',
        // Gemini 2.0
        'gemini-2.0-flash': 'Gemini 2.0 Flash',
        'gemini-2.0-flash-lite': 'Gemini 2.0 Flash Lite'
    };

    private readonly OPENROUTER_MODELS: Record<string, string> = {
        // Claude (Anthropic)
        'anthropic/claude-sonnet-4.5': 'Claude Sonnet 4.5 (Anthropic)',
        'anthropic/claude-haiku-4.5': 'Claude Haiku 4.5 (Fast)',
        'anthropic/claude-opus-4.5': 'Claude Opus 4.5 (Best)',
        // OpenAI
        'openai/gpt-5.2': 'GPT-5.2 (OpenAI)',
        'openai/gpt-5-mini': 'GPT-5 Mini (OpenAI)',
        'openai/gpt-5-nano': 'GPT-5 Nano (Cheapest)',
        // Google
        'google/gemini-3-pro': 'Gemini 3 Pro (Google)',
        'google/gemini-3-flash': 'Gemini 3 Flash (Google)',
        'google/gemini-2.5-flash': 'Gemini 2.5 Flash (Google)',
        // Others
        'deepseek/deepseek-chat': 'DeepSeek Chat (Best Value)',
        'deepseek/deepseek-r1': 'DeepSeek R1 (Reasoning)',
        'meta-llama/llama-3.3-70b-instruct': 'Llama 3.3 70B (Meta)',
        'qwen/qwen-2.5-72b-instruct': 'Qwen 2.5 72B (Alibaba)'
    };

    private displayCloudSettings(): void {
        new Setting(this.containerEl)
            .setName(this.plugin.t.settings.llm.apiEndpoint)
            .setDesc(this.plugin.t.settings.llm.apiEndpointDesc)
            .addText(text => {
                const placeholder = this.plugin.settings.cloudEndpoint ||
                    (this.plugin.settings.cloudServiceType === 'openai-compatible' ? 'http://your-api-endpoint/v1/chat/completions' : '');

                text.setPlaceholder(placeholder)
                    .setValue(this.plugin.settings.cloudEndpoint);

                text.onChange(async (value) => {
                    this.plugin.settings.cloudEndpoint = value;
                    await this.plugin.saveSettings();
                });

                return text;
            });

        new Setting(this.containerEl)
            .setName(this.plugin.t.settings.llm.apiKey)
            .setDesc(this.plugin.t.settings.llm.apiKeyDesc)
            .addText(text => {
                const placeholder =
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
                    'Bearer oauth2-token';

                // Display masked API key
                const currentKey = this.plugin.settings.cloudApiKey || '';
                const maskedKey = currentKey && currentKey.length > 6
                    ? currentKey.substring(0, 6) + '•'.repeat(Math.min(20, currentKey.length - 6))
                    : currentKey;

                text.setPlaceholder(placeholder)
                    .setValue(maskedKey)
                    .onChange(async (value) => {
                        // Only update if user typed something different (not the masked version)
                        if (value !== maskedKey) {
                            this.plugin.settings.cloudApiKey = value;
                            await this.plugin.saveSettings();
                        }
                    });

                // Make it a password field for security
                text.inputEl.type = 'password';
                return text;
            });

        // For providers with known models, show a dropdown
        const serviceType = this.plugin.settings.cloudServiceType;
        const modelLists: Record<string, { models: Record<string, string>; defaultModel: string }> = {
            'claude': { models: this.CLAUDE_MODELS, defaultModel: 'claude-sonnet-4-5-20250929' },
            'openai': { models: this.OPENAI_MODELS, defaultModel: 'gpt-5.2' },
            'gemini': { models: this.GEMINI_MODELS, defaultModel: 'gemini-2.5-flash' },
            'openrouter': { models: this.OPENROUTER_MODELS, defaultModel: 'anthropic/claude-sonnet-4.5' }
        };

        if (modelLists[serviceType]) {
            const { models, defaultModel } = modelLists[serviceType];
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

                    dropdown.onChange(async (value) => {
                        this.plugin.settings.cloudModel = value;
                        await this.plugin.saveSettings();
                    });
                });
        } else {
            // For other providers, use text input with placeholder hints
            const placeholders: Record<string, string> = {
                'deepseek': 'deepseek-chat',
                'aliyun': 'qwen-max',
                'groq': 'llama-3.3-70b-versatile',
                'bedrock': 'us.anthropic.claude-sonnet-4-5-v1:0',
                'requesty': 'gpt-4.1',
                'cohere': 'command-r-plus',
                'grok': 'grok-3',
                'mistral': 'mistral-large-latest',
                'openai-compatible': 'your-model'
            };

            new Setting(this.containerEl)
                .setName(this.plugin.t.settings.llm.modelName)
                .setDesc(this.plugin.t.settings.llm.modelNameDesc)
                .addText(text => text
                    .setPlaceholder(placeholders[serviceType] || 'model-name')
                    .setValue(this.plugin.settings.cloudModel)
                    .onChange(async (value) => {
                        this.plugin.settings.cloudModel = value;
                        await this.plugin.saveSettings();
                    }));
        }

        this.createTestButton();
    }

    private setStatusMessage(message: string, status: 'success' | 'error'): void {
        if (!this.statusContainer || !this.statusEl) return;

        this.statusContainer.style.display = 'block';
        this.statusContainer.className = 'connection-test-status ' + status;
        this.statusEl.textContent = message;
    }

    private async checkLocalService(endpoint: string): Promise<void> {
        const baseUrl = endpoint.trim().replace(/\/$/, '').replace(/\/v1\/chat\/completions$/, '');
        let checkUrl = `${baseUrl}/v1/models`;  // Default check URL for most services

        try {
            const response = await fetch(checkUrl, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' }
            });

            if (!response.ok) {
                new Notice(this.plugin.t.messages.localServiceNotRunning, 10000);
            }
        } catch (error) {
            new Notice(this.plugin.t.messages.localServiceNotAvailable, 10000);
        }
    }
}
