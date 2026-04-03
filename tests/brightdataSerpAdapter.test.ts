/**
 * BrightDataSerpAdapter tests
 *
 * Verifies response parsing, auth header format, error handling,
 * query params, and configuration checks for the Bright Data SERP adapter.
 */

vi.mock('obsidian', async () => {
    const mod = await import('./mocks/obsidian');
    return {
        ...mod,
        requestUrl: vi.fn(),
    };
});

import { requestUrl } from 'obsidian';
import { BrightDataSerpAdapter } from '../src/services/research/adapters/brightdataSerpAdapter';

const mockRequestUrl = requestUrl as unknown as ReturnType<typeof vi.fn>;

describe('BrightDataSerpAdapter', () => {
    let adapter: BrightDataSerpAdapter;
    const mockGetApiKey = vi.fn<() => Promise<string | null>>();

    beforeEach(() => {
        vi.clearAllMocks();
        mockGetApiKey.mockResolvedValue('bd-test-key');
        adapter = new BrightDataSerpAdapter(mockGetApiKey);
    });

    describe('search()', () => {
        it('sends POST to correct Bright Data SERP URL with Bearer auth', async () => {
            mockRequestUrl.mockResolvedValue({
                json: { organic: [] },
            });

            await adapter.search('test query');

            expect(mockRequestUrl).toHaveBeenCalledOnce();
            const call = mockRequestUrl.mock.calls[0][0];
            expect(call.url).toBe('https://api.brightdata.com/serp/req');
            expect(call.method).toBe('POST');
            expect(call.headers).toMatchObject({
                'Authorization': 'Bearer bd-test-key',
                'Content-Type': 'application/json',
            });
        });

        it('passes correct query params in request body', async () => {
            mockRequestUrl.mockResolvedValue({
                json: { organic: [] },
            });

            await adapter.search('quantum computing', { maxResults: 5 });

            const call = mockRequestUrl.mock.calls[0][0];
            const body = JSON.parse(call.body as string);
            expect(body.query).toBe('quantum computing');
            expect(body.search_engine).toBe('google');
            expect(body.num).toBe(5);
            expect(body.brd_json).toBe(1);
        });

        it('maps organic results to SearchResult[] with correct fields', async () => {
            mockRequestUrl.mockResolvedValue({
                json: {
                    organic: [
                        {
                            title: 'First Result',
                            link: 'https://example.com/page1',
                            description: 'Description of first result',
                            rank: 1,
                        },
                        {
                            title: 'Second Result',
                            url: 'https://youtube.com/watch?v=abc',
                            snippet: 'Snippet for second result',
                            rank: 5,
                        },
                    ],
                },
            });

            const results = await adapter.search('test');

            expect(results).toHaveLength(2);
            expect(results[0]).toMatchObject({
                title: 'First Result',
                url: 'https://example.com/page1',
                snippet: 'Description of first result',
                source: 'web',
                domain: 'example.com',
            });
            expect(results[0].score).toBeCloseTo(0.99);
            expect(results[1]).toMatchObject({
                title: 'Second Result',
                url: 'https://youtube.com/watch?v=abc',
                source: 'youtube',
                domain: 'youtube.com',
            });
            expect(results[1].score).toBeCloseTo(0.95);
        });

        it('handles link or url field for result URL', async () => {
            mockRequestUrl.mockResolvedValue({
                json: {
                    organic: [
                        { title: 'With Link', link: 'https://a.com', description: 'test' },
                        { title: 'With URL', url: 'https://b.com', description: 'test' },
                    ],
                },
            });

            const results = await adapter.search('test');

            expect(results[0].url).toBe('https://a.com');
            expect(results[1].url).toBe('https://b.com');
        });

        it('returns empty array when no organic results', async () => {
            mockRequestUrl.mockResolvedValue({
                json: {},
            });

            const results = await adapter.search('empty query');

            expect(results).toEqual([]);
        });

        it('throws on HTTP error', async () => {
            mockRequestUrl.mockRejectedValue(new Error('HTTP 401 Unauthorized'));

            await expect(adapter.search('unauthorized')).rejects.toThrow('HTTP 401 Unauthorized');
        });

        it('throws when API key is not configured', async () => {
            mockGetApiKey.mockResolvedValue(null);

            await expect(adapter.search('test')).rejects.toThrow('Bright Data SERP API key not configured');
        });

        it('uses default maxResults of 10 when not specified', async () => {
            mockRequestUrl.mockResolvedValue({
                json: { organic: [] },
            });

            await adapter.search('test');

            const body = JSON.parse(mockRequestUrl.mock.calls[0][0].body as string);
            expect(body.num).toBe(10);
        });

        it('handles results without rank field', async () => {
            mockRequestUrl.mockResolvedValue({
                json: {
                    organic: [
                        { title: 'No Rank', link: 'https://example.com', description: 'test' },
                    ],
                },
            });

            const results = await adapter.search('test');

            expect(results[0].score).toBeUndefined();
        });

        it('clamps score to 0 when rank exceeds 100', async () => {
            mockRequestUrl.mockResolvedValue({
                json: {
                    organic: [
                        { title: 'Low Rank', link: 'https://example.com', description: 'test', rank: 150 },
                    ],
                },
            });

            const results = await adapter.search('test');

            expect(results[0].score).toBe(0);
        });

        it('scores rank 100 as 0', async () => {
            mockRequestUrl.mockResolvedValue({
                json: {
                    organic: [
                        { title: 'Edge', link: 'https://example.com', description: 'test', rank: 100 },
                    ],
                },
            });

            const results = await adapter.search('test');

            expect(results[0].score).toBe(0);
        });

        it('handles description and snippet fields', async () => {
            mockRequestUrl.mockResolvedValue({
                json: {
                    organic: [
                        { title: 'Desc', link: 'https://a.com', description: 'Has description' },
                        { title: 'Snip', link: 'https://b.com', snippet: 'Has snippet' },
                        { title: 'None', link: 'https://c.com' },
                    ],
                },
            });

            const results = await adapter.search('test');

            expect(results[0].snippet).toBe('Has description');
            expect(results[1].snippet).toBe('Has snippet');
            expect(results[2].snippet).toBe('');
        });
    });

    describe('isConfigured()', () => {
        it('returns true when key present', async () => {
            mockGetApiKey.mockResolvedValue('bd-key-123');

            expect(await adapter.isConfigured()).toBe(true);
        });

        it('returns false when key is null', async () => {
            mockGetApiKey.mockResolvedValue(null);

            expect(await adapter.isConfigured()).toBe(false);
        });
    });
});
