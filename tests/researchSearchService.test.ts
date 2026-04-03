vi.mock('../src/services/research/adapters/tavilyAdapter', () => ({
    TavilyAdapter: class {
        readonly type = 'tavily';
        search = vi.fn().mockResolvedValue([]);
        isConfigured = vi.fn().mockResolvedValue(true);
    },
}));

import { ResearchSearchService } from '../src/services/research/researchSearchService';
import type { SearchProvider, SearchResult } from '../src/services/research/researchTypes';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
    return {
        title: 'Test',
        url: 'https://example.com/article',
        snippet: 'A test result',
        source: 'web',
        domain: 'example.com',
        ...overrides,
    };
}

function makeMockProvider(overrides: Partial<SearchProvider> = {}): SearchProvider {
    return {
        type: 'tavily',
        search: vi.fn().mockResolvedValue([]),
        isConfigured: vi.fn().mockResolvedValue(true),
        ...overrides,
    };
}

function makeMockPlugin(settingsOverrides: Record<string, unknown> = {}) {
    return {
        settings: { researchProvider: 'tavily', ...settingsOverrides },
        secretStorageService: {
            getSecret: vi.fn().mockResolvedValue('test-key'),
        },
    } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ResearchSearchService', () => {
    let service: ResearchSearchService;
    let mockPlugin: ReturnType<typeof makeMockPlugin>;

    beforeEach(() => {
        mockPlugin = makeMockPlugin();
        service = new ResearchSearchService(mockPlugin);
    });

    // -----------------------------------------------------------------------
    // Constructor & provider creation
    // -----------------------------------------------------------------------

    describe('constructor', () => {
        it('creates providers for tavily and brightdata-serp', () => {
            expect(service.getProvider('tavily')).not.toBeNull();
            expect(service.getProvider('brightdata-serp')).not.toBeNull();
        });

        it('returns null for unknown provider type', () => {
            expect(service.getProvider('unknown' as any)).toBeNull();
        });
    });

    // -----------------------------------------------------------------------
    // getActiveProvider
    // -----------------------------------------------------------------------

    describe('getActiveProvider', () => {
        it('returns provider matching researchProvider setting', () => {
            const provider = service.getActiveProvider();
            expect(provider).not.toBeNull();
            expect(provider!.type).toBe('tavily');
        });

        it('returns tavily provider when setting is tavily', () => {
            mockPlugin.settings.researchProvider = 'tavily';
            service = new ResearchSearchService(mockPlugin);
            const provider = service.getActiveProvider();
            expect(provider).not.toBeNull();
            expect(provider!.type).toBe('tavily');
        });

        it('returns null when setting points to unknown provider', () => {
            mockPlugin.settings.researchProvider = 'nonexistent';
            const provider = service.getActiveProvider();
            expect(provider).toBeNull();
        });
    });

    // -----------------------------------------------------------------------
    // getAvailableProviders
    // -----------------------------------------------------------------------

    describe('getAvailableProviders', () => {
        it('returns only providers where isConfigured() is true', async () => {
            const configured = makeMockProvider({ type: 'tavily', isConfigured: vi.fn().mockResolvedValue(true) });
            const notConfigured = makeMockProvider({ type: 'brightdata-serp', isConfigured: vi.fn().mockResolvedValue(false) });
            (service as any).providers = new Map([
                ['tavily', configured],
                ['brightdata-serp', notConfigured],
            ]);

            const available = await service.getAvailableProviders();
            expect(available).toEqual(['tavily']);
        });

        it('returns empty array when no providers are configured', async () => {
            const unconfigured1 = makeMockProvider({ type: 'tavily', isConfigured: vi.fn().mockResolvedValue(false) });
            const unconfigured2 = makeMockProvider({ type: 'brightdata-serp', isConfigured: vi.fn().mockResolvedValue(false) });
            (service as any).providers = new Map([
                ['tavily', unconfigured1],
                ['brightdata-serp', unconfigured2],
            ]);

            const available = await service.getAvailableProviders();
            expect(available).toEqual([]);
        });
    });

    // -----------------------------------------------------------------------
    // search() — core behaviour
    // -----------------------------------------------------------------------

    describe('search()', () => {
        let mockProvider: SearchProvider;

        beforeEach(() => {
            mockProvider = makeMockProvider({ type: 'tavily' });
            (service as any).providers = new Map([['tavily', mockProvider]]);
        });

        it('throws when no provider is configured', async () => {
            mockPlugin.settings.researchProvider = 'nonexistent';
            await expect(service.search(['test query'])).rejects.toThrow('No search provider configured');
        });

        it('deduplicates results by normalized URL', async () => {
            (mockProvider.search as ReturnType<typeof vi.fn>)
                .mockResolvedValueOnce([
                    makeResult({ url: 'https://example.com/page', title: 'First' }),
                ])
                .mockResolvedValueOnce([
                    makeResult({ url: 'https://example.com/page/', title: 'Duplicate (trailing slash)' }),
                    makeResult({ url: 'https://example.com/other', title: 'Different' }),
                ]);

            const results = await service.search(['query1', 'query2']);

            const titles = results.map(r => r.title);
            expect(titles).toContain('First');
            expect(titles).toContain('Different');
            expect(titles).not.toContain('Duplicate (trailing slash)');
        });

        it('deduplicates URLs with tracking parameters', async () => {
            (mockProvider.search as ReturnType<typeof vi.fn>)
                .mockResolvedValueOnce([
                    makeResult({ url: 'https://example.com/article', title: 'Clean' }),
                ])
                .mockResolvedValueOnce([
                    makeResult({ url: 'https://example.com/article?utm_source=google', title: 'With UTM' }),
                ]);

            const results = await service.search(['q1', 'q2']);
            expect(results).toHaveLength(1);
            expect(results[0].title).toBe('Clean');
        });

        it('filters out excluded sites', async () => {
            (mockProvider.search as ReturnType<typeof vi.fn>).mockResolvedValue([
                makeResult({ url: 'https://spam.com/page', domain: 'spam.com' }),
                makeResult({ url: 'https://good.com/page', domain: 'good.com' }),
                makeResult({ url: 'https://www.spam.com/other', domain: 'spam.com' }),
            ]);

            const results = await service.search(['query'], { excludedSites: ['spam.com'] });
            expect(results).toHaveLength(1);
            expect(results[0].url).toBe('https://good.com/page');
        });

        it('limits results to maxResults', async () => {
            const many = Array.from({ length: 20 }, (_, i) =>
                makeResult({ url: `https://example.com/page${i}`, title: `Result ${i}` })
            );
            (mockProvider.search as ReturnType<typeof vi.fn>).mockResolvedValue(many);

            const results = await service.search(['query'], { maxResults: 5 });
            expect(results).toHaveLength(5);
        });

        it('defaults maxResults to 10', async () => {
            const many = Array.from({ length: 15 }, (_, i) =>
                makeResult({ url: `https://example.com/page${i}` })
            );
            (mockProvider.search as ReturnType<typeof vi.fn>).mockResolvedValue(many);

            const results = await service.search(['query']);
            expect(results).toHaveLength(10);
        });

        it('sorts results by score descending', async () => {
            (mockProvider.search as ReturnType<typeof vi.fn>).mockResolvedValue([
                makeResult({ url: 'https://a.com', score: 0.3 }),
                makeResult({ url: 'https://b.com', score: 0.9 }),
                makeResult({ url: 'https://c.com', score: 0.6 }),
            ]);

            const results = await service.search(['query']);
            expect(results.map(r => r.score)).toEqual([0.9, 0.6, 0.3]);
        });

        it('treats undefined scores as 0 when sorting', async () => {
            (mockProvider.search as ReturnType<typeof vi.fn>).mockResolvedValue([
                makeResult({ url: 'https://a.com', score: undefined }),
                makeResult({ url: 'https://b.com', score: 0.5 }),
            ]);

            const results = await service.search(['query']);
            expect(results[0].score).toBe(0.5);
            expect(results[1].score).toBeUndefined();
        });
    });

    // -----------------------------------------------------------------------
    // search() — error handling
    // -----------------------------------------------------------------------

    describe('search() error handling', () => {
        let mockProvider: SearchProvider;

        beforeEach(() => {
            mockProvider = makeMockProvider({ type: 'tavily' });
            (service as any).providers = new Map([['tavily', mockProvider]]);
        });

        it('throws first error when ALL queries fail', async () => {
            (mockProvider.search as ReturnType<typeof vi.fn>)
                .mockRejectedValueOnce(new Error('Rate limited'))
                .mockRejectedValueOnce(new Error('Timeout'));

            await expect(service.search(['q1', 'q2'])).rejects.toThrow('Rate limited');
        });

        it('returns partial results when some queries succeed and others fail', async () => {
            (mockProvider.search as ReturnType<typeof vi.fn>)
                .mockResolvedValueOnce([makeResult({ url: 'https://good.com/1', title: 'Good' })])
                .mockRejectedValueOnce(new Error('Network error'));

            const results = await service.search(['q1', 'q2']);
            expect(results).toHaveLength(1);
            expect(results[0].title).toBe('Good');
        });
    });

    // -----------------------------------------------------------------------
    // applySiteScope (tested via search())
    // -----------------------------------------------------------------------

    describe('applySiteScope', () => {
        let mockProvider: SearchProvider;

        beforeEach(() => {
            mockProvider = makeMockProvider({ type: 'tavily' });
            (service as any).providers = new Map([['tavily', mockProvider]]);
            (mockProvider.search as ReturnType<typeof vi.fn>).mockResolvedValue([]);
        });

        it('passes queries unchanged when siteScope is "all"', async () => {
            await service.search(['test query'], { siteScope: 'all' });
            expect(mockProvider.search).toHaveBeenCalledTimes(1);
            expect((mockProvider.search as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('test query');
        });

        it('passes queries unchanged when siteScope is undefined', async () => {
            await service.search(['q1', 'q2']);
            expect(mockProvider.search).toHaveBeenCalledTimes(2);
        });

        it('adds site-scoped query for "preferred" scope', async () => {
            await service.search(['my query'], {
                siteScope: 'preferred',
                preferredSites: ['nature.com', 'science.org'],
            });

            // Original query + one site-scoped query = 2 calls
            expect(mockProvider.search).toHaveBeenCalledTimes(2);
            const secondCall = (mockProvider.search as ReturnType<typeof vi.fn>).mock.calls[1][0];
            expect(secondCall).toContain('my query');
            expect(secondCall).toContain('site:nature.com');
            expect(secondCall).toContain('site:science.org');
        });

        it('does not add site query for "preferred" when no preferredSites', async () => {
            await service.search(['query'], { siteScope: 'preferred', preferredSites: [] });
            // Only the original query
            expect(mockProvider.search).toHaveBeenCalledTimes(1);
        });

        it('adds academic site constraints for "academic" scope', async () => {
            await service.search(['quantum computing'], { siteScope: 'academic' });

            expect(mockProvider.search).toHaveBeenCalledTimes(1);
            const query = (mockProvider.search as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(query).toContain('quantum computing');
            expect(query).toContain('site:scholar.google.com');
            expect(query).toContain('site:pubmed.ncbi.nlm.nih.gov');
            expect(query).toContain('site:arxiv.org');
        });
    });

    // -----------------------------------------------------------------------
    // Provider fallback (Fix 14)
    // -----------------------------------------------------------------------

    describe('provider fallback', () => {
        let primaryProvider: SearchProvider;
        let fallbackProvider: SearchProvider;

        beforeEach(() => {
            primaryProvider = makeMockProvider({ type: 'tavily' });
            fallbackProvider = makeMockProvider({
                type: 'claude-web-search',
                isConfigured: vi.fn().mockResolvedValue(true),
            });
            (service as any).providers = new Map([
                ['tavily', primaryProvider],
                ['claude-web-search', fallbackProvider],
            ]);
        });

        it('falls back when primary returns empty results', async () => {
            (primaryProvider.search as ReturnType<typeof vi.fn>).mockResolvedValue([]);
            (fallbackProvider.search as ReturnType<typeof vi.fn>).mockResolvedValue([
                makeResult({ title: 'Fallback Result', url: 'https://fallback.com' }),
            ]);

            const results = await service.search(['test query']);
            expect(results).toHaveLength(1);
            expect(results[0].title).toBe('Fallback Result');
            expect(service.fallbackProviderUsed).toBe('claude-web-search');
        });

        it('returns empty when no fallback is configured', async () => {
            (primaryProvider.search as ReturnType<typeof vi.fn>).mockResolvedValue([]);
            (fallbackProvider.isConfigured as ReturnType<typeof vi.fn>).mockResolvedValue(false);

            const results = await service.search(['test query']);
            expect(results).toHaveLength(0);
            expect(service.fallbackProviderUsed).toBeNull();
        });

        it('does not fallback when primary returns results', async () => {
            (primaryProvider.search as ReturnType<typeof vi.fn>).mockResolvedValue([
                makeResult({ title: 'Primary Result', url: 'https://primary.com' }),
            ]);

            const results = await service.search(['test query']);
            expect(results).toHaveLength(1);
            expect(results[0].title).toBe('Primary Result');
            expect(service.fallbackProviderUsed).toBeNull();
        });

        it('resets fallback state on each search call', async () => {
            // First search: trigger fallback
            (primaryProvider.search as ReturnType<typeof vi.fn>).mockResolvedValue([]);
            (fallbackProvider.search as ReturnType<typeof vi.fn>).mockResolvedValue([
                makeResult({ url: 'https://fallback.com' }),
            ]);
            await service.search(['q1']);
            // Consume the fallback used (getter resets state)
            const _consumed = service.fallbackProviderUsed;

            // Second search: primary returns results
            (primaryProvider.search as ReturnType<typeof vi.fn>).mockResolvedValue([
                makeResult({ url: 'https://primary.com' }),
            ]);
            await service.search(['q2']);
            expect(service.fallbackProviderUsed).toBeNull();
        });

        it('skips active provider in fallback candidates', async () => {
            // Only provider is tavily (active) — no fallback available
            (service as any).providers = new Map([['tavily', primaryProvider]]);
            (primaryProvider.search as ReturnType<typeof vi.fn>).mockResolvedValue([]);

            const results = await service.search(['test query']);
            expect(results).toHaveLength(0);
            expect(service.fallbackProviderUsed).toBeNull();
        });
    });
});
