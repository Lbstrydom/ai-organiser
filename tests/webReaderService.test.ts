/**
 * WebReaderService tests
 * Tests fetchAndTriageArticles() and createNoteFromArticles() with mocked edges:
 * - fetchArticle (webContentService)
 * - summarizeText / pluginContext (llmFacade)
 * - truncateContent (tokenLimits)
 * - Obsidian vault (create, getAbstractFileByPath)
 */

// Mock obsidian
vi.mock('obsidian', async () => {
    const actual = await vi.importActual('./mocks/obsidian');
    return {
        ...actual,
        Notice: class MockNotice {
            constructor() {}
        }
    };
});

// Mock webContentService
const mockFetchArticle = vi.fn();
vi.mock('../src/services/webContentService', () => ({
    fetchArticle: (...args: unknown[]) => mockFetchArticle(...args)
}));

// Mock llmFacade
const mockSummarizeText = vi.fn();
vi.mock('../src/services/llmFacade', () => ({
    summarizeText: (...args: unknown[]) => mockSummarizeText(...args),
    pluginContext: () => ({ type: 'mock-context' })
}));

// Mock tokenLimits
vi.mock('../src/services/tokenLimits', () => ({
    truncateContent: (text: string) => text
}));

// Mock minutesUtils
const mockCreatedFiles = new Map<string, string>();
vi.mock('../src/utils/minutesUtils', () => ({
    ensureFolderExists: vi.fn().mockResolvedValue(undefined),
    sanitizeFileName: (name: string) => name.replace(/[\\/:*?"<>|]/g, '-'),
    getAvailableFilePath: (_vault: unknown, folder: string, filename: string) =>
        Promise.resolve(`${folder}/${filename}`)
}));

import {
    fetchAndTriageArticles,
    createNoteFromArticles,
    TriageProgress
} from '../src/services/webReaderService';
import { DEFAULT_SETTINGS } from '../src/core/settings';

function makePlugin(overrides?: Partial<any>): any {
    return {
        t: {
            modals: {
                webReader: {
                    fetchFailed: 'Could not fetch this article',
                    noSummaryAvailable: 'Summary unavailable'
                }
            }
        },
        settings: {
            ...DEFAULT_SETTINGS,
            serviceType: 'cloud',
            cloudServiceType: 'openai',
            summaryLanguage: '',
            ...overrides
        },
        llmService: {},
        app: {}
    };
}

function makeFetchSuccess(opts?: Partial<any>) {
    return {
        success: true,
        content: {
            title: opts?.title ?? 'Test Article',
            textContent: opts?.textContent ?? 'Article text content here.',
            excerpt: opts?.excerpt ?? 'Short excerpt from article.',
            siteName: opts?.siteName ?? 'example.com',
            byline: opts?.byline ?? 'John Doe',
            url: opts?.url ?? 'https://example.com/article'
        }
    };
}

function makeFetchFailure(error?: string) {
    return {
        success: false,
        content: null,
        error: error || 'Network error'
    };
}

describe('WebReaderService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockCreatedFiles.clear();
    });

    describe('fetchAndTriageArticles', () => {
        it('should return triaged articles when fetch and LLM both succeed', async () => {
            mockFetchArticle
                .mockResolvedValueOnce(makeFetchSuccess({ title: 'Article 1', url: 'https://a.com' }))
                .mockResolvedValueOnce(makeFetchSuccess({ title: 'Article 2', url: 'https://b.com' }));
            mockSummarizeText
                .mockResolvedValueOnce({ success: true, content: 'Summary of article 1' })
                .mockResolvedValueOnce({ success: true, content: 'Summary of article 2' });

            const progress: TriageProgress[] = [];
            const plugin = makePlugin();

            const results = await fetchAndTriageArticles(
                ['https://a.com', 'https://b.com'],
                plugin,
                (p) => progress.push({ ...p }),
            );

            expect(results).toHaveLength(2);
            expect(results[0].briefSummary).toBe('Summary of article 1');
            expect(results[0].title).toBe('Article 1');
            expect(results[0].fetchError).toBeUndefined();
            expect(results[0].llmFailed).toBeUndefined();
            expect(results[1].briefSummary).toBe('Summary of article 2');
            expect(results[1].title).toBe('Article 2');
        });

        it('should set fetchError when fetch fails', async () => {
            mockFetchArticle
                .mockResolvedValueOnce(makeFetchFailure('404 Not Found'))
                .mockResolvedValueOnce(makeFetchSuccess({ title: 'Good Article' }));
            mockSummarizeText
                .mockResolvedValueOnce({ success: true, content: 'Good summary' });

            const plugin = makePlugin();
            const results = await fetchAndTriageArticles(
                ['https://bad.com', 'https://good.com'],
                plugin,
                () => {},
            );

            expect(results).toHaveLength(2);
            expect(results[0].fetchError).toBe('404 Not Found');
            expect(results[0].briefSummary).toBe('404 Not Found');
            expect(results[0].title).toBe('https://bad.com');
            expect(results[1].fetchError).toBeUndefined();
            expect(results[1].briefSummary).toBe('Good summary');
        });

        it('should fall back to excerpt when LLM fails', async () => {
            mockFetchArticle.mockResolvedValueOnce(
                makeFetchSuccess({ excerpt: 'Readability excerpt text' })
            );
            mockSummarizeText.mockResolvedValueOnce({ success: false, error: 'LLM error' });

            const plugin = makePlugin();
            const results = await fetchAndTriageArticles(
                ['https://example.com'],
                plugin,
                () => {},
            );

            expect(results).toHaveLength(1);
            expect(results[0].briefSummary).toBe('Readability excerpt text');
            expect(results[0].llmFailed).toBe(true);
        });

        it('should use fallback message when both LLM and excerpt fail', async () => {
            mockFetchArticle.mockResolvedValueOnce(
                makeFetchSuccess({ excerpt: '' })
            );
            mockSummarizeText.mockResolvedValueOnce({ success: false, error: 'LLM error' });

            const plugin = makePlugin();
            const results = await fetchAndTriageArticles(
                ['https://example.com'],
                plugin,
                () => {},
            );

            expect(results).toHaveLength(1);
            expect(results[0].briefSummary).toBe('Summary unavailable');
            expect(results[0].llmFailed).toBe(true);
        });

        it('should report correct progress phase transitions', async () => {
            mockFetchArticle
                .mockResolvedValueOnce(makeFetchSuccess())
                .mockResolvedValueOnce(makeFetchSuccess());
            mockSummarizeText
                .mockResolvedValueOnce({ success: true, content: 'Sum 1' })
                .mockResolvedValueOnce({ success: true, content: 'Sum 2' });

            const phases: string[] = [];
            const plugin = makePlugin();

            await fetchAndTriageArticles(
                ['https://a.com', 'https://b.com'],
                plugin,
                (p) => phases.push(`${p.current}-${p.phase}`),
            );

            expect(phases).toEqual([
                '1-fetching', '1-summarizing', '1-done',
                '2-fetching', '2-summarizing', '2-done'
            ]);
        });

        it('should return empty array for empty URL list', async () => {
            const plugin = makePlugin();
            const results = await fetchAndTriageArticles([], plugin, () => {});
            expect(results).toEqual([]);
        });

        it('should stop processing when abort signal fires', async () => {
            const controller = new AbortController();
            mockFetchArticle.mockImplementation(async () => {
                // Abort after first article is fetched
                controller.abort();
                return makeFetchSuccess({ title: 'First Article', excerpt: 'Excerpt fallback' });
            });
            mockSummarizeText.mockResolvedValue({ success: true, content: 'Sum' });

            const plugin = makePlugin();
            const results = await fetchAndTriageArticles(
                ['https://a.com', 'https://b.com', 'https://c.com'],
                plugin,
                () => {},
                controller.signal
            );

            // Should have 1 result with excerpt fallback (LLM skipped due to abort)
            expect(results).toHaveLength(1);
            expect(results[0].title).toBe('First Article');
            expect(results[0].briefSummary).toBe('Excerpt fallback');
            expect(results[0].llmFailed).toBe(true);
            // LLM should NOT have been called (abort caught before LLM)
            expect(mockSummarizeText).not.toHaveBeenCalled();
        });
    });

    describe('createNoteFromArticles', () => {
        let mockApp: any;

        beforeEach(() => {
            mockApp = {
                vault: {
                    create: vi.fn().mockImplementation(async (path: string, content: string) => {
                        return { path, name: path.split('/').pop() } as any;
                    }),
                    getAbstractFileByPath: vi.fn().mockReturnValue(null),
                    createFolder: vi.fn().mockResolvedValue(undefined)
                }
            };
        });

        it('should create note with correct markdown format for single article', async () => {
            const articles = [{
                url: 'https://example.com/post',
                title: 'Great Article',
                siteName: 'example.com',
                byline: 'Author',
                briefSummary: 'A great article summary'
            }];

            const file = await createNoteFromArticles(mockApp, DEFAULT_SETTINGS, articles, 'My Note');

            expect(mockApp.vault.create).toHaveBeenCalledOnce();
            const [path, content] = mockApp.vault.create.mock.calls[0];
            expect(content).toContain('# My Note');
            expect(content).toContain('[Great Article](https://example.com/post)');
            expect(content).toContain('---');
        });

        it('should create note with all URLs listed for multiple articles', async () => {
            const articles = [
                { url: 'https://a.com', title: 'Article A', siteName: null, byline: null, briefSummary: 'Sum A' },
                { url: 'https://b.com', title: 'Article B', siteName: null, byline: null, briefSummary: 'Sum B' },
                { url: 'https://c.com', title: 'Article C', siteName: null, byline: null, briefSummary: 'Sum C' }
            ];

            await createNoteFromArticles(mockApp, DEFAULT_SETTINGS, articles, 'Multi');

            const [, content] = mockApp.vault.create.mock.calls[0];
            expect(content).toContain('[Article A](https://a.com)');
            expect(content).toContain('[Article B](https://b.com)');
            expect(content).toContain('[Article C](https://c.com)');
        });

        it('should use custom title as note heading', async () => {
            const articles = [
                { url: 'https://a.com', title: 'Article', siteName: null, byline: null, briefSummary: 'Sum' }
            ];

            await createNoteFromArticles(mockApp, DEFAULT_SETTINGS, articles, 'Custom Title');

            const [, content] = mockApp.vault.create.mock.calls[0];
            expect(content).toContain('# Custom Title');
        });

        it('should use first article title when no custom title provided', async () => {
            const articles = [
                { url: 'https://a.com', title: 'First Title', siteName: null, byline: null, briefSummary: 'Sum' },
                { url: 'https://b.com', title: 'Second Title', siteName: null, byline: null, briefSummary: 'Sum' }
            ];

            await createNoteFromArticles(mockApp, DEFAULT_SETTINGS, articles);

            const [, content] = mockApp.vault.create.mock.calls[0];
            expect(content).toContain('# First Title');
        });

        it('should include YAML frontmatter with tags array', async () => {
            const articles = [
                { url: 'https://a.com', title: 'Article', siteName: null, byline: null, briefSummary: 'Sum' }
            ];

            await createNoteFromArticles(mockApp, DEFAULT_SETTINGS, articles);

            const [, content] = mockApp.vault.create.mock.calls[0];
            expect(content.startsWith('---\n')).toBe(true);
            expect(content).toContain('tags: []');
        });

        it('should not call workspace methods (SRP — caller opens file)', async () => {
            const articles = [
                { url: 'https://a.com', title: 'Article', siteName: null, byline: null, briefSummary: 'Sum' }
            ];

            // Ensure no workspace property is accessed
            mockApp.workspace = {
                getLeaf: vi.fn(),
                openLinkText: vi.fn()
            };

            await createNoteFromArticles(mockApp, DEFAULT_SETTINGS, articles);

            expect(mockApp.workspace.getLeaf).not.toHaveBeenCalled();
            expect(mockApp.workspace.openLinkText).not.toHaveBeenCalled();
        });
    });
});
