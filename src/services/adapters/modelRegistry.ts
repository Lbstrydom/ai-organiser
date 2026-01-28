/**
 * LLM Model Registry
 *
 * Centralized registry for all LLM provider models.
 * Following the same pattern as embeddingRegistry.ts for consistency.
 *
 * This file should be the single source of truth for available models.
 * Update this file when providers release new models.
 */

import type { AdapterType } from './index';

// Model definition with display label
export interface ModelOption {
    id: string;
    label: string;
}

/**
 * Available models per provider
 * Format: { modelId: 'Display Label' }
 */
export const PROVIDER_MODELS: Partial<Record<AdapterType, Record<string, string>>> = {
    // Anthropic Claude models
    claude: {
        'claude-sonnet-4-5-20250929': 'Claude Sonnet 4.5 (Recommended)',
        'claude-haiku-4-5-20251001': 'Claude Haiku 4.5 (Fastest)',
        'claude-opus-4-5-20251101': 'Claude Opus 4.5 (Most Capable)'
    },

    // OpenAI models including o3 reasoning
    openai: {
        'gpt-5.2': 'GPT-5.2 (Best Reasoning)',
        'gpt-5.2-pro': 'GPT-5.2 Pro (Hardest Problems)',
        'gpt-5-mini': 'GPT-5 Mini (Balanced)',
        'o3-deep-research': 'o3 Deep Research (Extended Thinking)',
        'o3': 'o3 (Advanced Reasoning)',
        'o3-mini': 'o3 Mini (Fast Reasoning)',
        'gpt-4o': 'GPT-4o (Legacy)',
        'gpt-4o-mini': 'GPT-4o Mini (Legacy)'
    },

    // Google Gemini models
    gemini: {
        'gemini-3-pro': 'Gemini 3 Pro (Most Capable)',
        'gemini-3-flash': 'Gemini 3 Flash (Fast)',
        'gemini-2.5-pro': 'Gemini 2.5 Pro',
        'gemini-2.5-flash': 'Gemini 2.5 Flash (Recommended)',
        'gemini-2.5-flash-lite': 'Gemini 2.5 Flash Lite (Cheapest)',
        'gemini-2.0-flash': 'Gemini 2.0 Flash (Deprecated Mar 2026)',
        'gemini-2.0-flash-lite': 'Gemini 2.0 Flash Lite'
    },

    // Groq models (fast inference)
    groq: {
        'meta-llama/llama-4-scout-17b-16e-instruct': 'Llama 4 Scout (Recommended)',
        'meta-llama/llama-4-maverick-17b-128e-instruct': 'Llama 4 Maverick (400B MoE)',
        'llama-3.3-70b-versatile': 'Llama 3.3 70B Versatile',
        'llama-3.1-8b-instant': 'Llama 3.1 8B Instant (Fastest)',
        'llama-3-groq-70b-tool-use': 'Llama 3 70B Tool Use',
        'mixtral-8x7b-32768': 'Mixtral 8x7B (32K Context)',
        'deepseek-r1-distill-llama-70b': 'DeepSeek R1 Distill 70B'
    },

    // xAI Grok models
    grok: {
        'grok-4': 'Grok 4 (Recommended)',
        'grok-4-1-fast-reasoning': 'Grok 4.1 Fast Reasoning (2M context)',
        'grok-4-1-fast-non-reasoning': 'Grok 4.1 Fast Non-Reasoning (Instant)',
        'grok-3': 'Grok 3',
        'grok-2-vision-1212': 'Grok 2 Vision (Multimodal)'
    },

    // DeepSeek models
    deepseek: {
        'deepseek-v3.2': 'DeepSeek V3.2 (Recommended)',
        'deepseek-r1-0528': 'DeepSeek R1 (Reasoning)',
        'deepseek-ocr-maas': 'DeepSeek OCR (Document Processing)'
    },

    // Mistral AI models
    mistral: {
        'mistral-large-3': 'Mistral Large 3 (Recommended)',
        'mistral-medium-3.1': 'Mistral Medium 3.1',
        'devstral-2': 'Devstral 2 (Coding)',
        'ministral-8b-latest': 'Ministral 8B (Fastest)',
        'pixtral-large-latest': 'Pixtral Large (Vision)'
    },

    // Cohere models
    cohere: {
        'command-r7-plus-04-2025': 'Command R7+ (Recommended)',
        'command-r7-04-2025': 'Command R7'
    },

    // OpenRouter (aggregator - popular models)
    openrouter: {
        'anthropic/claude-sonnet-4.5': 'Claude Sonnet 4.5 (Anthropic)',
        'anthropic/claude-haiku-4.5': 'Claude Haiku 4.5 (Fast)',
        'anthropic/claude-opus-4.5': 'Claude Opus 4.5 (Best)',
        'openai/gpt-5.2': 'GPT-5.2 (OpenAI)',
        'openai/gpt-5-mini': 'GPT-5 Mini (OpenAI)',
        'openai/gpt-5-nano': 'GPT-5 Nano (Cheapest)',
        'google/gemini-3-pro': 'Gemini 3 Pro (Google)',
        'google/gemini-3-flash': 'Gemini 3 Flash (Google)',
        'google/gemini-2.5-flash': 'Gemini 2.5 Flash (Google)',
        'deepseek/deepseek-chat': 'DeepSeek Chat (Best Value)',
        'deepseek/deepseek-r1': 'DeepSeek R1 (Reasoning)',
        'meta-llama/llama-3.3-70b-instruct': 'Llama 3.3 70B (Meta)',
        'qwen/qwen-2.5-72b-instruct': 'Qwen 2.5 72B (Alibaba)'
    }
};

/**
 * Get model options for a specific provider
 * Returns empty object if provider not found
 */
export function getProviderModels(provider: AdapterType): Record<string, string> {
    return PROVIDER_MODELS[provider] || {};
}

/**
 * Check if a provider has a predefined model list
 */
export function hasModelList(provider: AdapterType): boolean {
    return provider in PROVIDER_MODELS && Object.keys(PROVIDER_MODELS[provider] || {}).length > 0;
}

/**
 * Get the first (recommended) model for a provider
 */
export function getFirstModel(provider: AdapterType): string | undefined {
    const models = PROVIDER_MODELS[provider];
    if (!models) return undefined;
    return Object.keys(models)[0];
}

/**
 * Validate if a model ID is valid for a provider
 */
export function isValidModel(provider: AdapterType, modelId: string): boolean {
    const models = PROVIDER_MODELS[provider];
    if (!models) return true; // Unknown provider - allow any model
    return modelId in models;
}
