/**
 * Speaker Labelling Service (Phase 4a — TRA Plan)
 *
 * LLM pre-pass that labels unlabelled transcript lines with speaker names
 * inferred from context, participant list, and conversational cues.
 *
 * Runs before chunking in the minutes pipeline. For long transcripts,
 * processes in ~5000-char segments to stay within token limits.
 */

import type AIOrganiserPlugin from '../main';
import { summarizeText, pluginContext } from './llmFacade';
import { withBusyIndicator } from '../utils/busyIndicator';
import type { SummarizeOptions } from './types';
import { buildSpeakerLabellingPrompt } from './prompts/minutesPrompts';
import {
    type TimedTranscript,
    type TimedSegment,
    type LabelledTimedTranscript,
    toLabelledTimedTranscript,
} from './transcriptTypes';
import type { TranscriptionResult } from './audioTranscriptionService';

export interface SpeakerLabellingResult {
    labelledTranscript: string;
    speakersFound: string[];
    unknownSpeakerCount: number;
}

/** Max chars per segment for the labelling LLM call */
const LABELLING_SEGMENT_CHARS = 5000;

/** LLM options: low token budget (transcript in ≈ transcript out), thinking disabled */
const LABELLING_OPTIONS: SummarizeOptions = {
    maxTokens: 4096,
    disableThinking: true,
    timeoutMs: 120_000,
};

/**
 * Detect whether a transcript already has speaker labels.
 *
 * A transcript is considered "labelled" if ≥30% of non-empty lines
 * match common speaker-label patterns like:
 *   - "Speaker Name: text"
 *   - "[Speaker Name]: text"
 *   - "SPEAKER NAME: text"
 */
export function hasExistingSpeakerLabels(transcript: string): boolean {
    const lines = transcript.split('\n').filter(l => l.trim().length > 0);
    if (lines.length === 0) return false;

    const labelPattern = /^(?:\[.+?\]|[A-Z][A-Za-z .'-]+(?:\s*\([^)]*\))?)\s*:\s*.+/;
    let labelledCount = 0;
    for (const line of lines) {
        if (labelPattern.test(line.trim())) {
            labelledCount++;
        }
    }

    return (labelledCount / lines.length) >= 0.3;
}

/**
 * Label speakers in a transcript using an LLM pre-pass.
 *
 * For short transcripts (≤ LABELLING_SEGMENT_CHARS), runs in a single call.
 * For longer transcripts, splits into segments and processes sequentially,
 * passing a context window from the previous segment's output for continuity.
 */
export async function labelSpeakers(
    plugin: AIOrganiserPlugin,
    transcript: string,
    participants: string[],
    meetingContext?: string
): Promise<SpeakerLabellingResult> {
    // Skip if transcript already has labels
    if (hasExistingSpeakerLabels(transcript)) {
        return {
            labelledTranscript: transcript,
            speakersFound: extractSpeakerNames(transcript),
            unknownSpeakerCount: 0,
        };
    }

    // Short transcript — single LLM call
    if (transcript.length <= LABELLING_SEGMENT_CHARS) {
        return labelSegment(plugin, transcript, participants, meetingContext);
    }

    // Long transcript — segment and process sequentially
    const segments = splitIntoSegments(transcript, LABELLING_SEGMENT_CHARS);
    const labelledParts: string[] = [];
    const allSpeakers = new Set<string>();
    let totalUnknown = 0;

    for (let i = 0; i < segments.length; i++) {
        // Build context from tail of previous labelled output
        const prevContext = labelledParts.length > 0
            ? labelledParts[labelledParts.length - 1].slice(-500)
            : undefined;

        const result = await labelSegment(
            plugin,
            segments[i],
            participants,
            meetingContext,
            prevContext
        );

        labelledParts.push(result.labelledTranscript);
        for (const speaker of result.speakersFound) allSpeakers.add(speaker);
        totalUnknown += result.unknownSpeakerCount;
    }

    return {
        labelledTranscript: labelledParts.join('\n'),
        speakersFound: Array.from(allSpeakers),
        unknownSpeakerCount: totalUnknown,
    };
}

/**
 * Label speakers in a single transcript segment.
 */
async function labelSegment(
    plugin: AIOrganiserPlugin,
    segment: string,
    participants: string[],
    meetingContext?: string,
    previousContext?: string
): Promise<SpeakerLabellingResult> {
    // Early return for empty segments — no point in LLM call
    if (!segment?.trim()) {
        return { labelledTranscript: segment || '', speakersFound: [], unknownSpeakerCount: 0 };
    }

    const prompt = buildSpeakerLabellingPrompt(participants, meetingContext, previousContext, segment);

    try {
        const response = await withBusyIndicator(plugin, () =>
            summarizeText(pluginContext(plugin), prompt, LABELLING_OPTIONS)
        );

        if (!response.success || !response.content) {
            // Fail open — return original transcript
            return {
                labelledTranscript: segment,
                speakersFound: [],
                unknownSpeakerCount: 0,
            };
        }

        const labelled = response.content.trim();
        const speakers = extractSpeakerNames(labelled);
        const unknownCount = (labelled.match(/\bUnknown Speaker\b/gi) || []).length;

        return {
            labelledTranscript: labelled,
            speakersFound: speakers,
            unknownSpeakerCount: unknownCount,
        };
    } catch {
        // Fail open — return original on any error
        return {
            labelledTranscript: segment,
            speakersFound: [],
            unknownSpeakerCount: 0,
        };
    }
}

/**
 * Split transcript into segments at paragraph boundaries, each ≤ maxChars.
 */
export function splitIntoSegments(text: string, maxChars: number): string[] {
    if (text.length <= maxChars) return [text];

    const segments: string[] = [];
    const paragraphs = text.split(/\n\s*\n/);
    let current = '';

    for (const para of paragraphs) {
        if (current.length + para.length + 2 > maxChars && current.length > 0) {
            segments.push(current.trim());
            current = '';
        }
        current += (current ? '\n\n' : '') + para;
    }
    if (current.trim()) {
        segments.push(current.trim());
    }

    // Handle case where a single paragraph exceeds maxChars — split at sentence boundaries
    const result: string[] = [];
    for (const seg of segments) {
        if (seg.length <= maxChars) {
            result.push(seg);
        } else {
            // Force-split at sentence boundaries
            const sentences = seg.split(/([.!?])\s+/).reduce<string[]>((acc, part, i, arr) => {
                if (i % 2 === 0) acc.push(part + (arr[i + 1] ?? ''));
                return acc;
            }, []);
            let chunk = '';
            for (const sentence of sentences) {
                if (chunk.length + sentence.length + 1 > maxChars && chunk.length > 0) {
                    result.push(chunk.trim());
                    chunk = '';
                }
                chunk += (chunk ? ' ' : '') + sentence;
            }
            if (chunk.trim()) result.push(chunk.trim());
        }
    }

    return result;
}

/**
 * Extract unique speaker names from a labelled transcript.
 * Matches patterns like "Speaker Name:" and "[Speaker Name]:" at the start of lines.
 */
export function extractSpeakerNames(transcript: string): string[] {
    const names = new Set<string>();
    const lines = transcript.split('\n');
    // Match both "Name:" and "[Name]:" formats (consistent with hasExistingSpeakerLabels)
    const bareNamePattern = /^([A-Z][A-Za-z .'-]+(?:\s*\([^)]*\))?)\s*:/;
    const bracketPattern = /^\[(.+?)\]\s*:/;

    for (const line of lines) {
        const trimmed = line.trim();
        const bareMatch = trimmed.match(bareNamePattern);
        const bracketMatch = trimmed.match(bracketPattern);
        const name = bareMatch?.[1]?.trim() || bracketMatch?.[1]?.trim();
        if (name && name.length > 1 && name.length < 60) {
            names.add(name);
        }
    }

    return Array.from(names);
}

// ============================================================================
// F2a — TimedTranscript-aware labelling (plan §1.5 R1 H2, R2 G2)
// ============================================================================

/**
 * Adapter: convert a `TranscriptionResult` (from `audioTranscriptionService`)
 * into the canonical `TimedTranscript` contract. Surfaces real Whisper
 * `verbose_json` timestamps when present, otherwise falls back to
 * `timestampSource: 'none'` (downstream consumers suppress audio preview).
 *
 * `languageCode` defaults to `'und'` when the caller has no better signal —
 * the speakerLabelling pre-pass still runs (it's language-agnostic at the
 * LLM layer), but downstream `getStrategyForLanguage` (F5) routes to the
 * NoOp attribution strategy.
 */
export function transcriptionResultToTimedTranscript(
    result: TranscriptionResult,
    fallbackLanguageCode: string = 'und'
): TimedTranscript {
    const segments: TimedSegment[] = (result.segments ?? []).map((s) => ({
        startMs: Math.round(s.start * 1000),
        endMs: Math.round(s.end * 1000),
        text: s.text,
        id: s.id,
    }));
    const text = result.transcript ?? segments.map((s) => s.text).join(' ');
    return {
        text,
        segments,
        timestampSource: segments.length > 0 ? 'whisper-verbose-json' : 'none',
        durationMs: result.duration !== undefined ? Math.round(result.duration * 1000) : undefined,
        languageCode: fallbackLanguageCode,
    };
}

/**
 * Label speakers across a `TimedTranscript` and return a `LabelledTimedTranscript`
 * with real Whisper timestamps preserved. This is the labelling entry point
 * the F2 SpeakerReviewPanel + minutes attribution post-pass consume.
 *
 * Pipeline:
 *  1. Run the existing string-based `labelSpeakers()` on `timed.text` (the
 *     joined transcript) — LLM emits `Name: utterance` lines.
 *  2. Tokenise the labelled text into a word→speaker stream so we can map
 *     positions back to segments without depending on the LLM preserving
 *     character indices exactly.
 *  3. For each segment, take the modal speaker across the words at that
 *     segment's position in the stream. Segment ordering is preserved by
 *     Whisper (segments are time-ordered) and by the LLM (we instruct it
 *     not to reorder utterances) — so a positional walk is robust.
 *
 * Degraded paths:
 *  - `timed.timestampSource === 'none'`: labelling still runs; per-segment
 *    speaker assignment still happens; consumers (SpeakerReviewPanel) check
 *    the source flag and suppress audio preview without affecting labelling.
 *  - Existing speaker labels in `timed.text` (e.g. transcript pre-labelled
 *    via Whisper diarization in v2): `labelSpeakers()` detects and short-
 *    circuits the LLM call; the same positional walk still produces a clean
 *    `LabelledTimedTranscript`.
 *  - LLM call fails: `labelSpeakers()` returns the raw transcript unchanged;
 *    we end up with zero speaker assignments → `LabelledTimedTranscript`
 *    with empty `speakers[]`. Caller decides whether to surface a banner.
 */
export async function labelSpeakersTimed(
    plugin: AIOrganiserPlugin,
    timed: TimedTranscript,
    participants: string[],
    meetingContext?: string
): Promise<LabelledTimedTranscript> {
    const labellingResult = await labelSpeakers(plugin, timed.text, participants, meetingContext);
    const perSegmentSpeakers = mapLabelledTextToSegments(timed, labellingResult.labelledTranscript);
    return toLabelledTimedTranscript(timed, perSegmentSpeakers);
}

/**
 * Map a "Name: utterance" labelled transcript back onto `TimedTranscript`
 * segments. Returns a `Map<segmentKey, speakerName>` where `segmentKey` is
 * `segment.id` when present and the array index otherwise (matching the
 * fallback `toLabelledTimedTranscript` uses).
 *
 * Strategy: word-stream positional walk. We:
 *  1. Parse the labelled text into `{name, words[]}` chunks.
 *  2. Build a flat array where each word maps to its labelled speaker.
 *  3. Walk segments in order, taking the modal speaker across the words
 *     consumed by each segment.
 *
 * Exported for testing.
 */
export function mapLabelledTextToSegments(
    timed: TimedTranscript,
    labelledText: string
): Map<number, string> {
    const out = new Map<number, string>();
    const labelPattern = /^([^\n:]{2,40}):\s*(.+)$/;

    interface LabelChunk { name: string; wordCount: number }
    const chunks: LabelChunk[] = [];
    for (const line of labelledText.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const m = labelPattern.exec(trimmed);
        if (!m) continue;
        const name = m[1].trim();
        // Reject obvious non-name prefixes that occasionally slip past the
        // regex (e.g. "Note", "Action", "TODO").
        if (!/^[A-Za-zÀ-ſ一-鿿]/.test(name)) continue;
        const text = m[2].trim();
        if (!text) continue;
        const wordCount = text.split(/\s+/).length;
        chunks.push({ name, wordCount });
    }

    if (chunks.length === 0) return out;

    // Flatten into a stream of speaker names per word.
    const stream: string[] = [];
    for (const c of chunks) {
        for (let i = 0; i < c.wordCount; i++) stream.push(c.name);
    }
    if (stream.length === 0) return out;

    // Walk segments; pick the modal speaker over the words this segment consumes.
    let cursor = 0;
    for (let i = 0; i < timed.segments.length; i++) {
        const seg = timed.segments[i];
        const segWords = seg.text.trim();
        const segWordCount = segWords ? segWords.split(/\s+/).length : 0;
        if (segWordCount === 0) {
            cursor += 0;
            continue;
        }
        // Clamp the slice — labelled stream may be shorter or longer than
        // the timed stream because the LLM can reformat slightly.
        const start = Math.min(cursor, stream.length);
        const end = Math.min(cursor + segWordCount, stream.length);
        const slice = stream.slice(start, end);
        if (slice.length > 0) {
            const counts = new Map<string, number>();
            for (const name of slice) counts.set(name, (counts.get(name) ?? 0) + 1);
            const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
            const dominant = sorted[0][0];
            out.set(seg.id ?? i, dominant);
        }
        cursor += segWordCount;
    }

    return out;
}
