/**
 * Kindle Prompts Tests
 *
 * Tests for LLM prompt generation: book summary hooks and highlight theme grouping.
 * Validates prompt structure, XML tags, language injection, and highlight capping.
 */

import { buildBookSummaryPrompt, buildHighlightThemePrompt } from '../src/services/prompts/kindlePrompts';
import type { KindleBook, KindleHighlight } from '../src/services/kindle/kindleTypes';

function makeHighlight(overrides: Partial<KindleHighlight> = {}): KindleHighlight {
    return {
        id: 'kh-00000001',
        text: 'Test highlight text.',
        page: 42,
        location: '1406-1407',
        ...overrides,
    };
}

function makeBook(overrides: Partial<KindleBook> = {}): KindleBook {
    return {
        title: 'Atomic Habits',
        author: 'James Clear',
        highlightCount: 3,
        highlights: [
            makeHighlight({ id: 'kh-01', text: 'First highlight' }),
            makeHighlight({ id: 'kh-02', text: 'Second highlight' }),
            makeHighlight({ id: 'kh-03', text: 'Third highlight' }),
        ],
        ...overrides,
    };
}

describe('buildBookSummaryPrompt', () => {
    it('should include XML task/requirements/output_format tags', () => {
        const prompt = buildBookSummaryPrompt(makeBook(), makeBook().highlights, 'English');
        expect(prompt).toContain('<task>');
        expect(prompt).toContain('</task>');
        expect(prompt).toContain('<requirements>');
        expect(prompt).toContain('</requirements>');
        expect(prompt).toContain('<output_format>');
        expect(prompt).toContain('</output_format>');
    });

    it('should include book title and author', () => {
        const book = makeBook({ title: 'Deep Work', author: 'Cal Newport' });
        const prompt = buildBookSummaryPrompt(book, book.highlights, 'English');
        expect(prompt).toContain('Title: Deep Work');
        expect(prompt).toContain('Author: Cal Newport');
    });

    it('should include highlight count', () => {
        const book = makeBook({ highlightCount: 42 });
        const prompt = buildBookSummaryPrompt(book, book.highlights, 'English');
        expect(prompt).toContain('Total highlights: 42');
    });

    it('should inject language into requirements', () => {
        const prompt = buildBookSummaryPrompt(makeBook(), makeBook().highlights, 'French');
        expect(prompt).toContain('Write in French');
    });

    it('should include numbered highlight texts', () => {
        const prompt = buildBookSummaryPrompt(makeBook(), makeBook().highlights, 'English');
        expect(prompt).toContain('[1] First highlight');
        expect(prompt).toContain('[2] Second highlight');
        expect(prompt).toContain('[3] Third highlight');
    });

    it('should cap highlights at 30', () => {
        const highlights: KindleHighlight[] = Array.from({ length: 50 }, (_, i) =>
            makeHighlight({ id: `kh-${i}`, text: `Highlight number ${i}` })
        );
        const book = makeBook({ highlights, highlightCount: 50 });
        const prompt = buildBookSummaryPrompt(book, highlights, 'English');

        expect(prompt).toContain('[30] Highlight number 29');
        expect(prompt).not.toContain('[31]');
    });

    it('should filter out highlights with empty text', () => {
        const highlights = [
            makeHighlight({ id: 'kh-01', text: 'Valid highlight' }),
            makeHighlight({ id: 'kh-02', text: '' }),
            makeHighlight({ id: 'kh-03', text: 'Another valid' }),
        ];
        const prompt = buildBookSummaryPrompt(makeBook(), highlights, 'English');
        expect(prompt).toContain('[1] Valid highlight');
        expect(prompt).toContain('[2] Another valid');
        expect(prompt).not.toContain('[3]');
    });

    it('should mention 280 character limit', () => {
        const prompt = buildBookSummaryPrompt(makeBook(), makeBook().highlights, 'English');
        expect(prompt).toContain('280');
    });

    it('should include anti-patterns (do NOT start with)', () => {
        const prompt = buildBookSummaryPrompt(makeBook(), makeBook().highlights, 'English');
        expect(prompt).toContain('Do NOT start with');
    });
});

describe('buildHighlightThemePrompt', () => {
    it('should include XML task/requirements/output_format tags', () => {
        const prompt = buildHighlightThemePrompt(makeBook(), makeBook().highlights, 'English');
        expect(prompt).toContain('<task>');
        expect(prompt).toContain('</task>');
        expect(prompt).toContain('<requirements>');
        expect(prompt).toContain('</requirements>');
        expect(prompt).toContain('<output_format>');
        expect(prompt).toContain('</output_format>');
    });

    it('should include book title in task', () => {
        const book = makeBook({ title: 'Sapiens' });
        const prompt = buildHighlightThemePrompt(book, book.highlights, 'English');
        expect(prompt).toContain('Sapiens');
    });

    it('should inject language into requirements', () => {
        const prompt = buildHighlightThemePrompt(makeBook(), makeBook().highlights, 'Simplified Chinese');
        expect(prompt).toContain('Use Simplified Chinese for theme labels');
    });

    it('should use 0-indexed highlight numbering', () => {
        const prompt = buildHighlightThemePrompt(makeBook(), makeBook().highlights, 'English');
        expect(prompt).toContain('[0] First highlight');
        expect(prompt).toContain('[1] Second highlight');
        expect(prompt).toContain('[2] Third highlight');
    });

    it('should cap highlights at 50', () => {
        const highlights: KindleHighlight[] = Array.from({ length: 60 }, (_, i) =>
            makeHighlight({ id: `kh-${i}`, text: `Highlight ${i}` })
        );
        const prompt = buildHighlightThemePrompt(makeBook(), highlights, 'English');

        expect(prompt).toContain('[49] Highlight 49');
        expect(prompt).not.toContain('[50]');
    });

    it('should specify JSON output format', () => {
        const prompt = buildHighlightThemePrompt(makeBook(), makeBook().highlights, 'English');
        expect(prompt).toContain('Return JSON only');
        expect(prompt).toContain('"themes"');
        expect(prompt).toContain('"highlightIndexes"');
    });

    it('should specify 3-7 theme range', () => {
        const prompt = buildHighlightThemePrompt(makeBook(), makeBook().highlights, 'English');
        expect(prompt).toContain('3-7 themes');
    });

    it('should include cap transparency note when highlights exceed 50', () => {
        const highlights: KindleHighlight[] = Array.from({ length: 60 }, (_, i) =>
            makeHighlight({ id: `kh-${i}`, text: `Highlight ${i}` })
        );
        const book = makeBook({ highlights, highlightCount: 60 });
        const prompt = buildHighlightThemePrompt(book, highlights, 'English');
        expect(prompt).toContain('Showing 50 of 60 highlights');
    });

    it('should NOT include cap note when highlights are within limit', () => {
        const highlights: KindleHighlight[] = Array.from({ length: 30 }, (_, i) =>
            makeHighlight({ id: `kh-${i}`, text: `Highlight ${i}` })
        );
        const book = makeBook({ highlights, highlightCount: 30 });
        const prompt = buildHighlightThemePrompt(book, highlights, 'English');
        expect(prompt).not.toContain('Showing');
    });
});
