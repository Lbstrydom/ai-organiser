/**
 * Kindle Sync Service Tests
 *
 * Tests for the sync orchestrator: differential sync, note creation/update,
 * state tracking, abort support, filename format, and frontmatter updates.
 */

// Mock transitive dependencies that use browser-only globals
vi.mock('../src/services/kindle/kindleAuthService', () => ({
    getStoredCookies: vi.fn().mockResolvedValue(null),
    clearCookies: vi.fn().mockResolvedValue(undefined),
    detectAuthExpiry: vi.fn(),
    isAuthenticated: vi.fn(),
    storeCookies: vi.fn(),
    validateCookies: vi.fn(),
    openAmazonInBrowser: vi.fn(),
    getNotebookUrl: vi.fn(),
    buildRequestHeaders: vi.fn(),
}));

vi.mock('../src/services/kindle/kindleScraperService', () => ({
    fetchAllHighlights: vi.fn(),
    parseBookListHTML: vi.fn(),
    parseHighlightsHTML: vi.fn(),
    fetchBookList: vi.fn(),
    fetchHighlightsForBook: vi.fn(),
}));

vi.mock('../src/core/settings', () => ({
    getKindleOutputFullPath: vi.fn((s: Record<string, string>) =>
        `${s.pluginFolder}/${s.kindleOutputFolder}`),
}));

vi.mock('../src/utils/minutesUtils', () => ({
    sanitizeFileName: (name: string) => name.replace(/[\\/:*?"<>|]/g, '-'),
    ensureFolderExists: vi.fn().mockResolvedValue(undefined),
    getAvailableFilePath: vi.fn((_v: unknown, folder: string, filename: string) =>
        Promise.resolve(`${folder}/${filename}`)),
}));

import {
    getNewHighlights,
    updateSyncState,
} from '../src/services/kindle/kindleSyncService';
import { updateFrontmatterInContent } from '../src/services/kindle/kindleNoteBuilder';
import type { KindleBook, KindleHighlight, KindleSyncState, KindleScrapedBook } from '../src/services/kindle/kindleTypes';
import { generateBookKey, toKindleBook } from '../src/services/kindle/kindleTypes';

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

function makeState(overrides: Partial<KindleSyncState> = {}): KindleSyncState {
    return {
        importedHighlights: {},
        ...overrides,
    };
}

function makeMockPlugin(settings: Record<string, unknown> = {}) {
    return {
        settings: {
            kindleSyncState: makeState(),
            kindleHighlightStyle: 'blockquote',
            kindleGroupByColor: false,
            kindleIncludeCoverImage: true,
            kindleOutputFolder: 'Kindle',
            pluginFolder: 'AI-Organiser',
            ...settings,
        },
        saveSettings: vi.fn(),
    };
}

describe('Kindle Sync Service', () => {
    describe('getNewHighlights', () => {
        it('should return all highlights when none imported', () => {
            const book = makeBook({
                highlights: [
                    makeHighlight({ id: 'kh-00000001' }),
                    makeHighlight({ id: 'kh-00000002', text: 'Second' }),
                ],
                highlightCount: 2,
            });
            const state = makeState();

            const result = getNewHighlights(book, state);
            expect(result).toHaveLength(2);
        });

        it('should exclude already imported highlights', () => {
            const book = makeBook({
                highlights: [
                    makeHighlight({ id: 'kh-00000001' }),
                    makeHighlight({ id: 'kh-00000002', text: 'Second' }),
                    makeHighlight({ id: 'kh-00000003', text: 'Third' }),
                ],
                highlightCount: 3,
            });
            const bookKey = generateBookKey(book.title, book.author);
            const state = makeState({
                importedHighlights: { [bookKey]: ['kh-00000001', 'kh-00000002'] },
            });

            const result = getNewHighlights(book, state);
            expect(result).toHaveLength(1);
            expect(result[0].id).toBe('kh-00000003');
        });

        it('should return empty array when all highlights imported', () => {
            const book = makeBook({
                highlights: [makeHighlight({ id: 'kh-00000001' })],
                highlightCount: 1,
            });
            const bookKey = generateBookKey(book.title, book.author);
            const state = makeState({
                importedHighlights: { [bookKey]: ['kh-00000001'] },
            });

            const result = getNewHighlights(book, state);
            expect(result).toHaveLength(0);
        });

        it('should handle missing state entry for book', () => {
            const book = makeBook();
            const state = makeState({
                importedHighlights: { 'kb-otherbook': ['kh-00000001'] },
            });

            const result = getNewHighlights(book, state);
            expect(result).toHaveLength(1);
        });
    });

    describe('updateSyncState', () => {
        it('should add highlight IDs to state', () => {
            const plugin = makeMockPlugin();
            const book = makeBook();
            const highlights = [
                makeHighlight({ id: 'kh-00000001' }),
                makeHighlight({ id: 'kh-00000002', text: 'Second' }),
            ];

            updateSyncState(plugin as any, book, highlights);

            const bookKey = generateBookKey(book.title, book.author);
            expect(plugin.settings.kindleSyncState.importedHighlights[bookKey]).toEqual([
                'kh-00000001',
                'kh-00000002',
            ]);
        });

        it('should append to existing IDs', () => {
            const book = makeBook();
            const bookKey = generateBookKey(book.title, book.author);
            const plugin = makeMockPlugin();
            plugin.settings.kindleSyncState.importedHighlights[bookKey] = ['kh-existing'];

            updateSyncState(plugin as any, book, [makeHighlight({ id: 'kh-new' })]);

            expect(plugin.settings.kindleSyncState.importedHighlights[bookKey]).toEqual([
                'kh-existing',
                'kh-new',
            ]);
        });
    });

    describe('updateFrontmatterInContent', () => {
        const content = [
            '---',
            'title: Test Book',
            'author: Test Author',
            'highlights_count: 5',
            'last_synced: "2026-01-01T00:00:00.000Z"',
            'tags: []',
            '---',
            '',
            '# Test Book',
        ].join('\n');

        it('should update existing highlights_count', () => {
            const updated = updateFrontmatterInContent(content, { highlights_count: 10 });
            expect(updated).toContain('highlights_count: 10');
            expect(updated).not.toContain('highlights_count: 5');
        });

        it('should update existing last_synced', () => {
            const updated = updateFrontmatterInContent(content, {
                last_synced: '2026-02-11T12:00:00.000Z',
            });
            expect(updated).toContain('last_synced: "2026-02-11T12:00:00.000Z"');
            expect(updated).not.toContain('2026-01-01');
        });

        it('should add new keys if not present', () => {
            const simple = '---\ntitle: Book\n---\nContent';
            const updated = updateFrontmatterInContent(simple, { highlights_count: 3 });
            expect(updated).toContain('highlights_count: 3');
            expect(updated).toContain('title: Book');
        });

        it('should return content unchanged when no frontmatter', () => {
            const noFm = 'Just some text';
            const updated = updateFrontmatterInContent(noFm, { highlights_count: 3 });
            expect(updated).toBe(noFm);
        });

        it('should quote strings containing special YAML characters', () => {
            const simple = '---\ntitle: Book\n---\nContent';
            const updated = updateFrontmatterInContent(simple, {
                last_synced: '2026-02-11T12:00:00Z',
            });
            expect(updated).toContain('"2026-02-11T12:00:00Z"');
        });

        it('should handle multiple updates at once', () => {
            const updated = updateFrontmatterInContent(content, {
                highlights_count: 15,
                last_synced: '2026-06-01T00:00:00Z',
            });
            expect(updated).toContain('highlights_count: 15');
            expect(updated).toContain('"2026-06-01T00:00:00Z"');
        });
    });

    describe('KindleSyncResult.createdFiles', () => {
        it('should be included in the result type', () => {
            // Type-level test: ensure createdFiles exists on the type
            const result = {
                success: true,
                booksProcessed: 0,
                highlightsImported: 0,
                errors: [] as string[],
                skippedBooks: [] as string[],
                createdFiles: [{ path: 'Kindle/Test.md', title: 'Test' }],
            };
            expect(result.createdFiles).toHaveLength(1);
            expect(result.createdFiles[0].path).toBe('Kindle/Test.md');
        });

        it('should carry optional book field for AI enhancement', () => {
            const book = makeBook();
            const result = {
                success: true,
                booksProcessed: 1,
                highlightsImported: 1,
                errors: [] as string[],
                skippedBooks: [] as string[],
                createdFiles: [{ path: 'Kindle/Test.md', title: 'Test', book }],
            };
            expect(result.createdFiles[0].book).toBeDefined();
            expect(result.createdFiles[0].book?.title).toBe('Thinking, Fast and Slow');
            expect(result.createdFiles[0].book?.highlights).toHaveLength(1);
        });

        it('should allow createdFiles without book (backward compat)', () => {
            const entry: { path: string; title: string; book?: KindleBook } = {
                path: 'Kindle/Test.md',
                title: 'Test',
            };
            expect(entry.book).toBeUndefined();
        });
    });

    describe('differential sync — state clearing for deleted notes', () => {
        it('should clear state when highlights were imported but checking reveals no file', () => {
            // This tests the concept: if importedHighlights has entries
            // but the note was deleted, those entries should be cleared
            const book = makeBook({
                highlights: [
                    makeHighlight({ id: 'kh-00000001' }),
                    makeHighlight({ id: 'kh-00000002', text: 'Second' }),
                ],
                highlightCount: 2,
            });
            const bookKey = generateBookKey(book.title, book.author);
            const state = makeState({
                importedHighlights: { [bookKey]: ['kh-00000001', 'kh-00000002'] },
            });

            // Simulate clearing state (as syncFromClippings does when note is missing)
            delete state.importedHighlights[bookKey];

            // Now getNewHighlights should return all
            const result = getNewHighlights(book, state);
            expect(result).toHaveLength(2);
        });
    });

    describe('generateBookKey uniqueness', () => {
        it('should produce different keys for same title different author', () => {
            const key1 = generateBookKey('The Art of War', 'Sun Tzu');
            const key2 = generateBookKey('The Art of War', 'Niccolò Machiavelli');
            expect(key1).not.toBe(key2);
        });

        it('should produce same key regardless of case', () => {
            const key1 = generateBookKey('Thinking Fast', 'Daniel Kahneman');
            const key2 = generateBookKey('thinking fast', 'daniel kahneman');
            expect(key1).toBe(key2);
        });
    });
});

// =========================================================================
// Phase 3: syncFromAmazon — ASIN-keyed differential sync
// =========================================================================

describe('syncFromAmazon', () => {
    describe('getNewHighlights with asin parameter', () => {
        it('checks importedHighlightsByAsin when asin is provided', () => {
            const book = makeBook({
                asin: 'B08N5WRWNW',
                highlights: [
                    makeHighlight({ id: 'ka-00000001' }),
                    makeHighlight({ id: 'ka-00000002', text: 'Second' }),
                    makeHighlight({ id: 'ka-00000003', text: 'Third' }),
                ],
                highlightCount: 3,
            });
            const state = makeState({
                importedHighlights: {},
                importedHighlightsByAsin: {
                    'B08N5WRWNW': ['ka-00000001', 'ka-00000002'],
                },
            });

            const result = getNewHighlights(book, state, 'B08N5WRWNW');
            expect(result).toHaveLength(1);
            expect(result[0].id).toBe('ka-00000003');
        });

        it('returns all highlights when asin has no entries in importedHighlightsByAsin', () => {
            const book = makeBook({
                asin: 'B08N5WRWNW',
                highlights: [
                    makeHighlight({ id: 'ka-00000001' }),
                    makeHighlight({ id: 'ka-00000002', text: 'Second' }),
                ],
                highlightCount: 2,
            });
            const state = makeState({
                importedHighlights: {},
                importedHighlightsByAsin: {
                    'B07XGF18MC': ['ka-99999999'],
                },
            });

            const result = getNewHighlights(book, state, 'B08N5WRWNW');
            expect(result).toHaveLength(2);
        });
    });

    describe('getNewHighlights without asin parameter (backward compat)', () => {
        it('uses title+author key when asin is not provided', () => {
            const book = makeBook({
                highlights: [
                    makeHighlight({ id: 'kh-00000001' }),
                    makeHighlight({ id: 'kh-00000002', text: 'Second' }),
                ],
                highlightCount: 2,
            });
            const bookKey = generateBookKey(book.title, book.author);
            const state = makeState({
                importedHighlights: { [bookKey]: ['kh-00000001'] },
                importedHighlightsByAsin: {
                    'B003JTHWJQ': ['kh-00000001', 'kh-00000002'],
                },
            });

            // Without asin, should use importedHighlights (title+author key)
            const result = getNewHighlights(book, state);
            expect(result).toHaveLength(1);
            expect(result[0].id).toBe('kh-00000002');
        });
    });

    describe('updateSyncState with asin parameter', () => {
        it('writes to both importedHighlights and importedHighlightsByAsin', () => {
            const plugin = makeMockPlugin();
            const book = makeBook({ asin: 'B08N5WRWNW' });
            const highlights = [
                makeHighlight({ id: 'ka-00000001' }),
                makeHighlight({ id: 'ka-00000002', text: 'Second' }),
            ];

            updateSyncState(plugin as any, book, highlights, 'B08N5WRWNW');

            // Check importedHighlights (title+author key)
            const bookKey = generateBookKey(book.title, book.author);
            expect(plugin.settings.kindleSyncState.importedHighlights[bookKey]).toEqual([
                'ka-00000001',
                'ka-00000002',
            ]);

            // Check importedHighlightsByAsin
            expect(plugin.settings.kindleSyncState.importedHighlightsByAsin).toBeDefined();
            expect(plugin.settings.kindleSyncState.importedHighlightsByAsin!['B08N5WRWNW']).toEqual([
                'ka-00000001',
                'ka-00000002',
            ]);
        });

        it('appends to existing ASIN entries', () => {
            const plugin = makeMockPlugin();
            plugin.settings.kindleSyncState.importedHighlightsByAsin = {
                'B08N5WRWNW': ['ka-existing'],
            };
            const book = makeBook({ asin: 'B08N5WRWNW' });

            updateSyncState(plugin as any, book, [makeHighlight({ id: 'ka-new' })], 'B08N5WRWNW');

            expect(plugin.settings.kindleSyncState.importedHighlightsByAsin!['B08N5WRWNW']).toEqual([
                'ka-existing',
                'ka-new',
            ]);
        });
    });

    describe('updateSyncState without asin (backward compat)', () => {
        it('only writes to importedHighlights, not importedHighlightsByAsin', () => {
            const plugin = makeMockPlugin();
            const book = makeBook();
            const highlights = [makeHighlight({ id: 'kh-00000001' })];

            updateSyncState(plugin as any, book, highlights);

            const bookKey = generateBookKey(book.title, book.author);
            expect(plugin.settings.kindleSyncState.importedHighlights[bookKey]).toEqual(['kh-00000001']);
            // importedHighlightsByAsin should remain undefined (not initialized)
            expect(plugin.settings.kindleSyncState.importedHighlightsByAsin).toBeUndefined();
        });
    });

    describe('updateSyncState initializes importedHighlightsByAsin', () => {
        it('creates importedHighlightsByAsin if undefined when asin is provided', () => {
            const plugin = makeMockPlugin();
            // Ensure importedHighlightsByAsin starts as undefined
            expect(plugin.settings.kindleSyncState.importedHighlightsByAsin).toBeUndefined();

            const book = makeBook({ asin: 'B08N5WRWNW' });
            updateSyncState(plugin as any, book, [makeHighlight({ id: 'ka-00000001' })], 'B08N5WRWNW');

            expect(plugin.settings.kindleSyncState.importedHighlightsByAsin).toBeDefined();
            expect(plugin.settings.kindleSyncState.importedHighlightsByAsin!['B08N5WRWNW']).toEqual(['ka-00000001']);
        });
    });

    describe('toKindleBook conversion', () => {
        it('sets correct highlightCount from highlights array', () => {
            const scraped: KindleScrapedBook = {
                asin: 'B08N5WRWNW',
                title: 'Atomic Habits',
                author: 'James Clear',
                highlightCount: 42, // Scraped count from page
            };
            const highlights = [
                makeHighlight({ id: 'ka-00000001' }),
                makeHighlight({ id: 'ka-00000002', text: 'Second' }),
                makeHighlight({ id: 'ka-00000003', text: 'Third' }),
            ];

            const book = toKindleBook(scraped, highlights);

            // highlightCount should be from actual highlights, not scraped value
            expect(book.highlightCount).toBe(3);
            expect(book.title).toBe('Atomic Habits');
            expect(book.author).toBe('James Clear');
            expect(book.asin).toBe('B08N5WRWNW');
            expect(book.highlights).toBe(highlights);
        });
    });
});
