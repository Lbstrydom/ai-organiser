/**
 * Embedding Services
 * Core exports for embedding generation used by semantic search
 */

export {
    IEmbeddingService,
    EmbeddingResult,
    BatchEmbeddingResult,
    EmbeddingModelInfo,
    EmbeddingServiceConfig,
    EMBEDDING_DIMENSIONS,
    getEmbeddingDimensions
} from './types';
export { OpenAIEmbeddingService } from './openaiEmbeddingService';
export { OllamaEmbeddingService } from './ollamaEmbeddingService';
export { GeminiEmbeddingService } from './geminiEmbeddingService';
export { CohereEmbeddingService } from './cohereEmbeddingService';
export { VoyageEmbeddingService } from './voyageEmbeddingService';
export {
    createEmbeddingService,
    createEmbeddingServiceFromSettings,
    getDefaultEmbeddingModel,
    getAvailableEmbeddingModels,
    requiresApiKey,
    EmbeddingProvider
} from './embeddingServiceFactory';
