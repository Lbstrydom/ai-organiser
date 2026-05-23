/**
 * Provenance backfill (plan F5, R1 H4 + Gemini G3).
 *
 * For actions the LLM emitted WITHOUT `source_timecodes`, search the
 * labelled transcript for a segment whose text best matches `action.text`.
 * When found, populate the action's timecodes so the downstream strategy
 * (English / NoOp) has provenance to anchor against. When not found, the
 * action is flagged `missing-provenance` and the strategy falls back to
 * lexical rules only.
 *
 * Strategy is graceful, not strict. Gemini G2 caught the bug in an earlier
 * draft where strict Zod validation made this path unreachable — so we
 * deliberately keep degraded actions (confidence=low + missing-provenance
 * flag) flowing through rather than throwing.
 *
 * Matching algorithm: normalised token-set intersection over a sliding
 * window of `WINDOW_SEGMENTS` consecutive segments. A match is accepted
 * when the Jaccard similarity exceeds `MIN_SIMILARITY`. The winner's
 * segment ids (or array indices) populate `source_timecodes`.
 */

import type { Action } from '../prompts/minutesPrompts';
import type { LabelledTimedTranscript, LabelledTimedSegment } from '../transcriptTypes';

/** Slide this many consecutive segments together — actions often span 1-3 segments. */
const WINDOW_SEGMENTS = 3;
/** Below this Jaccard similarity, we don't trust the match. */
const MIN_SIMILARITY = 0.35;

/**
 * Best-effort backfill of `source_timecodes` for actions that arrived without
 * provenance. Returns the same action (mutated copy) plus a flag indicating
 * whether the backfill succeeded.
 *
 * Caller is expected to:
 *   - Keep the returned action even when matched=false; downstream strategies
 *     still get a chance to apply lexical rules on the unattributed action.
 *   - Surface the `flag` to the warnings channel.
 */
export function attemptBackfill(
    action: Action,
    labelled: LabelledTimedTranscript
): { action: Action; matched: boolean } {
    // Already has at least one provenance reference — nothing to do.
    if (action.source_timecodes && action.source_timecodes.length > 0) {
        return { action, matched: true };
    }
    if (!labelled.segments.length) {
        return { action: copyWithLowConfidence(action), matched: false };
    }

    const actionTokens = tokenise(action.text);
    if (actionTokens.size === 0) {
        return { action: copyWithLowConfidence(action), matched: false };
    }

    let best: { score: number; ids: string[] } | null = null;

    for (let start = 0; start < labelled.segments.length; start++) {
        const window = labelled.segments.slice(start, start + WINDOW_SEGMENTS);
        const windowTokens = new Set<string>();
        for (const seg of window) {
            for (const tok of tokenise(seg.text)) windowTokens.add(tok);
        }
        const score = jaccardSimilarity(actionTokens, windowTokens);
        if (score < MIN_SIMILARITY) continue;
        if (best === null || score > best.score) {
            best = {
                score,
                ids: window.map((s, offset) => idFor(s, start + offset)),
            };
        }
    }

    if (best === null) {
        return { action: copyWithLowConfidence(action), matched: false };
    }

    return {
        action: {
            ...action,
            source_timecodes: best.ids,
        },
        matched: true,
    };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Resolve a segment's reference id — prefer `segment.id` (Whisper segment
 * number) over the array index so timecode strings survive transcript
 * rebuilds that preserve segment ids.
 */
function idFor(segment: LabelledTimedSegment, fallbackIndex: number): string {
    return String(segment.id ?? fallbackIndex);
}

/**
 * Lower-case, strip punctuation, split on whitespace. Words shorter than 3
 * characters are dropped — they're too common to drive a similarity score
 * (and dropping them speeds the comparison ~3x).
 */
function tokenise(text: string): Set<string> {
    const cleaned = text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!cleaned) return new Set();
    const out = new Set<string>();
    for (const word of cleaned.split(' ')) {
        if (word.length >= 3) out.add(word);
    }
    return out;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let intersection = 0;
    for (const item of a) if (b.has(item)) intersection++;
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
}

/**
 * Returned when backfill can't find a match. Lowers the action's confidence
 * to 'low' so downstream renderers (and minutes auditors) can surface the
 * uncertainty.
 */
function copyWithLowConfidence(action: Action): Action {
    return { ...action, confidence: 'low' };
}
