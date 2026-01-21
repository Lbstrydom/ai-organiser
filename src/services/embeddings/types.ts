/**
 * Embedding Service Types and Interfaces
 * Defines contracts for embedding generation used by semantic search
 */

/**
 * Result from generating a single embedding
 */
export interface EmbeddingResult {
    success: boolean;
    embedding?: number[];
    tokenCount?: number;
    error?: string;
}

/**
 * Result from generating multiple embeddings
 */
export interface BatchEmbeddingResult {
    success: boolean;
    embeddings?: number[][];
    totalTokens?: number;
    error?: string;
}

/**
 * Model information for an embedding provider
 */
export interface EmbeddingModelInfo {
    provider: string;
    model: string;
    dimensions: number;
    maxTokens: number;
}

/**
 * Core embedding service interface
 * All embedding providers must implement this interface
 */
export interface IEmbeddingService {
    /**
     * Generate embedding for a single text
     */
    generateEmbedding(text: string): Promise<EmbeddingResult>;

    /**
     * Generate embeddings for multiple texts (batch)
     */
    batchGenerateEmbeddings(texts: string[]): Promise<BatchEmbeddingResult>;

    /**
     * Get model dimensions
     */
    getModelDimensions(): number;

    /**
     * Get model name
     */
    getModelName(): string;

    /**
     * Get full model info
     */
    getModelInfo(): EmbeddingModelInfo;

    /**
     * Test the connection to the embedding provider
     */
    testConnection(): Promise<{ success: boolean; error?: string }>;

    /**
     * Cleanup resources
     */
    dispose(): Promise<void>;
}

/**
 * Configuration for embedding service
 */
export interface EmbeddingServiceConfig {
    provider: 'openai' | 'claude' | 'gemini' | 'ollama' | 'openrouter' | 'cohere' | 'voyage';
    model: string;
    apiKey?: string;
    endpoint?: string;
}

/**
 * Embedding provider dimensions map
 * Used to determine vector dimensions for various models
 */
export const EMBEDDING_DIMENSIONS: Record<string, number> = {
    // OpenAI models
    'text-embedding-3-small': 1536,
    'text-embedding-3-large': 3072,
    'text-embedding-ada-002': 1536,

    // Ollama/local models
    'nomic-embed-text': 768,
    'all-minilm': 384,
    'all-minilm:l6-v2': 384,
    'mxbai-embed-large': 1024,
    'bge-small': 384,
    'bge-base': 768,
    'bge-large': 1024,

    // Cohere models
    'embed-english-v3.0': 1024,
    'embed-multilingual-v3.0': 1024,
    'embed-english-light-v3.0': 384,

    // Voyage models
    'voyage-3': 1024,
    'voyage-3-lite': 512,
    'voyage-code-3': 1024,

    // Default fallback
    'default': 1536
};

/**
 * Get embedding dimensions for a model
 */
export function getEmbeddingDimensions(model: string): number {
    return EMBEDDING_DIMENSIONS[model] || EMBEDDING_DIMENSIONS['default'];
}
