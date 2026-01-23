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
    const maxTokens = options?.maxTokens && options.maxTokens > 0 ? options.maxTokens : 6000;
    return maxTokens * DEFAULT_APPROX_CHARS_PER_TOKEN;
}

function getOverlapChars(options?: TextChunkerOptions): number {
    return options?.overlapChars && options.overlapChars >= 0
        ? options.overlapChars
        : DEFAULT_OVERLAP_CHARS;
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
        const end = Math.min(index + maxChars, text.length);
        chunks.push(text.substring(index, end));
        index += maxChars - overlapChars;

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
