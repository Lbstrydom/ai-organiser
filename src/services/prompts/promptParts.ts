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

/**
 * Fill a template's own content slot. The slot is always the LAST occurrence of the
 * sentinel: every variable field (persona, user focus, language, context, chunk
 * position) is rendered before it, and only fixed template text follows. Replacing the
 * first occurrence instead lets a persona or focus string that contains the sentinel
 * steal the insertion. Inserted literally (no `$` expansion); a template without the
 * sentinel is returned unchanged.
 */
export function fillTrailingSlot(template: string, sentinel: string, text: string): string {
    const at = template.lastIndexOf(sentinel);
    if (at === -1) return template;
    return template.slice(0, at) + text + template.slice(at + sentinel.length);
}
