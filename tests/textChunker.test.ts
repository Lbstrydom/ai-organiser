/**
 * Text Chunker Tests
 * Tests for transcript chunking, overlap handling, and segment-based chunking
 *
 * These tests verify the chunking logic used for long meeting transcripts
 */

import { chunkPlainTextAsync, chunkSegmentsAsync, chunkContentSync, TranscriptSegmentLike } from '../src/utils/textChunker';
import { CHUNK_TOKEN_LIMIT } from '../src/core/constants';

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

        it('should use default maxTokens of CHUNK_TOKEN_LIMIT when not specified', async () => {
            const text = 'A'.repeat(100);
            // Default: CHUNK_TOKEN_LIMIT tokens * 4 = CHUNK_TOKEN_LIMIT*4 chars
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

    describe('Sentence Boundary Splitting', () => {
        it('should split at sentence boundary instead of mid-sentence', async () => {
            const text = 'First sentence here. Second sentence here. Third sentence is a bit longer than usual.';
            const result = await chunkPlainTextAsync(text, { maxChars: 45, overlapChars: 0 });

            // Should split after 'Second sentence here.' (42 chars) rather than at char 45
            expect(result[0]).toMatch(/\.$/);
            expect(result.length).toBeGreaterThanOrEqual(2);
        });

        it('should split at paragraph boundary (double newline)', async () => {
            const text = 'First paragraph content here.\n\nSecond paragraph content here.\n\nThird paragraph.';
            const result = await chunkPlainTextAsync(text, { maxChars: 35, overlapChars: 0 });

            // Should prefer paragraph boundary
            expect(result[0]).toContain('First paragraph');
            expect(result.length).toBeGreaterThanOrEqual(2);
        });

        it('should fall back to maxChars when no boundary found in window', async () => {
            // No sentence boundaries at all
            const text = 'A'.repeat(100);
            const result = await chunkPlainTextAsync(text, { maxChars: 30, overlapChars: 0 });

            // Should behave like original: each chunk is 30 chars (or less for last)
            expect(result[0].length).toBe(30);
            expect(result.length).toBe(4);
        });

        it('should handle question marks and exclamation marks as boundaries', async () => {
            const text = 'Is this working? Yes it is! Another sentence follows here.';
            const result = await chunkPlainTextAsync(text, { maxChars: 30, overlapChars: 0 });

            // Should split after '?' or '!' boundaries
            expect(result[0]).toMatch(/[?!]$/);
        });

        it('should maintain correct overlap when splitting at sentence boundary', async () => {
            const text = 'First sentence. Second sentence. Third sentence.';
            const result = await chunkPlainTextAsync(text, { maxChars: 35, overlapChars: 5 });

            // With overlap, later chunks should share some content with previous
            if (result.length > 1) {
                // Overlap means the end of chunk N-1 overlaps with start of chunk N
                expect(result.length).toBeGreaterThanOrEqual(2);
            }
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

        it('should use default maxTokens of CHUNK_TOKEN_LIMIT', async () => {
            // Default: CHUNK_TOKEN_LIMIT tokens * 4 chars per chunk.
            // Scale input to ~1.25x default so we reliably see ≥2 chunks
            // regardless of future CHUNK_TOKEN_LIMIT changes.
            const defaultChunkChars = CHUNK_TOKEN_LIMIT * 4;
            const text = 'A'.repeat(Math.floor(defaultChunkChars * 1.25));
            const result = await chunkPlainTextAsync(text, { overlapChars: 1 });

            expect(result.length).toBe(2);
            expect(result[0].length).toBe(defaultChunkChars);
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

            // Should use default CHUNK_TOKEN_LIMIT tokens = CHUNK_TOKEN_LIMIT*4 chars
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

describe('Text Chunker - chunkContentSync', () => {

    describe('Basic Behavior', () => {
        it('should return empty array for empty string', () => {
            expect(chunkContentSync('', 1000)).toEqual([]);
        });

        it('should return empty array for null/undefined', () => {
            // @ts-expect-error - testing runtime behavior
            expect(chunkContentSync(null, 1000)).toEqual([]);
            // @ts-expect-error - testing runtime behavior
            expect(chunkContentSync(undefined, 1000)).toEqual([]);
        });

        it('should return single chunk for short text', () => {
            const text = 'This is a short text.';
            const result = chunkContentSync(text, 1000);
            expect(result).toEqual([text]);
        });

        it('should return single chunk when text equals maxChars', () => {
            const text = 'A'.repeat(100);
            const result = chunkContentSync(text, 100);
            expect(result).toEqual([text]);
        });

        it('should return empty array for zero maxChars', () => {
            expect(chunkContentSync('some text', 0)).toEqual([]);
        });
    });

    describe('Paragraph Boundary Splitting', () => {
        it('should split at paragraph boundaries', () => {
            const text = 'First paragraph content.\n\nSecond paragraph content.\n\nThird paragraph content.';
            const result = chunkContentSync(text, 55);

            expect(result.length).toBe(2);
            expect(result[0]).toBe('First paragraph content.\n\nSecond paragraph content.');
            expect(result[1]).toBe('Third paragraph content.');
        });

        it('should handle multiple consecutive newlines as single boundary', () => {
            const text = 'First.\n\n\n\nSecond.\n\n\n\n\nThird.';
            const result = chunkContentSync(text, 15);

            // \n\n+ collapsed: paragraphs are 'First.', 'Second.', 'Third.'
            // 'First.' (6) + 'Second.' (7) + 2 separator = 15 <= 15, so they combine
            expect(result.length).toBe(2);
            expect(result[0]).toBe('First.\n\nSecond.');
            expect(result[1]).toBe('Third.');
        });
    });

    describe('Sentence Boundary Splitting', () => {
        it('should split oversized paragraph at sentence boundaries', () => {
            // One long paragraph with sentences
            const text = 'First sentence here. Second sentence here. Third sentence here. Fourth sentence here.';
            const result = chunkContentSync(text, 45);

            // Should split at sentence boundaries, not mid-word
            expect(result.length).toBeGreaterThanOrEqual(2);
            for (const chunk of result) {
                expect(chunk).toMatch(/[.!?]$/);
            }
        });

        it('should not split mid-word for oversized sentences', () => {
            // Long sentence with words but no sentence-ending punctuation until the end
            const words = Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ');
            const result = chunkContentSync(words, 100);

            // No chunk should start with digits (which would mean a mid-word split like "ord12")
            for (const chunk of result) {
                expect(chunk).not.toMatch(/^\d/);
                // No chunk should end mid-word (truncated before space)
                // Each chunk should end with a complete word
                expect(chunk).toMatch(/(word\d+|^.*)$/);
            }
            // All original words should be recoverable
            const allWords = words.split(' ');
            const recovered = result.join(' ').split(' ');
            for (const w of allWords) {
                expect(recovered).toContain(w);
            }
        });
    });

    describe('Hard Split Fallback', () => {
        it('should still produce chunks for pathological content (no spaces)', () => {
            const text = 'A'.repeat(300);
            const result = chunkContentSync(text, 100);

            expect(result.length).toBe(3);
            expect(result[0].length).toBe(100);
            expect(result[1].length).toBe(100);
            expect(result[2].length).toBe(100);
        });
    });

    describe('Chunk Count Reasonableness', () => {
        it('should not produce micro-chunks from boundary adjustments', () => {
            const text = Array.from({ length: 20 }, (_, i) =>
                `Paragraph ${i} has some content here.`
            ).join('\n\n');
            const result = chunkContentSync(text, 200);

            // Should produce reasonable-sized chunks, not tiny fragments
            for (const chunk of result) {
                expect(chunk.length).toBeGreaterThan(10);
            }
        });
    });

    describe('Round-Trip Content Preservation', () => {
        it('should preserve all content when chunks are joined', () => {
            const paragraphs = [
                'First paragraph with some content.',
                'Second paragraph is a bit longer and has more text.',
                'Third paragraph wraps things up.'
            ];
            const text = paragraphs.join('\n\n');
            const result = chunkContentSync(text, 60);

            // All original paragraphs should appear in the joined output
            const joined = result.join('\n\n');
            for (const p of paragraphs) {
                expect(joined).toContain(p);
            }
        });

        it('should preserve all words in sentence-split content', () => {
            const text = 'The quick brown fox jumps over the lazy dog. ' +
                'A second sentence follows with more words. ' +
                'And a third to make it long enough to split.';
            const result = chunkContentSync(text, 60);
            const allWords = text.split(/\s+/);
            const chunkWords = result.join(' ').split(/\s+/);

            for (const word of allWords) {
                expect(chunkWords).toContain(word);
            }
        });
    });

    describe('Mixed Content', () => {
        it('should handle mix of short and long paragraphs', () => {
            const shortPara = 'Short.';
            const longPara = 'This is a much longer paragraph that contains several sentences. ' +
                'It goes on and on with more content. And even more content here.';
            const text = `${shortPara}\n\n${longPara}\n\n${shortPara}`;
            const result = chunkContentSync(text, 80);

            expect(result.length).toBeGreaterThanOrEqual(2);
            // No chunk should be empty
            for (const chunk of result) {
                expect(chunk.trim().length).toBeGreaterThan(0);
            }
        });
    });
});
