import { Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { BaseSettingSection } from './BaseSettingSection';
import { EMBEDDING_DEFAULT_MODEL, getEmbeddingModelOptions, EmbeddingProvider } from '../../services/embeddings/embeddingRegistry';
import { PLUGIN_SECRET_IDS, EMBEDDING_PROVIDER_TO_SECRET_ID, PROVIDER_TO_SECRET_ID } from '../../core/secretIds';

export class SemanticSearchSettingsSection extends BaseSettingSection {
    private sectionEl: HTMLElement | null = null;

    async display(): Promise<void> {
        const { containerEl, plugin } = this;
        const t = plugin.t;
        const hasSecretStorage = plugin.secretStorageService.isAvailable();
        if (!this.sectionEl) {
            this.sectionEl = containerEl.createDiv({ cls: 'semantic-search-settings-section' });
        }

        const sectionEl = this.sectionEl;
        sectionEl.empty();

        // Section header (main h1 section)
        this.createSectionHeader(t.settings.semanticSearch.title, 'brain', 1, sectionEl);
        sectionEl.createEl('p', { 
            text: t.settings.semanticSearch.description,
            cls: 'setting-item-description'
        });

        // Master toggle for Semantic Search
        new Setting(sectionEl)
            .setName(t.settings.semanticSearch.enableSemanticSearch.name)
            .setDesc(t.settings.semanticSearch.enableSemanticSearch.description)
            .addToggle(toggle => toggle
                .setValue(plugin.settings.enableSemanticSearch)
                .onChange(async (value) => {
                    plugin.settings.enableSemanticSearch = value;
                    await plugin.saveSettings();
                    
                    // Cleanup vector store if disabled
                    if (!value && plugin.vectorStoreService) {
                        await plugin.vectorStoreService.dispose();
                        plugin.vectorStoreService = null;
                        plugin.vectorStore = null;
                    }
                    
                    // Refresh settings display to show/hide dependent settings
                    this.display();
                }));

        // Only show additional settings if semantic search is enabled
        if (!plugin.settings.enableSemanticSearch) {
            sectionEl.createEl('p', {
                text: t.settings.semanticSearch.enableToConfigureMessage,
                cls: 'setting-item-description mod-warning'
            });
            return;
        }

        // Embedding Provider
        // Note: Claude does not offer embedding APIs - use Voyage AI (Anthropic's recommended partner)
        new Setting(sectionEl)
            .setName(t.settings.semanticSearch.embeddingProvider.name)
            .setDesc(t.settings.semanticSearch.embeddingProvider.description)
            .addDropdown(dropdown => dropdown
                .addOption('openai', 'OpenAI')
                .addOption('gemini', 'Google Gemini')
                .addOption('ollama', 'Ollama (Local)')
                .addOption('openrouter', 'OpenRouter')
                .addOption('cohere', 'Cohere')
                .addOption('voyage', 'Voyage AI')
                .setValue(plugin.settings.embeddingProvider)
                .onChange(async (value: any) => {
                    const previousDefault = this.getDefaultEmbeddingModel(plugin.settings.embeddingProvider);
                    plugin.settings.embeddingProvider = value;

                    // Auto-set embedding model if empty or was the previous default
                    const newDefault = this.getDefaultEmbeddingModel(value);
                    if (!plugin.settings.embeddingModel || plugin.settings.embeddingModel === previousDefault) {
                        plugin.settings.embeddingModel = newDefault;
                    }

                    // Auto-fill embedding API key if blank, using provider-specific or cloud key
                    if (!hasSecretStorage && !plugin.settings.embeddingApiKey) {
                        const fallbackKey = this.getDefaultEmbeddingApiKey(value, plugin);
                        if (fallbackKey) {
                            plugin.settings.embeddingApiKey = fallbackKey;
                        }
                    }

                    await plugin.saveSettings();
                    this.display(); // Refresh to show provider-specific settings
                }));

        // Embedding Model - dropdown with provider-specific options
        const currentModel = plugin.settings.embeddingModel || this.getDefaultEmbeddingModel(plugin.settings.embeddingProvider);
        const modelOptions = this.getEmbeddingModelsForProvider(plugin.settings.embeddingProvider);

        new Setting(sectionEl)
            .setName(t.settings.semanticSearch.embeddingModel.name)
            .setDesc(t.settings.semanticSearch.embeddingModel.description)
            .addDropdown(dropdown => {
                // Add all available models for this provider
                for (const model of modelOptions) {
                    dropdown.addOption(model.value, model.label);
                }

                // If current model isn't in options, add it as custom
                if (!modelOptions.some((m: { value: string; label: string }) => m.value === currentModel)) {
                    dropdown.addOption(currentModel, currentModel + ' (custom)');
                }

                return dropdown
                    .setValue(currentModel)
                    .onChange(async (value) => {
                        plugin.settings.embeddingModel = value;
                        await plugin.saveSettings();
                    });
            });

        // Embedding API Key (if not using Ollama)
        if (plugin.settings.embeddingProvider !== 'ollama') {
            const hasInheritedKey = await this.checkEmbeddingKeyAvailable(plugin);

            if (hasInheritedKey) {
                // Key available via inheritance chain — show green status like Audio does
                const providerName = plugin.settings.embeddingProvider.charAt(0).toUpperCase()
                    + plugin.settings.embeddingProvider.slice(1);
                const statusEl = sectionEl.createDiv({ cls: 'ai-organiser-settings-status' });
                statusEl.createEl('span', {
                    text: `Using your ${providerName} API key`,
                    cls: 'ai-organiser-status-success'
                });
            } else {
                // No key found anywhere in the chain — show input field
                this.renderApiKeyField({
                    name: t.settings.semanticSearch.embeddingApiKey.name,
                    desc: t.settings.semanticSearch.embeddingApiKey.description,
                    secretId: PLUGIN_SECRET_IDS.EMBEDDING,
                    currentValue: plugin.settings.embeddingApiKey,
                    placeholder: 'sk-...',
                    onChange: async (value) => {
                        plugin.settings.embeddingApiKey = value;
                        await plugin.saveSettings();
                    }
                });
            }
        }

        // Embedding Endpoint (for Ollama or custom endpoints)
        if (plugin.settings.embeddingProvider === 'ollama') {
            new Setting(sectionEl)
                .setName(t.settings.semanticSearch.embeddingEndpoint.name)
                .setDesc(t.settings.semanticSearch.embeddingEndpoint.description)
                .addText(text => text
                    .setPlaceholder('http://localhost:11434')
                    .setValue(plugin.settings.embeddingEndpoint)
                    .onChange(async (value) => {
                        plugin.settings.embeddingEndpoint = value;
                        await plugin.saveSettings();
                    }));

            // Local Setup Wizard button
            new Setting(sectionEl)
                .setName(t.settings.semanticSearch.localSetup)
                .setDesc(t.settings.semanticSearch.localSetupDesc)
                .addButton(button => button
                    .setButtonText(t.settings.semanticSearch.openLocalSetup)
                    .setCta()
                    .onClick(async () => {
                        const { LocalSetupWizardModal } = await import('../modals/LocalSetupWizardModal');
                        new LocalSetupWizardModal(plugin.app, plugin).open();
                    }));
        }

        // === Indexing Settings ===
        sectionEl.createEl('h3', { text: t.settings.semanticSearch.indexing.title });

        // Auto-index new notes
        new Setting(sectionEl)
            .setName(t.settings.semanticSearch.autoIndexNewNotes.name)
            .setDesc(t.settings.semanticSearch.autoIndexNewNotes.description)
            .addToggle(toggle => toggle
                .setValue(plugin.settings.autoIndexNewNotes)
                .onChange(async (value) => {
                    plugin.settings.autoIndexNewNotes = value;
                    await plugin.saveSettings();
                }));

        // Use shared excluded folders toggle
        new Setting(sectionEl)
            .setName(t.settings.semanticSearch.useSharedExcludedFolders.name)
            .setDesc(t.settings.semanticSearch.useSharedExcludedFolders.description)
            .addToggle(toggle => toggle
                .setValue(plugin.settings.useSharedExcludedFolders)
                .onChange(async (value) => {
                    plugin.settings.useSharedExcludedFolders = value;
                    await plugin.saveSettings();
                    this.display(); // Refresh to show/hide custom folders
                }));

        // Show either shared folders info or custom folders textarea
        if (plugin.settings.useSharedExcludedFolders) {
            // Show read-only info about which folders are being used from tagging
            const sharedFolders = plugin.settings.excludedFolders;
            const infoEl = sectionEl.createDiv({ cls: 'setting-item' });
            const infoContent = infoEl.createDiv({ cls: 'setting-item-info' });
            infoContent.createDiv({
                cls: 'setting-item-name',
                text: t.settings.semanticSearch.usingTaggingExclusions
            });

            if (sharedFolders.length > 0) {
                const folderList = infoContent.createDiv({ cls: 'setting-item-description' });
                folderList.style.fontFamily = 'monospace';
                folderList.style.fontSize = '0.85em';
                folderList.style.opacity = '0.8';
                folderList.setText(sharedFolders.join(', ') || 'None');
            } else {
                infoContent.createDiv({
                    cls: 'setting-item-description',
                    text: 'No folders excluded'
                });
            }
        } else {
            // Show custom excluded folders textarea
            new Setting(sectionEl)
                .setName(t.settings.semanticSearch.indexExcludedFolders.name)
                .setDesc(t.settings.semanticSearch.indexExcludedFolders.description)
                .addTextArea(text => text
                    .setPlaceholder('folder1\nfolder2\nfolder3')
                    .setValue(plugin.settings.indexExcludedFolders.join('\n'))
                    .onChange(async (value) => {
                        plugin.settings.indexExcludedFolders = value
                            .split('\n')
                            .map(f => f.trim())
                            .filter(f => f.length > 0);
                        await plugin.saveSettings();
                    }));
        }

        // Chunk size
        new Setting(sectionEl)
            .setName(t.settings.semanticSearch.chunkSize.name)
            .setDesc(t.settings.semanticSearch.chunkSize.description)
            .addText(text => text
                .setPlaceholder('2000')
                .setValue(plugin.settings.chunkSize.toString())
                .onChange(async (value) => {
                    const numValue = parseInt(value);
                    if (!isNaN(numValue) && numValue > 0) {
                        plugin.settings.chunkSize = numValue;
                        await plugin.saveSettings();
                    }
                }));

        // Chunk overlap
        new Setting(sectionEl)
            .setName(t.settings.semanticSearch.chunkOverlap.name)
            .setDesc(t.settings.semanticSearch.chunkOverlap.description)
            .addText(text => text
                .setPlaceholder('200')
                .setValue(plugin.settings.chunkOverlap.toString())
                .onChange(async (value) => {
                    const numValue = parseInt(value);
                    if (!isNaN(numValue) && numValue >= 0) {
                        plugin.settings.chunkOverlap = numValue;
                        await plugin.saveSettings();
                    }
                }));

        // Max chunks per note
        new Setting(sectionEl)
            .setName(t.settings.semanticSearch.maxChunksPerNote.name)
            .setDesc(t.settings.semanticSearch.maxChunksPerNote.description)
            .addText(text => text
                .setPlaceholder('10')
                .setValue(plugin.settings.maxChunksPerNote.toString())
                .onChange(async (value) => {
                    const numValue = parseInt(value);
                    if (!isNaN(numValue) && numValue > 0) {
                        plugin.settings.maxChunksPerNote = numValue;
                        await plugin.saveSettings();
                    }
                }));

        // Manage Index action
        new Setting(sectionEl)
            .setName(t.settings.semanticSearch.manageIndexAction)
            .setDesc(t.settings.semanticSearch.manageIndexActionDesc)
            .addButton(button => {
                button
                    .setButtonText(t.settings.semanticSearch.manageIndexButton)
                    .setIcon('database')
                    .onClick(() => {
                        (plugin.app as any).commands.executeCommandById('ai-organiser:manage-index');
                    });
            });

        // === RAG Settings ===
        sectionEl.createEl('h3', { text: t.settings.semanticSearch.rag.title });

        // Enable Vault Chat
        new Setting(sectionEl)
            .setName(t.settings.semanticSearch.enableVaultChat.name)
            .setDesc(t.settings.semanticSearch.enableVaultChat.description)
            .addToggle(toggle => toggle
                .setValue(plugin.settings.enableVaultChat)
                .onChange(async (value) => {
                    plugin.settings.enableVaultChat = value;
                    await plugin.saveSettings();
                    // Refresh to show/hide RAG options
                    this.display();
                }));

        // Only show RAG options if Vault Chat is enabled
        if (!plugin.settings.enableVaultChat) {
            sectionEl.createEl('p', {
                text: t.settings.semanticSearch.enableVaultChatForRag,
                cls: 'setting-item-description mod-warning'
            });
            return;
        }

        // RAG context chunks
        new Setting(sectionEl)
            .setName(t.settings.semanticSearch.ragContextChunks.name)
            .setDesc(t.settings.semanticSearch.ragContextChunks.description)
            .addText(text => text
                .setPlaceholder('5')
                .setValue(plugin.settings.ragContextChunks.toString())
                .onChange(async (value) => {
                    const numValue = parseInt(value);
                    if (!isNaN(numValue) && numValue > 0) {
                        plugin.settings.ragContextChunks = numValue;
                        await plugin.saveSettings();
                    }
                }));

        // Include metadata in RAG context
        new Setting(sectionEl)
            .setName(t.settings.semanticSearch.ragIncludeMetadata.name)
            .setDesc(t.settings.semanticSearch.ragIncludeMetadata.description)
            .addToggle(toggle => toggle
                .setValue(plugin.settings.ragIncludeMetadata)
                .onChange(async (value) => {
                    plugin.settings.ragIncludeMetadata = value;
                    await plugin.saveSettings();
                }));

        new Setting(sectionEl)
            .setName(t.settings.semanticSearch.relatedNotesCount.name)
            .setDesc(t.settings.semanticSearch.relatedNotesCount.description)
            .addText(text => text
                .setPlaceholder('15')
                .setValue(plugin.settings.relatedNotesCount.toString())
                .onChange(async (value) => {
                    const numValue = parseInt(value);
                    if (!isNaN(numValue) && numValue >= 1 && numValue <= 50) {
                        plugin.settings.relatedNotesCount = numValue;
                        await plugin.saveSettings();
                    }
                }));
    }

    private getDefaultEmbeddingModel(provider: string): string {
        return EMBEDDING_DEFAULT_MODEL[provider as EmbeddingProvider] || EMBEDDING_DEFAULT_MODEL.openai;
    }

    private getEmbeddingModelsForProvider(provider: string): Array<{ value: string; label: string }> {
        return getEmbeddingModelOptions(provider as EmbeddingProvider);
    }

    private getDefaultEmbeddingApiKey(provider: string, plugin: AIOrganiserPlugin): string {
        // Prefer existing embedding key, then provider-specific key, then general cloud key
        const providerKey = plugin.settings.providerSettings?.[provider as keyof typeof plugin.settings.providerSettings]?.apiKey;
        return plugin.settings.embeddingApiKey
            || providerKey
            || plugin.settings.cloudApiKey
            || '';
    }

    /**
     * Check if any key in the embedding API key inheritance chain is available.
     * Mirrors the runtime resolution in main.ts resolveEmbeddingApiKey().
     * Chain: dedicated embedding secret → provider secret → main cloud secret → plaintext settings
     */
    private async checkEmbeddingKeyAvailable(plugin: AIOrganiserPlugin): Promise<boolean> {
        const secretStorage = plugin.secretStorageService;
        const provider = plugin.settings.embeddingProvider;

        if (secretStorage.isAvailable()) {
            // 1. Dedicated embedding secret
            if (await secretStorage.hasSecret(PLUGIN_SECRET_IDS.EMBEDDING)) return true;

            // 2. Provider-specific secret (e.g., OpenAI key used for embeddings)
            const providerSecretId = EMBEDDING_PROVIDER_TO_SECRET_ID[provider as keyof typeof EMBEDDING_PROVIDER_TO_SECRET_ID];
            if (providerSecretId && await secretStorage.hasSecret(providerSecretId)) return true;

            // 3. Main cloud provider secret
            const mainProvider = plugin.settings.cloudServiceType;
            const mainSecretId = PROVIDER_TO_SECRET_ID[mainProvider as keyof typeof PROVIDER_TO_SECRET_ID];
            if (mainSecretId && await secretStorage.hasSecret(mainSecretId)) return true;
        }

        // 4. Plaintext fallback chain
        if (plugin.settings.embeddingApiKey) return true;
        const providerKey = plugin.settings.providerSettings?.[provider as keyof typeof plugin.settings.providerSettings]?.apiKey;
        if (providerKey) return true;
        if (plugin.settings.cloudApiKey) return true;

        return false;
    }
}
