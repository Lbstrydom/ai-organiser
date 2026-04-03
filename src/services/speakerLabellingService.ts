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
            const sentences = seg.split(/(?<=[.!?])\s+/);
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
