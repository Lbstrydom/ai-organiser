/**
 * Transcript Preprocessor Tests
 * Tests for the preprocessTranscript() orchestrator function.
 *
 * MECE Coverage:
 * - Whitespace normalisation (collapse runs, trim)
 * - Corruption stripping (delegates to transcriptQualityService)
 * - Completeness validation (with and without duration)
 * - Combined pipeline behaviour
 * - Edge cases (empty, no options, warnings collection)
 */

import { preprocessTranscript } from '../src/services/transcriptPreprocessor';

describe('TranscriptPreprocessor', () => {

    describe('whitespace normalisation', () => {
        it('collapses 3+ whitespace chars to paragraph break', () => {
            const raw = 'Hello world.   \n\n\n   This is the second paragraph.';
            const result = preprocessTranscript(raw);
            // 3+ whitespace should be collapsed to \n\n
            expect(result.cleanTranscript).toContain('Hello world.');
            expect(result.cleanTranscript).toContain('This is the second paragraph.');
            // No runs of 3+ spaces or newlines
            expect(result.cleanTranscript).not.toMatch(/\s{3,}/);
        });

        it('collapses double spaces to single space (runs of 2)', () => {
            // Note: 3+ whitespace chars → \n\n first, then double-space → single-space
            const raw = 'Speaker  said  hello  world.';
            const result = preprocessTranscript(raw);
            expect(result.cleanTranscript).toBe('Speaker said hello world.');
        });

        it('trims leading and trailing whitespace', () => {
            const raw = '   Some transcript text.   ';
            const result = preprocessTranscript(raw);
            expect(result.cleanTranscript).toBe('Some transcript text.');
        });
    });

    describe('corruption stripping', () => {
        it('strips a corrupt repetition tail and records warning', () => {
            // Build a clean prefix followed by 600+ chars of "m m m m ..."
            const cleanText = 'The meeting discussed several important topics including the quarterly budget review.';
            const corruptTail = ' ' + 'm '.repeat(350);
            const raw = cleanText + corruptTail;

            const result = preprocessTranscript(raw);
            expect(result.stats.corruptCharsRemoved).toBeGreaterThan(0);
            expect(result.warnings.length).toBeGreaterThan(0);
            expect(result.warnings.some(w => w.toLowerCase().includes('corrupt') || w.toLowerCase().includes('repetit'))).toBe(true);
        });

        it('leaves clean transcripts untouched (zero chars removed)', () => {
            const raw = 'This is a perfectly clean transcript with varied words and normal content that has no repetition issues at all.';
            const result = preprocessTranscript(raw);
            expect(result.stats.corruptCharsRemoved).toBe(0);
            expect(result.warnings).toHaveLength(0);
        });
    });

    describe('completeness validation', () => {
        it('returns null coverage when no meeting duration provided', () => {
            const raw = 'Some transcript text for a meeting.';
            const result = preprocessTranscript(raw);
            expect(result.stats.coveragePercent).toBeNull();
        });

        it('calculates coverage percent when meeting duration provided', () => {
            // 120 wpm expected. 60 min meeting = 7200 expected words.
            // Let's give ~1000 words → well below 50%, should warn
            const words = Array.from({ length: 1000 }, (_, i) => `word${i}`).join(' ');
            const result = preprocessTranscript(words, { meetingDurationMinutes: 60 });
            expect(result.stats.coveragePercent).not.toBeNull();
            expect(result.stats.coveragePercent!).toBeGreaterThan(0);
            expect(result.stats.coveragePercent!).toBeLessThan(50);
        });

        it('adds warning when coverage is below threshold', () => {
            const words = Array.from({ length: 1000 }, (_, i) => `word${i}`).join(' ');
            const result = preprocessTranscript(words, { meetingDurationMinutes: 60 });
            // Should be 'block' severity (<50%) → produces a warning
            expect(result.warnings.length).toBeGreaterThan(0);
        });

        it('does not warn when coverage is sufficient', () => {
            // 120 wpm * 10 min = 1200 expected. Provide 1200 words → 100%
            const words = Array.from({ length: 1200 }, (_, i) => `word${i}`).join(' ');
            const result = preprocessTranscript(words, { meetingDurationMinutes: 10 });
            // Coverage should be ~100%, no warning
            expect(result.stats.coveragePercent!).toBeGreaterThanOrEqual(75);
            // Only completeness warnings — no corruption warnings
            const completenessWarnings = result.warnings.filter(w =>
                w.toLowerCase().includes('coverage') || w.toLowerCase().includes('transcript')
            );
            expect(completenessWarnings).toHaveLength(0);
        });
    });

    describe('combined pipeline', () => {
        it('normalises whitespace, strips corruption, and calculates stats', () => {
            const raw = '  Hello   world.\n\n\n\nThis is important.  ';
            const result = preprocessTranscript(raw);
            expect(result.cleanTranscript).not.toMatch(/  +/);
            expect(result.stats.originalChars).toBe(raw.length);
            expect(result.stats.cleanChars).toBeLessThanOrEqual(raw.length);
            expect(result.stats.corruptCharsRemoved).toBe(0);
        });

        it('collects warnings from both corruption and completeness', () => {
            const cleanText = 'Budget was discussed. ';
            const corruptTail = 'm '.repeat(350);
            const raw = cleanText + corruptTail;

            const result = preprocessTranscript(raw, { meetingDurationMinutes: 120 });
            // Should have at least corruption warning and possibly completeness warning
            expect(result.warnings.length).toBeGreaterThanOrEqual(1);
        });
    });

    describe('edge cases', () => {
        it('handles empty string input', () => {
            const result = preprocessTranscript('');
            expect(result.cleanTranscript).toBe('');
            expect(result.stats.originalChars).toBe(0);
            expect(result.stats.cleanChars).toBe(0);
            expect(result.stats.corruptCharsRemoved).toBe(0);
            expect(result.stats.coveragePercent).toBeNull();
            expect(result.warnings).toHaveLength(0);
        });

        it('handles zero meeting duration gracefully (skips completeness)', () => {
            const result = preprocessTranscript('Some text.', { meetingDurationMinutes: 0 });
            expect(result.stats.coveragePercent).toBeNull();
        });
    });
});
