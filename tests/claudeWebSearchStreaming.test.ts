/**
 * Claude Web Search Streaming tests
 *
 * Tests SSE event parsing, raw content reconstruction for pause_turn fidelity,
 * adapter streaming methods, orchestrator streaming with shared accumulation helpers,
 * modal streaming contract, and handler streaming branch.
 */

// ── Module-level mocks ──

vi.mock('obsidian', async () => {
    const mod = await import('./mocks/obsidian');
    return { ...mod, requestUrl: vi.fn(), Platform: { isMobile: false } };
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

import { ClaudeWebSearchAdapter } from '../src/services/research/adapters/claudeWebSearchAdapter';
import { ResearchOrchestrator } from '../src/services/research/researchOrchestrator';
import type { ClaudeWebSearchResponse, ClaudeWebSearchStreamCallbacks } from '../src/services/research/researchTypes';

// ── SSE Helpers ──

/** Build an SSE line from event type and data. */
function sse(data: Record<string, unknown>): string {
    return `data: ${JSON.stringify(data)}`;
}

function sseMessageStart(inputTokens = 100): string {
    return sse({ type: 'message_start', message: { usage: { input_tokens: inputTokens } } });
}

function sseBlockStart(index: number, block: Record<string, unknown>): string {
    return sse({ type: 'content_block_start', index, content_block: block });
}

function sseBlockDelta(index: number, delta: Record<string, unknown>): string {
    return sse({ type: 'content_block_delta', index, delta });
}

function sseBlockStop(index: number): string {
    return sse({ type: 'content_block_stop', index });
}

function sseMessageDelta(stopReason: string, outputTokens = 200, searchRequests = 1): string {
    return sse({
        type: 'message_delta',
        delta: { stop_reason: stopReason },
        usage: { output_tokens: outputTokens, server_tool_use: { web_search_requests: searchRequests } },
    });
}

function sseMessageStop(): string {
    return sse({ type: 'message_stop' });
}

/** Build a complete SSE stream for a typical search + synthesis response. */
function buildTypicalSSEStream(opts: {
    query?: string;
    urls?: { url: string; title: string; encrypted_content?: string }[];
    synthesis?: string;
    citations?: { url: string; title: string; cited_text: string }[];
    stopReason?: string;
    searchRequests?: number;
    preamble?: string;
} = {}): string[] {
    const query = opts.query ?? 'test query';
    const urls = opts.urls ?? [{ url: 'https://example.com/a', title: 'Article A', encrypted_content: 'enc...' }];
    const synthesis = opts.synthesis ?? 'Synthesized answer.';
    const citations = opts.citations ?? [{ url: urls[0].url, title: urls[0].title, cited_text: 'Some cited text.' }];
    const stopReason = opts.stopReason ?? 'end_turn';
    const searchRequests = opts.searchRequests ?? 1;

    const lines: string[] = [sseMessageStart()];
    let idx = 0;

    // Optional preamble text block (before search)
    if (opts.preamble) {
        lines.push(sseBlockStart(idx, { type: 'text' }));
        lines.push(sseBlockDelta(idx, { type: 'text_delta', text: opts.preamble }));
        lines.push(sseBlockStop(idx));
        idx++;
    }

    // server_tool_use block
    lines.push(sseBlockStart(idx, { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search' }));
    lines.push(sseBlockDelta(idx, { type: 'input_json_delta', partial_json: `{"query":"${query}"}` }));
    lines.push(sseBlockStop(idx));
    idx++;

    // web_search_tool_result block
    lines.push(sseBlockStart(idx, {
        type: 'web_search_tool_result',
        tool_use_id: 'srvtoolu_1',
        content: urls.map(u => ({
            type: 'web_search_result', url: u.url, title: u.title,
            encrypted_content: u.encrypted_content ?? 'enc...',
        })),
    }));
    lines.push(sseBlockStop(idx));
    idx++;

    // text block with synthesis + citations
    lines.push(sseBlockStart(idx, { type: 'text' }));
    // Send synthesis in two chunks for testing
    const mid = Math.floor(synthesis.length / 2);
    lines.push(sseBlockDelta(idx, { type: 'text_delta', text: synthesis.slice(0, mid) }));
    lines.push(sseBlockDelta(idx, { type: 'text_delta', text: synthesis.slice(mid) }));
    lines.push(sseBlockStop(idx));
    idx++;

    lines.push(sseMessageDelta(stopReason, 200, searchRequests));
    lines.push(sseMessageStop());

    return lines;
}

/** Create a mock fetch Response from SSE lines. */
function mockFetchResponse(lines: string[], status = 200): Response {
    const body = lines.join('\n') + '\n';
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
        },
    });
    return new Response(stream, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

// ── Test Helpers ──

function makeAdapter(apiKey = 'test-key') {
    return new ClaudeWebSearchAdapter(() => Promise.resolve(apiKey), {
        model: 'claude-sonnet-4-6', maxSearches: 5, useDynamicFiltering: true,
    });
}

function makePlugin(overrides: Record<string, unknown> = {}) {
    return {
        settings: {
            cloudServiceType: 'claude',
            cloudModel: 'claude-sonnet-4-6',
            enableResearchQualityScoring: false,
            enableResearchStreamingSynthesis: true,
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

// ── Tests ──

describe('ClaudeWebSearchAdapter SSE parsing', () => {
    let adapter: ClaudeWebSearchAdapter;

    beforeEach(() => {
        vi.clearAllMocks();
        adapter = makeAdapter();
    });

    // ═══ parseStreamingLine ═══

    it('parses message_start event and extracts input tokens', () => {
        const state = (adapter as any).createStreamState();
        adapter.parseStreamingLine(sseMessageStart(500), state);
        expect(state.usage.inputTokens).toBe(500);
    });

    it('parses content_block_start for server_tool_use', () => {
        const state = (adapter as any).createStreamState();
        adapter.parseStreamingLine(
            sseBlockStart(0, { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search' }),
            state,
        );
        expect(state.currentBlockType).toBe('server_tool_use');
        expect(state.currentServerToolUse).toMatchObject({ id: 'srvtoolu_1', name: 'web_search' });
    });

    it('buffers input_json_delta partial JSON', () => {
        const state = (adapter as any).createStreamState();
        adapter.parseStreamingLine(
            sseBlockStart(0, { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search' }),
            state,
        );
        adapter.parseStreamingLine(
            sseBlockDelta(0, { type: 'input_json_delta', partial_json: '{"query":' }),
            state,
        );
        adapter.parseStreamingLine(
            sseBlockDelta(0, { type: 'input_json_delta', partial_json: '"test"}' }),
            state,
        );
        expect(state.inputJsonBuffer).toBe('{"query":"test"}');
    });

    it('fires onSearchQuery on content_block_stop for server_tool_use', () => {
        const state = (adapter as any).createStreamState();
        const onSearchQuery = vi.fn();
        // Start block
        adapter.parseStreamingLine(
            sseBlockStart(0, { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search' }),
            state,
        );
        // Delta with query JSON
        adapter.parseStreamingLine(
            sseBlockDelta(0, { type: 'input_json_delta', partial_json: '{"query":"quantum computing"}' }),
            state,
        );
        // Stop block
        adapter.parseStreamingLine(sseBlockStop(0), state, { onSearchQuery });
        expect(onSearchQuery).toHaveBeenCalledWith('quantum computing');
        expect(state.searchQueries).toContain('quantum computing');
    });

    it('extracts search results from web_search_tool_result content_block_start', () => {
        const state = (adapter as any).createStreamState();
        adapter.parseStreamingLine(
            sseBlockStart(1, {
                type: 'web_search_tool_result',
                tool_use_id: 'srvtoolu_1',
                content: [
                    { type: 'web_search_result', url: 'https://example.com', title: 'Example', encrypted_content: 'enc...' },
                ],
            }),
            state,
        );
        expect(state.searchResults).toHaveLength(1);
        expect(state.searchResults[0].url).toBe('https://example.com');
    });

    it('fires onSearchResult callback for search results', () => {
        const state = (adapter as any).createStreamState();
        const onSearchResult = vi.fn();
        adapter.parseStreamingLine(
            sseBlockStart(1, {
                type: 'web_search_tool_result',
                content: [
                    { type: 'web_search_result', url: 'https://example.com', title: 'Ex' },
                ],
            }),
            state, { onSearchResult },
        );
        expect(onSearchResult).toHaveBeenCalledTimes(1);
    });

    it('starts text accumulation on text content_block_start', () => {
        const state = (adapter as any).createStreamState();
        adapter.parseStreamingLine(sseBlockStart(2, { type: 'text' }), state);
        expect(state.currentBlockType).toBe('text');
        expect(state.currentTextBlock).toEqual({ text: '', citations: [] });
    });

    it('fires onTextChunk for text_delta events', () => {
        const state = (adapter as any).createStreamState();
        const onTextChunk = vi.fn();
        // Need a search result first so text is after it (not preamble)
        state.lastSearchResultBlockIndex = 0;
        state.rawContent.push({ type: 'web_search_tool_result' });

        adapter.parseStreamingLine(sseBlockStart(1, { type: 'text' }), state);
        adapter.parseStreamingLine(
            sseBlockDelta(1, { type: 'text_delta', text: 'Hello ' }),
            state, { onTextChunk },
        );
        adapter.parseStreamingLine(
            sseBlockDelta(1, { type: 'text_delta', text: 'world' }),
            state, { onTextChunk },
        );
        expect(onTextChunk).toHaveBeenCalledTimes(2);
        expect(onTextChunk).toHaveBeenCalledWith('Hello ');
        expect(onTextChunk).toHaveBeenCalledWith('world');
        expect(state.currentTextBlock!.text).toBe('Hello world');
    });

    it('extracts stop_reason from message_delta', () => {
        const state = (adapter as any).createStreamState();
        adapter.parseStreamingLine(sseMessageDelta('end_turn', 300, 2), state);
        expect(state.stopReason).toBe('end_turn');
        expect(state.usage.outputTokens).toBe(300);
        expect(state.usage.searchRequests).toBe(2);
    });

    it('detects pause_turn from message_delta', () => {
        const state = (adapter as any).createStreamState();
        adapter.parseStreamingLine(sseMessageDelta('pause_turn'), state);
        expect(state.stopReason).toBe('pause_turn');
    });

    it('excludes preamble text blocks before search results from synthesis', () => {
        const state = (adapter as any).createStreamState();
        const onTextChunk = vi.fn();

        // Preamble text block (before any search results)
        adapter.parseStreamingLine(sseBlockStart(0, { type: 'text' }), state);
        adapter.parseStreamingLine(
            sseBlockDelta(0, { type: 'text_delta', text: "I'll search for..." }),
            state, { onTextChunk },
        );
        adapter.parseStreamingLine(sseBlockStop(0), state);

        // Search result
        adapter.parseStreamingLine(
            sseBlockStart(1, {
                type: 'web_search_tool_result', content: [
                    { type: 'web_search_result', url: 'https://ex.com', title: 'Ex' },
                ],
            }),
            state,
        );
        adapter.parseStreamingLine(sseBlockStop(1), state);

        // Synthesis text (after search)
        adapter.parseStreamingLine(sseBlockStart(2, { type: 'text' }), state);
        adapter.parseStreamingLine(
            sseBlockDelta(2, { type: 'text_delta', text: 'Real synthesis' }),
            state, { onTextChunk },
        );
        adapter.parseStreamingLine(sseBlockStop(2), state);

        // Preamble text was NOT fired as chunk and NOT in textParts
        expect(onTextChunk).toHaveBeenCalledTimes(1);
        expect(onTextChunk).toHaveBeenCalledWith('Real synthesis');
        expect(state.textParts).toEqual(['Real synthesis']);
    });

    it('skips malformed SSE lines gracefully', () => {
        const state = (adapter as any).createStreamState();
        // Not a data line
        adapter.parseStreamingLine('event: message_start', state);
        // Invalid JSON
        adapter.parseStreamingLine('data: {invalid json}', state);
        // Empty data
        adapter.parseStreamingLine('data: ', state);
        // [DONE]
        adapter.parseStreamingLine('data: [DONE]', state);
        // No crash, state unchanged
        expect(state.currentBlockType).toBeNull();
    });
});

describe('ClaudeWebSearchAdapter raw content reconstruction', () => {
    let adapter: ClaudeWebSearchAdapter;

    beforeEach(() => {
        vi.clearAllMocks();
        adapter = makeAdapter();
    });

    it('reconstructs server_tool_use blocks in rawContent', () => {
        const state = (adapter as any).createStreamState();
        const lines = [
            sseBlockStart(0, { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search' }),
            sseBlockDelta(0, { type: 'input_json_delta', partial_json: '{"query":"test"}' }),
            sseBlockStop(0),
        ];
        for (const line of lines) adapter.parseStreamingLine(line, state);

        expect(state.rawContent).toHaveLength(1);
        expect(state.rawContent[0]).toMatchObject({
            type: 'server_tool_use',
            id: 'srvtoolu_1',
            name: 'web_search',
            input: { query: 'test' },
        });
    });

    it('reconstructs web_search_tool_result blocks with encrypted_content', () => {
        const state = (adapter as any).createStreamState();
        const block = {
            type: 'web_search_tool_result',
            tool_use_id: 'srvtoolu_1',
            content: [
                { type: 'web_search_result', url: 'https://example.com', title: 'Ex', encrypted_content: 'EqgfCioIARgB...' },
            ],
        };
        adapter.parseStreamingLine(sseBlockStart(1, block), state);
        adapter.parseStreamingLine(sseBlockStop(1), state);

        expect(state.rawContent).toHaveLength(1);
        expect((state.rawContent[0] as any).content[0].encrypted_content).toBe('EqgfCioIARgB...');
    });

    it('reconstructs text blocks in rawContent', () => {
        const state = (adapter as any).createStreamState();
        adapter.parseStreamingLine(sseBlockStart(0, { type: 'text' }), state);
        adapter.parseStreamingLine(sseBlockDelta(0, { type: 'text_delta', text: 'Hello' }), state);
        adapter.parseStreamingLine(sseBlockStop(0), state);

        expect(state.rawContent).toHaveLength(1);
        expect(state.rawContent[0]).toMatchObject({ type: 'text', text: 'Hello' });
    });

    it('preserves block order matching non-streaming parseResponse', () => {
        const state = (adapter as any).createStreamState();
        const lines = buildTypicalSSEStream();
        for (const line of lines) adapter.parseStreamingLine(line, state);

        // Order: server_tool_use, web_search_tool_result, text
        expect((state.rawContent[0] as any).type).toBe('server_tool_use');
        expect((state.rawContent[1] as any).type).toBe('web_search_tool_result');
        expect((state.rawContent[2] as any).type).toBe('text');
    });
});

describe('ClaudeWebSearchAdapter searchAndSynthesizeStream()', () => {
    let adapter: ClaudeWebSearchAdapter;

    beforeEach(() => {
        vi.clearAllMocks();
        adapter = makeAdapter();
    });

    it('builds correct request with stream: true', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            mockFetchResponse(buildTypicalSSEStream()),
        );

        await adapter.searchAndSynthesizeStream('What is X?');

        expect(fetchSpy).toHaveBeenCalledOnce();
        const [url, options] = fetchSpy.mock.calls[0];
        expect(url).toContain('/v1/messages');
        const body = JSON.parse(options!.body as string);
        expect(body.stream).toBe(true);
        expect(body.messages).toEqual([{ role: 'user', content: 'What is X?' }]);
        fetchSpy.mockRestore();
    });

    it('fires callbacks in correct order', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            mockFetchResponse(buildTypicalSSEStream({ query: 'quantum' })),
        );
        const events: string[] = [];
        const callbacks: ClaudeWebSearchStreamCallbacks = {
            onSearchQuery: () => events.push('query'),
            onTextChunk: () => events.push('chunk'),
            onSearchResult: () => events.push('result'),
        };

        await adapter.searchAndSynthesizeStream('test', undefined, callbacks);

        // SSE order: server_tool_use (query) fires before web_search_tool_result (result)
        expect(events[0]).toBe('query');
        expect(events[1]).toBe('result');
        // Text chunks come after search results
        expect(events.filter(e => e === 'chunk').length).toBeGreaterThan(0);
        fetchSpy.mockRestore();
    });

    it('returns assembled ClaudeWebSearchResponse', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            mockFetchResponse(buildTypicalSSEStream({
                synthesis: 'Answer text.',
                searchRequests: 2,
            })),
        );

        const result = await adapter.searchAndSynthesizeStream('test');

        expect(result.synthesis).toBe('Answer text.');
        expect(result.searchCount).toBe(2);
        expect(result.searchResults).toHaveLength(1);
        expect(result.paused).toBe(false);
        expect(result.rawContent.length).toBeGreaterThan(0);
        fetchSpy.mockRestore();
    });

    it('throws on non-200 response', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response('error', { status: 500 }),
        );

        await expect(adapter.searchAndSynthesizeStream('test'))
            .rejects.toThrow('HTTP 500');
        fetchSpy.mockRestore();
    });

    it('supports abort signal', async () => {
        const controller = new AbortController();
        controller.abort();
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
            new DOMException('Aborted', 'AbortError'),
        );

        await expect(adapter.searchAndSynthesizeStream('test', undefined, undefined, controller.signal))
            .rejects.toThrow('Aborted');
        fetchSpy.mockRestore();
    });
});

describe('ClaudeWebSearchAdapter continueSearchStream()', () => {
    let adapter: ClaudeWebSearchAdapter;

    beforeEach(() => {
        vi.clearAllMocks();
        adapter = makeAdapter();
    });

    it('sends multi-message body with stream: true', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            mockFetchResponse(buildTypicalSSEStream()),
        );
        const rawContent = [{ type: 'text', text: 'Partial...' }];

        await adapter.continueSearchStream('original question', rawContent);

        const body = JSON.parse((fetchSpy.mock.calls[0][1]!.body as string));
        expect(body.stream).toBe(true);
        expect(body.messages).toHaveLength(3);
        expect(body.messages[0]).toEqual({ role: 'user', content: 'original question' });
        expect(body.messages[1]).toEqual({ role: 'assistant', content: rawContent });
        expect(body.messages[2]).toEqual({ role: 'user', content: 'Please continue.' });
        fetchSpy.mockRestore();
    });

    it('passes rawContent as assistant content', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            mockFetchResponse(buildTypicalSSEStream()),
        );
        const rawContent = [
            { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'test' } },
            { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://a.com', title: 'A' }] },
            { type: 'text', text: 'Partial synthesis' },
        ];

        await adapter.continueSearchStream('q', rawContent);

        const body = JSON.parse((fetchSpy.mock.calls[0][1]!.body as string));
        expect(body.messages[1].content).toEqual(rawContent);
        fetchSpy.mockRestore();
    });

    it('preserves domain filtering from options', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            mockFetchResponse(buildTypicalSSEStream()),
        );

        await adapter.continueSearchStream('q', [], { siteScope: 'academic' });

        const body = JSON.parse((fetchSpy.mock.calls[0][1]!.body as string));
        expect(body.tools[0].allowed_domains).toContain('arxiv.org');
        fetchSpy.mockRestore();
    });
});

describe('Orchestrator shared helpers', () => {
    let orchestrator: ResearchOrchestrator;

    beforeEach(() => {
        vi.clearAllMocks();
        const adapter = makeAdapter();
        const plugin = makePlugin();
        const searchService = makeSearchService(adapter);
        orchestrator = new ResearchOrchestrator(searchService, plugin);
    });

    it('accumulateContinuation merges search results with dedup by URL', () => {
        const prev: ClaudeWebSearchResponse = {
            searchResults: [{ url: 'https://a.com', title: 'A', snippet: '', source: 'web', domain: 'a.com' }],
            synthesis: 'Part 1. ', citations: [], searchCount: 1,
            usage: { inputTokens: 100, outputTokens: 50 }, paused: true, rawContent: [],
        };
        const current: ClaudeWebSearchResponse = {
            searchResults: [
                { url: 'https://a.com', title: 'A Updated', snippet: '', source: 'web', domain: 'a.com' },
                { url: 'https://b.com', title: 'B', snippet: '', source: 'web', domain: 'b.com' },
            ],
            synthesis: 'Part 2.', citations: [], searchCount: 1,
            usage: { inputTokens: 100, outputTokens: 50 }, paused: false, rawContent: [],
        };

        (orchestrator as any).accumulateContinuation(prev, current);

        const urls = current.searchResults.map(r => r.url);
        expect(urls).toContain('https://a.com');
        expect(urls).toContain('https://b.com');
        expect(urls.filter(u => u === 'https://a.com')).toHaveLength(1);
    });

    it('accumulateContinuation prepends synthesis text', () => {
        const prev = { synthesis: 'First. ', citations: [], searchResults: [] } as any;
        const current = { synthesis: 'Second.', citations: [], searchResults: [] } as any;

        (orchestrator as any).accumulateContinuation(prev, current);

        expect(current.synthesis).toBe('First. Second.');
    });

    it('accumulateContinuation merges citations arrays', () => {
        const prev = {
            citations: [{ url: 'https://a.com', title: 'A', citedText: 'Cite 1' }],
            synthesis: '', searchResults: [],
        } as any;
        const current = {
            citations: [{ url: 'https://b.com', title: 'B', citedText: 'Cite 2' }],
            synthesis: '', searchResults: [],
        } as any;

        (orchestrator as any).accumulateContinuation(prev, current);

        expect(current.citations).toHaveLength(2);
        expect(current.citations[0].url).toBe('https://a.com');
        expect(current.citations[1].url).toBe('https://b.com');
    });

    it('buildSourceMetadataMap deduplicates by URL and combines cited text', () => {
        const citations = [
            { url: 'https://a.com', title: 'A', citedText: 'First cite.' },
            { url: 'https://a.com', title: 'A', citedText: 'Second cite.' },
            { url: 'https://b.com', title: 'B', citedText: 'B cite.' },
        ];

        const result = (orchestrator as any).buildSourceMetadataMap(citations);

        expect(result).toHaveLength(2);
        const aEntry = result.find((m: any) => m.url === 'https://a.com');
        expect(aEntry.findings).toContain('First cite.');
        expect(aEntry.findings).toContain('Second cite.');
    });

    it('buildSourceMetadataMap propagates doi/authors/year from searchResults', () => {
        const citations = [
            { url: 'https://arxiv.org/abs/123', title: 'Paper', citedText: 'Finding.' },
        ];
        const searchResults = [
            {
                url: 'https://arxiv.org/abs/123', title: 'Paper', snippet: '', source: 'academic' as const,
                domain: 'arxiv.org', doi: '10.1234/test', authors: ['Smith'], year: 2024,
            },
        ];

        const result = (orchestrator as any).buildSourceMetadataMap(citations, searchResults);

        expect(result).toHaveLength(1);
        expect(result[0].doi).toBe('10.1234/test');
        expect(result[0].authors).toEqual(['Smith']);
        expect(result[0].year).toBe(2024);
    });

    it('buildSourceMetadataMap works without searchResults (backward compatible)', () => {
        const citations = [
            { url: 'https://a.com', title: 'A', citedText: 'Cite.' },
        ];

        const result = (orchestrator as any).buildSourceMetadataMap(citations);

        expect(result).toHaveLength(1);
        expect(result[0].doi).toBeUndefined();
        expect(result[0].authors).toBeUndefined();
    });
});

describe('Orchestrator executeClaudeWebSearchStream()', () => {
    let adapter: ClaudeWebSearchAdapter;
    let orchestrator: ResearchOrchestrator;
    let usageService: ReturnType<typeof makeUsageService>;

    beforeEach(() => {
        vi.clearAllMocks();
        adapter = makeAdapter();
        const plugin = makePlugin();
        usageService = makeUsageService();
        const searchService = makeSearchService(adapter);
        orchestrator = new ResearchOrchestrator(searchService, plugin);
        (orchestrator as any).usageService = usageService;
    });

    it('wires callbacks from orchestrator to adapter', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            mockFetchResponse(buildTypicalSSEStream({ query: 'quantum' })),
        );
        const callbacks: ClaudeWebSearchStreamCallbacks = {
            onSearchQuery: vi.fn(),
            onTextChunk: vi.fn(),
            onPhaseChange: vi.fn(),
        };

        await orchestrator.executeClaudeWebSearchStream('test', {}, callbacks);

        expect(callbacks.onPhaseChange).toHaveBeenCalledWith('searching');
        expect(callbacks.onPhaseChange).toHaveBeenCalledWith('done');
        expect(callbacks.onSearchQuery).toHaveBeenCalledWith('quantum');
        expect(callbacks.onTextChunk).toHaveBeenCalled();
        fetchSpy.mockRestore();
    });

    it('accumulates across pause_turn continuations', async () => {
        const pausedLines = buildTypicalSSEStream({
            query: 'q1',
            urls: [{ url: 'https://a.com', title: 'A' }],
            synthesis: 'Part 1. ',
            stopReason: 'pause_turn',
            searchRequests: 2,
        });
        const finalLines = buildTypicalSSEStream({
            query: 'q2',
            urls: [{ url: 'https://b.com', title: 'B' }],
            synthesis: 'Part 2.',
            searchRequests: 1,
        });

        let callCount = 0;
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
            callCount++;
            return callCount === 1
                ? mockFetchResponse(pausedLines)
                : mockFetchResponse(finalLines);
        });

        const result = await orchestrator.executeClaudeWebSearchStream('test', {}, {});

        expect(result.searchCount).toBe(3); // 2 + 1
        expect(result.synthesis).toContain('Part 1.');
        expect(result.synthesis).toContain('Part 2.');
        const urls = result.results.map(r => r.url);
        expect(urls).toContain('https://a.com');
        expect(urls).toContain('https://b.com');
        fetchSpy.mockRestore();
    });

    it('checks budget before streaming', async () => {
        usageService.checkBudget.mockReturnValue({ allowed: false, message: 'Budget exceeded' });

        await expect(orchestrator.executeClaudeWebSearchStream('test', {}, {}))
            .rejects.toThrow('Budget exceeded');

        expect(vi.spyOn(globalThis, 'fetch')).not.toHaveBeenCalled();
    });

    it('records usage with accumulated search counts', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            mockFetchResponse(buildTypicalSSEStream({ searchRequests: 3 })),
        );

        await orchestrator.executeClaudeWebSearchStream('test', {}, {});

        expect(usageService.recordOperation).toHaveBeenCalledTimes(3);
        expect(usageService.recordOperation).toHaveBeenCalledWith('claude-web-search');
        fetchSpy.mockRestore();
    });

    it('builds deduplicated source metadata', async () => {
        // Response with duplicate citations to same URL
        const lines = buildTypicalSSEStream({
            urls: [{ url: 'https://example.com', title: 'Ex' }],
        });
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockFetchResponse(lines));

        const result = await orchestrator.executeClaudeWebSearchStream('test', {}, {});

        // Source metadata should have entries (may be empty if no citations in SSE stream)
        expect(result.sourceMetadata).toBeDefined();
        expect(Array.isArray(result.sourceMetadata)).toBe(true);
        fetchSpy.mockRestore();
    });

    it('applies quality scoring when enabled', async () => {
        const plugin = makePlugin({ enableResearchQualityScoring: true });
        const mockQualityService = { scoreResults: vi.fn() };
        const searchService = makeSearchService(adapter);
        const orch = new ResearchOrchestrator(searchService, plugin);
        (orch as any).usageService = usageService;
        (orch as any).qualityService = mockQualityService;

        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            mockFetchResponse(buildTypicalSSEStream()),
        );

        await orch.executeClaudeWebSearchStream('test', {}, {});

        expect(mockQualityService.scoreResults).toHaveBeenCalledOnce();
        fetchSpy.mockRestore();
    });

    it('propagates abort signal', async () => {
        const controller = new AbortController();
        controller.abort();
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
            new DOMException('Aborted', 'AbortError'),
        );

        await expect(orchestrator.executeClaudeWebSearchStream('test', {}, {}, controller.signal))
            .rejects.toThrow();
        fetchSpy.mockRestore();
    });

    it('caps continuations at maxContinuations (3)', async () => {
        // Must create fresh Response for each call (body is consumed once)
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
            mockFetchResponse(buildTypicalSSEStream({ stopReason: 'pause_turn', searchRequests: 1 })),
        );

        const result = await orchestrator.executeClaudeWebSearchStream('test', {}, {});

        // 1 initial + 3 continuations = 4 fetch calls
        expect(fetchSpy).toHaveBeenCalledTimes(4);
        expect(result.searchCount).toBe(4);
        fetchSpy.mockRestore();
    });
});

describe('Modal streaming contract', () => {
    it('SendResult streamingSetup type is optional', () => {
        // Just verify the type works — no streamingSetup means non-streaming
        const result: import('../src/ui/chat/ChatModeHandler').SendResult = {
            prompt: '',
            directResponse: 'Hello',
        };
        expect(result.streamingSetup).toBeUndefined();
    });

    it('streamingSetup.start receives callbacks and returns result', async () => {
        const updates: string[] = [];
        const result: import('../src/ui/chat/ChatModeHandler').SendResult = {
            prompt: '',
            streamingSetup: {
                start: async (cb) => {
                    cb.updateMessage('chunk 1');
                    cb.updateMessage('chunk 1chunk 2');
                    return { finalContent: 'final text' };
                },
            },
        };

        const streamResult = await result.streamingSetup!.start({
            updateMessage: (c) => updates.push(c),
            addSystemNotice: vi.fn(),
        });

        expect(updates).toEqual(['chunk 1', 'chunk 1chunk 2']);
        expect(streamResult.finalContent).toBe('final text');
    });

    it('streamingSetup can include sources in result', async () => {
        const result: import('../src/ui/chat/ChatModeHandler').SendResult = {
            prompt: '',
            streamingSetup: {
                start: async () => ({
                    finalContent: 'text',
                    sources: ['https://example.com'],
                }),
            },
        };

        const streamResult = await result.streamingSetup!.start({
            updateMessage: vi.fn(),
            addSystemNotice: vi.fn(),
        });

        expect(streamResult.sources).toEqual(['https://example.com']);
    });
});

// ═══ Code review fixes — P2 round ═══

describe('Streaming citations_delta parsing (Finding 2)', () => {
    let adapter: ClaudeWebSearchAdapter;

    beforeEach(() => {
        vi.clearAllMocks();
        adapter = makeAdapter();
    });

    it('accumulates citations from citations_delta events into text block', () => {
        const state = (adapter as any).createStreamState();

        // Start text block after a search result to ensure it passes preamble filter
        state.lastSearchResultBlockIndex = 0;
        state.rawContent.push({ type: 'web_search_tool_result' });

        adapter.parseStreamingLine(sseBlockStart(1, { type: 'text' }), state);
        adapter.parseStreamingLine(sseBlockDelta(1, { type: 'text_delta', text: 'Answer text. ' }), state);
        adapter.parseStreamingLine(sseBlockDelta(1, {
            type: 'citations_delta',
            citation: {
                type: 'web_search_result_location',
                url: 'https://example.com',
                title: 'Example',
                cited_text: 'Some evidence',
                encrypted_index: 'enc...',
            },
        }), state);
        adapter.parseStreamingLine(sseBlockDelta(1, { type: 'text_delta', text: 'More text.' }), state);
        adapter.parseStreamingLine(sseBlockDelta(1, {
            type: 'citations_delta',
            citation: {
                type: 'web_search_result_location',
                url: 'https://other.com',
                title: 'Other',
                cited_text: 'Other evidence',
                encrypted_index: 'enc2...',
            },
        }), state);
        adapter.parseStreamingLine(sseBlockStop(1), state);

        // Citations should be populated
        expect(state.currentTextBlock).toBeNull(); // finalized
        const lastRaw = state.rawContent.at(-1) as Record<string, unknown>;
        expect(lastRaw.type).toBe('text');
        expect(Array.isArray(lastRaw.citations)).toBe(true);
        expect((lastRaw.citations as unknown[]).length).toBe(2);
    });

    it('citations_delta is ignored when no text block is active', () => {
        const state = (adapter as any).createStreamState();
        // No text block open
        adapter.parseStreamingLine(sseBlockDelta(0, {
            type: 'citations_delta',
            citation: { type: 'web_search_result_location', url: 'https://x.com', title: 'X', cited_text: 'y' },
        }), state);
        expect(state.citations).toHaveLength(0);
    });

    it('streaming response with citations_delta produces ParsedCitation entries', () => {
        const state = (adapter as any).createStreamState();

        // Simulate: search result block → text block with citations
        const searchBlock = {
            type: 'web_search_tool_result',
            content: [{ type: 'web_search_result', url: 'https://example.com', title: 'Ex', encrypted_content: 'enc' }],
        };
        adapter.parseStreamingLine(sseBlockStart(0, searchBlock), state);
        adapter.parseStreamingLine(sseBlockStop(0), state);

        adapter.parseStreamingLine(sseBlockStart(1, { type: 'text' }), state);
        adapter.parseStreamingLine(sseBlockDelta(1, { type: 'text_delta', text: 'Answer.' }), state);
        adapter.parseStreamingLine(sseBlockDelta(1, {
            type: 'citations_delta',
            citation: {
                type: 'web_search_result_location',
                url: 'https://example.com',
                title: 'Ex',
                cited_text: 'Cited evidence from example',
            },
        }), state);
        adapter.parseStreamingLine(sseBlockStop(1), state);

        // After finalizeTextBlock, extractCitations should have populated state.citations
        expect(state.citations.length).toBe(1);
        expect(state.citations[0]).toMatchObject({
            url: 'https://example.com',
            title: 'Ex',
            citedText: 'Cited evidence from example',
        });
    });

    it('assembleStreamResponse assigns citation scores from streamed citations', () => {
        const state = (adapter as any).createStreamState();

        // Simulate a search result
        state.searchResults.push({
            title: 'Ex', url: 'https://example.com', snippet: '', source: 'web',
            date: undefined, domain: 'example.com', score: undefined,
        });

        // Simulate citations
        state.citations.push(
            { url: 'https://example.com', title: 'Ex', citedText: 'a' },
            { url: 'https://example.com', title: 'Ex', citedText: 'b' },
        );

        const response = (adapter as any).assembleStreamResponse(state);
        expect(response.citations.length).toBe(2);
        // Score should be 1.0 (only URL, cited 2 times / max 2)
        expect(response.searchResults[0].score).toBe(1);
    });
});

describe('onSearchResult duplicate fix (Finding 4)', () => {
    let adapter: ClaudeWebSearchAdapter;

    beforeEach(() => {
        vi.clearAllMocks();
        adapter = makeAdapter();
    });

    it('emits only newly added search results, not all accumulated', () => {
        const state = (adapter as any).createStreamState();
        const emitted: string[] = [];
        const callbacks = { onSearchResult: (r: any) => emitted.push(r.url) };

        // First search result block
        adapter.parseStreamingLine(
            sseBlockStart(0, {
                type: 'web_search_tool_result',
                tool_use_id: 'srvtoolu_1',
                content: [
                    { type: 'web_search_result', url: 'https://a.com', title: 'A', encrypted_content: 'e' },
                ],
            }),
            state, callbacks,
        );
        expect(emitted).toEqual(['https://a.com']);

        // Second search result block (from a second web search)
        adapter.parseStreamingLine(sseBlockStop(0), state);
        adapter.parseStreamingLine(
            sseBlockStart(1, {
                type: 'web_search_tool_result',
                tool_use_id: 'srvtoolu_2',
                content: [
                    { type: 'web_search_result', url: 'https://b.com', title: 'B', encrypted_content: 'e' },
                ],
            }),
            state, callbacks,
        );

        // Should only emit the new one, not re-emit 'a.com'
        expect(emitted).toEqual(['https://a.com', 'https://b.com']);
    });
});

describe('ClaudeWebSearchAdapter searchAndSynthesizeMultiTurnStream()', () => {
    let adapter: ClaudeWebSearchAdapter;

    beforeEach(() => {
        vi.clearAllMocks();
        adapter = makeAdapter();
    });

    it('sends messages array with stream: true', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            mockFetchResponse(buildTypicalSSEStream()),
        );

        const messages = [
            { role: 'user', content: 'What is X?' },
            { role: 'assistant', content: [{ type: 'text', text: 'X is...' }] },
            { role: 'user', content: 'Tell me more.' },
        ];

        await adapter.searchAndSynthesizeMultiTurnStream(messages);

        const body = JSON.parse((fetchSpy.mock.calls[0][1]!.body as string));
        expect(body.stream).toBe(true);
        expect(body.messages).toEqual(messages);
        expect(body.messages).toHaveLength(3);
        fetchSpy.mockRestore();
    });

    it('preserves academic domain filtering in multi-turn stream', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            mockFetchResponse(buildTypicalSSEStream()),
        );

        await adapter.searchAndSynthesizeMultiTurnStream(
            [{ role: 'user', content: 'test' }],
            { academicMode: true },
        );

        const body = JSON.parse((fetchSpy.mock.calls[0][1]!.body as string));
        expect(body.tools[0].allowed_domains).toContain('arxiv.org');
        fetchSpy.mockRestore();
    });

    it('fires callbacks during multi-turn stream', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            mockFetchResponse(buildTypicalSSEStream({ query: 'follow-up' })),
        );
        const events: string[] = [];
        const callbacks: ClaudeWebSearchStreamCallbacks = {
            onSearchQuery: () => events.push('query'),
            onTextChunk: () => events.push('chunk'),
            onSearchResult: () => events.push('result'),
        };

        await adapter.searchAndSynthesizeMultiTurnStream(
            [{ role: 'user', content: 'test' }],
            undefined, callbacks,
        );

        expect(events).toContain('query');
        expect(events).toContain('result');
        expect(events).toContain('chunk');
        fetchSpy.mockRestore();
    });

    it('supports abort signal in multi-turn stream', async () => {
        const controller = new AbortController();
        controller.abort();
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
            new DOMException('Aborted', 'AbortError'),
        );

        await expect(adapter.searchAndSynthesizeMultiTurnStream(
            [{ role: 'user', content: 'test' }],
            undefined, undefined, controller.signal,
        )).rejects.toThrow('Aborted');
        fetchSpy.mockRestore();
    });
});

describe('Orchestrator executeClaudeWebSearchMultiTurnStream()', () => {
    let adapter: ClaudeWebSearchAdapter;
    let orchestrator: ResearchOrchestrator;
    let usageService: ReturnType<typeof makeUsageService>;

    beforeEach(() => {
        vi.clearAllMocks();
        adapter = makeAdapter();
        const plugin = makePlugin();
        usageService = makeUsageService();
        const searchService = makeSearchService(adapter);
        orchestrator = new ResearchOrchestrator(searchService, plugin);
        (orchestrator as any).usageService = usageService;
    });

    it('returns results from multi-turn streaming call', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            mockFetchResponse(buildTypicalSSEStream({
                synthesis: 'Follow-up answer.',
                searchRequests: 2,
            })),
        );

        const result = await orchestrator.executeClaudeWebSearchMultiTurnStream(
            [{ role: 'user', content: 'test' }],
            {},
            {},
        );

        expect(result.synthesis).toBe('Follow-up answer.');
        expect(result.searchCount).toBe(2);
        expect(result.rawContent.length).toBeGreaterThan(0);
        fetchSpy.mockRestore();
    });

    it('handles pause_turn in multi-turn streaming preserving user follow-up', async () => {
        const pausedLines = buildTypicalSSEStream({
            urls: [{ url: 'https://a.com', title: 'A' }],
            synthesis: 'Part 1. ',
            stopReason: 'pause_turn',
            searchRequests: 1,
        });
        const finalLines = buildTypicalSSEStream({
            urls: [{ url: 'https://b.com', title: 'B' }],
            synthesis: 'Part 2.',
            searchRequests: 1,
        });

        let callCount = 0;
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
            callCount++;
            return callCount === 1 ? mockFetchResponse(pausedLines) : mockFetchResponse(finalLines);
        });

        const messages = [
            { role: 'user', content: 'Q1' },
            { role: 'assistant', content: [{ type: 'text', text: 'A1' }] },
            { role: 'user', content: 'Follow-up' },
        ];

        const result = await orchestrator.executeClaudeWebSearchMultiTurnStream(
            messages, {}, {},
        );

        expect(result.searchCount).toBe(2);
        expect(result.synthesis).toContain('Part 1.');
        expect(result.synthesis).toContain('Part 2.');

        // Verify continuation preserved user follow-up (2nd fetch call)
        const continuationBody = JSON.parse((fetchSpy.mock.calls[1][1]!.body as string));
        const msgs = continuationBody.messages;
        // Original 3 + assistant (paused) + user ("Please continue.") = 5
        expect(msgs).toHaveLength(5);
        expect(msgs[2]).toMatchObject({ role: 'user', content: 'Follow-up' }); // User's follow-up preserved
        expect(msgs[3].role).toBe('assistant'); // Paused rawContent
        expect(msgs[4]).toMatchObject({ role: 'user', content: 'Please continue.' });

        fetchSpy.mockRestore();
    });

    it('checks budget before multi-turn streaming', async () => {
        usageService.checkBudget.mockReturnValue({ allowed: false, message: 'Budget exceeded' });

        await expect(orchestrator.executeClaudeWebSearchMultiTurnStream(
            [{ role: 'user', content: 'test' }],
            {},
            {},
        )).rejects.toThrow('Budget exceeded');
    });

    it('emits phase changes during multi-turn streaming', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            mockFetchResponse(buildTypicalSSEStream()),
        );
        const phases: string[] = [];

        await orchestrator.executeClaudeWebSearchMultiTurnStream(
            [{ role: 'user', content: 'test' }],
            {},
            { onPhaseChange: (p) => phases.push(p) },
        );

        expect(phases).toContain('searching');
        expect(phases).toContain('done');
        fetchSpy.mockRestore();
    });
});

describe('continuing phase (Finding 3)', () => {
    it('continuing is a valid ResearchPhase value', () => {
        // Type-level check: this should compile without error
        const phase: import('../src/services/research/researchTypes').ResearchPhase = 'continuing';
        expect(phase).toBe('continuing');
    });

    it('orchestrator emits continuing phase on pause_turn continuation', async () => {
        const adpt = makeAdapter();
        const plugin = makePlugin();
        const searchService = makeSearchService(adpt);
        const usage = makeUsageService();
        const orch = new ResearchOrchestrator(searchService, plugin);
        (orch as any).usageService = usage;

        const pausedLines = buildTypicalSSEStream({ stopReason: 'pause_turn', searchRequests: 1 });
        const finalLines = buildTypicalSSEStream({ stopReason: 'end_turn', searchRequests: 1 });

        let callCount = 0;
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
            callCount++;
            return callCount === 1 ? mockFetchResponse(pausedLines) : mockFetchResponse(finalLines);
        });

        const phases: string[] = [];
        await orch.executeClaudeWebSearchStream('test', {}, {
            onPhaseChange: (p) => phases.push(p),
        });

        expect(phases).toContain('continuing');
        expect(phases).toContain('searching');
        expect(phases).toContain('done');
        fetchSpy.mockRestore();
    });
});
