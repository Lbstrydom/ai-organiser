/**
 * Secret Storage Identifiers
 *
 * Centralized secret IDs for SecretStorage API integration.
 * Supports cross-plugin key sharing with standard identifiers.
 */

import type { AdapterType } from '../services/adapters';

/**
 * Standard cross-plugin secret identifiers
 * These IDs are shared across multiple Obsidian AI plugins for key reuse
 */
export const STANDARD_SECRET_IDS = {
    OPENAI: 'openai-api-key',
    ANTHROPIC: 'anthropic-api-key',
    GOOGLE_AI: 'google-ai-api-key',
    GROQ: 'groq-api-key',
    COHERE: 'cohere-api-key',
    VOYAGE: 'voyage-api-key',
    DEEPSEEK: 'deepseek-api-key',
    MISTRAL: 'mistral-api-key',
    OPENROUTER: 'openrouter-api-key',
    GROK: 'grok-api-key',
    OPENAI_COMPATIBLE: 'openai-compatible-api-key',
    GITHUB: 'github-api-key',
    PERPLEXITY: 'perplexity-api-key',
    FIREWORKS: 'fireworks-api-key',
} as const;

/**
 * Plugin-specific secret identifiers
 * These are unique to AI Organiser for specialized features
 */
export const PLUGIN_SECRET_IDS = {
    EMBEDDING: 'ai-organiser-embedding-key',
    YOUTUBE: 'ai-organiser-youtube-key',
    PDF: 'ai-organiser-pdf-key',
    AUDIO: 'ai-organiser-audio-key',
} as const;

/**
 * Provider-to-SecretID mapping (single source of truth)
 * Maps each LLM adapter to its corresponding standard secret ID
 */
export const PROVIDER_TO_SECRET_ID: Partial<Record<AdapterType, string>> = {
    openai: STANDARD_SECRET_IDS.OPENAI,
    claude: STANDARD_SECRET_IDS.ANTHROPIC,
    gemini: STANDARD_SECRET_IDS.GOOGLE_AI,
    groq: STANDARD_SECRET_IDS.GROQ,
    cohere: STANDARD_SECRET_IDS.COHERE,
    deepseek: STANDARD_SECRET_IDS.DEEPSEEK,
    mistral: STANDARD_SECRET_IDS.MISTRAL,
    openrouter: STANDARD_SECRET_IDS.OPENROUTER,
    grok: STANDARD_SECRET_IDS.GROK,
    'openai-compatible': STANDARD_SECRET_IDS.OPENAI_COMPATIBLE,
    // Note: Not all adapter types have standard secret IDs
    // aliyun, vertex, bedrock, requesty don't have cross-plugin IDs yet
};

/**
 * Embedding provider type (subset of providers that offer embeddings)
 */
export type EmbeddingProviderType = 'openai' | 'gemini' | 'ollama' | 'openrouter' | 'cohere' | 'voyage';

/**
 * Embedding provider to SecretID mapping
 * Maps embedding providers to their standard secret IDs
 * Note: Voyage is embedding-only (not an LLM adapter) so needs separate mapping
 */
export const EMBEDDING_PROVIDER_TO_SECRET_ID: Partial<Record<EmbeddingProviderType, string>> = {
    openai: STANDARD_SECRET_IDS.OPENAI,
    gemini: STANDARD_SECRET_IDS.GOOGLE_AI,
    openrouter: STANDARD_SECRET_IDS.OPENROUTER,
    cohere: STANDARD_SECRET_IDS.COHERE,
    voyage: STANDARD_SECRET_IDS.VOYAGE,
    // ollama doesn't need API key
};

/**
 * Key resolution options for inheritance chain
 */
export interface KeyResolutionOptions {
    /** Primary plugin-specific secret ID to check first */
    primaryId?: string;

    /** Provider to check as fallback */
    providerFallback?: AdapterType;

    /** Whether to fall back to main cloud provider key */
    useMainKeyFallback?: boolean;

    /** Plain-text settings to use as last resort (backward compat) */
    plainTextFallback?: {
        primaryKey?: string;
        providerKey?: string;
        mainCloudKey?: string;
    };
}

/**
 * Migration result from plain-text to SecretStorage
 */
export interface MigrationResult {
    /** Whether migration was successful */
    migrated: boolean;

    /** Reason if migration failed or was declined */
    reason?: string;

    /** List of migrated entries */
    entries?: MigrationEntry[];
}

/**
 * Single migration entry
 */
export interface MigrationEntry {
    /** Settings field that was migrated */
    field: string;

    /** Secret ID where the key was stored */
    secretId: string;

    /** Whether this entry was successful */
    success: boolean;
}
