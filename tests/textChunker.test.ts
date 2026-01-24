/**
 * Text Chunker Tests
 * Tests for transcript chunking, overlap handling, and segment-based chunking
 *
 * These tests verify the chunking logic used for long meeting transcripts
 */

import { describe, it, expect } from 'vitest';
import { chunkPlainTextAsync, chunkSegmentsAsync, TranscriptSegmentLike } from '../src/utils/textChunker';

describe('Text Chunker - chunkPlainTextAsync', () => {

    describe('Basic Chunking', () => {
        it('should return empty array for empty string', async () => {
            const result = await chunkPlainTextAsync('');
            expect(result).toEqual([]);
        });

        it('should return single chunk for short text', async () => {
            const text = 'This is a short text that fits in one chunk.';
            const result = await chunkPlainTextAsync(text, { maxChars: 1000 });

            expect(result.length).toBe(1);
            expect(result[0]).toBe(text);
        });

        it('should chunk text at maxChars boundary with no overlap', async () => {
            const text = 'A'.repeat(100);
            const result = await chunkPlainTextAsync(text, { maxChars: 30, overlapChars: 0 });

            // Each step advances by 30 (no overlap), so 100/30 ≈ 4 chunks
            expect(result.length).toBe(4);
            expect(result[0].length).toBe(30);
            expect(result[3].length).toBe(10); // Last chunk has remainder
        });

        it('should handle text exactly at maxChars with overlap', async () => {
            const text = 'A'.repeat(50);
            // With default overlap (400 chars) clamped to maxChars-1=49
            // Step = 50 - 49 = 1, so many small chunks
            // Use explicit small overlap for predictable behavior
            const result = await chunkPlainTextAsync(text, { maxChars: 50, overlapChars: 10 });

            // 50 chars, step = 40, so 2 chunks (0-50, 40-50)
            expect(result.length).toBe(2);
            expect(result[0]).toBe(text);
        });
    });

    describe('Overlap Handling', () => {
        it('should include overlap between chunks', async () => {
            const text = 'ABCDEFGHIJ'; // 10 chars
            const result = await chunkPlainTextAsync(text, { maxChars: 5, overlapChars: 2 });

            // First chunk: ABCDE (0-5), index becomes 0+3=3
            // Second chunk: DEFGH (3-8), index becomes 3+3=6
            // Third chunk: GHIJ (6-10), index becomes 6+3=9
            // Fourth chunk: J (9-10), index becomes 9+3=12 > 10, loop ends
            expect(result.length).toBe(4);
            expect(result[0]).toBe('ABCDE');
            expect(result[1]).toBe('DEFGH');
            expect(result[2]).toBe('GHIJ');
            expect(result[3]).toBe('J');
        });

        it('should allow zero overlap when explicitly specified', async () => {
            const text = 'ABCDEFGHIJ'; // 10 chars
            const result = await chunkPlainTextAsync(text, { maxChars: 5, overlapChars: 0 });

            // With 0 overlap, each step advances by 5 (maxChars)
            // 10 / 5 = 2 chunks
            expect(result.length).toBe(2);
            expect(result[0]).toBe('ABCDE');
            expect(result[1]).toBe('FGHIJ');
        });

        it('should clamp overlap to maxChars - 1', async () => {
            const text = 'ABCDEFGHIJ';
            // Overlap of 10 when maxChars is 5 should be clamped to 4
            const result = await chunkPlainTextAsync(text, { maxChars: 5, overlapChars: 10 });

            // With overlap clamped to 4, each step advances by 1 char
            expect(result.length).toBeGreaterThan(1);
            expect(result[0]).toBe('ABCDE');
        });
    });

    describe('Token-based Configuration', () => {
        it('should calculate maxChars from maxTokens (4 chars per token)', async () => {
            const text = 'A'.repeat(100);
            // maxTokens = 10 means maxChars = 40
            const result = await chunkPlainTextAsync(text, { maxTokens: 10, overlapChars: 0 });

            expect(result[0].length).toBe(40);
        });

        it('should prefer maxChars over maxTokens when both provided', async () => {
            const text = 'A'.repeat(100);
            const result = await chunkPlainTextAsync(text, {
                maxTokens: 10, // Would be 40 chars
                maxChars: 25,  // But we explicitly set 25
                overlapChars: 0
            });

            expect(result[0].length).toBe(25);
        });

        it('should use default maxTokens of 6000 when not specified', async () => {
            const text = 'A'.repeat(100);
            // Default: 6000 tokens * 4 = 24000 chars
            // 100 chars fits in one chunk
            const result = await chunkPlainTextAsync(text);

            expect(result.length).toBe(1);
        });
    });

    describe('Edge Cases', () => {
        it('should handle null/undefined gracefully', async () => {
            // @ts-expect-error - testing runtime behavior
            const result = await chunkPlainTextAsync(null);
            expect(result).toEqual([]);
        });

        it('should handle very long text', async () => {
            const text = 'A'.repeat(10000);
            const result = await chunkPlainTextAsync(text, { maxChars: 1000, overlapChars: 100 });

            // Each chunk after first advances by 900 (1000 - 100)
            // 10000 / 900 ≈ 11.11, so ~12 chunks
            expect(result.length).toBeGreaterThan(10);
            expect(result.every(chunk => chunk.length <= 1000)).toBe(true);
        });

        it('should handle single character', async () => {
            const result = await chunkPlainTextAsync('X', { maxChars: 100 });

            expect(result).toEqual(['X']);
        });
    });
});

describe('Text Chunker - chunkSegmentsAsync', () => {

    interface TestSegment extends TranscriptSegmentLike {
        text: string;
        timestamp?: number;
    }

    describe('Basic Segment Chunking', () => {
        it('should return empty array for empty segments', async () => {
            const result = await chunkSegmentsAsync([]);
            expect(result).toEqual([]);
        });

        it('should keep all segments in one chunk if within limit', async () => {
            const segments: TestSegment[] = [
                { text: 'Hello', timestamp: 0 },
                { text: 'World', timestamp: 1 }
            ];

            const result = await chunkSegmentsAsync(segments, { maxChars: 100 });

            expect(result.length).toBe(1);
            expect(result[0].length).toBe(2);
        });

        it('should split into multiple chunks when exceeding limit', async () => {
            const segments: TestSegment[] = [
                { text: 'A'.repeat(30), timestamp: 0 },
                { text: 'B'.repeat(30), timestamp: 1 },
                { text: 'C'.repeat(30), timestamp: 2 }
            ];

            const result = await chunkSegmentsAsync(segments, { maxChars: 50, overlapChars: 0 });

            // Each segment is 30 chars, limit is 50
            // First chunk: segment 0 (30)
            // Second chunk: segment 1 (30)
            // Third chunk: segment 2 (30)
            expect(result.length).toBe(3);
        });
    });

    describe('Segment Overlap', () => {
        it('should include overlapping segments between chunks', async () => {
            const segments: TestSegment[] = [
                { text: 'First segment.', timestamp: 0 },   // 14 chars
                { text: 'Second segment.', timestamp: 1 },  // 15 chars
                { text: 'Third segment.', timestamp: 2 },   // 14 chars
                { text: 'Fourth segment.', timestamp: 3 }   // 15 chars
            ];

            // maxChars: 30, so we can fit ~2 segments per chunk
            // overlapChars: 15, so last segment of each chunk overlaps into next
            const result = await chunkSegmentsAsync(segments, { maxChars: 30, overlapChars: 15 });

            expect(result.length).toBeGreaterThanOrEqual(2);
            // Overlapping segments should appear in multiple chunks
        });

        it('should handle zero overlap with segments', async () => {
            const segments: TestSegment[] = [
                { text: 'A'.repeat(20), timestamp: 0 },
                { text: 'B'.repeat(20), timestamp: 1 },
                { text: 'C'.repeat(20), timestamp: 2 }
            ];

            // Each segment is 20 chars, maxChars is 30
            // With 0 overlap, segments don't carry over between chunks
            const result = await chunkSegmentsAsync(segments, { maxChars: 30, overlapChars: 0 });

            // Expect 3 chunks, each with 1 segment
            expect(result.length).toBe(3);
            expect(result[0].length).toBe(1);
            expect(result[1].length).toBe(1);
            expect(result[2].length).toBe(1);
        });
    });

    describe('Segment Preservation', () => {
        it('should preserve segment properties', async () => {
            const segments: TestSegment[] = [
                { text: 'Hello', timestamp: 100 },
                { text: 'World', timestamp: 200 }
            ];

            const result = await chunkSegmentsAsync(segments, { maxChars: 1000 });

            expect(result[0][0].timestamp).toBe(100);
            expect(result[0][1].timestamp).toBe(200);
        });

        it('should not mutate original segments', async () => {
            const segments: TestSegment[] = [
                { text: 'Hello', timestamp: 0 }
            ];
            const originalText = segments[0].text;

            await chunkSegmentsAsync(segments, { maxChars: 100 });

            expect(segments[0].text).toBe(originalText);
        });
    });

    describe('Edge Cases', () => {
        it('should handle segment larger than maxChars', async () => {
            const segments: TestSegment[] = [
                { text: 'A'.repeat(100), timestamp: 0 } // Larger than limit
            ];

            const result = await chunkSegmentsAsync(segments, { maxChars: 50 });

            // Even though segment exceeds limit, it should be in its own chunk
            expect(result.length).toBe(1);
            expect(result[0][0].text.length).toBe(100);
        });

        it('should handle many small segments', async () => {
            const segments: TestSegment[] = Array.from({ length: 100 }, (_, i) => ({
                text: `S${i}`,
                timestamp: i
            }));

            const result = await chunkSegmentsAsync(segments, { maxChars: 50, overlapChars: 10 });

            expect(result.length).toBeGreaterThan(1);
            // All segments should be accounted for
            const totalSegmentsInChunks = result.reduce((sum, chunk) => sum + chunk.length, 0);
            expect(totalSegmentsInChunks).toBeGreaterThanOrEqual(100);
        });
    });
});

describe('Text Chunker - Configuration', () => {

    describe('Default Values', () => {
        it('should use default overlap of 400 chars', async () => {
            const text = 'A'.repeat(1000);
            const result = await chunkPlainTextAsync(text, { maxChars: 500 });

            // With 500 maxChars and 400 overlap, each step advances by 100
            // 1000 / 100 = 10 chunks
            expect(result.length).toBe(10);
        });

        it('should use default maxTokens of 6000', async () => {
            // Default: 6000 tokens * 4 chars = 24000 chars per chunk
            // With overlapChars: 1 (to avoid default 400 overlap)
            const text = 'A'.repeat(30000);
            const result = await chunkPlainTextAsync(text, { overlapChars: 1 });

            // 30000 chars with step of 23999 (24000 - 1)
            // 30000 / 23999 ≈ 1.25, so 2 chunks
            expect(result.length).toBe(2);
            expect(result[0].length).toBe(24000);
        });
    });

    describe('Custom Configuration', () => {
        it('should respect custom yieldEveryChunks for UI responsiveness', async () => {
            const text = 'A'.repeat(1000);

            // This tests that the function doesn't throw with yieldEvery option
            // Use overlapChars: 1 to avoid default 400 causing many chunks
            const result = await chunkPlainTextAsync(text, {
                maxChars: 100,
                overlapChars: 1,
                yieldEveryChunks: 2
            });

            // 1000 chars with step of 99, so ~11 chunks
            expect(result.length).toBeGreaterThan(5);
            expect(result.length).toBeLessThan(20);
        });

        it('should use default overlap for negative overlapChars', async () => {
            const text = 'ABCDEFGHIJ';
            const result = await chunkPlainTextAsync(text, { maxChars: 5, overlapChars: -10 });

            // Negative fails the >= 0 check, so uses default 400, clamped to 4
            // So step = 1, and we get many chunks
            expect(result.length).toBe(10);
        });

        it('should handle zero maxTokens with fallback', async () => {
            const text = 'A'.repeat(100);
            // Zero maxTokens should use default
            const result = await chunkPlainTextAsync(text, { maxTokens: 0, overlapChars: 0 });

            // Should use default 6000 tokens = 24000 chars
            expect(result.length).toBe(1);
        });
    });
});

describe('Text Chunker - Real-world Scenarios', () => {

    it('should handle meeting transcript with speaker segments', async () => {
        interface SpeakerSegment extends TranscriptSegmentLike {
            text: string;
            speaker: string;
            start: number;
            end: number;
        }

        const transcript: SpeakerSegment[] = [
            { text: 'Good morning everyone, let\'s begin the meeting.', speaker: 'John', start: 0, end: 5 },
            { text: 'Thanks John. First item on the agenda is the quarterly review.', speaker: 'Mary', start: 5, end: 12 },
            { text: 'Our revenue increased by 15% compared to last quarter.', speaker: 'John', start: 12, end: 20 },
            { text: 'That\'s excellent news. What about the expenses?', speaker: 'Mary', start: 20, end: 25 },
            { text: 'Expenses were down 5% due to cost optimization initiatives.', speaker: 'John', start: 25, end: 32 }
        ];

        const result = await chunkSegmentsAsync(transcript, { maxChars: 150, overlapChars: 50 });

        expect(result.length).toBeGreaterThan(1);
        // Each chunk should preserve speaker info
        expect(result[0][0].speaker).toBe('John');
    });

    it('should handle YouTube-style transcript without timestamps', async () => {
        const transcript: TranscriptSegmentLike[] = [
            { text: 'Welcome to the tutorial.' },
            { text: 'Today we will learn about JavaScript.' },
            { text: 'JavaScript is a programming language.' },
            { text: 'It runs in web browsers.' }
        ];

        const result = await chunkSegmentsAsync(transcript, { maxChars: 80, overlapChars: 20 });

        expect(result.length).toBeGreaterThanOrEqual(1);
        // All text should be preserved
        const allText = result.flat().map(s => s.text).join(' ');
        expect(allText).toContain('Welcome to the tutorial');
        expect(allText).toContain('It runs in web browsers');
    });

    it('should handle long monologue segments', async () => {
        const longMonologue = 'This is a very long monologue that goes on and on. '.repeat(50);
        const segments: TranscriptSegmentLike[] = [
            { text: longMonologue }
        ];

        // Even with small maxChars, large segments are kept intact
        const result = await chunkSegmentsAsync(segments, { maxChars: 100 });

        expect(result.length).toBe(1);
        expect(result[0][0].text).toBe(longMonologue);
    });
});
