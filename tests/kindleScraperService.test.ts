// @vitest-environment happy-dom
/**
 * Kindle Scraper Service Tests (v2)
 *
 * Tests for HTML parsing (book list, highlights), ID generation,
 * toKindleBook conversion.
 *
 * Uses happy-dom environment for DOMParser availability.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    parseBookListHTML,
    parseHighlightsHTML,
    stripAuthorPrefix,
    setPreScrapedBooks,
    consumePreScrapedBooks,
} from '../src/services/kindle/kindleScraperService';
import {
    generateAmazonHighlightId,
    toKindleBook,
} from '../src/services/kindle/kindleTypes';
import type { KindleScrapedBook, KindleHighlight } from '../src/services/kindle/kindleTypes';
import { NON_BOOK_IDS } from '../src/services/kindle/kindleBookmarklet';

// =========================================================================
// Fixture loading
// =========================================================================

const FIXTURE_DIR = path.join(__dirname, 'fixtures');

function loadFixture(filename: string): string {
    return fs.readFileSync(path.join(FIXTURE_DIR, filename), 'utf-8');
}

// =========================================================================
// parseBookListHTML
// =========================================================================

describe('Kindle Scraper Service', () => {
    describe('parseBookListHTML', () => {
        it('parses 3 books from .com fixture', () => {
            const html = loadFixture('amazon-notebook-books-com.html');
            const books = parseBookListHTML(html);
            expect(books).toHaveLength(3);
        });

        it('extracts correct ASINs from element IDs', () => {
            const html = loadFixture('amazon-notebook-books-com.html');
            const books = parseBookListHTML(html);
            const asins = books.map(b => b.asin).sort();
            expect(asins).toEqual(['B003JTHWJQ', 'B07XGF18MC', 'B08N5WRWNW']);
        });

        it('extracts correct titles and authors', () => {
            const html = loadFixture('amazon-notebook-books-com.html');
            const books = parseBookListHTML(html);
            const byAsin = new Map(books.map(b => [b.asin, b]));

            expect(byAsin.get('B08N5WRWNW')!.title).toBe('Atomic Habits');
            // stripAuthorPrefix removes "by " prefix from Amazon HTML
            expect(byAsin.get('B08N5WRWNW')!.author).toBe('James Clear');

            expect(byAsin.get('B07XGF18MC')!.title).toBe('The Psychology of Money');
            expect(byAsin.get('B07XGF18MC')!.author).toBe('Morgan Housel');

            expect(byAsin.get('B003JTHWJQ')!.title).toBe('Thinking, Fast and Slow');
            expect(byAsin.get('B003JTHWJQ')!.author).toBe('Daniel Kahneman');
        });

        it('extracts correct highlight counts', () => {
            const html = loadFixture('amazon-notebook-books-com.html');
            const books = parseBookListHTML(html);
            const byAsin = new Map(books.map(b => [b.asin, b]));

            expect(byAsin.get('B08N5WRWNW')!.highlightCount).toBe(42);
            expect(byAsin.get('B07XGF18MC')!.highlightCount).toBe(28);
            expect(byAsin.get('B003JTHWJQ')!.highlightCount).toBe(15);
        });

        it('extracts highlight count from data attributes when text is not rendered yet', () => {
            const html = `
                <div id="kp-notebook-library-B08N5WRWNW" class="kp-notebook-library-each-book" data-annotation-count="42">
                    <h2>Atomic Habits</h2>
                    <p>by James Clear</p>
                </div>
            `;
            const books = parseBookListHTML(html);
            expect(books).toHaveLength(1);
            expect(books[0].highlightCount).toBe(42);
        });

        it('returns empty array for empty library fixture', () => {
            const html = loadFixture('amazon-empty-library.html');
            const books = parseBookListHTML(html);
            expect(books).toEqual([]);
        });

        it('returns empty array for login page (auth expired)', () => {
            const html = loadFixture('amazon-login-page.html');
            const books = parseBookListHTML(html);
            expect(books).toEqual([]);
        });
    });

    // =========================================================================
    // parseHighlightsHTML
    // =========================================================================

    describe('parseHighlightsHTML', () => {
        const ASIN = 'B08N5WRWNW';

        it('parses exactly 4 highlights from fixture (no duplicates)', () => {
            const html = loadFixture('amazon-notebook-highlights.html');
            const highlights = parseHighlightsHTML(html, ASIN);
            // Dedup logic ensures inner text divs are not counted as separate highlights
            expect(highlights).toHaveLength(4);
        });

        it('extracts highlight text correctly', () => {
            const html = loadFixture('amazon-notebook-highlights.html');
            const highlights = parseHighlightsHTML(html, ASIN);
            const texts = highlights.map(h => h.text);

            // Verify key highlight texts are present (may appear in both outer and inner elements)
            expect(texts.some(t => t.includes('You do not rise to the level of your goals'))).toBe(true);
            expect(texts.some(t => t.includes('Every action you take is a vote'))).toBe(true);
            expect(texts.some(t => t.includes('Habits are the compound interest'))).toBe(true);
            expect(texts.some(t => t.includes('most effective way to change your habits'))).toBe(true);
        });

        it('extracts colors from class names (yellow, blue, pink, orange)', () => {
            const html = loadFixture('amazon-notebook-highlights.html');
            const highlights = parseHighlightsHTML(html, ASIN);
            const colors = new Set(highlights.map(h => h.color).filter(Boolean));

            expect(colors.has('yellow')).toBe(true);
            expect(colors.has('blue')).toBe(true);
            expect(colors.has('pink')).toBe(true);
            expect(colors.has('orange')).toBe(true);
        });

        it('extracts locations from metadata', () => {
            const html = loadFixture('amazon-notebook-highlights.html');
            const highlights = parseHighlightsHTML(html, ASIN);
            const locations = highlights.map(h => h.location).filter(Boolean);

            // At least some highlights should have locations extracted
            expect(locations.length).toBeGreaterThan(0);
            // Check known locations from the fixture
            expect(locations.some(l => l === '1406-1407')).toBe(true);
        });

        it('extracts notes when present', () => {
            const html = loadFixture('amazon-notebook-highlights.html');
            const highlights = parseHighlightsHTML(html, ASIN);
            const withNotes = highlights.filter(h => h.note);

            // The fixture has exactly one note on highlight 3
            expect(withNotes).toHaveLength(1);
            expect(withNotes[0].note).toBe('This is the key insight');
        });

        it('generates correct Amazon highlight IDs (ka- prefix)', () => {
            const html = loadFixture('amazon-notebook-highlights.html');
            const highlights = parseHighlightsHTML(html, ASIN);

            for (const h of highlights) {
                expect(h.id).toMatch(/^ka-[0-9a-f]{8}$/);
            }
        });

        it('preserves same text highlighted at different locations', () => {
            // Regression: dedup must use text+location, not text alone
            const html = `
                <div id="highlight-B123-1" class="a-row kp-notebook-highlight kp-notebook-highlight-yellow">
                    <span class="kp-notebook-metadata">Yellow highlight | Location 100-101</span>
                    <div id="highlight-1" class="kp-notebook-highlight-text">Important sentence</div>
                </div>
                <div id="highlight-B123-2" class="a-row kp-notebook-highlight kp-notebook-highlight-blue">
                    <span class="kp-notebook-metadata">Blue highlight | Location 500-501</span>
                    <div id="highlight-2" class="kp-notebook-highlight-text">Important sentence</div>
                </div>
            `;
            const highlights = parseHighlightsHTML(html, 'B123');
            expect(highlights).toHaveLength(2);
            expect(highlights[0].location).toBe('100-101');
            expect(highlights[1].location).toBe('500-501');
        });

        it('deduplicates identical text at the same location', () => {
            const html = `
                <div id="highlight-B123-1" class="a-row kp-notebook-highlight kp-notebook-highlight-yellow">
                    <span class="kp-notebook-metadata">Yellow highlight | Location 100-101</span>
                    <div id="highlight-1" class="kp-notebook-highlight-text">Duplicate text</div>
                </div>
                <div id="highlight-B123-2" class="a-row kp-notebook-highlight kp-notebook-highlight-yellow">
                    <span class="kp-notebook-metadata">Yellow highlight | Location 100-101</span>
                    <div id="highlight-2" class="kp-notebook-highlight-text">Duplicate text</div>
                </div>
            `;
            const highlights = parseHighlightsHTML(html, 'B123');
            expect(highlights).toHaveLength(1);
        });

        it('parses legacy row markup with #highlight/#note/#kp-annotation-location fields', () => {
            const html = `
                <div class="a-row a-spacing-base">
                    <span id="annotationNoteHeader">Yellow highlight | Page 44</span>
                    <input id="kp-annotation-location" value="1120-1121" />
                    <div class="kp-notebook-highlight kp-notebook-highlight-yellow">
                        <span id="highlight">Legacy highlight one</span>
                    </div>
                    <div class="kp-notebook-note">
                        <span id="note">Legacy note one</span>
                    </div>
                </div>
                <div class="a-row a-spacing-base">
                    <span id="annotationNoteHeader">Blue highlight | Page 45</span>
                    <input id="kp-annotation-location" value="1180-1181" />
                    <div class="kp-notebook-highlight kp-notebook-highlight-blue">
                        <span id="highlight">Legacy highlight two</span>
                    </div>
                </div>
            `;
            const highlights = parseHighlightsHTML(html, 'BLEGACY01');
            expect(highlights).toHaveLength(2);
            expect(highlights[0].text).toBe('Legacy highlight one');
            expect(highlights[0].note).toBe('Legacy note one');
            expect(highlights[0].location).toBe('1120-1121');
            expect(highlights[0].page).toBe(44);
            expect(highlights[1].text).toBe('Legacy highlight two');
            expect(highlights[1].location).toBe('1180-1181');
            expect(highlights[1].page).toBe(45);
        });

        it('parses multiple highlights when wrapped by one outer kp-notebook-highlight container', () => {
            const html = `
                <div class="a-row kp-notebook-highlight">
                    <div class="a-row a-spacing-base">
                        <span class="kp-notebook-metadata">Yellow highlight | Location 10-11</span>
                        <div class="kp-notebook-highlight-text">Wrapped highlight one</div>
                    </div>
                    <div class="a-row a-spacing-base">
                        <span class="kp-notebook-metadata">Blue highlight | Location 20-21</span>
                        <div class="kp-notebook-highlight-text">Wrapped highlight two</div>
                    </div>
                </div>
            `;
            const highlights = parseHighlightsHTML(html, 'BWRAPPED01');
            expect(highlights).toHaveLength(2);
            expect(highlights.some(h => h.text === 'Wrapped highlight one')).toBe(true);
            expect(highlights.some(h => h.text === 'Wrapped highlight two')).toBe(true);
        });
    });

    // =========================================================================
    // generateAmazonHighlightId
    // =========================================================================

    describe('generateAmazonHighlightId', () => {
        it('generates deterministic IDs (same input produces same output)', () => {
            const id1 = generateAmazonHighlightId('B08N5WRWNW', '1406-1407', 'Some text');
            const id2 = generateAmazonHighlightId('B08N5WRWNW', '1406-1407', 'Some text');
            expect(id1).toBe(id2);
        });

        it('different inputs produce different IDs', () => {
            const id1 = generateAmazonHighlightId('B08N5WRWNW', '1406-1407', 'Text A');
            const id2 = generateAmazonHighlightId('B08N5WRWNW', '1406-1407', 'Text B');
            expect(id1).not.toBe(id2);
        });

        it('uses ka- prefix (not kh-)', () => {
            const id = generateAmazonHighlightId('B08N5WRWNW', '1406', 'test');
            expect(id).toMatch(/^ka-/);
            expect(id).not.toMatch(/^kh-/);
        });

        it('handles empty location gracefully', () => {
            const id = generateAmazonHighlightId('B08N5WRWNW', '', 'Some text');
            expect(id).toMatch(/^ka-[0-9a-f]{8}$/);
        });

        it('different ASINs produce different IDs even with same text', () => {
            const id1 = generateAmazonHighlightId('ASIN1', '100', 'same text');
            const id2 = generateAmazonHighlightId('ASIN2', '100', 'same text');
            expect(id1).not.toBe(id2);
        });
    });

    // =========================================================================
    // toKindleBook
    // =========================================================================

    describe('toKindleBook', () => {
        const scrapedBook: KindleScrapedBook = {
            asin: 'B08N5WRWNW',
            title: 'Atomic Habits',
            author: 'James Clear',
            imageUrl: 'https://example.com/cover.jpg',
            highlightCount: 42,
        };

        const highlights: KindleHighlight[] = [
            { id: 'ka-00000001', text: 'First highlight.' },
            { id: 'ka-00000002', text: 'Second highlight.' },
            { id: 'ka-00000003', text: 'Third highlight.' },
        ];

        it('converts KindleScrapedBook + highlights to KindleBook', () => {
            const book = toKindleBook(scrapedBook, highlights);

            expect(book.asin).toBe('B08N5WRWNW');
            expect(book.title).toBe('Atomic Habits');
            expect(book.author).toBe('James Clear');
            expect(book.imageUrl).toBe('https://example.com/cover.jpg');
            expect(book.highlights).toBe(highlights);
        });

        it('sets highlightCount from highlights array length', () => {
            const book = toKindleBook(scrapedBook, highlights);
            // highlightCount should reflect actual highlights, not scraped count
            expect(book.highlightCount).toBe(3);
        });

        it('preserves all fields from scraped book', () => {
            const scrapedWithDate: KindleScrapedBook = {
                ...scrapedBook,
                lastAnnotatedDate: '2026-01-15T10:00:00Z',
            };
            const book = toKindleBook(scrapedWithDate, highlights);

            expect(book.lastAnnotatedDate).toBe('2026-01-15T10:00:00Z');
        });
    });

    // =========================================================================
    // stripAuthorPrefix
    // =========================================================================

    describe('stripAuthorPrefix', () => {
        it('strips English "by " prefix', () => {
            expect(stripAuthorPrefix('by James Clear')).toBe('James Clear');
        });

        it('strips German "von " prefix', () => {
            expect(stripAuthorPrefix('von Daniel Kahneman')).toBe('Daniel Kahneman');
        });

        it('strips French "de " prefix', () => {
            expect(stripAuthorPrefix('de Victor Hugo')).toBe('Victor Hugo');
        });

        it('strips Italian "di " prefix', () => {
            expect(stripAuthorPrefix('di Italo Calvino')).toBe('Italo Calvino');
        });

        it('strips Portuguese "por " prefix', () => {
            expect(stripAuthorPrefix('por Paulo Coelho')).toBe('Paulo Coelho');
        });

        it('is case-insensitive', () => {
            expect(stripAuthorPrefix('By Morgan Housel')).toBe('Morgan Housel');
            expect(stripAuthorPrefix('BY Author Name')).toBe('Author Name');
        });

        it('does not strip when no prefix present', () => {
            expect(stripAuthorPrefix('James Clear')).toBe('James Clear');
        });

        it('does not strip partial matches', () => {
            // "by" at start of name should not be stripped without space
            expect(stripAuthorPrefix('Byron Katie')).toBe('Byron Katie');
        });
    });

    // =====================================================================
    // Pre-Scraped Books Cache
    // =====================================================================

    describe('setPreScrapedBooks / consumePreScrapedBooks', () => {
        afterEach(() => {
            // Consume any leftover cache to avoid inter-test pollution
            consumePreScrapedBooks();
        });

        it('returns null when nothing has been set', () => {
            expect(consumePreScrapedBooks()).toBeNull();
        });

        it('returns cached books and clears the cache', () => {
            const books: KindleScrapedBook[] = [
                { asin: 'B123', title: 'Test', author: 'Auth', highlightCount: 5 },
            ];
            setPreScrapedBooks(books);
            const result = consumePreScrapedBooks();
            expect(result).toHaveLength(1);
            expect(result![0].asin).toBe('B123');

            // Second call should return null (consumed)
            expect(consumePreScrapedBooks()).toBeNull();
        });

        it('overwrites previous cache when set again', () => {
            setPreScrapedBooks([{ asin: 'A', title: 'A', author: 'A', highlightCount: 0 }]);
            setPreScrapedBooks([{ asin: 'B', title: 'B', author: 'B', highlightCount: 0 }]);
            const result = consumePreScrapedBooks();
            expect(result).toHaveLength(1);
            expect(result![0].asin).toBe('B');
        });

        it('cache is not reusable across multiple consume calls (prevents stale reuse)', () => {
            setPreScrapedBooks([{ asin: 'X', title: 'X', author: 'X', highlightCount: 0 }]);
            consumePreScrapedBooks(); // first consume
            // Simulate a second sync session — cache must be empty
            expect(consumePreScrapedBooks()).toBeNull();
        });
    });

    // =====================================================================
    // parseBookListHTML — Non-book ID filtering
    // =====================================================================

    describe('parseBookListHTML non-book filtering', () => {
        it('filters out spinner/load-error/no-results placeholder elements', () => {
            const html = `
                <div id="kp-notebook-library-spinner"></div>
                <div id="kp-notebook-library-load-error"></div>
                <div id="kp-notebook-library-no-results"></div>
                <div id="kp-notebook-library-B08N5WRWNW">
                    <h2>Real Book</h2>
                    <p>by Real Author</p>
                    <img src="https://img.com/cover.jpg" />
                </div>
            `;
            const books = parseBookListHTML(html);
            const asins = books.map(b => b.asin);
            expect(asins).not.toContain('spinner');
            expect(asins).not.toContain('load-error');
            expect(asins).not.toContain('no-results');
        });

        it('filters ASINs shorter than 4 characters', () => {
            const html = `
                <div id="kp-notebook-library-AB">
                    <h2>Short ASIN</h2>
                    <p>by Author</p>
                </div>
            `;
            const books = parseBookListHTML(html);
            expect(books).toHaveLength(0);
        });

        it('filters additional non-book IDs (loading, placeholder, container, etc.)', () => {
            const html = `
                <div id="kp-notebook-library-loading"></div>
                <div id="kp-notebook-library-placeholder"></div>
                <div id="kp-notebook-library-container"></div>
                <div id="kp-notebook-library-header"></div>
                <div id="kp-notebook-library-B08N5WRWNW">
                    <h2>Real Book</h2>
                    <p>by Author</p>
                </div>
            `;
            const books = parseBookListHTML(html);
            expect(books).toHaveLength(1);
            expect(books[0].asin).toBe('B08N5WRWNW');
        });

        it('parses class-based book cards even when only placeholder ID cards exist', () => {
            const html = `
                <div id="kp-notebook-library-spinner"></div>
                <div id="kp-notebook-library-load-error"></div>
                <div id="kp-notebook-library-no-results"></div>
                <div class="kp-notebook-library-each-book" id="B07XGF18MC">
                    <h2 class="kp-notebook-searchable">The Psychology of Money</h2>
                    <p class="kp-notebook-searchable">by Morgan Housel</p>
                    <span>28 highlights</span>
                </div>
            `;
            const books = parseBookListHTML(html);
            expect(books).toHaveLength(1);
            expect(books[0].asin).toBe('B07XGF18MC');
            expect(books[0].title).toBe('The Psychology of Money');
            expect(books[0].author).toBe('Morgan Housel');
            expect(books[0].highlightCount).toBe(28);
        });

        it('extracts ASIN when element id is a raw 10-char ASIN', () => {
            const html = `
                <div class="kp-notebook-library-each-book" id="B08N5WRWNW">
                    <h2 class="kp-notebook-searchable">Atomic Habits</h2>
                    <p class="kp-notebook-searchable">by James Clear</p>
                </div>
            `;
            const books = parseBookListHTML(html);
            expect(books).toHaveLength(1);
            expect(books[0].asin).toBe('B08N5WRWNW');
        });

        it('extracts ASIN from data-asin fallback when ID not present', () => {
            // No kp-notebook-library- elements, but data-asin elements exist
            const html = `
                <div data-asin="B08N5WRWNW">
                    <h3>Atomic Habits</h3>
                    <p>by James Clear</p>
                </div>
            `;
            const books = parseBookListHTML(html);
            expect(books).toHaveLength(1);
            expect(books[0].asin).toBe('B08N5WRWNW');
            expect(books[0].title).toBe('Atomic Habits');
        });

        it('extracts ASIN from link href as last-resort fallback', () => {
            // No ID and no data-asin, but a link with asin= param inside library container
            const html = `
                <div id="kp-notebook-library">
                    <div id="some-other-id">
                        <h2>Deep Work</h2>
                        <a href="/notebook?asin=B07MBRX7VC">View</a>
                    </div>
                </div>
            `;
            const books = parseBookListHTML(html);
            expect(books).toHaveLength(1);
            expect(books[0].asin).toBe('B07MBRX7VC');
        });
    });

});
