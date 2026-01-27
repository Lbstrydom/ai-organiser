import { Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { BaseSettingSection } from './BaseSettingSection';
import { EMBEDDING_DEFAULT_MODEL, getEmbeddingModelOptions, EmbeddingProvider } from '../../services/embeddings/embeddingRegistry';
import { PLUGIN_SECRET_IDS } from '../../core/secretIds';

export class SemanticSearchSettingsSection extends BaseSettingSection {
    private sectionEl: HTMLElement | null = null;

    display(): void {
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
            if (hasSecretStorage) {
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
            } else {
                const inferredKey = this.getDefaultEmbeddingApiKey(plugin.settings.embeddingProvider, plugin);
                const hasInferredKey = inferredKey && !plugin.settings.embeddingApiKey;

                // Build description - note if using main API key
                let keyDesc = t.settings.semanticSearch.embeddingApiKey.description;
                if (hasInferredKey && plugin.settings.embeddingProvider === plugin.settings.cloudServiceType) {
                    keyDesc += ' (Using main LLM API key)';
                }

                const settingEl = new Setting(sectionEl)
                    .setName(t.settings.semanticSearch.embeddingApiKey.name)
                    .setDesc(keyDesc);

                // If we can infer from main API key and same provider, show indicator
                if (hasInferredKey) {
                    settingEl.addButton(btn => btn
                        .setButtonText('Use main API key')
                        .setTooltip('Copy from main LLM settings')
                        .onClick(async () => {
                            plugin.settings.embeddingApiKey = inferredKey;
                            await plugin.saveSettings();
                            this.display(); // Refresh
                        }));
                }

                settingEl.addText(text => {
                    const displayKey = plugin.settings.embeddingApiKey || '';
                    const maskedKey = displayKey && displayKey.length > 6
                        ? displayKey.substring(0, 6) + '*'.repeat(Math.min(20, displayKey.length - 6))
                        : displayKey;

                    text.setPlaceholder(hasInferredKey ? '(using main API key)' : 'sk-...')
                        .setValue(maskedKey)
                        .onChange(async (value) => {
                            // Only update if user actually typed something (not just the masked version)
                            if (value !== maskedKey) {
                                plugin.settings.embeddingApiKey = value;
                                await plugin.saveSettings();
                            }
                        });
                    text.inputEl.type = 'password';
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
}
