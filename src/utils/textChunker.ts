import { CHUNK_TOKEN_LIMIT } from '../core/constants';
import { findBoundaryPosition } from '../services/tokenLimits';
export interface TextChunkerOptions {
    maxTokens?: number;
    maxChars?: number;
    overlapChars?: number;
    yieldEveryChunks?: number;
}

const DEFAULT_APPROX_CHARS_PER_TOKEN = 4;
const DEFAULT_OVERLAP_CHARS = 400;
const DEFAULT_YIELD_EVERY = 8;

function getMaxChars(options?: TextChunkerOptions): number {
    if (options?.maxChars && options.maxChars > 0) {
        return options.maxChars;
    }
    const maxTokens = options?.maxTokens && options.maxTokens > 0 ? options.maxTokens : CHUNK_TOKEN_LIMIT;
    return maxTokens * DEFAULT_APPROX_CHARS_PER_TOKEN;
}

function getOverlapChars(options?: TextChunkerOptions): number {
    // Use explicit undefined check to allow overlapChars: 0
    if (options?.overlapChars !== undefined && options.overlapChars >= 0) {
        return options.overlapChars;
    }
    return DEFAULT_OVERLAP_CHARS;
}

function getYieldEvery(options?: TextChunkerOptions): number {
    return options?.yieldEveryChunks && options.yieldEveryChunks > 0
        ? options.yieldEveryChunks
        : DEFAULT_YIELD_EVERY;
}

async function yieldToUi(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 0));
}

export async function chunkPlainTextAsync(text: string, options?: TextChunkerOptions): Promise<string[]> {
    const maxChars = getMaxChars(options);
    const overlapChars = Math.max(0, Math.min(getOverlapChars(options), maxChars - 1));
    const yieldEvery = getYieldEvery(options);

    const chunks: string[] = [];
    if (!text) return chunks;

    let index = 0;
    while (index < text.length) {
        let end = Math.min(index + maxChars, text.length);

        // Try to split at a boundary instead of mid-word/sentence.
        let adjustedForSentence = false;
        if (end < text.length) {
            const lookbackWindow = Math.min(500, Math.max(30, Math.floor(maxChars * 0.1)));
            const threshold = Math.max(index, end - lookbackWindow);
            const bestBreak = findBoundaryPosition(text, end, threshold);
            if (bestBreak > index && bestBreak < end) {
                end = bestBreak;
                adjustedForSentence = true;
            }
        }

        chunks.push(text.substring(index, end));
        // When a sentence boundary shortened the chunk, step by actual chunk length minus overlap.
        // Otherwise preserve original step (maxChars - overlap) to avoid extra tiny tail chunks.
        const step = adjustedForSentence
            ? Math.max(1, (end - index) - overlapChars)
            : Math.max(1, maxChars - overlapChars);
        index += step;

        if (chunks.length % yieldEvery === 0) {
            await yieldToUi();
        }
    }

    return chunks;
}

export interface TranscriptSegmentLike {
    text: string;
}

export async function chunkSegmentsAsync<T extends TranscriptSegmentLike>(
    segments: T[],
    options?: TextChunkerOptions
): Promise<T[][]> {
    const maxChars = getMaxChars(options);
    const overlapChars = Math.max(0, Math.min(getOverlapChars(options), maxChars - 1));
    const yieldEvery = getYieldEvery(options);

    const chunks: T[][] = [];
    if (!segments.length) return chunks;

    let currentChunk: T[] = [];
    let currentLength = 0;

    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const segmentLength = segment.text.length;

        if (currentLength + segmentLength > maxChars && currentChunk.length > 0) {
            chunks.push(currentChunk);

            const overlapStartIndex = findOverlapStart(currentChunk, overlapChars);
            currentChunk = currentChunk.slice(overlapStartIndex);
            currentLength = currentChunk.reduce((sum, s) => sum + s.text.length, 0);
        }

        currentChunk.push(segment);
        currentLength += segmentLength;

        if ((i + 1) % (yieldEvery * 5) === 0) {
            await yieldToUi();
        }
    }

    if (currentChunk.length > 0) {
        chunks.push(currentChunk);
    }

    return chunks;
}

/** Scan backward from `end` to find a sentence or word boundary within the lookback window. */
function findBestBreak(text: string, start: number, end: number, maxChars: number): number {
    const lookbackWindow = Math.min(500, Math.max(30, Math.floor(maxChars * 0.1)));
    const searchStart = Math.max(start, end - lookbackWindow);
    let wordBreak = -1;
    for (let j = end - 1; j >= searchStart; j--) {
        const ch = text[j];
        if ((ch === '.' || ch === '?' || ch === '!') && j + 1 < text.length) {
            const next = text[j + 1];
            if (next === ' ' || next === '\n' || next === '\r') {
                return j + 1; // sentence boundary — best possible
            }
        }
        if (ch === ' ' && wordBreak === -1) {
            wordBreak = j; // remember first word boundary found
        }
    }
    return wordBreak > start ? wordBreak : -1;
}

/**
 * Split an oversized text fragment at word/sentence boundaries.
 * Used as the innermost fallback when paragraph and sentence splitting
 * still produces pieces exceeding maxChars.
 */
function splitAtBoundaries(text: string, maxChars: number): string[] {
    const pieces: string[] = [];
    let index = 0;
    while (index < text.length) {
        let end = Math.min(index + maxChars, text.length);
        if (end < text.length) {
            const breakPoint = findBestBreak(text, index, end, maxChars);
            if (breakPoint > 0) end = breakPoint;
        }
        const piece = text.substring(index, end).trim();
        if (piece) pieces.push(piece);
        index = end;
        while (index < text.length && text[index] === ' ') index++;
    }
    return pieces;
}

/**
 * Split an oversized paragraph into sentence-sized pieces,
 * falling back to boundary-aware splitting for oversized sentences.
 */
function splitOversizedParagraph(paragraph: string, maxChars: number, chunks: string[]): string {
    const sentences = paragraph.split(/(?<=[.!?])\s+/);
    let currentChunk = '';

    for (const sentence of sentences) {
        if (currentChunk.length + sentence.length + 1 > maxChars) {
            if (currentChunk.trim()) chunks.push(currentChunk.trim());
            if (sentence.length > maxChars) {
                chunks.push(...splitAtBoundaries(sentence, maxChars));
                currentChunk = '';
            } else {
                currentChunk = sentence;
            }
        } else {
            currentChunk += (currentChunk ? ' ' : '') + sentence;
        }
    }
    return currentChunk;
}

/** Flush a non-empty trimmed chunk into the array. */
function flushChunk(chunk: string, chunks: string[]): void {
    const trimmed = chunk.trim();
    if (trimmed) chunks.push(trimmed);
}

/**
 * Synchronous content chunker for map-reduce summarization and translation.
 * Uses paragraph → sentence → word boundary hierarchy (no mid-word splits).
 * No overlap, no UI yielding — suitable for synchronous callers.
 */
export function chunkContentSync(text: string, maxCharsPerChunk: number): string[] {
    if (!text || maxCharsPerChunk <= 0) return [];
    if (text.length <= maxCharsPerChunk) return [text];

    const chunks: string[] = [];
    const paragraphs = text.split(/\n\n+/);
    let current = '';

    for (const paragraph of paragraphs) {
        const fitsInCurrent = current.length + paragraph.length + 2 <= maxCharsPerChunk;

        if (fitsInCurrent) {
            current += (current ? '\n\n' : '') + paragraph;
            continue;
        }

        flushChunk(current, chunks);
        if (paragraph.length > maxCharsPerChunk) {
            current = splitOversizedParagraph(paragraph, maxCharsPerChunk, chunks);
        } else {
            current = paragraph;
        }
    }

    flushChunk(current, chunks);
    return chunks;
}

function findOverlapStart<T extends TranscriptSegmentLike>(segments: T[], overlapChars: number): number {
    if (overlapChars <= 0 || segments.length === 0) {
        return segments.length;
    }

    let count = 0;
    for (let i = segments.length - 1; i >= 0; i--) {
        count += segments[i].text.length;
        if (count >= overlapChars) {
            return i;
        }
    }

    return 0;
}
