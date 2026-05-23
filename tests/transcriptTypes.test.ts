/**
 * Unit tests for src/services/transcriptTypes (plan F1 foundation).
 *
 * Coverage:
 *  - toLabelledTimedTranscript: applies speaker labels by segment id when present,
 *    falls back to array index when id is absent, surfaces unique speakers in
 *    first-appearance order, omits speaker field on unlabelled segments, carries
 *    timestampSource / durationMs / languageCode through unchanged.
 */

import {
    toLabelledTimedTranscript,
    type TimedTranscript,
    type TimedSegment,
} from '../src/services/transcriptTypes';

function segment(startMs: number, endMs: number, text: string, id?: number): TimedSegment {
    return id === undefined ? { startMs, endMs, text } : { startMs, endMs, text, id };
}

describe('toLabelledTimedTranscript', () => {
    it('labels segments by Whisper segment id when present', () => {
        const timed: TimedTranscript = {
            text: 'hello world goodbye',
            segments: [
                segment(0, 1000, 'hello', 10),
                segment(1000, 2000, 'world', 11),
                segment(2000, 3000, 'goodbye', 12),
            ],
            timestampSource: 'whisper-verbose-json',
            durationMs: 3000,
            languageCode: 'en',
        };
        const labels = new Map<number, string>([
            [10, 'Speaker A'],
            [11, 'Speaker B'],
            [12, 'Speaker A'],
        ]);

        const result = toLabelledTimedTranscript(timed, labels);

        expect(result.segments.map((s) => s.speaker)).toEqual(['Speaker A', 'Speaker B', 'Speaker A']);
        expect(result.speakers).toEqual(['Speaker A', 'Speaker B']);
    });

    it('falls back to array index when segment ids are absent', () => {
        const timed: TimedTranscript = {
            text: 'one two',
            segments: [segment(0, 500, 'one'), segment(500, 1000, 'two')],
            timestampSource: 'whisper-verbose-json',
            languageCode: 'en',
        };
        const labels = new Map<number, string>([
            [0, 'Speaker A'],
            [1, 'Speaker B'],
        ]);

        const result = toLabelledTimedTranscript(timed, labels);

        expect(result.segments[0].speaker).toBe('Speaker A');
        expect(result.segments[1].speaker).toBe('Speaker B');
    });

    it('omits speaker field on segments with no mapping', () => {
        const timed: TimedTranscript = {
            text: 'silence speech',
            segments: [segment(0, 500, 'silence', 0), segment(500, 1000, 'speech', 1)],
            timestampSource: 'whisper-verbose-json',
            languageCode: 'en',
        };
        const labels = new Map<number, string>([[1, 'Sarah']]);

        const result = toLabelledTimedTranscript(timed, labels);

        expect(result.segments[0].speaker).toBeUndefined();
        expect(result.segments[1].speaker).toBe('Sarah');
        expect(result.speakers).toEqual(['Sarah']);
    });

    it('emits unique speakers in first-appearance order', () => {
        const timed: TimedTranscript = {
            text: 'a b c d e',
            segments: [
                segment(0, 100, 'a', 0),
                segment(100, 200, 'b', 1),
                segment(200, 300, 'c', 2),
                segment(300, 400, 'd', 3),
                segment(400, 500, 'e', 4),
            ],
            timestampSource: 'whisper-verbose-json',
            languageCode: 'en',
        };
        const labels = new Map<number, string>([
            [0, 'Marco'],
            [1, 'Pat'],
            [2, 'Marco'],
            [3, 'Sarah'],
            [4, 'Pat'],
        ]);

        const result = toLabelledTimedTranscript(timed, labels);

        // First-appearance order: Marco (idx 0), Pat (idx 1), Sarah (idx 3).
        expect(result.speakers).toEqual(['Marco', 'Pat', 'Sarah']);
    });

    it('carries timestampSource / durationMs / languageCode through unchanged', () => {
        const timed: TimedTranscript = {
            text: '',
            segments: [],
            timestampSource: 'none',
            durationMs: 42,
            languageCode: 'zh-CN',
        };

        const result = toLabelledTimedTranscript(timed, new Map());

        expect(result.timestampSource).toBe('none');
        expect(result.durationMs).toBe(42);
        expect(result.languageCode).toBe('zh-CN');
        expect(result.segments).toEqual([]);
        expect(result.speakers).toEqual([]);
    });

    it('handles an entirely unlabelled transcript', () => {
        const timed: TimedTranscript = {
            text: 'untagged text here',
            segments: [segment(0, 1000, 'untagged text here', 0)],
            timestampSource: 'whisper-verbose-json',
            languageCode: 'en',
        };

        const result = toLabelledTimedTranscript(timed, new Map());

        expect(result.speakers).toEqual([]);
        expect(result.segments[0].speaker).toBeUndefined();
    });
});
