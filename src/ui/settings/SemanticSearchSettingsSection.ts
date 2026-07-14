import { Notice, Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { BaseSettingSection } from './BaseSettingSection';
import { EMBEDDING_DEFAULT_MODEL, getEmbeddingModelOptions, EmbeddingProvider } from '../../services/embeddings/embeddingRegistry';
import { PLUGIN_SECRET_IDS, EMBEDDING_PROVIDER_TO_SECRET_ID, PROVIDER_TO_SECRET_ID } from '../../core/secretIds';
import { classifyEmbeddingAvailability } from '../../services/embeddings/embeddingServiceFactory';
import { isAzureMode } from '../../services/azure/endpointResolver';
import { LocalOnnxConsentModal } from '../modals/LocalOnnxConsentModal';
import { logger } from '../../utils/logger';

export class SemanticSearchSettingsSection extends BaseSettingSection {
    private sectionEl: HTMLElement | null = null;

    async display(): Promise<void> {
        const { containerEl, plugin } = this;
        const t = plugin.t;
        const hasSecretStorage = plugin.secretStorageService.isAvailable();
        if (!this.sectionEl) {
            this.sectionEl = containerEl.createDiv({ cls: 'ai-organiser-semantic-search-settings-section' });
        }

        const sectionEl = this.sectionEl;
        sectionEl.empty();

        // Section header (main h1 section)
        this.createSectionHeader(t.settings.semanticSearch.title, 'brain', 1, sectionEl);
        sectionEl.createEl('p', {
            text: t.settings.semanticSearch.description,
            cls: 'setting-item-description'
        });
        // The feature flag (Settings → Features) is the master switch (FT-11). This section
        // only renders when semantic-search is enabled, so it shows configuration only —
        // the redundant inner enable toggle was removed.
        sectionEl.createEl('p', {
            text: t.features.managedInFeatures,
            cls: 'setting-item-description'
        });

        // Embedding Provider
        // Note: Claude does not offer embedding APIs - use Voyage AI (Anthropic's recommended partner)
        new Setting(sectionEl)
            .setName(t.settings.semanticSearch.embeddingProvider.name)
            .setDesc(t.settings.semanticSearch.embeddingProvider.description)
            .addDropdown(dropdown => dropdown
                .addOption('local-onnx', t.settings.semanticSearch.localOnnxLabel)
                .addOption('openai', ['OpenAI'].join(''))
                .addOption('gemini', ['Gemini (google)'].join(''))
                .addOption('ollama', ['Ollama (local)'].join(''))
                .addOption('openrouter', ['OpenRouter'].join(''))
                .addOption('cohere', ['Cohere'].join(''))
                .addOption('voyage', ['Voyage AI'].join(''))
                .setValue(plugin.settings.embeddingProvider)
                .onChange((value: string) => {
                    // npm-audit-remediation Cluster 4: selecting local-onnx
                    // without consent already granted routes through the
                    // consent modal instead of applying immediately.
                    if (value === 'local-onnx' && !plugin.settings.enableLocalOnnxEmbeddings) {
                        void this.display(); // revert the dropdown's visible value first
                        this.openLocalOnnxConsentModal(plugin, (accepted) => {
                            if (!accepted) return;
                            void this.applyLocalOnnxConsentChange(plugin, () => {
                                // audit-caught: the consent flag itself was missing here —
                                // accepting the modal changed the provider but never actually
                                // granted consent, so the very next embedding-service
                                // resolution would immediately deny it as not-consented.
                                // embeddingModel is also set explicitly (not just left to the
                                // generic auto-select logic below, which this early-return
                                // bypasses) — otherwise a switch FROM a cloud provider would
                                // leave a non-ONNX model id persisted against provider
                                // 'local-onnx', since resolveLocalOnnxEmbeddingService() is
                                // called with settings.embeddingModel as the model id.
                                plugin.settings.enableLocalOnnxEmbeddings = true;
                                plugin.settings.embeddingProvider = 'local-onnx' as typeof plugin.settings.embeddingProvider;
                                plugin.settings.embeddingModel = 'Xenova/all-MiniLM-L6-v2';
                            });
                        });
                        return;
                    }

                    const previousDefault = this.getDefaultEmbeddingModel(plugin.settings.embeddingProvider);
                    plugin.settings.embeddingProvider = value as typeof plugin.settings.embeddingProvider;

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

                    void plugin.saveSettings();
                    void this.display(); // Refresh to show provider-specific settings
                }));

        // npm-audit-remediation Cluster 4: an independent, symmetric on/off
        // control for local-embedding consent — separate from the provider
        // dropdown so revocation doesn't require switching providers.
        new Setting(sectionEl)
            .setName(t.settings.semanticSearch.localOnnxConsentToggleName)
            .setDesc(t.settings.semanticSearch.localOnnxConsentToggleDesc)
            .addToggle(toggle => toggle
                .setValue(plugin.settings.enableLocalOnnxEmbeddings)
                .onChange((value) => {
                    if (value) {
                        void this.display(); // revert the toggle's visible value first
                        this.openLocalOnnxConsentModal(plugin, (accepted) => {
                            if (!accepted) return;
                            void this.applyLocalOnnxConsentChange(plugin, () => {
                                plugin.settings.enableLocalOnnxEmbeddings = true;
                            });
                        });
                        return;
                    }
                    // Turning off never needs a modal — declining/revoking
                    // needs no confirmation.
                    void this.applyLocalOnnxConsentChange(plugin, () => {
                        plugin.settings.enableLocalOnnxEmbeddings = false;
                    });
                }));

        // Persistent, discoverable denied-state banner — covers BOTH the
        // never-consented-auto-fallback case and the explicitly-selected-
        // but-revoked case (same classifier the factory uses, so this can
        // never drift from the actual resolution logic).
        const hasApiKeyForBanner = plugin.settings.embeddingProvider !== 'ollama'
            && plugin.settings.embeddingProvider !== 'local-onnx'
            && (!!plugin.settings.embeddingApiKey || await this.checkEmbeddingKeyAvailable(plugin));
        const availability = classifyEmbeddingAvailability(
            plugin.settings.embeddingProvider,
            hasApiKeyForBanner,
            plugin.settings.enableLocalOnnxEmbeddings,
            isAzureMode(plugin.settings),
        );
        if (availability === 'local-onnx-not-consented') {
            const bannerEl = sectionEl.createDiv({ cls: 'ai-organiser-settings-banner' });
            bannerEl.createEl('p', {
                text: t.settings.semanticSearch.localOnnxNotConsentedBanner,
                cls: 'setting-item-description'
            });
            const reviewBtn = bannerEl.createEl('button', {
                text: t.settings.semanticSearch.localOnnxNotConsentedBannerButton,
                cls: 'mod-cta'
            });
            reviewBtn.addEventListener('click', () => {
                this.openLocalOnnxConsentModal(plugin, (accepted) => {
                    if (!accepted) return;
                    void this.applyLocalOnnxConsentChange(plugin, () => {
                        plugin.settings.enableLocalOnnxEmbeddings = true;
                    });
                });
            });
        }

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
                    .onChange((value) => {
                        plugin.settings.embeddingModel = value;
                        void plugin.saveSettings();
                    });
            });

        // local-onnx: show "ready" notice instead of API key/endpoint
        if (plugin.settings.embeddingProvider === 'local-onnx') {
            const readyEl = sectionEl.createDiv({ cls: 'ai-organiser-settings-status' });
            readyEl.createEl('span', {
                text: t.settings.semanticSearch.localOnnxReady,
                cls: 'ai-organiser-status-success'
            });
            readyEl.createEl('p', {
                text: t.settings.semanticSearch.localOnnxDesc,
                cls: 'setting-item-description'
            });
        }

        // Embedding API Key (if not using Ollama or local-onnx)
        const noKeyProvider = plugin.settings.embeddingProvider === 'ollama'
            || plugin.settings.embeddingProvider === 'local-onnx';
        if (!noKeyProvider) {
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
                    onChange: (value) => {
                        plugin.settings.embeddingApiKey = value;
                        void plugin.saveSettings();
                    }
                });
            }
        }

        // Embedding Endpoint (for Ollama or custom endpoints)
        if (plugin.settings.embeddingProvider === 'ollama') {
            new Setting(sectionEl)
                .setName(t.settings.semanticSearch.embeddingEndpoint.name)
                .setDesc(t.settings.semanticSearch.embeddingEndpoint.description)
                .addText(text => {
                    const endpointPlaceholder = 'http://localhost:11434';
                    return text
                        .setPlaceholder(endpointPlaceholder)
                        .setValue(plugin.settings.embeddingEndpoint)
                        .onChange((value) => {
                            plugin.settings.embeddingEndpoint = value;
                            void plugin.saveSettings();
                        });
                });

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
                .onChange((value) => {
                    plugin.settings.autoIndexNewNotes = value;
                    void plugin.saveSettings();
                }));

        // Index attachment text (azure-capability-completion-v2 Phase 1) + per-note cap.
        new Setting(sectionEl)
            .setName(t.settings.semanticSearch.indexAttachmentText.name)
            .setDesc(t.settings.semanticSearch.indexAttachmentText.description)
            .addToggle(toggle => toggle
                .setValue(plugin.settings.indexAttachmentText)
                .onChange((value) => {
                    plugin.settings.indexAttachmentText = value;
                    void plugin.saveSettings();
                }));
        new Setting(sectionEl)
            .setName(t.settings.semanticSearch.maxAttachmentCharsPerNote.name)
            .setDesc(t.settings.semanticSearch.maxAttachmentCharsPerNote.description)
            .addText(text => text
                .setPlaceholder('50000')
                .setValue(plugin.settings.maxAttachmentCharsPerNote.toString())
                .onChange((value) => {
                    const n = parseInt(value, 10);
                    if (!isNaN(n) && n > 0) {
                        plugin.settings.maxAttachmentCharsPerNote = Math.min(1_000_000, Math.max(1000, n));
                        void plugin.saveSettings();
                    }
                }));

        // Use shared excluded folders toggle
        new Setting(sectionEl)
            .setName(t.settings.semanticSearch.useSharedExcludedFolders.name)
            .setDesc(t.settings.semanticSearch.useSharedExcludedFolders.description)
            .addToggle(toggle => toggle
                .setValue(plugin.settings.useSharedExcludedFolders)
                .onChange((value) => {
                    plugin.settings.useSharedExcludedFolders = value;
                    void plugin.saveSettings();
                    void this.display(); // Refresh to show/hide custom folders
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
                folderList.addClass('ai-organiser-font-mono');
                folderList.addClass('ai-organiser-text-ui-smaller');
                folderList.addClass('ai-organiser-opacity-85');
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
                .addTextArea(text => {
                    const foldersPlaceholder = 'folder1\nfolder2\nfolder3';
                    return text
                        .setPlaceholder(foldersPlaceholder)
                        .setValue(plugin.settings.indexExcludedFolders.join('\n'))
                        .onChange((value) => {
                            plugin.settings.indexExcludedFolders = value
                                .split('\n')
                                .map(f => f.trim())
                                .filter(f => f.length > 0);
                            void plugin.saveSettings();
                        });
                });
        }

        // Chunk size
        new Setting(sectionEl)
            .setName(t.settings.semanticSearch.chunkSize.name)
            .setDesc(t.settings.semanticSearch.chunkSize.description)
            .addText(text => text
                .setPlaceholder('2000')
                .setValue(plugin.settings.chunkSize.toString())
                .onChange((value) => {
                    const numValue = parseInt(value);
                    if (!isNaN(numValue) && numValue > 0) {
                        plugin.settings.chunkSize = numValue;
                        void plugin.saveSettings();
                    }
                }));

        // Chunk overlap
        new Setting(sectionEl)
            .setName(t.settings.semanticSearch.chunkOverlap.name)
            .setDesc(t.settings.semanticSearch.chunkOverlap.description)
            .addText(text => text
                .setPlaceholder('200')
                .setValue(plugin.settings.chunkOverlap.toString())
                .onChange((value) => {
                    const numValue = parseInt(value);
                    if (!isNaN(numValue) && numValue >= 0) {
                        plugin.settings.chunkOverlap = numValue;
                        void plugin.saveSettings();
                    }
                }));

        // Max chunks per note
        new Setting(sectionEl)
            .setName(t.settings.semanticSearch.maxChunksPerNote.name)
            .setDesc(t.settings.semanticSearch.maxChunksPerNote.description)
            .addText(text => text
                .setPlaceholder('10')
                .setValue(plugin.settings.maxChunksPerNote.toString())
                .onChange((value) => {
                    const numValue = parseInt(value);
                    if (!isNaN(numValue) && numValue > 0) {
                        plugin.settings.maxChunksPerNote = numValue;
                        void plugin.saveSettings();
                    }
                }));

        // Manage Index action
        new Setting(sectionEl)
            .setName(t.settings.semanticSearch.manageIndexAction)
            .setDesc(t.settings.semanticSearch.manageIndexActionDesc)
            .addButton(button => {
                button
                    .setIcon('database')
                    .setButtonText(t.settings.semanticSearch.manageIndexButton)
                    .onClick(() => {
                        (plugin.app as import('obsidian').App & { commands: { executeCommandById: (id: string) => void } }).commands.executeCommandById('ai-organiser:manage-index');
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
                .onChange((value) => {
                    plugin.settings.enableVaultChat = value;
                    void plugin.saveSettings();
                    // Refresh to show/hide RAG options
                    void this.display();
                }));

        // Only show RAG options if Vault Chat is enabled
        if (!plugin.settings.enableVaultChat) {
            sectionEl.createEl('p', {
                text: t.settings.semanticSearch.enableVaultChatForRag,
                cls: 'setting-item-description mod-warning'
            });
            return;
        }

        // Chat export folder
        new Setting(sectionEl)
            .setName(t.settings.semanticSearch.chatExportFolder)
            .setDesc(t.settings.semanticSearch.chatExportFolderDesc)
            .addText(text => text
                .setPlaceholder('Chats')
                .setValue(plugin.settings.chatExportFolder)
                .onChange((value) => {
                    plugin.settings.chatExportFolder = value.trim() || 'Chats';
                    void plugin.saveSettings();
                }));

        // RAG context chunks
        new Setting(sectionEl)
            .setName(t.settings.semanticSearch.ragContextChunks.name)
            .setDesc(t.settings.semanticSearch.ragContextChunks.description)
            .addText(text => text
                .setPlaceholder('5')
                .setValue(plugin.settings.ragContextChunks.toString())
                .onChange((value) => {
                    const numValue = parseInt(value);
                    if (!isNaN(numValue) && numValue > 0) {
                        plugin.settings.ragContextChunks = numValue;
                        void plugin.saveSettings();
                    }
                }));

        // Include metadata in RAG context
        new Setting(sectionEl)
            .setName(t.settings.semanticSearch.ragIncludeMetadata.name)
            .setDesc(t.settings.semanticSearch.ragIncludeMetadata.description)
            .addToggle(toggle => toggle
                .setValue(plugin.settings.ragIncludeMetadata)
                .onChange((value) => {
                    plugin.settings.ragIncludeMetadata = value;
                    void plugin.saveSettings();
                }));

        new Setting(sectionEl)
            .setName(t.settings.semanticSearch.relatedNotesCount.name)
            .setDesc(t.settings.semanticSearch.relatedNotesCount.description)
            .addText(text => text
                .setPlaceholder('15')
                .setValue(plugin.settings.relatedNotesCount.toString())
                .onChange((value) => {
                    const numValue = parseInt(value);
                    if (!isNaN(numValue) && numValue >= 1 && numValue <= 50) {
                        plugin.settings.relatedNotesCount = numValue;
                        void plugin.saveSettings();
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
            const mainSecretId = PROVIDER_TO_SECRET_ID[mainProvider];
            if (mainSecretId && await secretStorage.hasSecret(mainSecretId)) return true;
        }

        // 4. Plaintext fallback chain
        if (plugin.settings.embeddingApiKey) return true;
        const providerKey = plugin.settings.providerSettings?.[provider as keyof typeof plugin.settings.providerSettings]?.apiKey;
        if (providerKey) return true;
        if (plugin.settings.cloudApiKey) return true;

        return false;
    }

    /** Opens the local-ONNX consent disclosure. `callback` receives the
     *  user's decision — the caller decides what to mutate on accept. */
    private openLocalOnnxConsentModal(plugin: AIOrganiserPlugin, callback: (accepted: boolean) => void): void {
        new LocalOnnxConsentModal(plugin.app, plugin.t, callback).open();
    }

    /**
     * The ONE apply-operation for every direction of the local-ONNX consent
     * change (grant via modal accept, revoke via the toggle) — a `mutator`
     * callback rather than a boolean, since different callers change
     * different fields (the toggle only touches the consent flag; the
     * dropdown/banner also set `embeddingProvider`/`embeddingModel`).
     * Snapshots BEFORE calling `mutator()` so a save failure can roll back
     * to the exact pre-change state, then persists and re-renders. A failed
     * save leaves both the in-memory settings and the rendered UI exactly
     * as they were before the mutation — not a partial, inconsistent state.
     */
    private async applyLocalOnnxConsentChange(plugin: AIOrganiserPlugin, mutator: () => void): Promise<void> {
        const snapshot = {
            enableLocalOnnxEmbeddings: plugin.settings.enableLocalOnnxEmbeddings,
            embeddingProvider: plugin.settings.embeddingProvider,
            embeddingModel: plugin.settings.embeddingModel,
        };
        mutator();
        try {
            await plugin.saveSettings();
        } catch (err) {
            plugin.settings.enableLocalOnnxEmbeddings = snapshot.enableLocalOnnxEmbeddings;
            plugin.settings.embeddingProvider = snapshot.embeddingProvider;
            plugin.settings.embeddingModel = snapshot.embeddingModel;
            logger.error('Search', `Failed to save local-ONNX consent change: ${err instanceof Error ? err.message : String(err)}`);
            new Notice(plugin.t.settings.semanticSearch.localOnnxConsentSaveFailed);
        }
        void this.display();
    }
}
