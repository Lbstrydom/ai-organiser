/**
 * TavilyAdapter tests
 *
 * Verifies POST request construction, response mapping, raw_content handling,
 * error handling, and configuration checks for the Tavily search adapter.
 */

vi.mock('obsidian', async () => {
    const mod = await import('./mocks/obsidian');
    return {
        ...mod,
        requestUrl: vi.fn(),
    };
});

import { requestUrl } from 'obsidian';
import { TavilyAdapter } from '../src/services/research/adapters/tavilyAdapter';

const mockRequestUrl = requestUrl as unknown as ReturnType<typeof vi.fn>;

describe('TavilyAdapter', () => {
    let adapter: TavilyAdapter;
    const mockGetApiKey = vi.fn<() => Promise<string | null>>();

    beforeEach(() => {
        vi.clearAllMocks();
        mockGetApiKey.mockResolvedValue('tvly-test-key');
        adapter = new TavilyAdapter(mockGetApiKey);
    });

    describe('search()', () => {
        it('sends POST to correct Tavily API URL', async () => {
            mockRequestUrl.mockResolvedValue({
                json: { results: [] },
            });

            await adapter.search('test query');

            expect(mockRequestUrl).toHaveBeenCalledOnce();
            const call = mockRequestUrl.mock.calls[0][0];
            expect(call.url).toBe('https://api.tavily.com/search');
            expect(call.method).toBe('POST');
            expect(call.headers).toMatchObject({ 'Content-Type': 'application/json' });
        });

        it('maps response results to SearchResult[] with correct fields', async () => {
            mockRequestUrl.mockResolvedValue({
                json: {
                    results: [
                        {
                            title: 'Tavily Result',
                            url: 'https://example.com/article',
                            content: 'This is the content snippet from Tavily that describes the article in detail and may be quite long.',
                            score: 0.95,
                            raw_content: null,
                        },
                        {
                            title: 'Second Result',
                            url: 'https://arxiv.org/abs/1234',
                            content: 'Academic paper abstract',
                            score: 0.88,
                        },
                    ],
                },
            });

            const results = await adapter.search('search term');

            expect(results).toHaveLength(2);
            expect(results[0]).toMatchObject({
                title: 'Tavily Result',
                url: 'https://example.com/article',
                source: 'web',
                score: 0.95,
                domain: 'example.com',
            });
            // snippet is content sliced to 200 chars
            expect(results[0].snippet.length).toBeLessThanOrEqual(200);
            expect(results[1]).toMatchObject({
                title: 'Second Result',
                url: 'https://arxiv.org/abs/1234',
                source: 'academic',
                score: 0.88,
                domain: 'arxiv.org',
            });
        });

        it('includes extractedContent from Tavily raw_content when present', async () => {
            const fullContent = 'Full raw content of the page extracted by Tavily.';
            mockRequestUrl.mockResolvedValue({
                json: {
                    results: [
                        {
                            title: 'Article With Raw',
                            url: 'https://example.com/page',
                            content: 'Short snippet',
                            score: 0.9,
                            raw_content: fullContent,
                        },
                    ],
                },
            });

            const results = await adapter.search('test');

            expect(results).toHaveLength(1);
            expect(results[0].extractedContent).toBe(fullContent);
        });

        it('falls back to content for extractedContent when raw_content is absent', async () => {
            mockRequestUrl.mockResolvedValue({
                json: {
                    results: [
                        {
                            title: 'No Raw',
                            url: 'https://example.com/page',
                            content: 'Only content available',
                            score: 0.7,
                        },
                    ],
                },
            });

            const results = await adapter.search('test');

            expect(results[0].extractedContent).toBe('Only content available');
        });

        it('returns empty array when no results', async () => {
            mockRequestUrl.mockResolvedValue({
                json: {},
            });

            const results = await adapter.search('no results query');

            expect(results).toEqual([]);
        });

        it('throws on HTTP error', async () => {
            mockRequestUrl.mockRejectedValue(new Error('HTTP 429 Too Many Requests'));

            await expect(adapter.search('rate limited')).rejects.toThrow('HTTP 429 Too Many Requests');
        });

        it('passes include_raw_content: true in request body', async () => {
            mockRequestUrl.mockResolvedValue({
                json: { results: [] },
            });

            await adapter.search('test query', { maxResults: 5 });

            const call = mockRequestUrl.mock.calls[0][0];
            const body = JSON.parse(call.body as string);
            expect(body.include_raw_content).toBe(true);
            expect(body.api_key).toBe('tvly-test-key');
            expect(body.query).toBe('test query');
            expect(body.max_results).toBe(5);
            expect(body.search_depth).toBe('basic');
            expect(body.include_answer).toBe(false);
        });

        it('passes days=7 when dateRange is recent', async () => {
            mockRequestUrl.mockResolvedValue({ json: { results: [] } });
            await adapter.search('test', { dateRange: 'recent' });
            const body = JSON.parse(mockRequestUrl.mock.calls[0][0].body);
            expect(body.days).toBe(7);
        });

        it('passes days=365 when dateRange is year', async () => {
            mockRequestUrl.mockResolvedValue({ json: { results: [] } });
            await adapter.search('test', { dateRange: 'year' });
            const body = JSON.parse(mockRequestUrl.mock.calls[0][0].body);
            expect(body.days).toBe(365);
        });

        it('omits days parameter when dateRange is any', async () => {
            mockRequestUrl.mockResolvedValue({ json: { results: [] } });
            await adapter.search('test', { dateRange: 'any' });
            const body = JSON.parse(mockRequestUrl.mock.calls[0][0].body);
            expect(body.days).toBeUndefined();
        });

        it('omits days parameter when dateRange not specified', async () => {
            mockRequestUrl.mockResolvedValue({ json: { results: [] } });
            await adapter.search('test');
            const body = JSON.parse(mockRequestUrl.mock.calls[0][0].body);
            expect(body.days).toBeUndefined();
        });
    });

    describe('isConfigured()', () => {
        it('returns true when key present', async () => {
            mockGetApiKey.mockResolvedValue('tvly-key-123');

            const result = await adapter.isConfigured();

            expect(result).toBe(true);
        });

        it('returns false when key is null', async () => {
            mockGetApiKey.mockResolvedValue(null);

            const result = await adapter.isConfigured();

            expect(result).toBe(false);
        });
    });
});
