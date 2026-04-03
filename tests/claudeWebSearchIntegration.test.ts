/**
 * Claude Web Search integration tests
 *
 * Tests the orchestrator's executeClaudeWebSearch() method:
 * pause_turn accumulation, usage recording, source metadata dedup,
 * budget checks, quality scoring, and provider branching.
 */

// ── Module-level mocks ──

vi.mock('obsidian', async () => {
    const mod = await import('./mocks/obsidian');
    return { ...mod, requestUrl: vi.fn() };
});

vi.mock('../src/services/llmFacade', () => ({
    summarizeText: vi.fn(),
    pluginContext: () => ({ type: 'mock-context' }),
}));

vi.mock('@mozilla/readability', () => ({
    Readability: vi.fn(),
}));

vi.mock('../src/services/prompts/researchPrompts', () => ({
    buildQueryDecompositionPrompt: vi.fn(),
    buildContextualAnswerPrompt: vi.fn(),
    buildResultTriagePrompt: vi.fn(),
    buildSourceExtractionPrompt: vi.fn(),
    buildSynthesisPrompt: vi.fn(),
    PERSPECTIVE_PRESETS: { balanced: [] },
}));

vi.mock('../src/core/settings', () => ({
    resolvePluginPath: vi.fn().mockReturnValue('AI-Organiser/Config'),
    DEFAULT_SETTINGS: {},
}));

vi.mock('../src/utils/minutesUtils', () => ({
    ensureFolderExists: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/services/canvas/canvasUtils', () => ({
    generateId: vi.fn().mockReturnValue('abc123def456ghij'),
}));

import { requestUrl } from 'obsidian';
import { ResearchOrchestrator } from '../src/services/research/researchOrchestrator';
import type { ClaudeWebSearchResponse } from '../src/services/research/researchTypes';
import { ClaudeWebSearchAdapter } from '../src/services/research/adapters/claudeWebSearchAdapter';

const mockRequestUrl = requestUrl as unknown as ReturnType<typeof vi.fn>;

// ── Helpers ──

function makePlugin(overrides: Record<string, unknown> = {}) {
    return {
        settings: {
            cloudServiceType: 'claude',
            cloudModel: 'claude-sonnet-4-6',
            enableResearchQualityScoring: false,
            summaryLanguage: '',
            ...overrides,
        },
        app: { vault: { getAbstractFileByPath: vi.fn(), read: vi.fn(), modify: vi.fn(), create: vi.fn() } },
        secretStorageService: { getSecret: vi.fn().mockResolvedValue(null) },
    } as any;
}

function makeSearchService(adapter: ClaudeWebSearchAdapter) {
    return {
        search: vi.fn(),
        getProvider: vi.fn().mockReturnValue(adapter),
    } as any;
}

function makeUsageService() {
    return {
        checkBudget: vi.fn().mockReturnValue({ allowed: true }),
        recordOperation: vi.fn().mockResolvedValue(undefined),
    } as any;
}

/** Build a mock Claude API response with web_search_tool_result + text blocks. */
function buildApiResponse(opts: {
    urls?: { url: string; title: string }[];
    synthesis?: string;
    citations?: { url: string; title: string; cited_text: string }[];
    searchCount?: number;
    stopReason?: string;
} = {}) {
    const urls = opts.urls ?? [{ url: 'https://example.com/a', title: 'Article A' }];
    const citations = opts.citations ?? [{ url: urls[0].url, title: urls[0].title, cited_text: 'Some cited text.' }];
    return {
        status: 200,
        json: {
            content: [
                {
                    type: 'web_search_tool_result',
                    tool_use_id: 'srvtoolu_1',
                    content: urls.map(u => ({
                        type: 'web_search_result', url: u.url, title: u.title, encrypted_content: 'enc...',
                    })),
                },
                {
                    type: 'text',
                    text: opts.synthesis ?? 'Synthesized answer.',
                    citations: citations.map(c => ({
                        type: 'web_search_result_location', url: c.url, title: c.title, cited_text: c.cited_text,
                    })),
                },
            ],
            usage: {
                input_tokens: 1000, output_tokens: 500,
                server_tool_use: { web_search_requests: opts.searchCount ?? 1 },
            },
            stop_reason: opts.stopReason ?? 'end_turn',
        },
    };
}

function buildPausedResponse(searchCount: number, urls: { url: string; title: string }[]) {
    return buildApiResponse({ urls, searchCount, stopReason: 'pause_turn', synthesis: 'Partial...' });
}

// ── Tests ──

describe('executeClaudeWebSearch', () => {
    let adapter: ClaudeWebSearchAdapter;
    let orchestrator: ResearchOrchestrator;
    let plugin: ReturnType<typeof makePlugin>;
    let usageService: ReturnType<typeof makeUsageService>;

    beforeEach(() => {
        vi.clearAllMocks();
        adapter = new ClaudeWebSearchAdapter(() => Promise.resolve('test-key'), {
            model: 'claude-sonnet-4-6', maxSearches: 5, useDynamicFiltering: true,
        });
        plugin = makePlugin();
        usageService = makeUsageService();
        const searchService = makeSearchService(adapter);
        orchestrator = new ResearchOrchestrator(searchService, plugin);
        (orchestrator as any).usageService = usageService;
    });

    // ═══ Basic flow ═══

    it('returns search results and synthesis from a single API call', async () => {
        mockRequestUrl.mockResolvedValue(buildApiResponse({
            urls: [{ url: 'https://example.com/a', title: 'A' }],
            synthesis: 'Answer text.',
            searchCount: 2,
        }));

        const result = await orchestrator.executeClaudeWebSearch('What is X?', {});

        expect(result.results).toHaveLength(1);
        expect(result.synthesis).toBe('Answer text.');
        expect(result.searchCount).toBe(2);
    });

    it('calls onPhaseChange callbacks', async () => {
        mockRequestUrl.mockResolvedValue(buildApiResponse());
        const phases: string[] = [];

        await orchestrator.executeClaudeWebSearch('test', {}, {
            onPhaseChange: (p) => phases.push(p),
        });

        expect(phases).toEqual(['searching', 'done']);
    });

    it('emits continuing phase on pause_turn (non-streaming)', async () => {
        mockRequestUrl
            .mockResolvedValueOnce(buildPausedResponse(1, [{ url: 'https://a.com', title: 'A' }]))
            .mockResolvedValueOnce(buildApiResponse({ searchCount: 1 }));
        const phases: string[] = [];

        await orchestrator.executeClaudeWebSearch('test', {}, {
            onPhaseChange: (p) => phases.push(p),
        });

        expect(phases).toContain('searching');
        expect(phases).toContain('continuing');
        expect(phases).toContain('done');
    });

    // ═══ pause_turn accumulation ═══

    it('accumulates searchCount across continuations', async () => {
        // First call: paused, 2 searches
        mockRequestUrl
            .mockResolvedValueOnce(buildPausedResponse(2, [{ url: 'https://a.com', title: 'A' }]))
            // Continuation: done, 3 searches
            .mockResolvedValueOnce(buildApiResponse({
                urls: [{ url: 'https://b.com', title: 'B' }],
                searchCount: 3,
            }));

        const result = await orchestrator.executeClaudeWebSearch('test', {});

        expect(result.searchCount).toBe(5); // 2 + 3
    });

    it('records all searches in usage ledger across continuations', async () => {
        mockRequestUrl
            .mockResolvedValueOnce(buildPausedResponse(2, [{ url: 'https://a.com', title: 'A' }]))
            .mockResolvedValueOnce(buildApiResponse({ searchCount: 1 }));

        await orchestrator.executeClaudeWebSearch('test', {});

        // Total: 2 + 1 = 3 recordOperation calls
        expect(usageService.recordOperation).toHaveBeenCalledTimes(3);
        expect(usageService.recordOperation).toHaveBeenCalledWith('claude-web-search');
    });

    it('merges search results from paused + continuation (dedup by URL)', async () => {
        mockRequestUrl
            .mockResolvedValueOnce(buildPausedResponse(1, [
                { url: 'https://a.com', title: 'A' },
                { url: 'https://b.com', title: 'B' },
            ]))
            .mockResolvedValueOnce(buildApiResponse({
                urls: [
                    { url: 'https://b.com', title: 'B Updated' }, // Duplicate URL
                    { url: 'https://c.com', title: 'C' },        // New
                ],
                searchCount: 1,
            }));

        const result = await orchestrator.executeClaudeWebSearch('test', {});

        // b.com from continuation wins, a.com from paused is merged in, c.com is new
        const urls = result.results.map(r => r.url);
        expect(urls).toContain('https://a.com');
        expect(urls).toContain('https://b.com');
        expect(urls).toContain('https://c.com');
        // No duplicate b.com
        expect(urls.filter(u => u === 'https://b.com')).toHaveLength(1);
    });

    it('concatenates synthesis text from paused + continuation', async () => {
        mockRequestUrl
            .mockResolvedValueOnce(buildPausedResponse(1, [{ url: 'https://a.com', title: 'A' }]))
            .mockResolvedValueOnce(buildApiResponse({ synthesis: 'Final answer.' }));

        const result = await orchestrator.executeClaudeWebSearch('test', {});

        expect(result.synthesis).toBe('Partial...Final answer.');
    });

    it('caps continuations at maxContinuations (3)', async () => {
        // All paused, never resolves
        mockRequestUrl.mockResolvedValue(buildPausedResponse(1, [{ url: 'https://a.com', title: 'A' }]));

        const result = await orchestrator.executeClaudeWebSearch('test', {});

        // 1 initial + 3 continuations = 4 API calls
        expect(mockRequestUrl).toHaveBeenCalledTimes(4);
        expect(result.searchCount).toBe(4); // 1 per call
    });

    // ═══ Source metadata deduplication ═══

    it('deduplicates source metadata by URL', async () => {
        // Response with two citations pointing to the same URL
        mockRequestUrl.mockResolvedValue({
            status: 200,
            json: {
                content: [
                    {
                        type: 'web_search_tool_result',
                        content: [
                            { type: 'web_search_result', url: 'https://example.com/a', title: 'A' },
                        ],
                    },
                    {
                        type: 'text',
                        text: 'Answer.',
                        citations: [
                            { type: 'web_search_result_location', url: 'https://example.com/a', title: 'A', cited_text: 'First cite.' },
                            { type: 'web_search_result_location', url: 'https://example.com/a', title: 'A', cited_text: 'Second cite.' },
                        ],
                    },
                ],
                usage: { input_tokens: 100, output_tokens: 50, server_tool_use: { web_search_requests: 1 } },
                stop_reason: 'end_turn',
            },
        });

        const result = await orchestrator.executeClaudeWebSearch('test', {});

        // One source metadata entry, not two
        expect(result.sourceMetadata).toHaveLength(1);
        expect(result.sourceMetadata[0].url).toBe('https://example.com/a');
        // Both cited texts combined
        expect(result.sourceMetadata[0].findings).toContain('First cite.');
        expect(result.sourceMetadata[0].findings).toContain('Second cite.');
    });

    // ═══ Budget checks ═══

    it('throws when budget is exceeded', async () => {
        usageService.checkBudget.mockReturnValue({ allowed: false, message: 'Monthly budget exceeded' });

        await expect(orchestrator.executeClaudeWebSearch('test', {}))
            .rejects.toThrow('Monthly budget exceeded');
    });

    it('does not call API when budget blocked', async () => {
        usageService.checkBudget.mockReturnValue({ allowed: false, message: 'Budget exceeded' });

        try { await orchestrator.executeClaudeWebSearch('test', {}); } catch { /* expected */ }

        expect(mockRequestUrl).not.toHaveBeenCalled();
    });

    // ═══ Quality scoring ═══

    it('applies quality scoring when enabled', async () => {
        plugin.settings.enableResearchQualityScoring = true;
        const mockQualityService = { scoreResults: vi.fn() };
        (orchestrator as any).qualityService = mockQualityService;

        mockRequestUrl.mockResolvedValue(buildApiResponse());

        await orchestrator.executeClaudeWebSearch('test', {});

        expect(mockQualityService.scoreResults).toHaveBeenCalledOnce();
    });

    // ═══ Academic mode enrichment ═══

    it('calls enrichAcademicMetadata when academicMode is true', async () => {
        mockRequestUrl.mockResolvedValue(buildApiResponse({
            urls: [{ url: 'https://arxiv.org/abs/2301.12345', title: 'A Paper' }],
        }));

        const spy = vi.spyOn(orchestrator as any, 'enrichAcademicMetadata');

        await orchestrator.executeClaudeWebSearch('test', { academicMode: true });

        expect(spy).toHaveBeenCalledOnce();
        spy.mockRestore();
    });

    it('does not call enrichAcademicMetadata when academicMode is false', async () => {
        mockRequestUrl.mockResolvedValue(buildApiResponse());

        const spy = vi.spyOn(orchestrator as any, 'enrichAcademicMetadata');

        await orchestrator.executeClaudeWebSearch('test', { academicMode: false });

        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    it('propagates academic metadata from searchResults into sourceMetadata', async () => {
        // Response with a citation URL matching a search result
        mockRequestUrl.mockResolvedValue({
            status: 200,
            json: {
                content: [
                    {
                        type: 'web_search_tool_result',
                        content: [
                            { type: 'web_search_result', url: 'https://arxiv.org/abs/2301.12345', title: 'A Paper' },
                        ],
                    },
                    {
                        type: 'text',
                        text: 'Answer.',
                        citations: [
                            { type: 'web_search_result_location', url: 'https://arxiv.org/abs/2301.12345', title: 'A Paper', cited_text: 'Finding.' },
                        ],
                    },
                ],
                usage: { input_tokens: 100, output_tokens: 50, server_tool_use: { web_search_requests: 1 } },
                stop_reason: 'end_turn',
            },
        });

        // Mock enrichAcademicMetadata to set doi/authors/year on search results
        vi.spyOn(orchestrator as any, 'enrichAcademicMetadata').mockImplementation((...args: unknown[]) => {
            const results = args[0] as any[];
            for (const r of results) {
                if (r.url.includes('arxiv.org')) {
                    r.doi = '10.48550/arXiv.2301.12345';
                    r.authors = ['Smith', 'Jones'];
                    r.year = 2023;
                }
            }
        });

        const result = await orchestrator.executeClaudeWebSearch('test', { academicMode: true });

        // sourceMetadata should now contain the academic fields propagated from searchResults
        expect(result.sourceMetadata).toHaveLength(1);
        expect(result.sourceMetadata[0].doi).toBe('10.48550/arXiv.2301.12345');
        expect(result.sourceMetadata[0].authors).toEqual(['Smith', 'Jones']);
        expect(result.sourceMetadata[0].year).toBe(2023);
    });

    // ═══ rawContent returned ═══

    it('returns rawContent from single-turn response', async () => {
        mockRequestUrl.mockResolvedValue(buildApiResponse());

        const result = await orchestrator.executeClaudeWebSearch('test', {});

        expect(result.rawContent).toBeDefined();
        expect(Array.isArray(result.rawContent)).toBe(true);
        expect(result.rawContent.length).toBeGreaterThan(0);
    });

    // ═══ Error handling ═══

    it('throws when provider is not available', async () => {
        const searchService = { search: vi.fn(), getProvider: vi.fn().mockReturnValue(null) } as any;
        const orch = new ResearchOrchestrator(searchService, plugin);

        await expect(orch.executeClaudeWebSearch('test', {}))
            .rejects.toThrow('Claude Web Search provider not available');
    });
});

// ═══ Multi-turn integration tests ═══

describe('executeClaudeWebSearchMultiTurn', () => {
    let adapter: ClaudeWebSearchAdapter;
    let orchestrator: ResearchOrchestrator;
    let plugin: ReturnType<typeof makePlugin>;
    let usageService: ReturnType<typeof makeUsageService>;

    beforeEach(() => {
        vi.clearAllMocks();
        adapter = new ClaudeWebSearchAdapter(() => Promise.resolve('test-key'), {
            model: 'claude-sonnet-4-6', maxSearches: 5, useDynamicFiltering: true,
        });
        plugin = makePlugin();
        usageService = makeUsageService();
        const searchService = makeSearchService(adapter);
        orchestrator = new ResearchOrchestrator(searchService, plugin);
        (orchestrator as any).usageService = usageService;
    });

    it('sends messages array through to adapter', async () => {
        mockRequestUrl.mockResolvedValue(buildApiResponse({
            urls: [{ url: 'https://example.com/a', title: 'A' }],
            synthesis: 'Follow-up answer.',
        }));

        const messages = [
            { role: 'user', content: 'What is X?' },
            { role: 'assistant', content: [{ type: 'text', text: 'X is...' }] },
            { role: 'user', content: 'Tell me more.' },
        ];

        const result = await orchestrator.executeClaudeWebSearchMultiTurn(messages, {});

        expect(result.synthesis).toBe('Follow-up answer.');
        expect(result.results).toHaveLength(1);
        expect(result.rawContent).toBeDefined();
    });

    it('handles pause_turn in multi-turn preserving user follow-up', async () => {
        mockRequestUrl
            .mockResolvedValueOnce(buildPausedResponse(1, [{ url: 'https://a.com', title: 'A' }]))
            .mockResolvedValueOnce(buildApiResponse({
                urls: [{ url: 'https://b.com', title: 'B' }],
                synthesis: 'Final.',
                searchCount: 1,
            }));

        const messages = [
            { role: 'user', content: 'First question' },
            { role: 'assistant', content: [{ type: 'text', text: 'First answer' }] },
            { role: 'user', content: 'Follow-up' },
        ];

        const result = await orchestrator.executeClaudeWebSearchMultiTurn(messages, {});

        expect(result.searchCount).toBe(2); // 1 + 1
        expect(mockRequestUrl).toHaveBeenCalledTimes(2);

        // Continuation should preserve ALL original messages (including user's follow-up)
        // then append assistant's paused content + "Please continue."
        const continuationBody = JSON.parse(mockRequestUrl.mock.calls[1][0].body);
        const msgs = continuationBody.messages;
        // Original 3 messages + assistant (paused) + user ("Please continue.") = 5
        expect(msgs).toHaveLength(5);
        expect(msgs[0]).toMatchObject({ role: 'user', content: 'First question' });
        expect(msgs[1]).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'First answer' }] });
        expect(msgs[2]).toMatchObject({ role: 'user', content: 'Follow-up' }); // User's follow-up preserved
        expect(msgs[3].role).toBe('assistant'); // Paused rawContent
        expect(msgs[4]).toMatchObject({ role: 'user', content: 'Please continue.' });
    });

    it('records usage across multi-turn calls', async () => {
        mockRequestUrl.mockResolvedValue(buildApiResponse({ searchCount: 2 }));

        await orchestrator.executeClaudeWebSearchMultiTurn(
            [{ role: 'user', content: 'test' }],
            {},
        );

        expect(usageService.recordOperation).toHaveBeenCalledTimes(2);
    });

    it('checks budget before multi-turn call', async () => {
        usageService.checkBudget.mockReturnValue({ allowed: false, message: 'Budget exceeded' });

        await expect(orchestrator.executeClaudeWebSearchMultiTurn(
            [{ role: 'user', content: 'test' }],
            {},
        )).rejects.toThrow('Budget exceeded');

        expect(mockRequestUrl).not.toHaveBeenCalled();
    });

    it('calls onPhaseChange callbacks', async () => {
        mockRequestUrl.mockResolvedValue(buildApiResponse());
        const phases: string[] = [];

        await orchestrator.executeClaudeWebSearchMultiTurn(
            [{ role: 'user', content: 'test' }],
            {},
            { onPhaseChange: (p) => phases.push(p) },
        );

        expect(phases).toEqual(['searching', 'done']);
    });
});
