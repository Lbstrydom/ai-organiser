/**
 * Public entry point for the speaker attribution post-pass (plan F5).
 *
 * Sequence (R1 H4 + Gemini G3 ordering):
 *   1. For each action missing `source_timecodes`, run `attemptBackfill`
 *      against the labelled transcript. Backfill fills provenance OR drops
 *      confidence to 'low' + flags `missing-provenance`.
 *   2. Resolve the language strategy via `getStrategyForLanguage`.
 *   3. Call `strategy.apply` to rewrite owners per language rules + flag
 *      ambiguous / non-participant cases.
 *
 * Returns `Result<AttributionResult>` so the caller (`minutesService`) can
 * surface errors via the warnings channel without losing the actions
 * array (we always return AT LEAST the LLM's original output — graceful
 * degradation per R1 H4 layer-2 contract).
 *
 * Re-exports the type surface so external callers import a single path.
 */

import type { Action } from '../prompts/minutesPrompts';
import type { Result } from '../../core/result';
import { attemptBackfill } from './provenanceBackfill';
import { getStrategyForLanguage } from './registry';
import type {
    AttributionInput,
    AttributionResult,
    AttributionFlag,
} from './types';

export type {
    SpeakerAttributionStrategy,
    AttributionInput,
    AttributionResult,
    AttributionFlag,
    AttributionFlagKind,
} from './types';
export { attemptBackfill } from './provenanceBackfill';
export { getStrategyForLanguage } from './registry';
export { EnglishAttributionStrategy } from './englishStrategy';
export { NoOpAttributionStrategy } from './noOpStrategy';

/**
 * Run the deterministic attribution post-pass. Pure function — no I/O, no
 * mutation of inputs.
 *
 * Errors returned (never thrown):
 *   - `'invalid-input'` — `actions` missing entirely (caller bug)
 */
export function applyDeterministicAttribution(
    input: AttributionInput,
    languageCode: string
): Result<AttributionResult> {
    if (!Array.isArray(input.actions)) {
        return { ok: false, error: 'invalid-input' };
    }

    const backfilled: Action[] = [];
    const flags: AttributionFlag[] = [];

    // Phase 1: provenance backfill.
    for (const action of input.actions) {
        const result = attemptBackfill(action, input.labelledTranscript);
        backfilled.push(result.action);
        if (!result.matched) {
            flags.push({
                kind: 'missing-provenance',
                actionId: action.id,
                detail: `No transcript segment matched action text; confidence dropped to low`,
            });
        }
    }

    // Phase 2: language-strategy dispatch.
    const strategy = getStrategyForLanguage(languageCode);
    const strategyResult = strategy.apply({
        actions: backfilled,
        labelledTranscript: input.labelledTranscript,
        speakerMapping: input.speakerMapping,
        participants: input.participants,
    });

    return {
        ok: true,
        value: {
            actions: strategyResult.actions,
            flags: [...flags, ...strategyResult.flags],
        },
    };
}
