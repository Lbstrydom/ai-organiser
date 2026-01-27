/**
 * SecretStorage Service
 *
 * Manages secure storage of API keys using Obsidian's SecretStorage API (v1.11+).
 * Provides cross-plugin key sharing, inheritance chain resolution, and backward compatibility.
 */

import type { App } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import type { AdapterType } from './adapters';
import type { AIOrganiserSettings } from '../core/settings';
import {
    STANDARD_SECRET_IDS,
    PLUGIN_SECRET_IDS,
    PROVIDER_TO_SECRET_ID,
    type KeyResolutionOptions,
    type MigrationResult,
    type MigrationEntry,
} from '../core/secretIds';

/**
 * SecretStorage service interface
 */
export interface ISecretStorageService {
    /** Check if SecretStorage is available */
    isAvailable(): boolean;

    /** Get a secret by ID */
    getSecret(id: string): Promise<string | null>;

    /** Set a secret by ID */
    setSecret(id: string, value: string): Promise<void>;

    /** Remove a secret by ID */
    removeSecret(id: string): Promise<void>;

    /** Get provider-specific API key */
    getProviderKey(provider: AdapterType): Promise<string | null>;

    /** Set provider-specific API key */
    setProviderKey(provider: AdapterType, value: string): Promise<void>;

    /** Resolve API key via inheritance chain */
    resolveApiKey(options: KeyResolutionOptions): Promise<string | null>;

    /** Migrate from plain-text settings */
    migrateFromPlainText(): Promise<MigrationResult>;
}

/**
 * SecretStorage service implementation
 */
export class SecretStorageService implements ISecretStorageService {
    private app: App;
    private plugin: AIOrganiserPlugin;

    constructor(app: App, plugin: AIOrganiserPlugin) {
        this.app = app;
        this.plugin = plugin;
    }

    /**
     * Check if SecretStorage API is available (Obsidian 1.11+)
     */
    isAvailable(): boolean {
        return 'secretStorage' in this.app.vault;
    }

    /**
     * Get a secret by ID from SecretStorage
     */
    async getSecret(id: string): Promise<string | null> {
        if (!this.isAvailable()) {
            return null;
        }

        try {
            const value = await (this.app.vault as any).secretStorage.get(id);
            return value || null;
        } catch (error) {
            console.error(`SecretStorage: Failed to get secret ${id}:`, error);
            return null;
        }
    }

    /**
     * Set a secret by ID in SecretStorage
     */
    async setSecret(id: string, value: string): Promise<void> {
        if (!this.isAvailable()) {
            throw new Error('SecretStorage not available');
        }

        try {
            await (this.app.vault as any).secretStorage.set(id, value);
        } catch (error) {
            console.error(`SecretStorage: Failed to set secret ${id}:`, error);
            throw error;
        }
    }

    /**
     * Remove a secret by ID from SecretStorage
     */
    async removeSecret(id: string): Promise<void> {
        if (!this.isAvailable()) {
            return;
        }

        try {
            await (this.app.vault as any).secretStorage.delete(id);
        } catch (error) {
            console.error(`SecretStorage: Failed to remove secret ${id}:`, error);
        }
    }

    /**
     * Get provider-specific API key using standardized ID
     */
    async getProviderKey(provider: AdapterType): Promise<string | null> {
        const secretId = PROVIDER_TO_SECRET_ID[provider];
        if (!secretId) {
            console.warn(`SecretStorage: No secret ID mapped for provider ${provider}`);
            return null;
        }

        return await this.getSecret(secretId);
    }

    /**
     * Set provider-specific API key using standardized ID
     */
    async setProviderKey(provider: AdapterType, value: string): Promise<void> {
        const secretId = PROVIDER_TO_SECRET_ID[provider];
        if (!secretId) {
            throw new Error(`No secret ID mapped for provider ${provider}`);
        }

        await this.setSecret(secretId, value);
    }

    /**
     * Resolve API key via inheritance chain
     *
     * Resolution order:
     * 1. Primary plugin-specific secret (e.g., PLUGIN_SECRET_IDS.EMBEDDING)
     * 2. Provider-specific secret (e.g., STANDARD_SECRET_IDS.OPENAI)
     * 3. Main cloud provider secret (from settings.cloudServiceType)
     * 4. Plain-text fallback (backward compatibility)
     */
    async resolveApiKey(options: KeyResolutionOptions): Promise<string | null> {
        const {
            primaryId,
            providerFallback,
            useMainKeyFallback = true,
            plainTextFallback,
        } = options;

        // 1. Check primary plugin-specific secret
        if (primaryId) {
            const key = await this.getSecret(primaryId);
            if (key) return key;
        }

        // 2. Check provider-specific secret
        if (providerFallback) {
            const key = await this.getProviderKey(providerFallback);
            if (key) return key;
        }

        // 3. Check main cloud provider secret
        if (useMainKeyFallback) {
            const mainProvider = this.plugin.settings.cloudServiceType;
            const key = await this.getProviderKey(mainProvider);
            if (key) return key;
        }

        // 4. Fallback to plain-text settings (backward compatibility)
        if (plainTextFallback) {
            if (plainTextFallback.primaryKey) return plainTextFallback.primaryKey;
            if (plainTextFallback.providerKey) return plainTextFallback.providerKey;
            if (plainTextFallback.mainCloudKey) return plainTextFallback.mainCloudKey;
        }

        return null;
    }

    /**
     * Migrate API keys from plain-text settings to SecretStorage
     *
     * This is user-initiated (not automatic) to avoid surprising users.
     * Shows confirmation modal with multi-device warning.
     */
    async migrateFromPlainText(): Promise<MigrationResult> {
        if (!this.isAvailable()) {
            return {
                migrated: false,
                reason: 'SecretStorage not available',
            };
        }

        const entries: MigrationEntry[] = [];
        const settings = this.plugin.settings;

        try {
            // Migrate main cloud API key
            if (settings.cloudApiKey) {
                const provider = settings.cloudServiceType;
                const secretId = PROVIDER_TO_SECRET_ID[provider];
                if (secretId) {
                    try {
                        await this.setSecret(secretId, settings.cloudApiKey);
                        settings.cloudApiKey = '';
                        entries.push({
                            field: 'cloudApiKey',
                            secretId,
                            success: true,
                        });
                    } catch (error) {
                        entries.push({
                            field: 'cloudApiKey',
                            secretId,
                            success: false,
                        });
                    }
                }
            }

            // Migrate provider-specific keys
            if (settings.providerSettings) {
                for (const [provider, config] of Object.entries(settings.providerSettings)) {
                    if (config?.apiKey) {
                        const secretId = PROVIDER_TO_SECRET_ID[provider as AdapterType];
                        if (secretId) {
                            try {
                                await this.setSecret(secretId, config.apiKey);
                                config.apiKey = '';
                                entries.push({
                                    field: `providerSettings.${provider}.apiKey`,
                                    secretId,
                                    success: true,
                                });
                            } catch (error) {
                                entries.push({
                                    field: `providerSettings.${provider}.apiKey`,
                                    secretId,
                                    success: false,
                                });
                            }
                        }
                    }
                }
            }

            // Migrate embedding API key
            if (settings.embeddingApiKey) {
                try {
                    await this.setSecret(PLUGIN_SECRET_IDS.EMBEDDING, settings.embeddingApiKey);
                    settings.embeddingApiKey = '';
                    entries.push({
                        field: 'embeddingApiKey',
                        secretId: PLUGIN_SECRET_IDS.EMBEDDING,
                        success: true,
                    });
                } catch (error) {
                    entries.push({
                        field: 'embeddingApiKey',
                        secretId: PLUGIN_SECRET_IDS.EMBEDDING,
                        success: false,
                    });
                }
            }

            // Migrate YouTube API key
            if (settings.youtubeGeminiApiKey) {
                try {
                    await this.setSecret(PLUGIN_SECRET_IDS.YOUTUBE, settings.youtubeGeminiApiKey);
                    settings.youtubeGeminiApiKey = '';
                    entries.push({
                        field: 'youtubeGeminiApiKey',
                        secretId: PLUGIN_SECRET_IDS.YOUTUBE,
                        success: true,
                    });
                } catch (error) {
                    entries.push({
                        field: 'youtubeGeminiApiKey',
                        secretId: PLUGIN_SECRET_IDS.YOUTUBE,
                        success: false,
                    });
                }
            }

            // Migrate PDF API key
            if (settings.pdfApiKey) {
                try {
                    await this.setSecret(PLUGIN_SECRET_IDS.PDF, settings.pdfApiKey);
                    settings.pdfApiKey = '';
                    entries.push({
                        field: 'pdfApiKey',
                        secretId: PLUGIN_SECRET_IDS.PDF,
                        success: true,
                    });
                } catch (error) {
                    entries.push({
                        field: 'pdfApiKey',
                        secretId: PLUGIN_SECRET_IDS.PDF,
                        success: false,
                    });
                }
            }

            // Migrate audio transcription API key
            if (settings.audioTranscriptionApiKey) {
                try {
                    await this.setSecret(PLUGIN_SECRET_IDS.AUDIO, settings.audioTranscriptionApiKey);
                    settings.audioTranscriptionApiKey = '';
                    entries.push({
                        field: 'audioTranscriptionApiKey',
                        secretId: PLUGIN_SECRET_IDS.AUDIO,
                        success: true,
                    });
                } catch (error) {
                    entries.push({
                        field: 'audioTranscriptionApiKey',
                        secretId: PLUGIN_SECRET_IDS.AUDIO,
                        success: false,
                    });
                }
            }

            // Mark migration as complete
            settings.secretStorageMigrated = true;
            await this.plugin.saveSettings();

            return {
                migrated: true,
                entries,
            };
        } catch (error) {
            console.error('SecretStorage: Migration failed:', error);
            return {
                migrated: false,
                reason: error instanceof Error ? error.message : 'Unknown error',
                entries,
            };
        }
    }

    /**
     * Check if a specific secret has a value
     */
    async hasSecret(id: string): Promise<boolean> {
        const value = await this.getSecret(id);
        return value !== null && value.length > 0;
    }

    /**
     * Get all standard secret IDs
     */
    getStandardSecretIds(): typeof STANDARD_SECRET_IDS {
        return STANDARD_SECRET_IDS;
    }

    /**
     * Get all plugin-specific secret IDs
     */
    getPluginSecretIds(): typeof PLUGIN_SECRET_IDS {
        return PLUGIN_SECRET_IDS;
    }

    /**
     * Get secret ID for a provider
     */
    getProviderSecretId(provider: AdapterType): string | undefined {
        return PROVIDER_TO_SECRET_ID[provider];
    }
}
