/**
 * Tests for the TTS chunker that splits a podcast script into ~90-second
 * segments. Pinning this behaviour so we can trust the fix for the "audio
 * gets softer toward the end" symptom (Gemini TTS attention decay on long
 * scripts) doesn't regress.
 */

import { describe, it, expect } from 'vitest';
import { splitScriptForTts } from '../src/services/newsletter/newsletterAudioService';

// Mirror the module's chunk target (1100 chars ≈ 90 s at 150 wpm).
const CHAR_TARGET = 1100;
const CHAR_MAX = 1800;

function paragraph(words: number, prefix = 'word'): string {
    return Array.from({ length: words }, (_, i) => `${prefix}${i}`).join(' ') + '.';
}

describe('splitScriptForTts — short scripts pass through', () => {
    it('returns a single chunk for a sub-target script', () => {
        const script = paragraph(80); // ~480 chars
        const chunks = splitScriptForTts(script);
        expect(chunks).toHaveLength(1);
        expect(chunks[0].length).toBeLessThanOrEqual(CHAR_TARGET);
    });

    it('trims whitespace', () => {
        const chunks = splitScriptForTts('  hello world.  ');
        expect(chunks).toEqual(['hello world.']);
    });

    it('returns empty array for an empty script', () => {
        // Behaviour change April 2026 after refactor onto shared splitForTts:
        // empty input → no chunks (safer — caller's loop is a no-op rather than
        // sending an empty TTS request).
        const chunks = splitScriptForTts('');
        expect(chunks).toEqual([]);
    });
});

describe('splitScriptForTts — long scripts split on paragraph boundaries', () => {
    it('keeps whole paragraphs together when possible', () => {
        // Five paragraphs × 300 chars ≈ 1500 chars total — forces a split
        const paras = Array.from({ length: 5 }, (_, i) => paragraph(40, `p${i}w`));
        const script = paras.join('\n\n');
        const chunks = splitScriptForTts(script);
        expect(chunks.length).toBeGreaterThan(1);
        // Every chunk should be ≤ target OR a single paragraph that
        // couldn't be split further.
        for (const c of chunks) {
            expect(c.length).toBeLessThanOrEqual(CHAR_MAX);
        }
    });

    it('concatenates chunks to reproduce all original content', () => {
        const paras = Array.from({ length: 6 }, (_, i) => paragraph(30, `s${i}w`));
        const script = paras.join('\n\n');
        const chunks = splitScriptForTts(script);
        // Reassemble chunks with the same separator — every word must be present.
        const reassembled = chunks.join(' ');
        for (let i = 0; i < 6; i++) {
            expect(reassembled).toContain(`s${i}w0`);
            expect(reassembled).toContain(`s${i}w29`);
        }
    });
});

describe('splitScriptForTts — giant paragraphs fall back to sentence split', () => {
    it('splits a single oversized paragraph by sentence boundaries', () => {
        const sentences = Array.from({ length: 40 },
            (_, i) => `This is sentence number ${i} about a long topic we are discussing in detail here.`);
        const script = sentences.join(' '); // one big paragraph, no blank lines
        expect(script.length).toBeGreaterThan(CHAR_MAX);

        const chunks = splitScriptForTts(script);
        expect(chunks.length).toBeGreaterThan(1);
        for (const c of chunks) {
            expect(c.length).toBeLessThanOrEqual(CHAR_MAX);
        }
        // All sentence content preserved (at least first/last word of each).
        const joined = chunks.join(' ');
        for (let i = 0; i < 20; i++) {
            expect(joined).toContain(`sentence number ${i}`);
        }
    });

    it('does not drop sentences between chunk boundaries', () => {
        const sentences = Array.from({ length: 15 },
            (_, i) => `Alpha${i} Beta${i} Gamma${i} Delta${i} Epsilon${i}.`);
        const script = sentences.join(' ');
        const chunks = splitScriptForTts(script);
        const joined = chunks.join(' ');
        for (let i = 0; i < 15; i++) {
            expect(joined).toContain(`Alpha${i}`);
            expect(joined).toContain(`Epsilon${i}`);
        }
    });
});

describe('splitScriptForTts — behavioural invariants', () => {
    it('never emits an empty chunk', () => {
        const script = Array.from({ length: 10 }, () => paragraph(50)).join('\n\n\n\n');
        const chunks = splitScriptForTts(script);
        for (const c of chunks) expect(c.length).toBeGreaterThan(0);
    });

    it('5-minute-sized script (~4500 chars) splits into a sensible chunk count', () => {
        // Typical daily-brief podcast is 3-5 min. 4500 chars ≈ 4.5 min at 150 wpm.
        const paras = Array.from({ length: 8 }, (_, i) => paragraph(80, `brief${i}w`));
        const script = paras.join('\n\n');
        const chunks = splitScriptForTts(script);
        // Expect between 3 (packed) and 10 (unpacked — one per paragraph if
        // paragraphs happen to be near the target). What matters is that
        // (a) we split, and (b) no chunk is unreasonably large.
        expect(chunks.length).toBeGreaterThanOrEqual(3);
        for (const c of chunks) expect(c.length).toBeLessThanOrEqual(CHAR_MAX);
    });
});
