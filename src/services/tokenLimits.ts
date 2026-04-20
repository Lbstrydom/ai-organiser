/**
 * Token Limits for LLM Providers
 */

import { claudeHas1MContext } from './adapters/modelCapabilities';

export interface ProviderLimits {
    maxInputTokens: number;
    maxOutputTokens: number;
    charsPerToken: number;  // Approximate characters per token
}

export const PROVIDER_LIMITS: Record<string, ProviderLimits> = {
    'claude': { maxInputTokens: 200000, maxOutputTokens: 64000, charsPerToken: 4 },
    'openai': { maxInputTokens: 128000, maxOutputTokens: 16384, charsPerToken: 4 },
    'gemini': { maxInputTokens: 1000000, maxOutputTokens: 8192, charsPerToken: 4 },
    'groq': { maxInputTokens: 32000, maxOutputTokens: 8192, charsPerToken: 4 },
    'deepseek': { maxInputTokens: 64000, maxOutputTokens: 8192, charsPerToken: 4 },
    'openrouter': { maxInputTokens: 128000, maxOutputTokens: 16384, charsPerToken: 4 },
    'local': { maxInputTokens: 8000, maxOutputTokens: 4096, charsPerToken: 4 },  // Conservative default
};

// Reserve tokens for prompt template + output
const PROMPT_OVERHEAD_TOKENS = 500;
const OUTPUT_RESERVE_TOKENS = 2000;

/**
 * Model-specific input token resolver. Capability-gated by family+version
 * pattern rather than hardcoded IDs — so future Claude releases (Opus 4.8,
 * 5.0, Sonnet 4.7, …) pick up the 1M window automatically without edits.
 * Add new providers here as they evolve context-window tiers per model.
 */
function getModelInputTokens(provider: string, model: string | undefined): number | null {
    if (!model) return null;
    if (provider.toLowerCase() === 'claude' && claudeHas1MContext(model)) {
        return 1_000_000;
    }
    // Add other providers here as they ship larger context models:
    //   - OpenAI: gpt-5.2 family has 400K; gate via parseOpenAIModel if needed
    //   - Gemini: 2.5+ has 1M; already reflected in PROVIDER_LIMITS default
    return null;
}

/**
 * Get the maximum content characters allowed for a provider
 */
export function getMaxContentChars(provider: string): number {
    const limits = PROVIDER_LIMITS[provider.toLowerCase()] || PROVIDER_LIMITS['local'];
    const availableTokens = limits.maxInputTokens - PROMPT_OVERHEAD_TOKENS - OUTPUT_RESERVE_TOKENS;
    return availableTokens * limits.charsPerToken;
}

/**
 * Get the maximum content characters for a provider+model pair.
 * Falls back to provider-only limits when model is unknown or unmatched.
 */
export function getMaxContentCharsForModel(provider: string, model?: string): number {
    const baseLimits = PROVIDER_LIMITS[provider.toLowerCase()] || PROVIDER_LIMITS['local'];
    const modelOverride = getModelInputTokens(provider, model);
    const inputTokens = modelOverride ?? baseLimits.maxInputTokens;
    const available = inputTokens - PROMPT_OVERHEAD_TOKENS - OUTPUT_RESERVE_TOKENS;
    return available * baseLimits.charsPerToken;
}

/**
 * Get max chars per chunk for translation tasks.
 * Translation output ≈ input length, so chunks must fit within output token budget.
 * Uses 80% of output budget to leave room for language expansion.
 * Capped at 32K chars (~8K tokens) to keep individual translation requests manageable.
 */
export function getTranslationChunkChars(provider: string): number {
    const MAX_TRANSLATION_CHUNK_CHARS = 32_000;
    const limits = PROVIDER_LIMITS[provider.toLowerCase()] || PROVIDER_LIMITS['local'];
    return Math.min(Math.floor(limits.maxOutputTokens * limits.charsPerToken * 0.8), MAX_TRANSLATION_CHUNK_CHARS);
}

/**
 * Estimate token count for text
 */
export function estimateTokens(text: string, provider: string): number {
    const limits = PROVIDER_LIMITS[provider.toLowerCase()] || PROVIDER_LIMITS['local'];
    return Math.ceil(text.length / limits.charsPerToken);
}

/**
 * Check if content exceeds the limit for a provider
 */
export function isContentTooLarge(content: string, provider: string): boolean {
    const maxChars = getMaxContentChars(provider);
    return content.length > maxChars;
}

/**
 * Get provider limits, with fallback to local defaults
 */
export function getProviderLimits(provider: string): ProviderLimits {
    return PROVIDER_LIMITS[provider.toLowerCase()] || PROVIDER_LIMITS['local'];
}

/**
 * Find best break point before maxPos, searching backward from maxPos.
 * Priority: paragraph (\n\n) → sentence (. ! ?) → word (space) → hard cut.
 * @param text The full text to search within
 * @param maxPos The maximum position (exclusive) to consider
 * @param threshold The minimum position a boundary must be at to be accepted
 * @returns The best break position, or maxPos if no boundary found above threshold
 */
export function findBoundaryPosition(text: string, maxPos: number, threshold: number): number {
    const region = text.substring(0, maxPos);

    // Try paragraph boundary
    const lastParagraph = region.lastIndexOf('\n\n');
    if (lastParagraph >= threshold) {
        return lastParagraph;
    }

    // Try sentence boundary
    const lastSentence = Math.max(
        region.lastIndexOf('. '),
        region.lastIndexOf('.\n'),
        region.lastIndexOf('? '),
        region.lastIndexOf('! ')
    );
    if (lastSentence >= threshold) {
        return lastSentence + 1; // include the punctuation
    }

    // Try word boundary
    const lastSpace = region.lastIndexOf(' ');
    if (lastSpace >= threshold) {
        return lastSpace;
    }

    // Hard fallback (pathological: no spaces above threshold)
    return maxPos;
}

/**
 * Truncate text at the best available boundary (paragraph → sentence → word → hard).
 * Accounts for suffix length in the budget so the result never exceeds maxChars.
 */
export function truncateAtBoundary(
    text: string,
    maxChars: number,
    suffix: string = '\n\n[Content truncated...]'
): string {
    if (text.length <= maxChars) return text;

    const effectiveMax = maxChars - suffix.length;
    if (effectiveMax <= 0) return suffix.substring(0, maxChars);

    const threshold = effectiveMax * 0.8;
    const breakPos = findBoundaryPosition(text, effectiveMax, threshold);

    return text.substring(0, breakPos) + suffix;
}

/**
 * Truncate content to fit within provider limits
 */
export function truncateContent(content: string, provider: string): string {
    const maxChars = getMaxContentChars(provider);
    return truncateAtBoundary(content, maxChars);
}
