/**
 * Transcript Pre-processor Service
 *
 * Orchestrates all transcript pre-processing steps before the text is sent to the
 * minutes LLM pipeline. Centralises normalisation, corruption stripping, and
 * completeness validation so callers (minutesService, modal) get a single
 * clean-and-warn result.
 */

import { stripCorruptTail, validateTranscriptCompleteness, TranscriptCompletenessResult } from './transcriptQualityService';

export interface PreprocessorResult {
    cleanTranscript: string;
    warnings: string[];
    stats: {
        originalChars: number;
        cleanChars: number;
        corruptCharsRemoved: number;
        coveragePercent: number | null;     // null when meeting duration unknown
    };
}

export interface PreprocessorOptions {
    meetingDurationMinutes?: number;
}

/**
 * Preprocess a raw transcript:
 *   1. Normalise whitespace (collapse runs of 3+ whitespace → double-newline, collapse multi-spaces → single)
 *   2. Strip corrupt repetition tail (from Phase 1 transcriptQualityService)
 *   3. Count words
 *   4. If meeting duration provided, validate transcript completeness
 *   5. Collect warnings and stats
 */
export function preprocessTranscript(
    rawTranscript: string,
    options?: PreprocessorOptions
): PreprocessorResult {
    const warnings: string[] = [];
    const originalChars = rawTranscript.length;

    // Step 1: Normalise whitespace
    let text = rawTranscript;
    text = text.replace(/\s{3,}/g, '\n\n');   // 3+ whitespace chars → paragraph break
    text = text.replace(/  +/g, ' ');           // multiple spaces → single space
    text = text.trim();

    // Step 2: Strip corrupt tail
    const corruption = stripCorruptTail(text);
    if (corruption.warning) {
        warnings.push(corruption.warning);
    }
    text = corruption.cleanText;

    // Step 3: Count words
    const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;

    // Step 4: Completeness check
    let coveragePercent: number | null = null;
    if (options?.meetingDurationMinutes && options.meetingDurationMinutes > 0) {
        const completeness: TranscriptCompletenessResult = validateTranscriptCompleteness(
            wordCount,
            options.meetingDurationMinutes
        );
        coveragePercent = completeness.coveragePercent;
        if (completeness.severity !== 'ok') {
            warnings.push(completeness.message);
        }
    }

    return {
        cleanTranscript: text,
        warnings,
        stats: {
            originalChars,
            cleanChars: text.length,
            corruptCharsRemoved: corruption.charsRemoved,
            coveragePercent,
        },
    };
}
