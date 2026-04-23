/**
 * Content Size Policy — single source of truth for chunking/truncation
 * decisions across the plugin.
 *
 * Replaces scattered `isContentTooLarge` checks + inline char comparisons
 * in `summarizeCommands`, `DocumentHandlingController`, multi-source truncation.
 *
 * Thresholds here are QUALITY limits — the point at which one-shot LLM
 * output quality degrades — not provider HARD limits (those still belong in
 * `tokenLimits.ts` and are used for actual API safety).
 *
 * See docs/plans/large-content-ingestion.md for rationale.
 */

import { getMaxContentChars, getMaxContentCharsForModel } from './tokenLimits';

/** Auto-chunk at 40K chars (≈ 10-page dense Latin article) for summarization.
 *  Below this, one-shot summaries are comparable to chunked quality. Above,
 *  measurable degradation — the model loses middle-of-content detail. */
export const QUALITY_CHUNK_THRESHOLD_SUMMARIZATION = 40_000;

/** Minutes gets a higher threshold — transcripts are looser content and
 *  the minutes pipeline already has structured extraction per chunk. */
export const QUALITY_CHUNK_THRESHOLD_MINUTES = 48_000;

/** Attached documents (Minutes context docs, multi-source docs). */
export const QUALITY_CHUNK_THRESHOLD_DOCUMENT = 40_000;

/** Hierarchical reduction fires above this chunk count. 4 chunks can be
 *  combined in a single reduce call; more than 4 benefits from an
 *  intermediate merge layer. Matches existing `HIERARCHICAL_THRESHOLD` in
 *  minutesService (kept in sync). */
export const HIERARCHICAL_CHUNK_THRESHOLD = 4;

/** Hierarchical threshold (in chars) for each content type — the point
 *  above which the flat map-reduce must use intermediate merge passes. */
export const QUALITY_HIERARCHICAL_THRESHOLD_SUMMARIZATION = 120_000;
export const QUALITY_HIERARCHICAL_THRESHOLD_MINUTES = 192_000;

/** When content exceeds this, we warn the user before kicking off the
 *  pipeline — cost/time concern warrants a heads-up. Not a blocking check. */
export const CHUNKING_WARNING_THRESHOLD = 500_000;

/** Tokens reserved for system + prompt + output per LLM call. Used to
 *  decide whether the fast model's context window can accommodate a given
 *  chunk size plus prompt overhead. */
export const PROMPT_BUDGET_TOKENS = 2_000;

export type ContentType = 'summarization' | 'minutes' | 'document' | 'translation';
export type ChunkStrategy = 'direct' | 'chunk' | 'hierarchical';

export interface ContentAssessment {
    strategy: ChunkStrategy;
    estimatedChunks: number;
    qualityChunkChars: number;
    /** Set only when a fast model is available + its context window can
     *  accommodate qualityChunkChars + PROMPT_BUDGET_TOKENS. Callers pass
     *  this as SummarizeOptions.modelOverride on map-phase calls. */
    mapModelOverride?: string;
    /** Set when content.length > CHUNKING_WARNING_THRESHOLD — caller should
     *  surface a pre-flight Notice about cost/time. */
    warningMessage?: string;
}

/**
 * Resolve the effective quality chunk threshold (in chars) for a content
 * type. Priority: user override (future setting) → content-type default.
 */
export function getQualityChunkThreshold(
    contentType: ContentType,
    settings: { qualityChunkThresholdChars?: number } = {},
): number {
    if (typeof settings.qualityChunkThresholdChars === 'number'
        && settings.qualityChunkThresholdChars >= 10_000
        && settings.qualityChunkThresholdChars <= 200_000) {
        return settings.qualityChunkThresholdChars;
    }
    switch (contentType) {
        case 'minutes': return QUALITY_CHUNK_THRESHOLD_MINUTES;
        case 'document': return QUALITY_CHUNK_THRESHOLD_DOCUMENT;
        case 'summarization':
        case 'translation':
        default:
            return QUALITY_CHUNK_THRESHOLD_SUMMARIZATION;
    }
}

/** Hierarchical reduce threshold (in chars) for a content type. */
export function getHierarchicalThreshold(contentType: ContentType): number {
    return contentType === 'minutes'
        ? QUALITY_HIERARCHICAL_THRESHOLD_MINUTES
        : QUALITY_HIERARCHICAL_THRESHOLD_SUMMARIZATION;
}

/**
 * Estimate characters per token for a given model + optional content sample.
 * Keyed by model family (Claude/GPT/LLaMA) — tokenization differences are
 * model-family-specific, not provider-specific. CJK ≈ 2, code ≈ 3,
 * Latin ≈ 4 (default).
 */
export function estimateCharsPerToken(modelId: string, sampleText?: string): number {
    if (sampleText && sampleText.length > 200) {
        const sample = sampleText.slice(0, 2000);
        const cjkCount = (sample.match(/[一-鿿぀-ゟ゠-ヿ가-힯]/g) || []).length;
        if (cjkCount / sample.length > 0.2) return 2;
        // Code-heavy heuristic: many braces + semicolons relative to length
        const codeCount = (sample.match(/[{};()[\]<>]/g) || []).length;
        if (codeCount / sample.length > 0.05) return 3;
    }
    // Default Latin approximation — consistent with getMaxContentChars()
    void modelId; // reserved for future family-specific overrides
    return 4;
}

/**
 * Core assessment — decides direct / chunk / hierarchical strategy + whether
 * a fast model can cover the map phase.
 *
 * @param text       content to be processed
 * @param contentType which thresholds apply
 * @param provider    main LLM provider (for fallback)
 * @param settings    plugin settings subset (fast-model preference, overrides)
 */
export function assessContent(
    text: string,
    contentType: ContentType,
    provider: string,
    settings: {
        useHaikuForFastTasks?: boolean;
        cloudServiceType?: string;
        qualityChunkThresholdChars?: number;
    } = {},
): ContentAssessment {
    const charsPerToken = estimateCharsPerToken(provider, text);
    const qualityChunkChars = getQualityChunkThreshold(contentType, settings);
    const hierarchicalChars = getHierarchicalThreshold(contentType);

    let strategy: ChunkStrategy = 'direct';
    let estimatedChunks = 1;
    if (text.length > hierarchicalChars) {
        strategy = 'hierarchical';
        estimatedChunks = Math.ceil(text.length / qualityChunkChars);
    } else if (text.length > qualityChunkChars) {
        strategy = 'chunk';
        estimatedChunks = Math.ceil(text.length / qualityChunkChars);
    }

    const mapModelOverride = resolveFastModel(provider, settings, qualityChunkChars, charsPerToken);

    const warningMessage = text.length > CHUNKING_WARNING_THRESHOLD
        ? `Large content (${(text.length / 1000).toFixed(0)}K chars, ~${estimatedChunks} sections) — this may take several minutes and incur higher API cost.`
        : undefined;

    return {
        strategy,
        estimatedChunks,
        qualityChunkChars,
        mapModelOverride,
        warningMessage,
    };
}

/**
 * Returns a fast-model ID suitable for the map phase, or undefined if no
 * fast model is safely usable.
 *
 * Currently only Claude has a cheap/fast variant (Haiku) with significant
 * cost/latency improvement vs the main Sonnet. Non-Claude providers use
 * their configured model for both map and reduce (no-op).
 *
 * Capability check: the fast model's context window must be >= chunk size
 * + prompt overhead. If not (e.g. a future 64K-window fast model), falls
 * back to undefined (orchestrator uses main model for map — no failure).
 */
function resolveFastModel(
    provider: string,
    settings: { useHaikuForFastTasks?: boolean; cloudServiceType?: string },
    chunkChars: number,
    charsPerToken: number,
): string | undefined {
    if (!settings.useHaikuForFastTasks) return undefined;
    if ((settings.cloudServiceType ?? provider) !== 'claude') return undefined;

    // Haiku latest sentinel — resolved at adapter-build time via modelRegistry.
    // We don't hardcode the concrete version here.
    const fastModel = 'latest-haiku';

    // Capability check: claude haiku's 200K window should handle our chunk
    // size easily but guard against future model changes.
    const fastContextTokens = getMaxContentCharsForModel(provider, fastModel) / charsPerToken;
    const requiredTokens = (chunkChars / charsPerToken) + PROMPT_BUDGET_TOKENS;
    if (fastContextTokens < requiredTokens) return undefined;

    return fastModel;
}

/**
 * True when content definitely exceeds the provider's hard limit and
 * MUST be chunked (vs quality-threshold chunking which is a preference).
 * This is the original semantics of `isContentTooLarge()` — kept as a
 * thin re-export for call sites that explicitly need the hard-limit check.
 */
export function exceedsProviderHardLimit(content: string, provider: string): boolean {
    return content.length > getMaxContentChars(provider);
}
