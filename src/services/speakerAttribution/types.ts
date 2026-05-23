/**
 * Speaker attribution types (plan F5, R1 H3 + R2 G2 + G3).
 *
 * The attribution post-pass is deterministic code that runs AFTER the LLM
 * produces `MinutesJSON` and rewrites `action.owner` based on either real
 * provenance (source_timecodes → labelled segment → speaker → mapping) or
 * language-specific lexical rules (first-person "I'll do X" → speaker;
 * third-person "Bob will do X" → Bob).
 *
 * Per the audit (R1 H3): NEVER hardcode English regexes into the
 * orchestrator. The `SpeakerAttributionStrategy` interface is the seam —
 * each supported language gets its own strategy; everything else gets a
 * NoOp strategy that emits a single `unsupported-language` warning.
 */

import type { Action } from '../prompts/minutesPrompts';
import type { LabelledTimedTranscript } from '../transcriptTypes';
import type { SpeakerMapping } from '../../ui/components/speakerReviewState';

/**
 * Per-action diagnostic emitted by the attribution post-pass. Surfaced to
 * the user via the minutes warnings channel so they can spot
 * silently-corrected ownership.
 */
export type AttributionFlagKind =
    /** Action had no `source_timecodes` AND provenanceBackfill found no match. */
    | 'missing-provenance'
    /** LLM-produced owner is not in the participants list — rewritten to "TBC". */
    | 'non-participant-owner'
    /** Provenance found a speaker, but the lexical rule couldn't choose one
     *  side of an ambiguous third-person statement. Owner left as LLM produced it. */
    | 'ambiguous-attribution'
    /** No strategy is implemented for the transcript's language — owner left
     *  unchanged; emitted once per minutes run, not per action. */
    | 'unsupported-language';

export interface AttributionFlag {
    kind: AttributionFlagKind;
    /** Optional action ID — omitted for the once-per-run unsupported-language flag */
    actionId?: string;
    /** Free-text explanation surfaced via the warnings channel */
    detail?: string;
}

export interface AttributionInput {
    actions: Action[];
    labelledTranscript: LabelledTimedTranscript;
    speakerMapping: SpeakerMapping;
    participants: string[];
}

export interface AttributionResult {
    /** Actions array — same length as input, owners possibly rewritten */
    actions: Action[];
    /** Diagnostics to surface via the minutes warnings channel */
    flags: AttributionFlag[];
}

/**
 * One implementation per supported transcript language. v1 ships:
 *   - EnglishAttributionStrategy ('en', 'en-*')
 *   - NoOpAttributionStrategy (everything else)
 *
 * v2 candidates: 'zh-CN' (different pronoun resolution + name-tagging rules),
 * 'es' (gendered first-person), 'de' (V2 word order changes the regex anchor).
 * Each lands as a new strategy file + registry entry — never a branch inside
 * the orchestrator.
 */
export interface SpeakerAttributionStrategy {
    /** Strategy id — used for diagnostics, logs, registry dispatch */
    name: string;
    /** Apply the strategy's rules. Pure function — no side effects, no I/O. */
    apply(input: AttributionInput): AttributionResult;
}
