/**
 * Kindle Clippings Parser Tests
 *
 * Tests for My Clippings.txt parsing, grouping, and deduplication.
 */

import { parseClippings } from '../src/services/kindle/kindleClippingsParser';
import { generateHighlightId, generateBookKey } from '../src/services/kindle/kindleTypes';

describe('Kindle Clippings Parser', () => {
    const SAMPLE_CLIPPING = `Thinking, Fast and Slow (Daniel Kahneman)
- Your Highlight on page 42 | location 1406-1407 | Added on Saturday, 26 March 2016 14:59:39

Nothing in life is as important as you think it is, while you are thinking about it.
==========`;

    const TWO_BOOKS = `Thinking, Fast and Slow (Daniel Kahneman)
- Your Highlight on page 42 | location 1406-1407 | Added on Saturday, 26 March 2016 14:59:39

Nothing in life is as important as you think it is, while you are thinking about it.
==========
Atomic Habits (James Clear)
- Your Highlight on page 15 | location 200-201 | Added on Monday, 1 January 2024 09:00:00

Every action you take is a vote for the type of person you wish to become.
==========`;

    describe('parseClippings', () => {
        it('should parse a single highlight entry', () => {
            const books = parseClippings(SAMPLE_CLIPPING);

            expect(books).toHaveLength(1);
            expect(books[0].title).toBe('Thinking, Fast and Slow');
            expect(books[0].author).toBe('Daniel Kahneman');
            expect(books[0].highlightCount).toBe(1);
            expect(books[0].highlights[0].text).toContain('Nothing in life is as important');
            expect(books[0].highlights[0].page).toBe(42);
            expect(books[0].highlights[0].location).toBe('1406-1407');
        });

        it('should group highlights by book', () => {
            const books = parseClippings(TWO_BOOKS);

            expect(books).toHaveLength(2);
            const titles = books.map(b => b.title).sort();
            expect(titles).toEqual(['Atomic Habits', 'Thinking, Fast and Slow']);
        });

        it('should handle multiple highlights from same book', () => {
            const content = `My Book (Author)
- Your Highlight on page 1 | location 10-11 | Added on Monday, 1 January 2024 09:00:00

First highlight.
==========
My Book (Author)
- Your Highlight on page 2 | location 20-21 | Added on Monday, 1 January 2024 10:00:00

Second highlight.
==========`;

            const books = parseClippings(content);

            expect(books).toHaveLength(1);
            expect(books[0].highlightCount).toBe(2);
            expect(books[0].highlights[0].text).toBe('First highlight.');
            expect(books[0].highlights[1].text).toBe('Second highlight.');
        });

        it('should deduplicate identical highlights', () => {
            const content = `My Book (Author)
- Your Highlight on page 1 | location 10-11 | Added on Monday, 1 January 2024 09:00:00

Same text repeated.
==========
My Book (Author)
- Your Highlight on page 1 | location 10-11 | Added on Tuesday, 2 January 2024 09:00:00

Same text repeated.
==========`;

            const books = parseClippings(content);

            expect(books).toHaveLength(1);
            expect(books[0].highlightCount).toBe(1);
        });

        it('should handle notes separately from highlights', () => {
            const content = `My Book (Author)
- Your Highlight on page 5 | location 50-51 | Added on Monday, 1 January 2024 09:00:00

Important passage.
==========
My Book (Author)
- Your Note on page 5 | location 50-51 | Added on Monday, 1 January 2024 09:01:00

My thoughts on this.
==========`;

            const books = parseClippings(content);

            expect(books).toHaveLength(1);
            // Note should be attached to the highlight at same location
            const highlight = books[0].highlights.find(h => h.text === 'Important passage.');
            expect(highlight).toBeDefined();
            expect(highlight!.note).toBe('My thoughts on this.');
        });

        it('should handle standalone notes (no matching highlight)', () => {
            const content = `My Book (Author)
- Your Note on page 99 | location 900-901 | Added on Monday, 1 January 2024 09:00:00

A standalone note without a highlight.
==========`;

            const books = parseClippings(content);

            expect(books).toHaveLength(1);
            expect(books[0].highlightCount).toBe(1);
            expect(books[0].highlights[0].note).toBe('A standalone note without a highlight.');
            expect(books[0].highlights[0].text).toBe('');
        });

        it('should skip bookmarks', () => {
            const content = `My Book (Author)
- Your Bookmark on page 10 | Added on Monday, 1 January 2024 09:00:00


==========`;

            const books = parseClippings(content);
            expect(books).toHaveLength(0);
        });

        it('should return empty array for empty input', () => {
            expect(parseClippings('')).toEqual([]);
            expect(parseClippings('  ')).toEqual([]);
        });

        it('should handle malformed entries gracefully', () => {
            const content = `This is not a valid entry
==========
Proper Book (Author)
- Your Highlight on page 1 | location 10-11 | Added on Monday, 1 January 2024 09:00:00

Valid highlight.
==========`;

            const books = parseClippings(content);

            expect(books).toHaveLength(1);
            expect(books[0].title).toBe('Proper Book');
        });

        it('should handle entries without page numbers', () => {
            const content = `My Book (Author)
- Your Highlight on location 500 | Added on Monday, 1 January 2024 09:00:00

Highlight without page.
==========`;

            const books = parseClippings(content);

            expect(books).toHaveLength(1);
            expect(books[0].highlights[0].page).toBeUndefined();
            expect(books[0].highlights[0].location).toBe('500');
        });

        it('should handle title without author parentheses', () => {
            const content = `Book Without Author
- Your Highlight on page 1 | location 10 | Added on Monday, 1 January 2024 09:00:00

Some text.
==========`;

            const books = parseClippings(content);

            expect(books).toHaveLength(1);
            expect(books[0].title).toBe('Book Without Author');
            expect(books[0].author).toBe('Unknown');
        });

        it('should handle Windows-style line endings (CRLF)', () => {
            const content = `My Book (Author)\r\n- Your Highlight on page 1 | location 10 | Added on Monday, 1 January 2024 09:00:00\r\n\r\nHighlight text.\r\n==========`;

            const books = parseClippings(content);

            expect(books).toHaveLength(1);
            expect(books[0].highlights[0].text).toBe('Highlight text.');
        });

        it('should sort books alphabetically by title', () => {
            const content = `Zebra Book (Author Z)
- Your Highlight on page 1 | location 10 | Added on Monday, 1 January 2024 09:00:00

Text Z.
==========
Alpha Book (Author A)
- Your Highlight on page 1 | location 10 | Added on Monday, 1 January 2024 09:00:00

Text A.
==========`;

            const books = parseClippings(content);

            expect(books[0].title).toBe('Alpha Book');
            expect(books[1].title).toBe('Zebra Book');
        });

        it('should track lastAnnotatedDate from most recent entry', () => {
            const content = `My Book (Author)
- Your Highlight on page 1 | location 10 | Added on Monday, 1 January 2024 09:00:00

First.
==========
My Book (Author)
- Your Highlight on page 2 | location 20 | Added on Friday, 15 March 2024 14:30:00

Second.
==========`;

            const books = parseClippings(content);

            expect(books[0].lastAnnotatedDate).toContain('Friday, 15 March 2024');
        });

        it('should handle multi-line highlight text', () => {
            const content = `My Book (Author)
- Your Highlight on page 1 | location 10-15 | Added on Monday, 1 January 2024 09:00:00

First line of the highlight.
Second line continues here.
Third line as well.
==========`;

            const books = parseClippings(content);

            expect(books[0].highlights[0].text).toContain('First line');
            expect(books[0].highlights[0].text).toContain('Second line');
            expect(books[0].highlights[0].text).toContain('Third line');
        });
    });
});

describe('Kindle Types - Hash Functions', () => {
    describe('generateHighlightId', () => {
        it('should generate deterministic IDs', () => {
            const id1 = generateHighlightId('same text');
            const id2 = generateHighlightId('same text');
            expect(id1).toBe(id2);
        });

        it('should generate different IDs for different text', () => {
            const id1 = generateHighlightId('text one');
            const id2 = generateHighlightId('text two');
            expect(id1).not.toBe(id2);
        });

        it('should prefix with kh-', () => {
            const id = generateHighlightId('any text');
            expect(id).toMatch(/^kh-[0-9a-f]{8}$/);
        });
    });

    describe('generateBookKey', () => {
        it('should be case-insensitive', () => {
            const key1 = generateBookKey('My Book', 'Author');
            const key2 = generateBookKey('my book', 'author');
            expect(key1).toBe(key2);
        });

        it('should prefix with kb-', () => {
            const key = generateBookKey('Title', 'Author');
            expect(key).toMatch(/^kb-[0-9a-f]{8}$/);
        });

        it('should trim whitespace', () => {
            const key1 = generateBookKey('  Title  ', '  Author  ');
            const key2 = generateBookKey('Title', 'Author');
            expect(key1).toBe(key2);
        });
    });
});
