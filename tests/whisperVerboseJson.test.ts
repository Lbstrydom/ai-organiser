import { describe, it, expect } from 'vitest';
import { parseWhisperSegments, WhisperSegment } from '../src/services/audioTranscriptionService';

describe('parseWhisperSegments', () => {
    it('parses valid verbose_json segments', () => {
        const raw = [
            {
                id: 0,
                start: 0.0,
                end: 3.5,
                text: ' Good morning everyone.',
                no_speech_prob: 0.02,
                compression_ratio: 1.2,
                avg_logprob: -0.3,
                temperature: 0.0,
            },
            {
                id: 1,
                start: 3.5,
                end: 7.0,
                text: " Let's review the budget.",
                no_speech_prob: 0.01,
                compression_ratio: 1.1,
                avg_logprob: -0.25,
                temperature: 0.0,
            },
        ];

        const result = parseWhisperSegments(raw);
        expect(result).toBeDefined();
        expect(result).toHaveLength(2);
        expect(result![0].text).toBe(' Good morning everyone.');
        expect(result![0].no_speech_prob).toBe(0.02);
        expect(result![0].compression_ratio).toBe(1.2);
        expect(result![1].start).toBe(3.5);
        expect(result![1].end).toBe(7.0);
    });

    it('returns undefined for empty array', () => {
        expect(parseWhisperSegments([])).toBeUndefined();
    });

    it('returns undefined for null/undefined', () => {
        expect(parseWhisperSegments(null)).toBeUndefined();
        expect(parseWhisperSegments(undefined)).toBeUndefined();
    });

    it('returns undefined for non-array', () => {
        expect(parseWhisperSegments('not an array')).toBeUndefined();
        expect(parseWhisperSegments(42)).toBeUndefined();
    });

    it('handles segments with missing optional fields', () => {
        const raw = [
            {
                id: 0,
                start: 0.0,
                end: 5.0,
                text: 'Hello',
                no_speech_prob: 0.1,
                compression_ratio: 1.5,
                // avg_logprob and temperature missing
            },
        ];

        const result = parseWhisperSegments(raw);
        expect(result).toBeDefined();
        expect(result![0].avg_logprob).toBeUndefined();
        expect(result![0].temperature).toBeUndefined();
    });

    it('handles segments with wrong field types gracefully', () => {
        const raw = [
            {
                id: 'not-a-number',
                start: '0',
                end: 5.0,
                text: 123, // number instead of string
                no_speech_prob: 'high', // string instead of number
                compression_ratio: null,
            },
        ];

        const result = parseWhisperSegments(raw);
        expect(result).toBeDefined();
        expect(result![0].id).toBe(0); // fallback to parsed.length (0)
        expect(result![0].start).toBe(0); // fallback default
        expect(result![0].text).toBe(''); // fallback empty string
        expect(result![0].no_speech_prob).toBe(0); // fallback
        expect(result![0].compression_ratio).toBe(1); // fallback
    });

    it('skips non-object entries', () => {
        const raw = [
            null,
            42,
            'string',
            {
                id: 0,
                start: 0,
                end: 3,
                text: 'Valid',
                no_speech_prob: 0.05,
                compression_ratio: 1.0,
            },
        ];

        const result = parseWhisperSegments(raw);
        expect(result).toBeDefined();
        expect(result).toHaveLength(1);
        expect(result![0].text).toBe('Valid');
    });

    it('identifies high no_speech_prob segments (silence/noise)', () => {
        const raw = [
            { id: 0, start: 0, end: 5, text: '...', no_speech_prob: 0.95, compression_ratio: 1.0 },
            { id: 1, start: 5, end: 10, text: 'Hello there.', no_speech_prob: 0.02, compression_ratio: 1.2 },
        ];

        const result = parseWhisperSegments(raw)!;
        const silentSegments = result.filter(s => s.no_speech_prob > 0.5);
        expect(silentSegments).toHaveLength(1);
        expect(silentSegments[0].text).toBe('...');
    });

    it('identifies high compression_ratio segments (repetitive/corrupt)', () => {
        const raw = [
            { id: 0, start: 0, end: 5, text: 'thank you thank you thank you', no_speech_prob: 0.01, compression_ratio: 3.5 },
            { id: 1, start: 5, end: 10, text: 'The budget is approved.', no_speech_prob: 0.01, compression_ratio: 1.1 },
        ];

        const result = parseWhisperSegments(raw)!;
        const suspectSegments = result.filter(s => s.compression_ratio > 2.4);
        expect(suspectSegments).toHaveLength(1);
        expect(suspectSegments[0].text).toContain('thank you');
    });
});
