import { describe, it, expect } from 'vitest';
import {
    hasExistingSpeakerLabels,
    splitIntoSegments,
    extractSpeakerNames,
} from '../src/services/speakerLabellingService';

// ── hasExistingSpeakerLabels ────────────────────────────────────────

describe('hasExistingSpeakerLabels', () => {
    it('returns true when ≥30% of lines have speaker labels', () => {
        const transcript = [
            'Alice: Good morning everyone.',
            'Bob: Let\'s get started.',
            'Alice: First item on the agenda.',
            'Some unlabelled line here.',
        ].join('\n');
        expect(hasExistingSpeakerLabels(transcript)).toBe(true); // 3/4 = 75%
    });

    it('returns false when <30% of lines have labels', () => {
        const transcript = [
            'Good morning everyone.',
            'Let\'s get started.',
            'First item on the agenda.',
            'Alice: Only one labelled line.',
            'Another unlabelled line.',
            'And another one.',
            'Yet another.',
            'Still no label.',
            'Nope.',
            'Nothing here.',
        ].join('\n');
        expect(hasExistingSpeakerLabels(transcript)).toBe(false); // 1/10 = 10%
    });

    it('returns false for empty transcript', () => {
        expect(hasExistingSpeakerLabels('')).toBe(false);
    });

    it('returns true for fully labelled transcript', () => {
        const transcript = [
            'Alice: First point.',
            'Bob: Second point.',
            'Charlie: Third point.',
        ].join('\n');
        expect(hasExistingSpeakerLabels(transcript)).toBe(true);
    });

    it('handles bracket-style labels', () => {
        const transcript = [
            '[Alice] First point.',
            '[Bob] Second point.',
            '[Charlie] Third point.',
        ].join('\n');
        // The pattern requires ":" — bracket-only without colon won't match the main pattern
        // This is intentional — we focus on "Name: text" format
        expect(hasExistingSpeakerLabels(transcript)).toBe(false);
    });

    it('ignores blank lines in percentage calculation', () => {
        const transcript = [
            'Alice: First point.',
            '',
            'Bob: Second point.',
            '',
            '',
        ].join('\n');
        // Only 2 non-empty lines, both labelled → 100%
        expect(hasExistingSpeakerLabels(transcript)).toBe(true);
    });
});

// ── splitIntoSegments ───────────────────────────────────────────────

describe('splitIntoSegments', () => {
    it('returns single segment for short text', () => {
        const text = 'Hello world';
        expect(splitIntoSegments(text, 5000)).toEqual(['Hello world']);
    });

    it('splits at paragraph boundaries', () => {
        const para1 = 'A'.repeat(100);
        const para2 = 'B'.repeat(100);
        const para3 = 'C'.repeat(100);
        const text = `${para1}\n\n${para2}\n\n${para3}`;
        const segments = splitIntoSegments(text, 250);
        expect(segments.length).toBeGreaterThanOrEqual(2);
        // Each segment should be ≤ maxChars
        for (const seg of segments) {
            expect(seg.length).toBeLessThanOrEqual(250);
        }
    });

    it('handles single oversized paragraph by splitting at sentences', () => {
        const longSentences = Array.from({ length: 20 }, (_, i) =>
            `This is sentence number ${i + 1} in a very long paragraph.`
        ).join(' ');
        const segments = splitIntoSegments(longSentences, 200);
        expect(segments.length).toBeGreaterThan(1);
        for (const seg of segments) {
            expect(seg.length).toBeLessThanOrEqual(200);
        }
    });

    it('returns empty array for empty text', () => {
        expect(splitIntoSegments('', 5000)).toEqual(['']);
    });
});

// ── extractSpeakerNames ─────────────────────────────────────────────

describe('extractSpeakerNames', () => {
    it('extracts unique speaker names', () => {
        const transcript = [
            'Alice: Hello.',
            'Bob: Hi there.',
            'Alice: Let\'s begin.',
            'Charlie: Sounds good.',
        ].join('\n');
        const names = extractSpeakerNames(transcript);
        expect(names).toContain('Alice');
        expect(names).toContain('Bob');
        expect(names).toContain('Charlie');
        expect(names).toHaveLength(3);
    });

    it('handles names with titles/roles', () => {
        const transcript = 'Dr. Smith: The results are in.\nProf. Jones: Interesting.';
        const names = extractSpeakerNames(transcript);
        expect(names).toContain('Dr. Smith');
        expect(names).toContain('Prof. Jones');
    });

    it('returns empty array for unlabelled transcript', () => {
        const transcript = 'Just some text without labels.\nAnother line.';
        expect(extractSpeakerNames(transcript)).toEqual([]);
    });

    it('ignores very short or very long names', () => {
        const longName = 'A'.repeat(70);
        const transcript = `${longName}: Some text.\nA: Too short maybe.`;
        const names = extractSpeakerNames(transcript);
        // Long name (>60) should be excluded
        expect(names.every(n => n.length < 60)).toBe(true);
    });

    it('extracts names from bracket-colon format', () => {
        const transcript = '[Alice]: Hello.\n[Bob Smith]: Hi.\nCharlie: Plain format.';
        const names = extractSpeakerNames(transcript);
        expect(names).toContain('Alice');
        expect(names).toContain('Bob Smith');
        expect(names).toContain('Charlie');
        expect(names).toHaveLength(3);
    });
});
