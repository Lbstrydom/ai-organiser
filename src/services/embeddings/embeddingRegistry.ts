/**
 * Embedding Provider Registry
 * 
 * Single source of truth for embedding provider defaults and available models.
 * Used by embeddingServiceFactory and SemanticSearchSettingsSection.
 */

export type EmbeddingProvider = 'openai' | 'ollama' | 'gemini' | 'cohere' | 'voyage' | 'openrouter' | 'local-onnx';

/**
 * Default embedding model for each provider
 */
export const EMBEDDING_DEFAULT_MODEL: Record<EmbeddingProvider, string> = {
    openai: 'text-embedding-3-small',
    ollama: 'nomic-embed-text',
    gemini: 'text-embedding-004',
    cohere: 'embed-english-v3.0',
    voyage: 'voyage-3',
    openrouter: 'openai/text-embedding-3-small',
    'local-onnx': 'Xenova/all-MiniLM-L6-v2'
};

/**
 * Available embedding models for each provider
 */
export const EMBEDDING_MODELS: Record<EmbeddingProvider, string[]> = {
    openai: [
        'text-embedding-3-small',
        'text-embedding-3-large',
        'text-embedding-ada-002'
    ],
    ollama: [
        'nomic-embed-text',
        'mxbai-embed-large',
        'snowflake-arctic-embed',
        'qwen3-embedding:0.6b'
    ],
    gemini: [
        'text-embedding-004',
        'text-multilingual-embedding-002'
    ],
    cohere: [
        'embed-english-v3.0',
        'embed-multilingual-v3.0',
        'embed-english-light-v3.0'
    ],
    voyage: [
        'voyage-3',
        'voyage-3-lite',
        'voyage-code-3'
    ],
    openrouter: [
        'openai/text-embedding-3-small',
        'openai/text-embedding-3-large',
        'openai/text-embedding-ada-002'
    ],
    'local-onnx': [
        'Xenova/all-MiniLM-L6-v2',
        'Xenova/bge-small-en-v1.5',
        'nomic-ai/nomic-embed-text-v1.5'
    ]
};

/**
 * UI-friendly labeled models for settings dropdown
 */
export interface EmbeddingModelOption {
    value: string;
    label: string;
}

/**
 * Get labeled models for a provider (for UI dropdowns)
 */
export function getEmbeddingModelOptions(provider: EmbeddingProvider): EmbeddingModelOption[] {
    const models = EMBEDDING_MODELS[provider];
    
    // Provider-specific labels with recommendations
    const labels: Record<EmbeddingProvider, Record<string, string>> = {
        openai: {
            'text-embedding-3-small': 'text-embedding-3-small (recommended)',
            'text-embedding-3-large': 'text-embedding-3-large (higher quality)',
            'text-embedding-ada-002': 'text-embedding-ada-002 (legacy)'
        },
        gemini: {
            'text-embedding-004': 'text-embedding-004 (latest)',
            'text-multilingual-embedding-002': 'text-multilingual-embedding-002'
        },
        ollama: {
            'nomic-embed-text': 'nomic-embed-text (recommended)',
            'mxbai-embed-large': 'mxbai-embed-large',
            'snowflake-arctic-embed': 'snowflake-arctic-embed',
            'qwen3-embedding:0.6b': 'Qwen3 Embedding 0.6B (multilingual)'
        },
        openrouter: {
            'openai/text-embedding-3-small': 'OpenAI small (recommended)',
            'openai/text-embedding-3-large': 'OpenAI large (higher quality)',
            'openai/text-embedding-ada-002': 'OpenAI ada-002 (legacy)'
        },
        cohere: {
            'embed-english-v3.0': 'embed-english-v3.0 (recommended)',
            'embed-multilingual-v3.0': 'embed-multilingual-v3.0',
            'embed-english-light-v3.0': 'embed-english-light-v3.0 (faster)'
        },
        voyage: {
            'voyage-3': 'voyage-3 (general)',
            'voyage-3-lite': 'voyage-3-lite (faster)',
            'voyage-code-3': 'voyage-code-3 (code-optimized)'
        },
        'local-onnx': {
            'Xenova/all-MiniLM-L6-v2': 'all-MiniLM-L6-v2 (23MB, fast) ⭐',
            'Xenova/bge-small-en-v1.5': 'BGE Small EN v1.5 (33MB, better)',
            'nomic-ai/nomic-embed-text-v1.5': 'Nomic Embed v1.5 (137MB, best)'
        }
    };

    return models.map(value => ({
        value,
        label: labels[provider][value] || value
    }));
}
