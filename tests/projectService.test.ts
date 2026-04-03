/**
 * Tests for ProjectService and extractWikilinks utility
 */
import { describe, it, expect } from 'vitest';
import { extractWikilinks } from '../src/services/chat/projectService';

// Note: ProjectService requires Obsidian App (vault operations).
// We test the pure utility functions and parseable logic separately.

describe('extractWikilinks', () => {
    it('extracts simple wikilinks', () => {
        expect(extractWikilinks('[[Finance/Q3 Report]]')).toEqual(['Finance/Q3 Report']);
    });

    it('extracts multiple wikilinks', () => {
        expect(extractWikilinks('See [[Note A]] and [[Note B]]')).toEqual(['Note A', 'Note B']);
    });

    it('strips alias from wikilinks', () => {
        expect(extractWikilinks('[[Real Name|Display Name]]')).toEqual(['Real Name']);
    });

    it('returns empty array for no wikilinks', () => {
        expect(extractWikilinks('No links here')).toEqual([]);
    });

    it('handles wikilinks on multiple lines', () => {
        const text = '- [[File One]]\n- [[File Two]]\n- [[File Three]]';
        expect(extractWikilinks(text)).toEqual(['File One', 'File Two', 'File Three']);
    });

    it('trims whitespace inside wikilinks', () => {
        expect(extractWikilinks('[[ Spaced Note ]]')).toEqual(['Spaced Note']);
    });

    it('ignores malformed brackets', () => {
        expect(extractWikilinks('[single bracket]')).toEqual([]);
    });
});
