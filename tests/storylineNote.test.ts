/**
 * Storyline-note classifier (presentation-demo-fixes B3) — pure, fence-aware.
 */
import { describe, it, expect } from 'vitest';
import { classifyStorylineNote, isStorylineNote } from '../src/services/chat/storylineNote';

const STORYLINE = [
    '# Deck title',
    '',
    '> **Thesis:** something',
    '',
    '## EMEA grew 30% — the so-what',
    '<!-- aio-slide:1 eyJpZCI6InMxIn0= -->',
    '',
    '- core message',
    '> visual: bar',
].join('\n');

describe('classifyStorylineNote', () => {
    it('ok: slide anchor under a heading, outside fences', () => {
        expect(classifyStorylineNote(STORYLINE).kind).toBe('ok');
        expect(isStorylineNote(STORYLINE)).toBe(true);
    });

    it('empty: blank body', () => {
        expect(classifyStorylineNote('   \n\n').kind).toBe('empty');
    });

    it('not-storyline: plain note with no anchors', () => {
        const plain = '# Meeting notes\n\n- discussed roadmap\n- next steps';
        expect(classifyStorylineNote(plain).kind).toBe('not-storyline');
        expect(isStorylineNote(plain)).toBe(false);
    });

    it('fence-aware (R3-L1): an aio-slide anchor inside a code fence is NOT a storyline', () => {
        const fenced = [
            '# How storylines work',
            '',
            'Example of the hidden anchor format:',
            '',
            '```',
            '## A heading',
            '<!-- aio-slide:1 abc= -->',
            '```',
            '',
            'That is just documentation.',
        ].join('\n');
        expect(classifyStorylineNote(fenced).kind).toBe('not-storyline');
    });

    it('folder hint alone does not qualify a non-anchored note', () => {
        const plain = '# Random note in the folder\n\njust text';
        expect(isStorylineNote(plain)).toBe(false);
    });

    it('anchor present but no heading → not-storyline', () => {
        const noHeading = 'just text\n<!-- aio-slide:1 abc= -->\nmore text';
        expect(classifyStorylineNote(noHeading).kind).toBe('not-storyline');
    });
});
