/**
 * No-op attribution strategy (plan F5, R1 H3).
 *
 * Returned by the registry for any language we haven't implemented a real
 * strategy for. Crucially this is NOT silent — the strategy emits a single
 * `unsupported-language` flag so the user sees a warning in the minutes
 * output ("Speaker-based ownership rewriting unavailable for language X —
 * action owners reflect LLM inference only").
 *
 * Why explicit instead of "just skip the post-pass": the audit-plan R1 H3
 * called this out specifically — silently behaving differently for
 * non-English transcripts creates bugs that are difficult to detect and
 * expensive to unwind. The single warning makes the behaviour visible.
 */

import type {
    SpeakerAttributionStrategy,
    AttributionInput,
    AttributionResult,
} from './types';

export class NoOpAttributionStrategy implements SpeakerAttributionStrategy {
    readonly name: string;

    constructor(private readonly languageCode: string) {
        this.name = `noop-${languageCode}`;
    }

    apply(input: AttributionInput): AttributionResult {
        // Pass actions through unchanged; emit a once-per-run warning so the
        // absence of attribution is visible in the minutes warnings channel.
        return {
            actions: input.actions,
            flags: [
                {
                    kind: 'unsupported-language',
                    detail: `Deterministic speaker attribution not available for language "${this.languageCode}" — action owners reflect LLM inference only`,
                },
            ],
        };
    }
}
