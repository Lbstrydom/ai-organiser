/**
 * A prompt split into its byte-stable head and its volatile tail.
 *
 * Anthropic prompt caching keys on an exact prefix, so a builder that wants its
 * instructions cached returns them as `stablePrefix` (nothing in it may vary
 * between calls — no timestamps, ids, counters, chunk indices or note content)
 * and the per-call content as `prompt`. `joinPromptParts` is the ONE rule for
 * recombining them; every path that cannot or should not cache (non-Claude
 * providers, prefixes below the model minimum, the local provider, streaming)
 * uses it, so the joined text is the same string a single-block prompt would
 * have been.
 */
export interface PromptParts {
    /** Instructions identical across the calls that should share a cache entry. */
    stablePrefix?: string;
    /** Everything that varies per call. */
    prompt: string;
}

/** `stablePrefix` + blank line + `prompt`, or `prompt` alone when there is no prefix. */
export function joinPromptParts(stablePrefix: string | undefined, prompt: string): string {
    return stablePrefix ? `${stablePrefix}\n\n${prompt}` : prompt;
}
