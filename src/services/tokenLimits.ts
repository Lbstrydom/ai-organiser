/**
 * Token Limits for LLM Providers
 */

export interface ProviderLimits {
    maxInputTokens: number;
    maxOutputTokens: number;
    charsPerToken: number;  // Approximate characters per token
}

export const PROVIDER_LIMITS: Record<string, ProviderLimits> = {
    'claude': { maxInputTokens: 200000, maxOutputTokens: 4096, charsPerToken: 4 },
    'openai': { maxInputTokens: 128000, maxOutputTokens: 4096, charsPerToken: 4 },
    'gemini': { maxInputTokens: 1000000, maxOutputTokens: 8192, charsPerToken: 4 },
    'groq': { maxInputTokens: 32000, maxOutputTokens: 4096, charsPerToken: 4 },
    'deepseek': { maxInputTokens: 64000, maxOutputTokens: 4096, charsPerToken: 4 },
    'openrouter': { maxInputTokens: 128000, maxOutputTokens: 4096, charsPerToken: 4 },
    'local': { maxInputTokens: 8000, maxOutputTokens: 2048, charsPerToken: 4 },  // Conservative default
};

// Reserve tokens for prompt template + output
const PROMPT_OVERHEAD_TOKENS = 500;
const OUTPUT_RESERVE_TOKENS = 2000;

/**
 * Get the maximum content characters allowed for a provider
 */
export function getMaxContentChars(provider: string): number {
    const limits = PROVIDER_LIMITS[provider.toLowerCase()] || PROVIDER_LIMITS['local'];
    const availableTokens = limits.maxInputTokens - PROMPT_OVERHEAD_TOKENS - OUTPUT_RESERVE_TOKENS;
    return availableTokens * limits.charsPerToken;
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
 * Truncate content to fit within provider limits
 */
export function truncateContent(content: string, provider: string): string {
    const maxChars = getMaxContentChars(provider);
    if (content.length <= maxChars) {
        return content;
    }

    // Try to break at a paragraph boundary
    const truncated = content.substring(0, maxChars);
    const lastParagraph = truncated.lastIndexOf('\n\n');
    if (lastParagraph > maxChars * 0.8) {
        return truncated.substring(0, lastParagraph) + '\n\n[Content truncated...]';
    }

    // Fall back to sentence boundary
    const lastSentence = truncated.lastIndexOf('. ');
    if (lastSentence > maxChars * 0.8) {
        return truncated.substring(0, lastSentence + 1) + '\n\n[Content truncated...]';
    }

    // Hard truncate
    return truncated + '\n\n[Content truncated...]';
}
