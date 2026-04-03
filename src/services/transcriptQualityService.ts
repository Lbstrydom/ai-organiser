/**
 * Transcript Quality Service
 * Pure functions for detecting transcript corruption, validating quality,
 * and stitching overlapping transcripts.
 *
 * Phase 1 of the TRA (Transcription Reliability & Accuracy) plan.
 */

// ============================================================================
// CONSTANTS
// ============================================================================

/** Window size in chars for sliding corruption detection */
export const REPETITION_WINDOW_CHARS = 500;

/** Step size for sliding window (half the window) */
export const REPETITION_WINDOW_STEP = 250;

/** % of tokens in a window that must be single-char ASCII to flag as corrupt */
export const REPETITION_THRESHOLD_PERCENT = 80;

/** % of single-char ASCII tokens that must be the same character to flag */
export const REPETITION_SAME_CHAR_PERCENT = 50;

/** Minimum expected words per minute for non-silent audio */
export const MIN_WORDS_PER_MINUTE = 40;

/** Coverage below this % → severity 'block' */
export const COVERAGE_BLOCK_THRESHOLD = 50;

/** Coverage below this % → severity 'warn' */
export const COVERAGE_WARN_THRESHOLD = 75;

/** Expected words per minute in typical meeting speech */
export const EXPECTED_WORDS_PER_MINUTE = 120;

/** Minimum word count for a non-empty chunk */
export const MIN_CHUNK_WORDS = 5;

// ============================================================================
// TYPES
// ============================================================================

export interface RepetitionDetectionResult {
    /** Whether corruption was detected */
    isCorrupt: boolean;
    /** Character index where corruption starts (-1 if clean) */
    corruptionStartIndex: number;
    /** The detected repeated token/pattern (empty string if clean) */
    corruptPattern: string;
    /** Transcript with corrupt tail removed */
    cleanTranscript: string;
}

export interface ChunkQualityReport {
    /** 0-based chunk index */
    chunkIndex: number;
    /** Word count in the chunk */
    wordCount: number;
    /** Words per minute (null if no duration provided) */
    wordsPerMinute: number | null;
    /** Whether a repetition loop was detected */
    hasRepetitionLoop: boolean;
}

export interface TranscriptCompletenessResult {
    /** Estimated coverage as a percentage */
    coveragePercent: number;
    /** Severity classification */
    severity: 'ok' | 'warn' | 'block';
    /** Human-readable message */
    message: string;
}

// ============================================================================
// REPETITION DETECTION (SCRIPT-AWARE)
// ============================================================================

/** Check if a character is in the ASCII range (0x00-0x7F) */
function isAsciiChar(char: string): boolean {
    return char.length === 1 && char.charCodeAt(0) <= 0x7F;
}

/**
 * Detect repetition loops in transcript text.
 * Uses a sliding window approach with CJK-aware guards to avoid false positives
 * on Chinese, Japanese, and Korean text where single-character tokens are normal.
 *
 * Algorithm:
 * - Slide a 500-char window across the text, stepping by 250 chars
 * - In each window, tokenize by whitespace
 * - Count tokens that are single-char AND ASCII
 * - If >80% of tokens are single-char ASCII AND >50% are the same character → corrupt
 * - CJK single-char tokens are excluded from the count
 */
export function detectRepetitionLoop(text: string): RepetitionDetectionResult {
    const clean: RepetitionDetectionResult = {
        isCorrupt: false,
        corruptionStartIndex: -1,
        corruptPattern: '',
        cleanTranscript: text,
    };

    if (!text || text.length < REPETITION_WINDOW_CHARS) {
        // For short texts, check the entire text as one window
        if (text && text.length > 0) {
            const result = analyzeWindow(text);
            if (result.isCorrupt) {
                return {
                    isCorrupt: true,
                    corruptionStartIndex: 0,
                    corruptPattern: result.dominantChar,
                    cleanTranscript: '',
                };
            }
        }
        return clean;
    }

    // Slide window across text
    for (let offset = 0; offset <= text.length - REPETITION_WINDOW_CHARS; offset += REPETITION_WINDOW_STEP) {
        const window = text.substring(offset, offset + REPETITION_WINDOW_CHARS);
        const result = analyzeWindow(window);

        if (result.isCorrupt) {
            return {
                isCorrupt: true,
                corruptionStartIndex: offset,
                corruptPattern: result.dominantChar,
                cleanTranscript: text.substring(0, offset).trimEnd(),
            };
        }
    }

    return clean;
}

/**
 * Analyze a single text window for corruption patterns.
 * Returns whether the window is corrupt and the dominant character if so.
 */
function analyzeWindow(window: string): { isCorrupt: boolean; dominantChar: string } {
    const tokens = window.split(/\s+/).filter(t => t.length > 0);
    if (tokens.length === 0) {
        return { isCorrupt: false, dominantChar: '' };
    }

    // Count single-char ASCII tokens
    let singleCharAsciiCount = 0;
    const charFrequency: Record<string, number> = {};

    for (const token of tokens) {
        if (token.length === 1 && isAsciiChar(token)) {
            singleCharAsciiCount++;
            charFrequency[token] = (charFrequency[token] || 0) + 1;
        }
    }

    // Check threshold: >80% of tokens are single-char ASCII
    const singleCharPercent = (singleCharAsciiCount / tokens.length) * 100;
    if (singleCharPercent < REPETITION_THRESHOLD_PERCENT) {
        return { isCorrupt: false, dominantChar: '' };
    }

    // Check same-char threshold: >50% of single-char ASCII tokens are identical
    let maxFreq = 0;
    let dominantChar = '';
    for (const [char, freq] of Object.entries(charFrequency)) {
        if (freq > maxFreq) {
            maxFreq = freq;
            dominantChar = char;
        }
    }

    const sameCharPercent = singleCharAsciiCount > 0
        ? (maxFreq / singleCharAsciiCount) * 100
        : 0;

    if (sameCharPercent >= REPETITION_SAME_CHAR_PERCENT) {
        return { isCorrupt: true, dominantChar };
    }

    return { isCorrupt: false, dominantChar: '' };
}

// ============================================================================
// CORRUPT TAIL STRIPPING
// ============================================================================

/**
 * Strip corrupt tail from transcript text.
 * Calls detectRepetitionLoop and returns the clean portion.
 */
export function stripCorruptTail(text: string): {
    cleanText: string;
    charsRemoved: number;
    warning: string | null;
} {
    if (!text) {
        return { cleanText: '', charsRemoved: 0, warning: null };
    }

    const detection = detectRepetitionLoop(text);

    if (!detection.isCorrupt) {
        return { cleanText: text, charsRemoved: 0, warning: null };
    }

    const charsRemoved = text.length - detection.cleanTranscript.length;
    const warning = `Repetition loop detected (pattern: "${detection.corruptPattern}"). ` +
        `Removed ${charsRemoved} corrupt characters from transcript tail.`;

    return {
        cleanText: detection.cleanTranscript,
        charsRemoved,
        warning,
    };
}

// ============================================================================
// CHUNK QUALITY VALIDATION
// ============================================================================

/**
 * Count words in text (split by whitespace, filter empties).
 */
function countWords(text: string): number {
    return text.split(/\s+/).filter(w => w.length > 0).length;
}

/**
 * Validate quality of a single transcription chunk.
 * Checks for repetition loops, minimum word count, and words-per-minute.
 */
export function validateChunkQuality(
    transcript: string,
    chunkIndex: number,
    chunkDurationSeconds?: number
): ChunkQualityReport {
    const wordCount = countWords(transcript);
    const detection = detectRepetitionLoop(transcript);

    let wordsPerMinute: number | null = null;
    if (chunkDurationSeconds != null && chunkDurationSeconds > 0) {
        wordsPerMinute = Math.round(wordCount / (chunkDurationSeconds / 60));
    }

    return {
        chunkIndex,
        wordCount,
        wordsPerMinute,
        hasRepetitionLoop: detection.isCorrupt,
    };
}

// ============================================================================
// TRANSCRIPT COMPLETENESS VALIDATION
// ============================================================================

/**
 * Validate transcript completeness by comparing word count to expected words
 * based on meeting duration and average speech rate.
 *
 * @param wordCount - Actual word count of the transcript
 * @param meetingDurationMinutes - Expected meeting duration in minutes
 * @returns Completeness result with severity and message
 */
export function validateTranscriptCompleteness(
    wordCount: number,
    meetingDurationMinutes: number
): TranscriptCompletenessResult {
    if (meetingDurationMinutes <= 0) {
        return {
            coveragePercent: 0,
            severity: 'block',
            message: 'Meeting duration is zero or negative. Cannot assess transcript completeness.',
        };
    }

    if (wordCount <= 0) {
        return {
            coveragePercent: 0,
            severity: 'block',
            message: 'Transcript is empty. Please check the audio source and re-transcribe.',
        };
    }

    const expectedWords = meetingDurationMinutes * EXPECTED_WORDS_PER_MINUTE;
    const coveragePercent = Math.round((wordCount / expectedWords) * 100);

    if (coveragePercent >= COVERAGE_WARN_THRESHOLD) {
        return {
            coveragePercent,
            severity: 'ok',
            message: `Transcript coverage: ${coveragePercent}% of expected content.`,
        };
    }

    if (coveragePercent >= COVERAGE_BLOCK_THRESHOLD) {
        return {
            coveragePercent,
            severity: 'warn',
            message: `Transcript coverage is ${coveragePercent}% — some content may be missing. ` +
                `Minutes generated from this transcript may be incomplete.`,
        };
    }

    return {
        coveragePercent,
        severity: 'block',
        message: `Transcript coverage is only ${coveragePercent}% — significant content appears missing. ` +
            `Consider re-transcribing or using a different audio source for better results.`,
    };
}

// ============================================================================
// OVERLAP STITCHING
// ============================================================================

/**
 * Stitch overlapping transcripts by finding the longest common substring
 * in the overlap regions and merging at that boundary.
 *
 * @param transcripts - Array of transcript strings from overlapping audio chunks
 * @param overlapSeconds - Duration of overlap between consecutive chunks (seconds)
 * @param wordsPerSecondEstimate - Estimated words per second (default: 2.5 ≈ 150 wpm)
 * @returns Merged transcript with duplicated overlap content removed
 */
export function stitchOverlappingTranscripts(
    transcripts: string[],
    overlapSeconds: number,
    wordsPerSecondEstimate = 2.5
): string {
    if (transcripts.length === 0) return '';
    if (transcripts.length === 1) return transcripts[0];

    const overlapWords = Math.ceil(overlapSeconds * wordsPerSecondEstimate);
    let result = transcripts[0];

    for (let i = 1; i < transcripts.length; i++) {
        result = mergeOverlappingPair(result, transcripts[i], overlapWords);
    }

    return result;
}

/**
 * Merge two overlapping transcript segments.
 * Takes the tail of segment A and head of segment B, finds the longest
 * common substring, and merges at that boundary.
 */
function mergeOverlappingPair(
    segmentA: string,
    segmentB: string,
    overlapWords: number
): string {
    const wordsA = segmentA.split(/\s+/);
    const wordsB = segmentB.split(/\s+/);

    // Extract overlap windows
    const tailA = wordsA.slice(-overlapWords);
    const headB = wordsB.slice(0, overlapWords);

    if (tailA.length === 0 || headB.length === 0) {
        return segmentA + ' ' + segmentB;
    }

    // Find the longest common subsequence of words (exact match)
    const match = findLongestCommonSubstring(tailA, headB);

    if (match.length === 0) {
        // No overlap found — fall back to space join (safe degradation)
        return segmentA + ' ' + segmentB;
    }

    // Find where the match starts in each segment's words
    const matchStartInA = findSubarrayIndex(tailA, match);
    const matchEndInB = findSubarrayIndex(headB, match);

    if (matchStartInA === -1 || matchEndInB === -1) {
        // Shouldn't happen, but fall back safely
        return segmentA + ' ' + segmentB;
    }

    // A up to and including the match, then B after the match
    const aUpToMatch = wordsA.slice(0, wordsA.length - tailA.length + matchStartInA);
    const bAfterMatch = wordsB.slice(matchEndInB + match.length);

    return [...aUpToMatch, ...match, ...bAfterMatch].join(' ');
}

/**
 * Find the longest common contiguous subsequence of words between two arrays.
 * Uses dynamic programming.
 */
function findLongestCommonSubstring(a: string[], b: string[]): string[] {
    if (a.length === 0 || b.length === 0) return [];

    // DP table: lengths[i][j] = length of LCS ending at a[i-1] and b[j-1]
    const lengths: number[][] = Array.from({ length: a.length + 1 }, () =>
        new Array(b.length + 1).fill(0)
    );

    let maxLen = 0;
    let endIndexA = 0;

    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            if (a[i - 1].toLowerCase() === b[j - 1].toLowerCase()) {
                lengths[i][j] = lengths[i - 1][j - 1] + 1;
                if (lengths[i][j] > maxLen) {
                    maxLen = lengths[i][j];
                    endIndexA = i;
                }
            }
        }
    }

    if (maxLen === 0) return [];

    // Minimum match length to avoid false positives on common short words
    if (maxLen < 3) return [];

    return a.slice(endIndexA - maxLen, endIndexA);
}

/**
 * Find the starting index of a subarray within an array (case-insensitive).
 * Returns -1 if not found.
 */
function findSubarrayIndex(arr: string[], sub: string[]): number {
    if (sub.length === 0 || sub.length > arr.length) return -1;

    outer:
    for (let i = 0; i <= arr.length - sub.length; i++) {
        for (let j = 0; j < sub.length; j++) {
            if (arr[i + j].toLowerCase() !== sub[j].toLowerCase()) {
                continue outer;
            }
        }
        return i;
    }
    return -1;
}
