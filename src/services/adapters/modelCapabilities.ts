/**
 * Model Capability Classifier
 *
 * Single source of truth for "what can this model do?" — pattern-matches on
 * model-family + version rather than hardcoded IDs, so new releases in
 * known families (e.g. `claude-opus-4-8`, `claude-opus-5`) pick up the
 * right capabilities automatically without code edits.
 *
 * Adding a new family: extend the parser + the corresponding helper.
 * Promoting a minimum version (e.g. new capability lands in 5.x but not
 * 4.x): bump the threshold inline.
 */

// ── Claude ──────────────────────────────────────────────────────────────────

export interface ClaudeModelParts {
    tier: 'opus' | 'sonnet' | 'haiku';
    major: number;
    minor: number;
}

/**
 * Parse Anthropic's `claude-{tier}-{major}-{minor}[-{date-suffix}]` pattern.
 * Returns null for non-Claude or malformed IDs. Examples parsed:
 *   - claude-opus-4-7            → { opus, 4, 7 }
 *   - claude-opus-4-6            → { opus, 4, 6 }
 *   - claude-sonnet-4-5-20250929 → { sonnet, 4, 5 }
 *   - claude-haiku-4-5-20251001  → { haiku, 4, 5 }
 */
export function parseClaudeModel(id: string | undefined | null): ClaudeModelParts | null {
    if (!id) return null;
    const m = /^claude-(opus|sonnet|haiku)-(\d+)-(\d+)/.exec(id);
    if (!m) return null;
    return {
        tier: m[1] as 'opus' | 'sonnet' | 'haiku',
        major: Number(m[2]),
        minor: Number(m[3]),
    };
}

/** True if v is equal to OR newer than (major.minor). */
function versionAtLeast(v: { major: number; minor: number }, major: number, minor: number): boolean {
    if (v.major !== major) return v.major > major;
    return v.minor >= minor;
}

/**
 * Does this Claude model support the `thinking: { type: 'adaptive' }` request
 * parameter? Introduced in Opus 4.6 / Sonnet 4.6; future 4.x / 5.x / 6.x
 * Opus + Sonnet inherit automatically. Haiku does not.
 */
export function claudeSupportsAdaptiveThinking(modelId: string | undefined | null): boolean {
    const p = parseClaudeModel(modelId);
    if (!p) return false;
    if (p.tier === 'opus' || p.tier === 'sonnet') return versionAtLeast(p, 4, 6);
    return false; // haiku: no adaptive thinking
}

/**
 * Does this Claude model ship with a 1M input context window? Opus/Sonnet 4.6+
 * have it; older Claude models cap at ~200K per Anthropic defaults.
 *
 * Happens to track the same capability gate as adaptive thinking today —
 * if Anthropic releases a new feature that ships in Opus/Sonnet 4.6+ but
 * NOT the older 4.x line, this helper will match. If a future release
 * decouples these (e.g. 2M context in 5.0 only), split into its own
 * body at that time.
 */
export function claudeHas1MContext(modelId: string | undefined | null): boolean {
    return claudeSupportsAdaptiveThinking(modelId);
}

/**
 * Does the Claude Web Search tool's dynamic-filter variant
 * (`web_search_20260209`) work against this model? Same gate as
 * adaptive thinking — both are 4.5+/4.6+ features.
 */
export function claudeSupportsDynamicWebSearch(modelId: string | undefined | null): boolean {
    return claudeSupportsAdaptiveThinking(modelId);
}

// ── OpenAI ──────────────────────────────────────────────────────────────────

export interface OpenAIModelParts {
    /** 'gpt' for chat completion models; 'o' for reasoning models (o1, o3 …) */
    family: 'gpt' | 'o';
    major: number;
    minor: number;
    variant?: string;  // e.g. 'mini', 'pro', 'nano', 'deep-research'
}

/**
 * Parse OpenAI model IDs covering both GPT and o-series:
 *   - gpt-5.2            → { gpt, 5, 2 }
 *   - gpt-5.2-pro        → { gpt, 5, 2, pro }
 *   - gpt-5-mini         → { gpt, 5, 0, mini }
 *   - gpt-4o             → { gpt, 4, 0, o }
 *   - gpt-4o-mini        → { gpt, 4, 0, o-mini }
 *   - o3                 → { o, 3, 0 }
 *   - o3-deep-research   → { o, 3, 0, deep-research }
 *   - o1-mini            → { o, 1, 0, mini }
 */
export function parseOpenAIModel(id: string | undefined | null): OpenAIModelParts | null {
    if (!id) return null;
    // GPT pattern: gpt-{major}[.{minor}][-{variant}]
    let m = /^gpt-(\d+)(?:\.(\d+))?(?:-(.+))?$/.exec(id);
    if (m) {
        return {
            family: 'gpt',
            major: Number(m[1]),
            minor: m[2] ? Number(m[2]) : 0,
            variant: m[3],
        };
    }
    // o-series pattern: o{major}[-{variant}]
    m = /^o(\d+)(?:-(.+))?$/.exec(id);
    if (m) {
        return {
            family: 'o',
            major: Number(m[1]),
            minor: 0,
            variant: m[2],
        };
    }
    return null;
}

/** o-series models use a dedicated reasoning endpoint. */
export function openaiIsReasoningModel(modelId: string | undefined | null): boolean {
    const p = parseOpenAIModel(modelId);
    return p?.family === 'o';
}

// ── Gemini ──────────────────────────────────────────────────────────────────

export interface GeminiModelParts {
    major: number;
    minor: number;
    tier: 'pro' | 'flash' | 'ultra' | 'nano' | 'unknown';
    isPreview: boolean;
    isTts: boolean;
    /** True for `-flash-lite`, `-pro-lite`, etc. — weaker than the base
     *  tier, so `latest-flash` should prefer non-lite when both exist. */
    isLite: boolean;
}

/**
 * Parse Gemini model IDs. Google's naming has drifted over versions —
 * we canonicalize here:
 *   - gemini-3.1-pro-preview               → { 3, 1, pro, preview }
 *   - gemini-3-flash-preview               → { 3, 0, flash, preview }
 *   - gemini-3.1-flash-lite-preview        → { 3, 1, flash, preview, lite }
 *   - gemini-2.5-flash-preview-tts         → { 2, 5, flash, preview, tts }
 *   - gemini-3.1-flash-tts-preview         → { 3, 1, flash, preview, tts }
 *   - gemini-2.5-flash                     → { 2, 5, flash, ga }
 *   - gemini-2.5-flash-lite                → { 2, 5, flash, ga, lite }
 *
 * Google's own `-latest` aliases (`gemini-flash-latest`, `gemini-pro-latest`)
 * don't have a digit after `gemini-`, so they return null here — they're
 * handled as a short-circuit in `resolveLatestModel`.
 */
export function parseGeminiModel(id: string | undefined | null): GeminiModelParts | null {
    if (!id) return null;
    const m = /^gemini-(\d+)(?:\.(\d+))?(?:-(pro|flash|ultra|nano))?/.exec(id);
    if (!m) return null;
    const rest = id.slice(m[0].length);
    return {
        major: Number(m[1]),
        minor: m[2] ? Number(m[2]) : 0,
        tier: (m[3] ?? 'unknown') as GeminiModelParts['tier'],
        isPreview: /preview/.test(id),
        isTts: /tts/.test(rest) || /tts/.test(id),
        isLite: /\blite\b/.test(rest),
    };
}

/** Gemini 2.5+ supports extended thinking / reasoning (varies by tier). */
export function geminiSupportsThinking(modelId: string | undefined | null): boolean {
    const p = parseGeminiModel(modelId);
    if (!p) return false;
    // 2.5+ Pro/Flash have thinking. Older versions + nano/unknown tiers: no.
    if (p.tier !== 'pro' && p.tier !== 'flash') return false;
    return p.major > 2 || (p.major === 2 && p.minor >= 5);
}

// ── "Latest-tier" resolver ──────────────────────────────────────────────────
//
// Rather than hardcoding specific model IDs in settings ("claude-opus-4-7"),
// users can pick a symbolic tier ("latest-opus") and the resolver picks the
// newest model of that tier from the available list at runtime. When the
// provider ships a new release and the registry gets updated, users on
// "latest-*" automatically follow — no re-selection needed.
//
// The available-ids list is typically the hardcoded PROVIDER_MODELS entry
// for the provider, but can also be a live-fetched list from the provider's
// /models endpoint (see dynamicModelService when we add it).

export type ClaudeTier = 'opus' | 'sonnet' | 'haiku';
export type GeminiTier = 'pro' | 'flash' | 'ultra' | 'nano';
export type OpenAITier = 'gpt' | 'gpt-mini' | 'gpt-nano' | 'o';

/** Pick the newest Claude model of the given tier from a pool of IDs. */
export function pickNewestClaude(availableIds: string[], tier: ClaudeTier): string | null {
    const ranked = availableIds
        .map(id => ({ id, parts: parseClaudeModel(id) }))
        .filter((x): x is { id: string; parts: ClaudeModelParts } =>
            x.parts !== null && x.parts.tier === tier)
        .sort((a, b) => {
            if (a.parts.major !== b.parts.major) return b.parts.major - a.parts.major;
            return b.parts.minor - a.parts.minor;
        });
    return ranked[0]?.id ?? null;
}

/** Pick the newest Gemini model of the given tier from a pool of IDs.
 *  Excludes TTS + lite variants (lite is weaker than the base tier — users
 *  asking for `latest-flash` shouldn't silently get flash-lite just because
 *  it has a higher version number). */
export function pickNewestGemini(availableIds: string[], tier: GeminiTier): string | null {
    const ranked = availableIds
        .map(id => ({ id, parts: parseGeminiModel(id) }))
        .filter((x): x is { id: string; parts: GeminiModelParts } =>
            x.parts !== null && x.parts.tier === tier && !x.parts.isTts && !x.parts.isLite)
        .sort((a, b) => {
            if (a.parts.major !== b.parts.major) return b.parts.major - a.parts.major;
            if (a.parts.minor !== b.parts.minor) return b.parts.minor - a.parts.minor;
            // Prefer GA over preview at the same version
            if (a.parts.isPreview !== b.parts.isPreview) return a.parts.isPreview ? 1 : -1;
            return 0;
        });
    return ranked[0]?.id ?? null;
}

/** Pick the newest OpenAI model of the given tier from a pool of IDs. */
export function pickNewestOpenAI(availableIds: string[], tier: OpenAITier): string | null {
    const ranked = availableIds
        .map(id => ({ id, parts: parseOpenAIModel(id) }))
        .filter((x): x is { id: string; parts: OpenAIModelParts } => {
            if (!x.parts) return false;
            // Map requested tier to (family, variant-predicate)
            switch (tier) {
                case 'o': return x.parts.family === 'o' && !x.parts.variant;
                case 'gpt': return x.parts.family === 'gpt' && !x.parts.variant;
                case 'gpt-mini': return x.parts.family === 'gpt' && x.parts.variant === 'mini';
                case 'gpt-nano': return x.parts.family === 'gpt' && x.parts.variant === 'nano';
            }
        })
        .sort((a, b) => {
            if (a.parts.major !== b.parts.major) return b.parts.major - a.parts.major;
            return b.parts.minor - a.parts.minor;
        });
    return ranked[0]?.id ?? null;
}

/**
 * Resolve a symbolic `latest-*` model ID to the concrete newest model in
 * its tier from `availableIds`. Non-symbolic IDs pass through unchanged.
 * Returns `null` if a `latest-*` sentinel can't be resolved (caller should
 * fall back to a provider default).
 *
 * Examples:
 *   resolveLatestModel('claude', 'latest-opus', ['claude-opus-4-7', 'claude-opus-4-6'])
 *     → 'claude-opus-4-7'
 *   resolveLatestModel('claude', 'claude-opus-4-6', [...])
 *     → 'claude-opus-4-6' (passthrough)
 */
export function resolveLatestModel(
    provider: string,
    modelId: string | undefined | null,
    availableIds: string[],
): string | null {
    if (!modelId) return null;
    if (!modelId.startsWith('latest-')) return modelId;
    const tier = modelId.slice('latest-'.length);
    switch (provider.toLowerCase()) {
        case 'claude':
            if (tier === 'opus' || tier === 'sonnet' || tier === 'haiku') {
                return pickNewestClaude(availableIds, tier);
            }
            return null;
        case 'gemini':
            if (tier === 'pro' || tier === 'flash' || tier === 'ultra' || tier === 'nano') {
                // Prefer Google's official `gemini-{tier}-latest` alias
                // when it appears in the pool — Google hot-swaps these with
                // 2-week notice as new releases land, which is strictly
                // better than our major/minor heuristic that guesses from
                // a static registry. Fall back to picking by parsed version
                // only when Google's alias isn't present (e.g. user's live
                // catalog didn't surface it).
                const googleAlias = `gemini-${tier}-latest`;
                if (availableIds.includes(googleAlias)) return googleAlias;
                return pickNewestGemini(availableIds, tier);
            }
            return null;
        case 'openai':
            if (tier === 'gpt' || tier === 'gpt-mini' || tier === 'gpt-nano' || tier === 'o') {
                return pickNewestOpenAI(availableIds, tier);
            }
            return null;
        default:
            return null;
    }
}

/**
 * Specialist-path helper: resolve a (possibly `latest-*`) model id to a
 * concrete one at call time. Mirrors the logic in CloudLLMService
 * constructor for specialists that construct their own HTTP requests
 * (YouTube video analysis, PDF multimodal, direct Gemini calls outside
 * the adapter). Returns the input unchanged when it's already concrete or
 * the sentinel can't be resolved (e.g. empty live cache + no matching
 * registry entry).
 *
 * Import from this module rather than duplicating the pool-selection
 * logic — keeps the "pick latest" contract unified across all Gemini /
 * Claude / OpenAI specialist surfaces.
 */
export function resolveSpecialistModel(
    provider: string,
    modelId: string,
    pools: { liveIds: string[] | null; staticIds: string[] },
): string {
    if (!modelId.startsWith('latest-')) return modelId;
    const available = pools.liveIds && pools.liveIds.length > 0
        ? pools.liveIds
        : pools.staticIds;
    return resolveLatestModel(provider, modelId, available) ?? modelId;
}
