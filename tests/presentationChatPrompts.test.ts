import { describe, it, expect } from 'vitest';
import {
    buildGenerationPrompt,
    buildBrandAuditPrompt,
    extractHtmlFromResponse,
    wrapInDocument,
    extractDeckTitle,
    countSlides,
} from '../src/services/prompts/presentationChatPrompts';

const dummyCss = ':root { --brand-primary: #1A3A5C; }';

// ── Generation Prompt ───────────────────────────────────────────────────────

describe('buildGenerationPrompt', () => {
    it('includes user query', () => {
        const prompt = buildGenerationPrompt({ userQuery: 'Make a pitch deck' });
        expect(prompt).toContain('Make a pitch deck');
    });

    it('includes note content when provided', () => {
        const prompt = buildGenerationPrompt({ userQuery: 'test', noteContent: 'My notes' });
        expect(prompt).toContain('note_content');
    });

    it('excludes note content when not provided', () => {
        const prompt = buildGenerationPrompt({ userQuery: 'test' });
        expect(prompt).not.toContain('note_content');
    });
});

// ── Brand Audit Prompt ──────────────────────────────────────────────────────

describe('buildBrandAuditPrompt', () => {
    it('includes rules and HTML', () => {
        const prompt = buildBrandAuditPrompt('<div>slides</div>', [
            { id: 'r1', description: 'No orange text' },
        ]);
        expect(prompt).toContain('[r1]');
        expect(prompt).toContain('No orange text');
        expect(prompt).toContain('<div>slides</div>');
    });

    it('requests JSON output', () => {
        const prompt = buildBrandAuditPrompt('<div>', []);
        expect(prompt).toContain('violations');
        expect(prompt).toContain('passed');
    });
});

// ── HTML Extraction ─────────────────────────────────────────────────────────

describe('extractHtmlFromResponse', () => {
    it('extracts from code fence', () => {
        const response = 'Here is the deck:\n```html\n<div class="deck">slides</div>\n```\nDone!';
        const html = extractHtmlFromResponse(response);
        expect(html).toContain('class="deck"');
    });

    it('extracts raw HTML', () => {
        const response = '<div class="deck" data-title="Test"><section class="slide">hi</section></div>';
        const html = extractHtmlFromResponse(response);
        expect(html).toContain('class="deck"');
    });

    it('extracts HTML with surrounding text', () => {
        const response = 'Sure! Here:\n<div class="deck"><section class="slide">hi</section></div>';
        const html = extractHtmlFromResponse(response);
        expect(html).toContain('class="deck"');
    });

    it('returns null for empty input', () => {
        expect(extractHtmlFromResponse('')).toBeNull();
        expect(extractHtmlFromResponse('  ')).toBeNull();
    });

    it('returns null for non-HTML text', () => {
        expect(extractHtmlFromResponse('Just some text without any HTML')).toBeNull();
    });
});

// ── Wrap in Document ────────────────────────────────────────────────────────

describe('wrapInDocument', () => {
    it('wraps deck HTML in full document', () => {
        const doc = wrapInDocument('<div class="deck">x</div>', dummyCss);
        expect(doc).toContain('<!DOCTYPE html>');
        expect(doc).toContain(dummyCss);
        expect(doc).toContain('class="deck"');
    });
});

// ── Deck Title Extraction ───────────────────────────────────────────────────

describe('extractDeckTitle', () => {
    it('extracts from data-title attribute', () => {
        expect(extractDeckTitle('<div class="deck" data-title="Q2 Review">')).toBe('Q2 Review');
    });

    it('falls back to first h1', () => {
        expect(extractDeckTitle('<h1>My Deck</h1>')).toBe('My Deck');
    });

    it('defaults to Presentation', () => {
        expect(extractDeckTitle('<div>no title</div>')).toBe('Presentation');
    });
});

// ── Slide Count ─────────────────────────────────────────────────────────────

describe('countSlides', () => {
    it('counts slide elements', () => {
        const html = '<section class="slide slide-title">1</section><section class="slide slide-content">2</section>';
        expect(countSlides(html)).toBe(2);
    });

    it('returns 0 for no slides', () => {
        expect(countSlides('<div>nothing</div>')).toBe(0);
    });
});
