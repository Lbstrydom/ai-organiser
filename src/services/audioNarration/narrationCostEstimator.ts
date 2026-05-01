/**
 * Pre-flight cost / duration estimator.
 * Reads pricing from NARRATION_PROVIDERS — no duplicated price tables.
 */

import { getProvider, type NarrationProviderId } from '../tts/ttsProviderRegistry';
import { splitForTts } from '../tts/ttsChunker';
import type { CostEstimate } from './narrationTypes';

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
