/**
 * Pre-flight cost / duration estimator.
 * Reads pricing from NARRATION_PROVIDERS — no duplicated price tables.
 */

import { getProvider, type NarrationProviderId } from '../tts/ttsProviderRegistry';
import { splitForTts } from '../tts/ttsChunker';
import type { CostEstimate } from './narrationTypes';
import type { LlmEnhancementProvider } from './llmEnhancerProvider';

/** Approximate USD → EUR. Refresh when the exchange rate drifts noticeably. */
const USD_TO_EUR = 0.92;
const SPEAKING_RATE_CHARS_PER_SECOND = 14;

export function estimateNarrationCost(
    spokenText: string,
    providerId: NarrationProviderId,
    voice: string,
): CostEstimate {
    const provider = getProvider(providerId);
    const charCount = spokenText.length;
    const chunkCount = splitForTts(spokenText).length;
    const estDurationSec = Math.ceil(charCount / SPEAKING_RATE_CHARS_PER_SECOND);
    const estUsd = (charCount / 1_000_000) * provider.costPerMillionCharsUsd;
    const estEur = estUsd * USD_TO_EUR;
    return {
        charCount,
        chunkCount,
        estDurationSec,
        estUsd,
        estEur,
        providerId,
        voice,
    };
}

/**
 * Deterministic LLM-enhancement cost estimate — char-based heuristic so the
 * cost-confirmation modal can show a number without making any LLM call.
 *
 * Heuristic:
 *   tokens_in  ≈ chars / 4 (typical ratio for English markdown)
 *   tokens_out ≈ chars / 4 * 1.2 (20% headroom for the decisions JSON + small expansion)
 *
 * Spike measurements across 5 real notes lined up with this ±5%; the
 * modal's "Final TTS cost may vary ±15%" disclaimer covers the rest.
 */
export function estimateLlmEnhancementCostUsd(
    noteCharCount: number,
    provider: LlmEnhancementProvider,
): number {
    const inTokens = Math.ceil(noteCharCount / 4);
    const outTokens = Math.ceil((noteCharCount / 4) * 1.2);
    return (inTokens * provider.costPerMTokensInput + outTokens * provider.costPerMTokensOutput) / 1_000_000;
}
