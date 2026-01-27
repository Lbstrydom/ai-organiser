/**
 * Tests for SecretStorageService
 * Covers key resolution, migration, fallback, and cross-plugin compatibility
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SecretStorageService } from '../src/services/secretStorageService';
import { MockSecretStorage } from './mocks/mockSecretStorage';
import { STANDARD_SECRET_IDS, PLUGIN_SECRET_IDS, PROVIDER_TO_SECRET_ID } from '../src/core/secretIds';
import type { AdapterType } from '../src/services/adapters';

describe('SecretStorageService', () => {
    let mockSecretStorage: MockSecretStorage;
    let mockApp: any;
    let mockPlugin: any;
    let service: SecretStorageService;

    beforeEach(() => {
        mockSecretStorage = new MockSecretStorage(true);
        
        mockApp = {
            vault: {
                secretStorage: mockSecretStorage
            }
        };

        mockPlugin = {
            settings: {
                cloudApiKey: '',
                cloudServiceType: 'openai',
                providerSettings: {},
                embeddingApiKey: '',
                youtubeGeminiApiKey: '',
                pdfApiKey: '',
                audioTranscriptionApiKey: '',
                secretStorageMigrated: false
            },
            saveSettings: vi.fn()
        };

        service = new SecretStorageService(mockApp, mockPlugin);
    });

    describe('isAvailable', () => {
        it('should return true when SecretStorage exists', () => {
            expect(service.isAvailable()).toBe(true);
        });

        it('should return false when SecretStorage does not exist', () => {
            delete mockApp.vault.secretStorage;
            const unavailableService = new SecretStorageService(mockApp, mockPlugin);
            expect(unavailableService.isAvailable()).toBe(false);
        });
    });

    describe('getSecret / setSecret / removeSecret', () => {
        it('should store and retrieve secret', async () => {
            await service.setSecret('test-key', 'test-value');
            const value = await service.getSecret('test-key');
            expect(value).toBe('test-value');
        });

        it('should return null for non-existent secret', async () => {
            const value = await service.getSecret('non-existent');
            expect(value).toBeNull();
        });

        it('should remove secret', async () => {
            await service.setSecret('test-key', 'test-value');
            await service.removeSecret('test-key');
            const value = await service.getSecret('test-key');
            expect(value).toBeNull();
        });

        it('should return null when SecretStorage unavailable', async () => {
            mockSecretStorage.setAvailable(false);
            const value = await service.getSecret('test-key');
            expect(value).toBeNull();
        });
    });

    describe('getProviderKey / setProviderKey', () => {
        it('should map provider to standard secret ID', async () => {
            const provider: AdapterType = 'openai';
            await service.setProviderKey(provider, 'sk-test123');
            
            const value = await service.getProviderKey(provider);
            expect(value).toBe('sk-test123');
            
            // Verify it used the mapped secret ID
            const standardValue = await service.getSecret(PROVIDER_TO_SECRET_ID[provider]);
            expect(standardValue).toBe('sk-test123');
        });

        it('should handle provider mappings', async () => {
            // Test providers that have secret ID mappings
            const providersWithMappings: AdapterType[] = [
                'openai', 'claude', 'gemini', 'groq', 'cohere',
                'deepseek', 'mistral', 'openrouter', 'grok',
                'openai-compatible'
            ];

            for (const provider of providersWithMappings) {
                const secretId = PROVIDER_TO_SECRET_ID[provider];
                expect(secretId).toBeDefined();
                
                await service.setProviderKey(provider, `key-for-${provider}`);
                const value = await service.getProviderKey(provider);
                expect(value).toBe(`key-for-${provider}`);
            }

            // Test that providers without mappings return null
            const result = await service.getProviderKey('aliyun' as AdapterType);
            expect(result).toBeNull();
        });
    });

    describe('resolveApiKey - Inheritance Chain', () => {
        it('should return primary plugin key if set (step 1)', async () => {
            await service.setSecret(PLUGIN_SECRET_IDS.EMBEDDING, 'embedding-key');
            await service.setSecret(STANDARD_SECRET_IDS.OPENAI, 'openai-key');
            mockPlugin.settings.cloudApiKey = 'fallback-key';

            const result = await service.resolveApiKey({
                primaryId: PLUGIN_SECRET_IDS.EMBEDDING,
                providerFallback: 'openai'
            });

            expect(result).toBe('embedding-key');
        });

        it('should return provider key if primary not set (step 2)', async () => {
            await service.setSecret(STANDARD_SECRET_IDS.OPENAI, 'openai-key');
            mockPlugin.settings.cloudApiKey = 'fallback-key';

            const result = await service.resolveApiKey({
                providerFallback: 'openai'
            });

            expect(result).toBe('openai-key');
        });

        it('should return main cloud key if provider not set (step 3)', async () => {
            await service.setSecret(STANDARD_SECRET_IDS.OPENAI, 'main-key');
            mockPlugin.settings.cloudServiceType = 'openai';

            const result = await service.resolveApiKey({
                useMainKeyFallback: true
            });

            expect(result).toBe('main-key');
        });

        it('should return plain-text fallback if nothing in SecretStorage (step 4)', async () => {
            const result = await service.resolveApiKey({
                providerFallback: 'openai',
                plainTextFallback: {
                    mainCloudKey: 'fallback-key'
                }
            });

            expect(result).toBe('fallback-key');
        });

        it('should return null if no keys available', async () => {
            const result = await service.resolveApiKey({
                providerFallback: 'openai'
            });

            expect(result).toBeNull();
        });

        it('should prefer provider-specific key from providerSettings', async () => {
            const result = await service.resolveApiKey({
                providerFallback: 'openai',
                plainTextFallback: {
                    providerKey: 'provider-settings-key',
                    mainCloudKey: 'main-key'
                }
            });

            expect(result).toBe('provider-settings-key');
        });
    });

    describe('migrateFromPlainText', () => {
        it('should migrate main cloud API key', async () => {
            mockPlugin.settings.cloudApiKey = 'main-cloud-key';
            mockPlugin.settings.cloudServiceType = 'openai';

            const result = await service.migrateFromPlainText();

            expect(result.migrated).toBe(true);
            expect(result.entries?.length).toBeGreaterThan(0);
            
            const stored = await service.getSecret(STANDARD_SECRET_IDS.OPENAI);
            expect(stored).toBe('main-cloud-key');
            expect(mockPlugin.settings.cloudApiKey).toBe('');
            expect(mockPlugin.saveSettings).toHaveBeenCalled();
        });

        it('should migrate provider-specific keys', async () => {
            mockPlugin.settings.providerSettings = {
                openai: { apiKey: 'openai-key' },
                claude: { apiKey: 'claude-key' }
            };

            const result = await service.migrateFromPlainText();

            expect(result.migrated).toBe(true);
            expect(result.entries?.some(e => e.secretId === STANDARD_SECRET_IDS.OPENAI)).toBe(true);
            expect(result.entries?.some(e => e.secretId === STANDARD_SECRET_IDS.ANTHROPIC)).toBe(true);
            
            const openaiKey = await service.getSecret(STANDARD_SECRET_IDS.OPENAI);
            const claudeKey = await service.getSecret(STANDARD_SECRET_IDS.ANTHROPIC);
            expect(openaiKey).toBe('openai-key');
            expect(claudeKey).toBe('claude-key');
            expect(mockPlugin.settings.providerSettings.openai.apiKey).toBe('');
            expect(mockPlugin.settings.providerSettings.claude.apiKey).toBe('');
        });

        it('should migrate embedding API key', async () => {
            mockPlugin.settings.embeddingApiKey = 'embedding-key';

            const result = await service.migrateFromPlainText();

            expect(result.migrated).toBe(true);
            expect(result.entries?.some(e => e.secretId === PLUGIN_SECRET_IDS.EMBEDDING)).toBe(true);
            
            const stored = await service.getSecret(PLUGIN_SECRET_IDS.EMBEDDING);
            expect(stored).toBe('embedding-key');
            expect(mockPlugin.settings.embeddingApiKey).toBe('');
        });

        it('should migrate YouTube Gemini API key', async () => {
            mockPlugin.settings.youtubeGeminiApiKey = 'youtube-key';

            const result = await service.migrateFromPlainText();

            expect(result.migrated).toBe(true);
            expect(result.entries?.some(e => e.secretId === PLUGIN_SECRET_IDS.YOUTUBE)).toBe(true);
            
            const stored = await service.getSecret(PLUGIN_SECRET_IDS.YOUTUBE);
            expect(stored).toBe('youtube-key');
            expect(mockPlugin.settings.youtubeGeminiApiKey).toBe('');
        });

        it('should migrate PDF API key', async () => {
            mockPlugin.settings.pdfApiKey = 'pdf-key';

            const result = await service.migrateFromPlainText();

            expect(result.migrated).toBe(true);
            expect(result.entries?.some(e => e.secretId === PLUGIN_SECRET_IDS.PDF)).toBe(true);
            
            const stored = await service.getSecret(PLUGIN_SECRET_IDS.PDF);
            expect(stored).toBe('pdf-key');
            expect(mockPlugin.settings.pdfApiKey).toBe('');
        });

        it('should migrate audio transcription API key', async () => {
            mockPlugin.settings.audioTranscriptionApiKey = 'audio-key';

            const result = await service.migrateFromPlainText();

            expect(result.migrated).toBe(true);
            expect(result.entries?.some(e => e.secretId === PLUGIN_SECRET_IDS.AUDIO)).toBe(true);
            
            const stored = await service.getSecret(PLUGIN_SECRET_IDS.AUDIO);
            expect(stored).toBe('audio-key');
            expect(mockPlugin.settings.audioTranscriptionApiKey).toBe('');
        });

        it('should migrate all keys at once', async () => {
            mockPlugin.settings.cloudApiKey = 'main-key';
            mockPlugin.settings.cloudServiceType = 'openai';
            mockPlugin.settings.embeddingApiKey = 'embedding-key';
            mockPlugin.settings.youtubeGeminiApiKey = 'youtube-key';
            mockPlugin.settings.pdfApiKey = 'pdf-key';
            mockPlugin.settings.audioTranscriptionApiKey = 'audio-key';
            mockPlugin.settings.providerSettings = {
                claude: { apiKey: 'claude-key' }
            };

            const result = await service.migrateFromPlainText();

            expect(result.migrated).toBe(true);
            expect(result.entries?.length).toBe(6);
            expect(mockPlugin.saveSettings).toHaveBeenCalledTimes(1);
        });

        it('should skip empty keys', async () => {
            mockPlugin.settings.cloudApiKey = '';
            mockPlugin.settings.embeddingApiKey = '';

            const result = await service.migrateFromPlainText();

            expect(result.migrated).toBe(true);
            expect(result.entries?.length).toBe(0);
            expect(mockPlugin.saveSettings).toHaveBeenCalledTimes(1);
        });

        it('should return error when SecretStorage unavailable at check time', async () => {
            // Create service with no secret storage
            delete mockApp.vault.secretStorage;
            const service2 = new SecretStorageService(mockApp, mockPlugin);
            
            mockPlugin.settings.cloudApiKey = 'main-key';
            const result = await service2.migrateFromPlainText();

            expect(result.migrated).toBe(false);
            expect(result.reason).toBe('SecretStorage not available');
            expect(result.entries).toBeUndefined();
            
            // Restore for other tests
            mockApp.vault.secretStorage = mockSecretStorage;
        });
    });

    describe('hasSecret', () => {
        it('should return true when secret exists', async () => {
            await service.setSecret('test-key', 'test-value');
            const result = await service.hasSecret('test-key');
            expect(result).toBe(true);
        });

        it('should return false when secret does not exist', async () => {
            const result = await service.hasSecret('non-existent');
            expect(result).toBe(false);
        });

        it('should return false when SecretStorage unavailable', async () => {
            mockSecretStorage.setAvailable(false);
            const result = await service.hasSecret('test-key');
            expect(result).toBe(false);
        });
    });

    describe('Cross-Plugin Compatibility', () => {
        it('should use standard secret IDs that other plugins can access', async () => {
            // Simulate another plugin setting OpenAI key
            await mockSecretStorage.set(STANDARD_SECRET_IDS.OPENAI, 'shared-openai-key');

            const result = await service.resolveApiKey({
                providerFallback: 'openai'
            });

            expect(result).toBe('shared-openai-key');
        });

        it('should expose standard secret IDs for documentation', () => {
            const standardIds = service.getStandardSecretIds();
            expect(standardIds).toEqual(STANDARD_SECRET_IDS);
        });

        it('should expose plugin-specific secret IDs', () => {
            const pluginIds = service.getPluginSecretIds();
            expect(pluginIds).toEqual(PLUGIN_SECRET_IDS);
        });

        it('should expose provider mappings', () => {
            const secretId = service.getProviderSecretId('openai');
            expect(secretId).toBe(STANDARD_SECRET_IDS.OPENAI);
        });
    });

    describe('Backward Compatibility', () => {
        it('should work when SecretStorage not available', async () => {
            delete mockApp.vault.secretStorage;
            const legacyService = new SecretStorageService(mockApp, mockPlugin);
            
            const result = await legacyService.resolveApiKey({
                providerFallback: 'openai',
                plainTextFallback: {
                    mainCloudKey: 'fallback-key'
                }
            });

            expect(result).toBe('fallback-key');
        });

        it('should not break existing code when migrating', async () => {
            mockPlugin.settings.cloudApiKey = 'main-key';
            mockPlugin.settings.cloudServiceType = 'openai';
            
            // Migrate
            await service.migrateFromPlainText();
            
            // Should still work via resolution chain
            const result = await service.resolveApiKey({
                providerFallback: 'openai',
                useMainKeyFallback: true
            });
            
            expect(result).toBe('main-key');
        });
    });
});
