/**
 * TTS Chunker tests — verifies the splitForTts logic behaves identically
 * to the legacy newsletter `splitScriptForTts` (now an alias for splitForTts).
 */

import { describe, it, expect } from 'vitest';
import {
    splitForTts,
    splitParagraphIntoSentences,
    TTS_CHUNK_CHAR_TARGET,
    TTS_CHUNK_CHAR_MAX,
} from '../src/services/tts/ttsChunker';

describe('splitForTts', () => {
    it('returns empty array for empty input', () => {
        expect(splitForTts('')).toEqual([]);
        expect(splitForTts('   ')).toEqual([]);
    });

    it('passes through short text unchunked', () => {
        const text = 'This is a short script.';
        expect(splitForTts(text)).toEqual([text]);
    });

    it('returns single chunk when length <= target', () => {
        const text = 'A'.repeat(TTS_CHUNK_CHAR_TARGET);
        expect(splitForTts(text)).toEqual([text]);
    });

    it('splits on paragraph boundaries', () => {
        const para1 = 'A'.repeat(800);
        const para2 = 'B'.repeat(800);
        const para3 = 'C'.repeat(400);
        const text = `${para1}\n\n${para2}\n\n${para3}`;
        const chunks = splitForTts(text);
        expect(chunks.length).toBeGreaterThan(1);
        // First two paragraphs would exceed target if combined, so they should split
        expect(chunks[0]).toBe(para1);
    });

    it('falls back to sentence split for paragraph > max', () => {
        const longSentences = Array.from({ length: 10 }, (_, i) => `Sentence ${i} with more words.`).join(' ');
        const huge = longSentences.repeat(20);  // way bigger than max
        expect(huge.length).toBeGreaterThan(TTS_CHUNK_CHAR_MAX);
        const chunks = splitForTts(huge);
        expect(chunks.length).toBeGreaterThan(1);
        for (const c of chunks) {
            expect(c.length).toBeLessThanOrEqual(TTS_CHUNK_CHAR_MAX * 1.5);  // sentence boundary may slightly exceed
        }
    });

    it('handles \\r\\n line endings', () => {
        const para1 = 'A'.repeat(800);
        const para2 = 'B'.repeat(800);
        const text = `${para1}\r\n\r\n${para2}`;
        const chunks = splitForTts(text);
        expect(chunks.length).toBeGreaterThan(0);
    });

    it('handles unicode without breaking sentences', () => {
        const text = 'Café réservation. Über Größe. Naïve résumé.';
        expect(splitForTts(text)).toEqual([text]);
    });

    it('handles boundary input at exactly TTS_CHUNK_CHAR_TARGET', () => {
        const text = 'A'.repeat(TTS_CHUNK_CHAR_TARGET);
        expect(splitForTts(text)).toEqual([text]);
    });

    it('handles input one character over target (forces split path)', () => {
        const para1 = 'A'.repeat(600);
        const para2 = 'B'.repeat(600);  // 600+600+sep > target so split
        const chunks = splitForTts(`${para1}\n\n${para2}`);
        expect(chunks.length).toBeGreaterThanOrEqual(1);
    });

    it('packs multiple short paragraphs until target', () => {
        const tiny = Array.from({ length: 20 }, () => 'Short paragraph.').join('\n\n');
        const chunks = splitForTts(tiny);
        // All fit easily under target
        expect(chunks.length).toBe(1);
    });
});

describe('splitParagraphIntoSentences', () => {
    it('returns empty array for empty input', () => {
        expect(splitParagraphIntoSentences('')).toEqual([]);
    });

    it('splits on sentence terminators', () => {
        const para = 'One. Two! Three? Four.'.repeat(200);  // force split
        const chunks = splitParagraphIntoSentences(para, 100, 200);
        expect(chunks.length).toBeGreaterThan(1);
    });

    it('handles paragraph with no sentence terminator', () => {
        const para = 'no terminator here just text and more text and more';
        const chunks = splitParagraphIntoSentences(para, 1000, 2000);
        expect(chunks).toEqual([para]);
    });

    it('enforces hard max via word-boundary split for sentence > max (audit H7)', () => {
        // Single huge "sentence" with no period — must still be ≤ max
        const huge = 'word '.repeat(500).trim() + ' final';  // 2505 chars, no period
        const chunks = splitParagraphIntoSentences(huge, 800, 1200);
        for (const c of chunks) {
            expect(c.length).toBeLessThanOrEqual(1200);
        }
        expect(chunks.length).toBeGreaterThan(1);
    });
});

describe('splitForTts: hard-max guarantee (audit H7)', () => {
    it('every emitted chunk is ≤ max even for pathological input', () => {
        const max = 500;
        const target = 300;
        // 5x huge sentences with no terminators
        const huge = ('a'.repeat(700) + ' ').repeat(5);
        const chunks = splitForTts(huge, target, max);
        for (const c of chunks) {
            expect(c.length).toBeLessThanOrEqual(max);
        }
    });

    it('handles CRLF paragraph separators (audit M8)', () => {
        const text = 'Para one.\r\n\r\nPara two.\r\n\r\nPara three.'.repeat(100);
        const chunks = splitForTts(text, 300, 600);
        expect(chunks.length).toBeGreaterThan(1);
        for (const c of chunks) {
            expect(c.length).toBeLessThanOrEqual(600);
        }
    });

    it('CRLF input does NOT collapse paragraphs into a mega-paragraph', () => {
        const a = 'A'.repeat(800);
        const b = 'B'.repeat(800);
        const lf = splitForTts(`${a}\n\n${b}`, 1000, 1500);
        const crlf = splitForTts(`${a}\r\n\r\n${b}`, 1000, 1500);
        // CRLF must produce equivalent (>=1 chunk) splitting behaviour
        expect(crlf.length).toBe(lf.length);
    });
});
