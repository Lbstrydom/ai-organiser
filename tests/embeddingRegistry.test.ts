/**
 * Embedding Registry Tests
 * Ensures embedding defaults and models come from a single registry
 */

import { 
    EMBEDDING_DEFAULT_MODEL, 
    EMBEDDING_MODELS, 
    getEmbeddingModelOptions,
    EmbeddingProvider 
} from '../src/services/embeddings/embeddingRegistry';
import { getDefaultEmbeddingModel, getAvailableEmbeddingModels } from '../src/services/embeddings/embeddingServiceFactory';

const ALL_EMBEDDING_PROVIDERS: EmbeddingProvider[] = ['openai', 'ollama', 'gemini', 'cohere', 'voyage', 'openrouter'];

describe('Embedding Registry', () => {
    describe('Registry Completeness', () => {
        it('has defaults for all providers', () => {
            ALL_EMBEDDING_PROVIDERS.forEach(provider => {
                expect(EMBEDDING_DEFAULT_MODEL[provider]).toBeDefined();
                expect(EMBEDDING_DEFAULT_MODEL[provider]).toBeTruthy();
            });
        });

        it('has model lists for all providers', () => {
            ALL_EMBEDDING_PROVIDERS.forEach(provider => {
                expect(EMBEDDING_MODELS[provider]).toBeDefined();
                expect(Array.isArray(EMBEDDING_MODELS[provider])).toBe(true);
                expect(EMBEDDING_MODELS[provider].length).toBeGreaterThan(0);
            });
        });

        it('default model exists in provider model list', () => {
            ALL_EMBEDDING_PROVIDERS.forEach(provider => {
                const defaultModel = EMBEDDING_DEFAULT_MODEL[provider];
                const models = EMBEDDING_MODELS[provider];
                
                expect(models).toContain(defaultModel);
            });
        });
    });

    describe('Model Options Helper', () => {
        it('returns labeled options for all providers', () => {
            ALL_EMBEDDING_PROVIDERS.forEach(provider => {
                const options = getEmbeddingModelOptions(provider);
                
                expect(Array.isArray(options)).toBe(true);
                expect(options.length).toBeGreaterThan(0);
                
                options.forEach(option => {
                    expect(option).toHaveProperty('value');
                    expect(option).toHaveProperty('label');
                    expect(typeof option.value).toBe('string');
                    expect(typeof option.label).toBe('string');
                });
            });
        });

        it('option values match model list', () => {
            ALL_EMBEDDING_PROVIDERS.forEach(provider => {
                const options = getEmbeddingModelOptions(provider);
                const models = EMBEDDING_MODELS[provider];
                
                const optionValues = options.map(opt => opt.value);
                expect(optionValues.sort()).toEqual(models.sort());
            });
        });

        it('labels provide helpful context', () => {
            const openaiOptions = getEmbeddingModelOptions('openai');
            
            // At least one label should contain contextual info
            const hasContextualLabel = openaiOptions.some(opt => 
                opt.label !== opt.value && 
                (opt.label.includes('recommended') || 
                 opt.label.includes('quality') || 
                 opt.label.includes('legacy'))
            );
            
            expect(hasContextualLabel).toBe(true);
        });
    });

    describe('Factory Integration', () => {
        it('getDefaultEmbeddingModel uses registry', () => {
            ALL_EMBEDDING_PROVIDERS.forEach(provider => {
                const factoryDefault = getDefaultEmbeddingModel(provider);
                const registryDefault = EMBEDDING_DEFAULT_MODEL[provider];
                
                expect(factoryDefault).toBe(registryDefault);
            });
        });

        it('getAvailableEmbeddingModels uses registry', () => {
            ALL_EMBEDDING_PROVIDERS.forEach(provider => {
                const factoryModels = getAvailableEmbeddingModels(provider);
                const registryModels = EMBEDDING_MODELS[provider];
                
                expect(factoryModels).toEqual(registryModels);
            });
        });

        it('factory functions fallback to openai for unknown provider', () => {
            const unknownProvider = 'unknown-provider' as EmbeddingProvider;
            
            const defaultModel = getDefaultEmbeddingModel(unknownProvider);
            const models = getAvailableEmbeddingModels(unknownProvider);
            
            expect(defaultModel).toBe(EMBEDDING_DEFAULT_MODEL.openai);
            expect(models).toEqual(EMBEDDING_MODELS.openai);
        });
    });

    describe('Known Provider Defaults', () => {
        it('OpenAI defaults to text-embedding-3-small', () => {
            expect(EMBEDDING_DEFAULT_MODEL.openai).toBe('text-embedding-3-small');
        });

        it('Gemini defaults to text-embedding-004', () => {
            expect(EMBEDDING_DEFAULT_MODEL.gemini).toBe('text-embedding-004');
        });

        it('Ollama defaults to nomic-embed-text', () => {
            expect(EMBEDDING_DEFAULT_MODEL.ollama).toBe('nomic-embed-text');
        });

        it('Cohere defaults to embed-english-v3.0', () => {
            expect(EMBEDDING_DEFAULT_MODEL.cohere).toBe('embed-english-v3.0');
        });

        it('Voyage defaults to voyage-3', () => {
            expect(EMBEDDING_DEFAULT_MODEL.voyage).toBe('voyage-3');
        });

        it('OpenRouter defaults to openai/text-embedding-3-small', () => {
            expect(EMBEDDING_DEFAULT_MODEL.openrouter).toBe('openai/text-embedding-3-small');
        });
    });

    describe('No Hard-Coded Duplication', () => {
        it('registry is single source of truth', () => {
            // This test verifies the registry pattern by checking that
            // factory and UI both delegate to the registry
            
            const provider: EmbeddingProvider = 'gemini';
            
            // Factory uses registry
            const factoryDefault = getDefaultEmbeddingModel(provider);
            const factoryModels = getAvailableEmbeddingModels(provider);
            
            // Registry values
            const registryDefault = EMBEDDING_DEFAULT_MODEL[provider];
            const registryModels = EMBEDDING_MODELS[provider];
            
            // UI helper uses registry
            const uiOptions = getEmbeddingModelOptions(provider);
            const uiModelValues = uiOptions.map(opt => opt.value);
            
            // All should match
            expect(factoryDefault).toBe(registryDefault);
            expect(factoryModels).toEqual(registryModels);
            expect(uiModelValues.sort()).toEqual(registryModels.sort());
        });

        it('no switch statements in factory functions', () => {
            // Verify functions are simple registry lookups
            // This is a meta-test to ensure we maintain DRY principles
            
            const factoryCode = getDefaultEmbeddingModel.toString();
            expect(factoryCode).not.toContain('switch');
            expect(factoryCode).not.toContain('case');
            
            const modelsCode = getAvailableEmbeddingModels.toString();
            expect(modelsCode).not.toContain('switch');
            expect(modelsCode).not.toContain('case');
        });
    });
});
