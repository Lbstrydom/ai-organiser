/**
 * Kindle Note Builder Tests
 *
 * Tests for markdown note generation from Kindle book highlights.
 */

import {
    buildBookNote,
    buildFrontmatter,
    formatHighlight,
    appendHighlightsToExisting,
} from '../src/services/kindle/kindleNoteBuilder';
import type { KindleBook, KindleHighlight } from '../src/services/kindle/kindleTypes';
import type { KindleNoteOptions } from '../src/services/kindle/kindleNoteBuilder';

const defaultOptions: KindleNoteOptions = {
    highlightStyle: 'blockquote',
    groupByColor: false,
    includeCoverImage: true,
};

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
        title: 'Thinking, Fast and Slow',
        author: 'Daniel Kahneman',
        highlightCount: 1,
        highlights: [makeHighlight()],
        ...overrides,
    };
}

describe('Kindle Note Builder', () => {
    describe('buildFrontmatter', () => {
        it('should include required fields', () => {
            const fm = buildFrontmatter(makeBook());

            expect(fm).toContain('title: "Thinking, Fast and Slow"');
            expect(fm).toContain('author: Daniel Kahneman');
            expect(fm).toContain('source: kindle');
            expect(fm).toContain('highlights_count: 1');
            expect(fm).toMatch(/last_synced: "\d{4}-\d{2}-\d{2}/);
            expect(fm).toContain('tags: []');
        });

        it('should wrap with YAML delimiters', () => {
            const fm = buildFrontmatter(makeBook());
            const lines = fm.split('\n');

            expect(lines[0]).toBe('---');
            expect(lines[lines.length - 2]).toBe('---');
        });

        it('should include ASIN when present', () => {
            const fm = buildFrontmatter(makeBook({ asin: 'B00XXXXXXXX' }));

            expect(fm).toContain('kindle_asin: B00XXXXXXXX');
        });

        it('should omit ASIN when absent', () => {
            const fm = buildFrontmatter(makeBook());

            expect(fm).not.toContain('kindle_asin');
        });

        it('should quote strings with special YAML characters', () => {
            const fm = buildFrontmatter(makeBook({ title: 'Book: A Study' }));

            expect(fm).toContain('"Book: A Study"');
        });
    });

    describe('formatHighlight', () => {
        describe('blockquote style', () => {
            it('should format with > prefix', () => {
                const result = formatHighlight(makeHighlight(), 'blockquote');

                expect(result).toContain('> Test highlight text.');
                expect(result).toContain('> — Page 42, Location 1406-1407');
            });

            it('should include note when present', () => {
                const h = makeHighlight({ note: 'My thoughts.' });
                const result = formatHighlight(h, 'blockquote');

                expect(result).toContain('**Note:** My thoughts.');
            });

            it('should handle highlight without page', () => {
                const h = makeHighlight({ page: undefined });
                const result = formatHighlight(h, 'blockquote');

                expect(result).toContain('> — Location 1406-1407');
                expect(result).not.toContain('Page');
            });

            it('should handle highlight without location', () => {
                const h = makeHighlight({ location: undefined });
                const result = formatHighlight(h, 'blockquote');

                expect(result).toContain('> — Page 42');
                expect(result).not.toContain('Location');
            });
        });

        describe('callout style', () => {
            it('should format with [!quote] header', () => {
                const result = formatHighlight(makeHighlight(), 'callout');

                expect(result).toContain('> [!quote] Page 42, Location 1406-1407');
                expect(result).toContain('> Test highlight text.');
            });

            it('should include note inside callout', () => {
                const h = makeHighlight({ note: 'Interesting.' });
                const result = formatHighlight(h, 'callout');

                expect(result).toContain('> **Note:** Interesting.');
            });

            it('should handle no location info', () => {
                const h = makeHighlight({ page: undefined, location: undefined });
                const result = formatHighlight(h, 'callout');

                expect(result).toContain('> [!quote]');
                expect(result).not.toContain('Page');
            });
        });

        describe('bullet style', () => {
            it('should format as list item', () => {
                const result = formatHighlight(makeHighlight(), 'bullet');

                expect(result).toMatch(/^- Test highlight text\. — \*Page 42, Location 1406-1407\*/);
            });

            it('should include note as sub-item', () => {
                const h = makeHighlight({ note: 'A note.' });
                const result = formatHighlight(h, 'bullet');

                expect(result).toContain('  - **Note:** A note.');
            });

            it('should omit location suffix when no location info', () => {
                const h = makeHighlight({ page: undefined, location: undefined });
                const result = formatHighlight(h, 'bullet');

                expect(result).toBe('- Test highlight text.');
            });
        });

        it('should return empty string for highlight without text', () => {
            const h = makeHighlight({ text: '' });
            const result = formatHighlight(h, 'blockquote');

            expect(result).toBe('');
        });
    });

    describe('buildBookNote', () => {
        it('should include frontmatter, title, and author', () => {
            const note = buildBookNote(makeBook(), defaultOptions);

            expect(note).toContain('---');
            expect(note).toContain('# Thinking, Fast and Slow');
            expect(note).toContain('*by Daniel Kahneman*');
        });

        it('should include highlights section', () => {
            const note = buildBookNote(makeBook(), defaultOptions);

            expect(note).toContain('## Highlights');
            expect(note).toContain('Test highlight text.');
        });

        it('should include cover image when enabled and URL present', () => {
            const book = makeBook({ imageUrl: 'https://example.com/cover.jpg' });
            const note = buildBookNote(book, defaultOptions);

            expect(note).toContain('![cover](https://example.com/cover.jpg)');
        });

        it('should omit cover image when disabled', () => {
            const book = makeBook({ imageUrl: 'https://example.com/cover.jpg' });
            const opts = { ...defaultOptions, includeCoverImage: false };
            const note = buildBookNote(book, opts);

            expect(note).not.toContain('![cover]');
        });

        it('should omit cover image when URL absent', () => {
            const note = buildBookNote(makeBook(), defaultOptions);

            expect(note).not.toContain('![cover]');
        });

        it('should handle empty highlights gracefully', () => {
            const book = makeBook({ highlights: [], highlightCount: 0 });
            const note = buildBookNote(book, defaultOptions);

            expect(note).toContain('# Thinking, Fast and Slow');
            expect(note).not.toContain('## Highlights');
        });

        it('should render standalone notes section', () => {
            const book = makeBook({
                highlights: [
                    makeHighlight(),
                    makeHighlight({ id: 'kh-note', text: '', note: 'Standalone note here.' }),
                ],
                highlightCount: 2,
            });
            const note = buildBookNote(book, defaultOptions);

            expect(note).toContain('## Notes');
            expect(note).toContain('Standalone note here.');
        });

        it('should use callout style when configured', () => {
            const opts = { ...defaultOptions, highlightStyle: 'callout' as const };
            const note = buildBookNote(makeBook(), opts);

            expect(note).toContain('> [!quote]');
        });

        it('should use bullet style when configured', () => {
            const opts = { ...defaultOptions, highlightStyle: 'bullet' as const };
            const note = buildBookNote(makeBook(), opts);

            expect(note).toMatch(/^- Test highlight text/m);
        });
    });

    describe('buildBookNote with groupByColor', () => {
        it('should group highlights by color when enabled', () => {
            const book = makeBook({
                highlights: [
                    makeHighlight({ id: 'kh-1', text: 'Yellow text.', color: 'yellow' }),
                    makeHighlight({ id: 'kh-2', text: 'Blue text.', color: 'blue' }),
                    makeHighlight({ id: 'kh-3', text: 'Another yellow.', color: 'yellow' }),
                ],
                highlightCount: 3,
            });
            const opts = { ...defaultOptions, groupByColor: true };
            const note = buildBookNote(book, opts);

            expect(note).toContain('## Yellow Highlights');
            expect(note).toContain('## Blue Highlights');
        });

        it('should use "Highlights" label for highlights without color', () => {
            const book = makeBook({
                highlights: [
                    makeHighlight({ id: 'kh-1', text: 'No color.' }),
                ],
                highlightCount: 1,
            });
            const opts = { ...defaultOptions, groupByColor: true };
            const note = buildBookNote(book, opts);

            expect(note).toContain('## Highlights');
        });

        it('should follow color order: yellow, blue, pink, orange, none', () => {
            const book = makeBook({
                highlights: [
                    makeHighlight({ id: 'kh-1', text: 'Orange text.', color: 'orange' }),
                    makeHighlight({ id: 'kh-2', text: 'Yellow text.', color: 'yellow' }),
                    makeHighlight({ id: 'kh-3', text: 'Pink text.', color: 'pink' }),
                    makeHighlight({ id: 'kh-4', text: 'Blue text.', color: 'blue' }),
                ],
                highlightCount: 4,
            });
            const opts = { ...defaultOptions, groupByColor: true };
            const note = buildBookNote(book, opts);

            const yellowIdx = note.indexOf('## Yellow Highlights');
            const blueIdx = note.indexOf('## Blue Highlights');
            const pinkIdx = note.indexOf('## Pink Highlights');
            const orangeIdx = note.indexOf('## Orange Highlights');

            expect(yellowIdx).toBeLessThan(blueIdx);
            expect(blueIdx).toBeLessThan(pinkIdx);
            expect(pinkIdx).toBeLessThan(orangeIdx);
        });
    });

    describe('appendHighlightsToExisting', () => {
        const existingContent = `---
title: My Book
---

# My Book
*by Author*

## Highlights

> Old highlight here.
> — Page 1

## Notes

> [!note] Page 99
> A note.
`;

        it('should insert before Notes section', () => {
            const newHighlights = [makeHighlight({ text: 'New highlight text.' })];
            const result = appendHighlightsToExisting(existingContent, newHighlights, 'blockquote');

            const highlightIdx = result.indexOf('New highlight text.');
            const notesIdx = result.indexOf('## Notes');

            expect(highlightIdx).toBeGreaterThan(-1);
            expect(notesIdx).toBeGreaterThan(highlightIdx);
        });

        it('should append at end when no Notes section exists', () => {
            const contentNoNotes = `## Highlights

> Old highlight.
`;
            const newHighlights = [makeHighlight({ text: 'Appended highlight.' })];
            const result = appendHighlightsToExisting(contentNoNotes, newHighlights, 'blockquote');

            expect(result).toContain('Appended highlight.');
            expect(result.indexOf('Appended highlight.')).toBeGreaterThan(result.indexOf('Old highlight.'));
        });

        it('should return original content when no new highlights', () => {
            const result = appendHighlightsToExisting(existingContent, [], 'blockquote');

            expect(result).toBe(existingContent);
        });

        it('should skip note-only highlights (no text)', () => {
            const newHighlights = [makeHighlight({ text: '', note: 'Note only.' })];
            const result = appendHighlightsToExisting(existingContent, newHighlights, 'blockquote');

            expect(result).toBe(existingContent);
        });

        it('should format with the specified style', () => {
            const newHighlights = [makeHighlight({ text: 'Callout style highlight.' })];
            const result = appendHighlightsToExisting(existingContent, newHighlights, 'callout');

            expect(result).toContain('> [!quote]');
            expect(result).toContain('Callout style highlight.');
        });

        it('should handle multiple new highlights', () => {
            const newHighlights = [
                makeHighlight({ id: 'kh-a', text: 'First new.' }),
                makeHighlight({ id: 'kh-b', text: 'Second new.' }),
            ];
            const result = appendHighlightsToExisting(existingContent, newHighlights, 'blockquote');

            expect(result).toContain('First new.');
            expect(result).toContain('Second new.');
        });
    });
});
