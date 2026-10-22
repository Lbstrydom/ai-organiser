import { claudeMinCacheableTokens } from './modelCapabilities';
import { joinPromptParts } from '../prompts/promptParts';

/** Conservative chars-per-token estimate for the cache-size gate. */
export const CHARS_PER_TOKEN_ESTIMATE = 4;

/**
 * Package a system prompt + optional cacheable stable prefix for the Claude
 * Messages API. Returns the value for `system` and the user-message text.
 *
 *  1. No `stablePrefix` → identity (string system, prompt as-is).
 *  2. Prefix shorter than the model's documented cache minimum, or a model
 *     whose minimum is not documented (`claudeMinCacheableTokens` →
 *     `undefined`) → prefix is concatenated onto the user content and no
 *     `cache_control` is emitted. Anthropic ignores a marker below the minimum
 *     at no charge, but moving the instructions into a system block for an
 *     unknown model would change the prompt for no gain, so this fails closed.
 *  3. Otherwise → the prefix becomes a second `system` block carrying
 *     `cache_control: { type: 'ephemeral' }`; the user message holds only the
 *     volatile prompt. A write costs 1.25× on the prefix, a read 0.1×, so this
 *     pays from the second call within the 5-minute TTL — callers mark only
 *     prefixes they expect to reuse.
 */
export function buildClaudeCachedPrompt(
    systemPrompt: string,
    prompt: string,
    modelName: string | undefined,
    stablePrefix: string | undefined,
): { systemField: string | Array<Record<string, unknown>>; userContent: string } {
    if (!stablePrefix) {
        return { systemField: systemPrompt, userContent: prompt };
    }

    const minTokens = claudeMinCacheableTokens(modelName);
    if (minTokens === undefined || stablePrefix.length < minTokens * CHARS_PER_TOKEN_ESTIMATE) {
        return {
            systemField: systemPrompt,
            userContent: joinPromptParts(stablePrefix, prompt),
        };
    }

    return {
        systemField: [
            { type: 'text', text: systemPrompt },
            {
                type: 'text',
                text: stablePrefix,
                cache_control: { type: 'ephemeral' },
            },
        ],
        userContent: prompt,
    };
}
