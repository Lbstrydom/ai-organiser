/**
 * Local Setup Wizard Modal
 * Guides users through setting up local AI (Ollama, Whisper) for offline use
 */

import { App, Modal, Setting, Notice, requestUrl } from 'obsidian';
import AIOrganiserPlugin from '../../main';

/**
 * Model recommendation with hardware requirements
 */
interface ModelRecommendation {
    name: string;
    ollamaId: string;
    sizeGB: number;
    minRamGB: number;
    type: 'chat' | 'embedding' | 'multimodal';
    quality: 'basic' | 'good' | 'excellent';
    description: string;
    speed: 'fast' | 'medium' | 'slow';
}

/**
 * Latest and most popular local LLM models (March 2026)
 */
const LOCAL_MODEL_RECOMMENDATIONS: ModelRecommendation[] = [
    // Chat models - sorted by quality/popularity
    {
        name: 'Qwen 3.5 9B ⭐',
        ollamaId: 'qwen3.5:9b',
        sizeGB: 6.6,
        minRamGB: 10,
        type: 'chat',
        quality: 'excellent',
        speed: 'medium',
        description: 'Top-tier 9B model. Multimodal, 201 languages, tool use. Best bang-for-buck local model.'
    },
    {
        name: 'Qwen 3.5 27B',
        ollamaId: 'qwen3.5:27b',
        sizeGB: 16,
        minRamGB: 20,
        type: 'chat',
        quality: 'excellent',
        speed: 'medium',
        description: 'Near frontier-model performance. Excellent reasoning and coding.'
    },
    {
        name: 'Llama 4 Scout 17B',
        ollamaId: 'llama4-scout:17b',
        sizeGB: 10,
        minRamGB: 16,
        type: 'chat',
        quality: 'excellent',
        speed: 'medium',
        description: 'Meta\'s latest. Strong instruction following and tool use.'
    },
    {
        name: 'DeepSeek R1 14B',
        ollamaId: 'deepseek-r1:14b',
        sizeGB: 9,
        minRamGB: 16,
        type: 'chat',
        quality: 'excellent',
        speed: 'medium',
        description: 'State-of-the-art reasoning model. Excellent for complex tasks.'
    },
    {
        name: 'Qwen 3.5 4B',
        ollamaId: 'qwen3.5:4b',
        sizeGB: 2.8,
        minRamGB: 6,
        type: 'chat',
        quality: 'good',
        speed: 'fast',
        description: 'Compact but powerful. Multimodal, tool use, thinking. Great for 8GB machines.'
    },
    {
        name: 'Gemma 2 9B',
        ollamaId: 'gemma2:9b',
        sizeGB: 5.5,
        minRamGB: 10,
        type: 'chat',
        quality: 'good',
        speed: 'medium',
        description: 'Google\'s model. Strong instruction following.'
    },
    {
        name: 'Phi-4 14B',
        ollamaId: 'phi4:14b',
        sizeGB: 8,
        minRamGB: 12,
        type: 'chat',
        quality: 'good',
        speed: 'medium',
        description: 'Microsoft\'s model. Excellent for reasoning and math.'
    },
    {
        name: 'Mistral 7B v0.3',
        ollamaId: 'mistral:7b',
        sizeGB: 4.1,
        minRamGB: 8,
        type: 'chat',
        quality: 'good',
        speed: 'fast',
        description: 'Fast and reliable. Proven track record.'
    },
    {
        name: 'Qwen 3.5 2B',
        ollamaId: 'qwen3.5:2b',
        sizeGB: 1.6,
        minRamGB: 4,
        type: 'chat',
        quality: 'basic',
        speed: 'fast',
        description: 'Tiny but capable. Good for low-RAM systems or quick tasks.'
    },
    {
        name: 'Llama 3.2 3B',
        ollamaId: 'llama3.2:3b',
        sizeGB: 2,
        minRamGB: 4,
        type: 'chat',
        quality: 'basic',
        speed: 'fast',
        description: 'Lightweight. Good for older machines.'
    },

    // Embedding models
    {
        name: 'Nomic Embed Text v1.5',
        ollamaId: 'nomic-embed-text',
        sizeGB: 0.3,
        minRamGB: 2,
        type: 'embedding',
        quality: 'excellent',
        speed: 'fast',
        description: 'Best local embedding model. 768 dimensions. Recommended.'
    },
    {
        name: 'MxBAI Embed Large',
        ollamaId: 'mxbai-embed-large',
        sizeGB: 0.7,
        minRamGB: 2,
        type: 'embedding',
        quality: 'excellent',
        speed: 'fast',
        description: 'High quality embeddings. 1024 dimensions.'
    },
    {
        name: 'All-MiniLM',
        ollamaId: 'all-minilm',
        sizeGB: 0.05,
        minRamGB: 1,
        type: 'embedding',
        quality: 'basic',
        speed: 'fast',
        description: 'Tiny and fast. 384 dimensions. Good for limited hardware.'
    },
    {
        name: 'BGE-M3',
        ollamaId: 'bge-m3',
        sizeGB: 0.6,
        minRamGB: 2,
        type: 'embedding',
        quality: 'excellent',
        speed: 'fast',
        description: 'Excellent multilingual embeddings. 1024 dimensions.'
    },

    // Multimodal models (vision)
    {
        name: 'Qwen 3 VL 8B',
        ollamaId: 'qwen3-vl:8b',
        sizeGB: 5,
        minRamGB: 10,
        type: 'multimodal',
        quality: 'excellent',
        speed: 'medium',
        description: 'Best local vision model. Image+video understanding, OCR.'
    },
    {
        name: 'Llava 1.6 13B',
        ollamaId: 'llava:13b',
        sizeGB: 8,
        minRamGB: 12,
        type: 'multimodal',
        quality: 'good',
        speed: 'medium',
        description: 'Vision model. Can analyze images and PDFs.'
    },
    {
        name: 'Llava 1.6 7B',
        ollamaId: 'llava:7b',
        sizeGB: 4.5,
        minRamGB: 8,
        type: 'multimodal',
        quality: 'basic',
        speed: 'fast',
        description: 'Smaller vision model for basic image understanding.'
    },
];

/**
 * Local AI setup status
 */
interface LocalAIStatus {
    ollama: {
        installed: boolean;
        running: boolean;
        models: string[];
        version?: string;
    };
    whisper: {
        available: boolean;
        method?: 'ollama' | 'whisper.cpp' | 'none';
    };
}

/**
 * Detect available RAM (approximation)
 */
function getApproximateRAM(): number {
    // navigator.deviceMemory gives a rough estimate in GB
    // Falls back to 8GB if not available
    const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    if (deviceMemory) {
        // deviceMemory is capped at 8 in some browsers, so multiply by 2 as estimate
        return Math.max(deviceMemory * 2, 8);
    }
    return 8; // Default assumption
}

/**
 * Local Setup Wizard Modal
 */
export class LocalSetupWizardModal extends Modal {
    private plugin: AIOrganiserPlugin;
    private status: LocalAIStatus = {
        ollama: { installed: false, running: false, models: [] },
        whisper: { available: false }
    };
    private estimatedRAM: number = 8;
    private currentStep: number = 1;
    private selectedChatModel: string = '';
    private selectedEmbeddingModel: string = '';

    constructor(app: App, plugin: AIOrganiserPlugin) {
        super(app);
        this.plugin = plugin;
        this.estimatedRAM = getApproximateRAM();
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('ai-organiser-local-setup-wizard');

        // Check status first
        await this.checkLocalAIStatus();

        this.renderWizard();
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }

    /**
     * Check local AI installation status
     */
    private async checkLocalAIStatus(): Promise<void> {
        // Check Ollama
        try {
            const response = await requestUrl({
                url: 'http://localhost:11434/api/tags',
                method: 'GET'
            });

            if (response.status === 200) {
                this.status.ollama.running = true;
                this.status.ollama.installed = true;
                this.status.ollama.models = response.json?.models?.map((m: { name: string }) => m.name) || [];
            }

            // Try to get version
            try {
                const versionResponse = await requestUrl({
                    url: 'http://localhost:11434/api/version',
                    method: 'GET'
                });
                if (versionResponse.status === 200) {
                    this.status.ollama.version = versionResponse.json?.version;
                }
            } catch {
                // Version endpoint may not exist in older versions
            }

            // Check for Whisper in Ollama (if it becomes available)
            const hasWhisper = this.status.ollama.models.some(m =>
                m.toLowerCase().includes('whisper')
            );
            if (hasWhisper) {
                this.status.whisper.available = true;
                this.status.whisper.method = 'ollama';
            }
        } catch {
            this.status.ollama.running = false;
        }
    }

    /**
     * Render the wizard UI
     */
    private renderWizard(): void {
        const { contentEl } = this;
        contentEl.empty();

        // Header
        contentEl.createEl('h2', { text: this.plugin.t.modals.localSetupWizard.title });

        // Progress indicator
        this.renderProgressIndicator(contentEl);

        // Step content
        switch (this.currentStep) {
            case 1:
                this.renderStep1(contentEl);
                break;
            case 2:
                this.renderStep2(contentEl);
                break;
            case 3:
                this.renderStep3(contentEl);
                break;
        }
    }

    /**
     * Render progress indicator
     */
    private renderProgressIndicator(container: HTMLElement): void {
        const progressEl = container.createDiv('ai-organiser-wizard-progress');

        for (let i = 1; i <= 3; i++) {
            const stepEl = progressEl.createDiv({
                cls: `progress-step ${i === this.currentStep ? 'active' : ''} ${i < this.currentStep ? 'completed' : ''}`
            });
            stepEl.createSpan({ text: String(i) });
        }
    }

    /**
     * Step 1: Install Ollama
     */
    private renderStep1(container: HTMLElement): void {
        const stepEl = container.createDiv('ai-organiser-wizard-step');

        stepEl.createEl('h3', { text: this.plugin.t.modals.localSetupWizard.step1Title });
        stepEl.createEl('p', { text: this.plugin.t.modals.localSetupWizard.step1Description });

        // Status indicator
        const statusEl = stepEl.createDiv('status-indicator');
        if (this.status.ollama.running) {
            statusEl.createEl('span', { cls: 'status-success', text: '✓' });
            const versionSuffix = this.status.ollama.version ? ' (v' + this.status.ollama.version + ')' : '';
            statusEl.appendText(' Ollama is running' + versionSuffix);
        } else {
            statusEl.createEl('span', { cls: 'status-warning', text: '⚠' });
            statusEl.appendText(' Ollama not detected');
        }

        // Installation instructions
        if (!this.status.ollama.running) {
            const instructionsEl = stepEl.createDiv('install-instructions');
            instructionsEl.createEl('h4', { text: 'Installation' });

            // Platform-specific instructions
            const platformEl = instructionsEl.createDiv('platform-instructions');

            // Windows
            const windowsEl = platformEl.createDiv('platform-item');
            windowsEl.createEl('strong', { text: 'Windows: ' });
            const winLink = windowsEl.createEl('a', {
                text: 'Download installer',
                href: 'https://ollama.com/download/windows'
            });
            winLink.setAttr('target', '_blank');

            // macOS
            const macEl = platformEl.createDiv('platform-item');
            macEl.createEl('strong', { text: 'macOS: ' });
            const macLink = macEl.createEl('a', {
                text: 'Download .dmg',
                href: 'https://ollama.com/download/mac'
            });
            macLink.setAttr('target', '_blank');
            macEl.createSpan({ text: ' or ' });
            const brewCmd = 'brew install ollama';
            macEl.createEl('code', { text: brewCmd });

            // Linux
            const linuxEl = platformEl.createDiv('platform-item');
            linuxEl.createEl('strong', { text: 'Linux: ' });
            linuxEl.createEl('code', { text: 'curl -fsSL https://ollama.com/install.sh | sh' });
        }

        // Verify button
        new Setting(stepEl)
            .setName(this.plugin.t.modals.localSetupWizard.verifySetup)
            .addButton(button => button
                .setButtonText('Verify connection')
                .onClick(async () => {
                    button.setButtonText(this.plugin.t.modals.localSetupWizard.verifying);
                    button.setDisabled(true);
                    await this.checkLocalAIStatus();
                    this.renderWizard();
                }));

        // Navigation
        this.renderNavigation(stepEl, false, this.status.ollama.running);
    }

    /**
     * Step 2: Download Models
     */
    private renderStep2(container: HTMLElement): void {
        const stepEl = container.createDiv('ai-organiser-wizard-step');

        stepEl.createEl('h3', { text: this.plugin.t.modals.localSetupWizard.step2Title });
        stepEl.createEl('p', { text: this.plugin.t.modals.localSetupWizard.step2Description });

        // RAM info
        const ramEl = stepEl.createDiv('ram-info');
        ramEl.createEl('strong', { text: `${this.plugin.t.modals.localSetupWizard.ramWarning} ` });
        ramEl.createSpan({ text: `~${this.estimatedRAM}GB RAM detected` });
        ramEl.createEl('p', {
            cls: 'setting-item-description',
            text: this.plugin.t.modals.localSetupWizard.ramRecommendation
        });

        // Chat model selection
        this.renderModelSection(stepEl, 'Chat Models', 'chat');

        // Embedding model selection
        this.renderModelSection(stepEl, 'Embedding Models (for Semantic Search)', 'embedding');

        // Installed models
        if (this.status.ollama.models.length > 0) {
            const installedEl = stepEl.createDiv('installed-models');
            installedEl.createEl('h4', { text: 'Installed models' });
            const modelsList = installedEl.createEl('ul');
            for (const model of this.status.ollama.models) {
                modelsList.createEl('li', { text: model });
            }
        }

        // Navigation
        this.renderNavigation(stepEl, true, true);
    }

    /**
     * Render model selection section
     */
    private renderModelSection(container: HTMLElement, title: string, type: 'chat' | 'embedding' | 'multimodal'): void {
        const sectionEl = container.createDiv('ai-organiser-model-section');
        sectionEl.createEl('h4', { text: title });

        const models = LOCAL_MODEL_RECOMMENDATIONS.filter(m => m.type === type);
        const compatibleModels = models.filter(m => m.minRamGB <= this.estimatedRAM);
        const recommendedModel = compatibleModels.find(m => m.quality === 'excellent') ||
                                  compatibleModels.find(m => m.quality === 'good') ||
                                  compatibleModels[0];

        for (const model of models) {
            const isCompatible = model.minRamGB <= this.estimatedRAM;
            const isRecommended = model === recommendedModel;
            const isInstalled = this.status.ollama.models.some(m =>
                m.startsWith(model.ollamaId.split(':')[0])
            );

            const modelEl = sectionEl.createDiv({
                cls: `ai-organiser-model-item ${!isCompatible ? 'incompatible' : ''} ${isRecommended ? 'recommended' : ''} ${isInstalled ? 'installed' : ''}`
            });

            const headerEl = modelEl.createDiv('ai-organiser-model-header');
            headerEl.createEl('strong', { text: model.name });

            const badges = headerEl.createDiv('ai-organiser-model-badges');
            if (isRecommended) badges.createSpan({ cls: 'badge recommended', text: 'Recommended' });
            if (isInstalled) badges.createSpan({ cls: 'badge installed', text: 'Installed' });
            badges.createSpan({ cls: `badge quality-${model.quality}`, text: model.quality });
            badges.createSpan({ cls: `badge speed-${model.speed}`, text: model.speed });

            modelEl.createEl('p', { cls: 'ai-organiser-model-description', text: model.description });

            const infoEl = modelEl.createDiv('ai-organiser-model-info');
            infoEl.createSpan({ text: `Size: ${model.sizeGB}GB` });
            infoEl.createSpan({ text: `RAM: ${model.minRamGB}GB+` });

            // Install/Select button
            const actionsEl = modelEl.createDiv('ai-organiser-model-actions');

            if (!isInstalled && isCompatible) {
                const installBtn = actionsEl.createEl('button', { text: 'Install' });
                installBtn.onclick = () => this.installModel(model.ollamaId, installBtn);
            }

            if (isCompatible) {
                const selectBtn = actionsEl.createEl('button', {
                    cls: 'mod-cta',
                    text: type === 'chat' && this.selectedChatModel === model.ollamaId ? 'Selected ✓' :
                          type === 'embedding' && this.selectedEmbeddingModel === model.ollamaId ? 'Selected ✓' : 'Select'
                });
                selectBtn.onclick = () => {
                    if (type === 'chat') {
                        this.selectedChatModel = model.ollamaId;
                    } else if (type === 'embedding') {
                        this.selectedEmbeddingModel = model.ollamaId;
                    }
                    this.renderWizard();
                };
            }

            if (!isCompatible) {
                actionsEl.createSpan({ cls: 'warning-text', text: 'Requires more RAM' });
            }
        }
    }

    /**
     * Install a model via Ollama
     */
    private async installModel(modelId: string, button: HTMLButtonElement): Promise<void> {
        button.setAttr('disabled', 'true');
        button.textContent = 'Installing...';

        // Copy command to clipboard
        const command = `ollama pull ${modelId}`;
        await navigator.clipboard.writeText(command);

        new Notice(this.plugin.t.modals.localSetupWizard.commandCopied.replace('{command}', command), 10000);

        // We can't actually run the command from the browser, but we can show instructions
        button.textContent = 'Command copied';
        setTimeout(() => {
            button.textContent = 'Install';
            button.removeAttribute('disabled');
        }, 3000);
    }

    /**
     * Step 3: Test & Apply Settings
     */
    private renderStep3(container: HTMLElement): void {
        const stepEl = container.createDiv('ai-organiser-wizard-step');

        stepEl.createEl('h3', { text: this.plugin.t.modals.localSetupWizard.step3Title });
        stepEl.createEl('p', { text: this.plugin.t.modals.localSetupWizard.step3Description });

        // Summary of selections
        const summaryEl = stepEl.createDiv('selection-summary');
        summaryEl.createEl('h4', { text: 'Your configuration' });

        if (this.selectedChatModel) {
            summaryEl.createEl('p', { text: `Chat model: ${this.selectedChatModel}` });
        }
        if (this.selectedEmbeddingModel) {
            summaryEl.createEl('p', { text: `Embedding model: ${this.selectedEmbeddingModel}` });
        }

        // Whisper section
        const whisperEl = stepEl.createDiv('whisper-section');
        whisperEl.createEl('h4', { text: 'Audio transcription (Whisper)' });

        if (this.status.whisper.available) {
            whisperEl.createEl('p', {
                cls: 'status-success',
                text: '✓ Whisper available via Ollama'
            });
        } else {
            whisperEl.createEl('p', { text: 'Local Whisper transcription requires Whisper.cpp. For now, use cloud transcription (OpenAI or Groq).' });

            const whisperLink = whisperEl.createEl('a', {
                text: 'Learn more about Whisper.cpp',
                href: 'https://github.com/ggerganov/whisper.cpp'
            });
            whisperLink.setAttr('target', '_blank');
        }

        // Test connection button
        new Setting(stepEl)
            .setName('Test connection')
            .addButton(button => button
                .setButtonText(this.plugin.t.modals.localSetupWizard.verifySetup)
                .onClick(async () => {
                    button.setButtonText(this.plugin.t.modals.localSetupWizard.verifying);
                    button.setDisabled(true);

                    const success = await this.testConnection();

                    if (success) {
                        new Notice(this.plugin.t.modals.localSetupWizard.setupComplete);
                    } else {
                        new Notice(this.plugin.t.modals.localSetupWizard.setupFailed);
                    }

                    button.setButtonText(this.plugin.t.modals.localSetupWizard.verifySetup);
                    button.setDisabled(false);
                }));

        // Apply settings button
        new Setting(stepEl)
            .setName(this.plugin.t.modals.localSetupWizard.applySettings)
            .setDesc('Update plugin settings to use local AI')
            .addButton(button => button
                .setButtonText('Apply and close')
                .setCta()
                .onClick(async () => {
                    await this.applySettings();
                    this.close();
                }));

        // Navigation
        this.renderNavigation(stepEl, true, false);
    }

    /**
     * Test connection to Ollama
     */
    private async testConnection(): Promise<boolean> {
        try {
            const response = await requestUrl({
                url: 'http://localhost:11434/api/tags',
                method: 'GET'
            });
            return response.status === 200;
        } catch {
            return false;
        }
    }

    /**
     * Apply selected settings to plugin
     */
    private async applySettings(): Promise<void> {
        // Update LLM settings for local
        this.plugin.settings.serviceType = 'local';
        this.plugin.settings.localEndpoint = 'http://localhost:11434/v1/chat/completions';

        if (this.selectedChatModel) {
            this.plugin.settings.localModel = this.selectedChatModel;
        }

        // Update embedding settings
        if (this.selectedEmbeddingModel) {
            this.plugin.settings.embeddingProvider = 'ollama';
            this.plugin.settings.embeddingModel = this.selectedEmbeddingModel;
            this.plugin.settings.embeddingEndpoint = 'http://localhost:11434';
        }

        await this.plugin.saveSettings();
        new Notice(this.plugin.t.modals.localSetupWizard.settingsApplied);
    }

    /**
     * Render navigation buttons
     */
    private renderNavigation(container: HTMLElement, showBack: boolean, showNext: boolean): void {
        const navEl = container.createDiv('ai-organiser-wizard-navigation');

        if (showBack) {
            const backBtn = navEl.createEl('button', { text: 'Back' });
            backBtn.onclick = () => {
                this.currentStep--;
                this.renderWizard();
            };
        }

        if (showNext) {
            const nextBtn = navEl.createEl('button', { cls: 'mod-cta', text: 'Next →' });
            nextBtn.onclick = () => {
                this.currentStep++;
                this.renderWizard();
            };
        }

        // Close button
        const closeBtn = navEl.createEl('button', { text: this.plugin.t.modals.localSetupWizard.closeButton });
        closeBtn.onclick = () => this.close();
    }
}
