/**
 * Token Limits for LLM Providers
 */

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
 * Model-specific input token overrides.
 * Keyed by model-name prefix — first matching prefix wins.
 * Only needed where a provider has models with different context windows.
 */
const MODEL_INPUT_TOKEN_OVERRIDES: Record<string, Record<string, number>> = {
    claude: {
        'claude-opus-4-6':   1_000_000,
        'claude-sonnet-4-6': 1_000_000,
        // All other Claude models fall through to PROVIDER_LIMITS (200K)
    },
};

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
    let inputTokens = baseLimits.maxInputTokens;

    if (model) {
        const overrides = MODEL_INPUT_TOKEN_OVERRIDES[provider.toLowerCase()];
        if (overrides) {
            for (const [prefix, tokens] of Object.entries(overrides)) {
                if (model.startsWith(prefix)) {
                    inputTokens = tokens;
                    break;
                }
            }
        }
    }

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
