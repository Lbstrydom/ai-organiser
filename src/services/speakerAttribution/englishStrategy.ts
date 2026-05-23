/**
 * English-language attribution strategy (plan F5, R1 H3).
 *
 * Three rules, applied in priority order:
 *   1. **Provenance + first-person** ("I'll do X" / "I will follow up"):
 *      look up the source segment's speaker via the mapping → owner = mapped name.
 *      This is the most reliable rule because it combines acoustic-ish
 *      provenance (real Whisper segment) with explicit pronoun anchor.
 *   2. **Third-person** ("Bob will check the budget"):
 *      regex captures the proper noun, validates against the participants
 *      list, owner = captured name. No provenance required.
 *   3. **Non-participant LLM owner**:
 *      when neither rule fires AND the LLM's owner is not in the participants
 *      list, rewrite to "TBC" and emit `non-participant-owner` flag.
 *
 * The third-person regex deliberately uses `{1,30}` between the name and
 * verb so "Bob said he'll do X" matches "Bob" but the "he'll" subordinate
 * clause doesn't get re-attributed — Bob remains the owner. Confirmed in
 * tests/speakerAttribution/englishStrategy.test.ts.
 */

import type {
    SpeakerAttributionStrategy,
    AttributionInput,
    AttributionResult,
    AttributionFlag,
} from './types';
import type { Action } from '../prompts/minutesPrompts';
import type { LabelledTimedTranscript } from '../transcriptTypes';
import type { SpeakerMapping } from '../../ui/components/speakerReviewState';

const FIRST_PERSON_PATTERN = /^I(?:['']ll| will| can| should| need to| have to| am going to)\b/i;
// Captures a proper noun followed within 30 characters by a future-action
// marker: a bare verb (will / should / etc.) OR a contracted form ('ll / 'd).
// The contraction alternation handles "Bob said he'll do X" → Bob is captured.
const THIRD_PERSON_PATTERN = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b.{1,30}(?:\b(?:will|should|to|needs to|has to|is going to)\b|['']ll|['']d)/;

export class EnglishAttributionStrategy implements SpeakerAttributionStrategy {
    readonly name = 'english';

    apply(input: AttributionInput): AttributionResult {
        const flags: AttributionFlag[] = [];
        const out: Action[] = input.actions.map((action) =>
            this.applyToAction(action, input, flags)
        );
        return { actions: out, flags };
    }

    private applyToAction(
        action: Action,
        input: AttributionInput,
        flags: AttributionFlag[]
    ): Action {
        // Rule 1: provenance + first-person.
        if (action.source_timecodes && action.source_timecodes.length > 0) {
            if (FIRST_PERSON_PATTERN.test(action.text)) {
                const speaker = resolveSpeakerFromTimecodes(
                    action.source_timecodes,
                    input.labelledTranscript
                );
                if (speaker) {
                    const mappedName = input.speakerMapping[speaker];
                    if (mappedName) {
                        return { ...action, owner: mappedName };
                    }
                    // Speaker label not in the user's mapping — leave owner
                    // alone, but flag as ambiguous so the user can spot it.
                    flags.push({
                        kind: 'ambiguous-attribution',
                        actionId: action.id,
                        detail: `First-person action attributed to unmapped speaker label "${speaker}"`,
                    });
                }
            }
        }

        // Rule 2: third-person proper-noun rule.
        const thirdMatch = THIRD_PERSON_PATTERN.exec(action.text);
        if (thirdMatch) {
            const candidate = thirdMatch[1].trim();
            const participant = findParticipantCaseInsensitive(candidate, input.participants);
            if (participant) {
                return { ...action, owner: participant };
            }
        }

        // Rule 3: LLM-produced owner sanity check.
        const owner = action.owner?.trim() ?? '';
        if (owner && owner !== 'TBC') {
            const participant = findParticipantCaseInsensitive(owner, input.participants);
            if (!participant) {
                flags.push({
                    kind: 'non-participant-owner',
                    actionId: action.id,
                    detail: `LLM-assigned owner "${owner}" is not in the participants list; rewriting to TBC`,
                });
                return { ...action, owner: 'TBC' };
            }
            // Normalise casing to match the participant list spelling.
            if (participant !== owner) {
                return { ...action, owner: participant };
            }
        }

        return action;
    }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Find the segment referenced by the first source_timecodes entry, then
 * return its speaker label (or undefined if the segment is missing/unlabelled).
 */
function resolveSpeakerFromTimecodes(
    timecodes: string[],
    labelled: LabelledTimedTranscript
): string | undefined {
    const probe = timecodes[0];
    if (probe === undefined) return undefined;
    // Match by `id` first (canonical), then fall back to array-index parse.
    for (let i = 0; i < labelled.segments.length; i++) {
        const seg = labelled.segments[i];
        if (String(seg.id ?? i) === probe) {
            return seg.speaker;
        }
    }
    return undefined;
}

/** Case-insensitive participant lookup; returns the canonical spelling when matched. */
function findParticipantCaseInsensitive(
    candidate: string,
    participants: string[]
): string | undefined {
    const lower = candidate.toLowerCase();
    for (const p of participants) {
        if (p.toLowerCase() === lower) return p;
        // Match first-name only — "Sarah" should match "Sarah Lee" in the list.
        const firstName = p.split(/\s+/)[0]?.toLowerCase();
        if (firstName === lower) return p;
    }
    return undefined;
}

// Re-export for callers that want the singleton.
export const englishAttributionStrategy: SpeakerAttributionStrategy = new EnglishAttributionStrategy();
// Cross-imports used by the strategy for tighter typing in tests.
export type { Action, LabelledTimedTranscript, SpeakerMapping };
