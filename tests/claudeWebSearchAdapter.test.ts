/**
 * ClaudeWebSearchAdapter tests
 *
 * Verifies response parsing, citation scoring, tool version selection,
 * system prompt building, configuration checks, API call structure,
 * and pause_turn handling.
 */

vi.mock('obsidian', async () => {
    const mod = await import('./mocks/obsidian');
    return {
        ...mod,
        requestUrl: vi.fn(),
    };
});

import { requestUrl } from 'obsidian';
import { ClaudeWebSearchAdapter } from '../src/services/research/adapters/claudeWebSearchAdapter';

const mockRequestUrl = requestUrl as unknown as ReturnType<typeof vi.fn>;

// Helpers to build mock API responses
function buildMockResponse(overrides: Record<string, unknown> = {}) {
    return {
        content: [
            {
                type: 'web_search_tool_result',
                tool_use_id: 'srvtoolu_abc123',
                content: [
                    {
                        type: 'web_search_result',
                        url: 'https://example.com/article1',
                        title: 'First Article',
                        encrypted_content: 'EqgfCioIARgB...',
                        page_age: 'February 15, 2026',
                    },
                    {
                        type: 'web_search_result',
                        url: 'https://arxiv.org/abs/2301.12345',
                        title: 'Academic Paper',
                        encrypted_content: 'EqgfCioIARgB...',
                    },
                ],
            },
            {
                type: 'text',
                text: 'According to recent research, quantum computing has made significant advances.',
                citations: [
                    {
                        type: 'web_search_result_location',
                        url: 'https://example.com/article1',
                        title: 'First Article',
                        cited_text: 'Quantum computing reached 1000 qubits in 2026.',
                        encrypted_index: 'Eo8BCioIAhgB...',
                    },
                    {
                        type: 'web_search_result_location',
                        url: 'https://example.com/article1',
                        title: 'First Article',
                        cited_text: 'Error correction rates improved by 50%.',
                        encrypted_index: 'Eo8BCioIAhgB...',
                    },
                    {
                        type: 'web_search_result_location',
                        url: 'https://arxiv.org/abs/2301.12345',
                        title: 'Academic Paper',
                        cited_text: 'Topological qubits show promise.',
                        encrypted_index: 'Eo8BCioIAhgB...',
                    },
                ],
            },
        ],
        usage: {
            input_tokens: 6039,
            output_tokens: 931,
            server_tool_use: { web_search_requests: 2 },
        },
        stop_reason: 'end_turn',
        ...overrides,
    };
}

describe('ClaudeWebSearchAdapter', () => {
    let adapter: ClaudeWebSearchAdapter;
    const mockGetApiKey = vi.fn<() => Promise<string | null>>();

    beforeEach(() => {
        vi.clearAllMocks();
        mockGetApiKey.mockResolvedValue('test-claude-key');
        adapter = new ClaudeWebSearchAdapter(mockGetApiKey, {
            model: 'claude-sonnet-4-6',
            maxSearches: 5,
            useDynamicFiltering: true,
        });
    });

    // ═══ parseResponse() ═══

    describe('parseResponse()', () => {
        it('extracts search results from web_search_tool_result blocks', () => {
            const response = buildMockResponse();
            const parsed = adapter.parseResponse(response);

            expect(parsed.searchResults).toHaveLength(2);
            expect(parsed.searchResults[0]).toMatchObject({
                title: 'First Article',
                url: 'https://example.com/article1',
                source: 'web',
                domain: 'example.com',
                date: 'February 15, 2026',
            });
            expect(parsed.searchResults[1]).toMatchObject({
                title: 'Academic Paper',
                url: 'https://arxiv.org/abs/2301.12345',
                source: 'academic',
                domain: 'arxiv.org',
            });
        });

        it('extracts synthesis text from text blocks', () => {
            const response = buildMockResponse();
            const parsed = adapter.parseResponse(response);

            expect(parsed.synthesis).toBe('According to recent research, quantum computing has made significant advances.');
        });

        it('extracts citations from text block citations array', () => {
            const response = buildMockResponse();
            const parsed = adapter.parseResponse(response);

            expect(parsed.citations).toHaveLength(3);
            expect(parsed.citations[0]).toMatchObject({
                url: 'https://example.com/article1',
                title: 'First Article',
                citedText: 'Quantum computing reached 1000 qubits in 2026.',
            });
        });

        it('enriches search result snippets with first cited text', () => {
            const response = buildMockResponse();
            const parsed = adapter.parseResponse(response);

            // First result gets first citation as snippet
            expect(parsed.searchResults[0].snippet).toBe('Quantum computing reached 1000 qubits in 2026.');
            // Second result gets its citation
            expect(parsed.searchResults[1].snippet).toBe('Topological qubits show promise.');
        });

        it('assigns citation-frequency scores', () => {
            const response = buildMockResponse();
            const parsed = adapter.parseResponse(response);

            // article1 has 2 citations (max), so score = 1.0
            expect(parsed.searchResults[0].score).toBe(1.0);
            // arxiv has 1 citation, so score = 0.5
            expect(parsed.searchResults[1].score).toBe(0.5);
        });

        it('assigns 0.5 baseline score to uncited-but-retrieved results', () => {
            // Round 1 persona test fix: uncited-but-retrieved sources used to get 0.1,
            // which caused the quality-score pipeline to label peer-reviewed journals
            // as "Low quality" whenever Claude's answer didn't directly quote them.
            // Baseline is now 0.5 — being retrieved at all means Claude considered them
            // relevant, just didn't quote them.
            const response = buildMockResponse({
                content: [
                    {
                        type: 'web_search_tool_result',
                        content: [
                            { type: 'web_search_result', url: 'https://uncited.com', title: 'Uncited' },
                        ],
                    },
                    {
                        type: 'text',
                        text: 'Some answer.',
                        citations: [],
                    },
                ],
            });
            const parsed = adapter.parseResponse(response);

            expect(parsed.searchResults[0].score).toBe(0.5);
        });

        it('extracts search count from usage', () => {
            const response = buildMockResponse();
            const parsed = adapter.parseResponse(response);

            expect(parsed.searchCount).toBe(2);
        });

        it('extracts token usage', () => {
            const response = buildMockResponse();
            const parsed = adapter.parseResponse(response);

            expect(parsed.usage).toEqual({ inputTokens: 6039, outputTokens: 931 });
        });

        it('handles empty content array', () => {
            const parsed = adapter.parseResponse({ content: [] });

            expect(parsed.searchResults).toEqual([]);
            expect(parsed.synthesis).toBe('');
            expect(parsed.citations).toEqual([]);
            expect(parsed.searchCount).toBe(0);
        });

        it('handles missing content', () => {
            const parsed = adapter.parseResponse({});

            expect(parsed.searchResults).toEqual([]);
            expect(parsed.synthesis).toBe('');
        });

        it('detects pause_turn stop reason', () => {
            const response = buildMockResponse({ stop_reason: 'pause_turn' });
            const parsed = adapter.parseResponse(response);

            expect(parsed.paused).toBe(true);
        });

        it('sets paused to false for end_turn', () => {
            const response = buildMockResponse({ stop_reason: 'end_turn' });
            const parsed = adapter.parseResponse(response);

            expect(parsed.paused).toBe(false);
        });

        it('joins multiple post-search text blocks into single synthesis', () => {
            const response = buildMockResponse({
                content: [
                    {
                        type: 'web_search_tool_result',
                        content: [{ type: 'web_search_result', url: 'https://a.com', title: 'A' }],
                    },
                    { type: 'text', text: 'Part one. ' },
                    { type: 'text', text: 'Part two.' },
                ],
            });
            const parsed = adapter.parseResponse(response);

            expect(parsed.synthesis).toBe('Part one. Part two.');
        });

        it('joins all text blocks when no search results present', () => {
            const response = buildMockResponse({
                content: [
                    { type: 'text', text: 'Part one. ' },
                    { type: 'text', text: 'Part two.' },
                ],
            });
            const parsed = adapter.parseResponse(response);

            expect(parsed.synthesis).toBe('Part one. Part two.');
        });

        it('excludes pre-search preamble text from synthesis', () => {
            const response = buildMockResponse({
                content: [
                    { type: 'text', text: "I'll search for quantum computing..." },
                    {
                        type: 'web_search_tool_result',
                        content: [{ type: 'web_search_result', url: 'https://a.com', title: 'A' }],
                    },
                    { type: 'text', text: 'The actual synthesized answer.' },
                ],
            });
            const parsed = adapter.parseResponse(response);

            expect(parsed.synthesis).toBe('The actual synthesized answer.');
            expect(parsed.synthesis).not.toContain("I'll search");
        });

        it('excludes text between multiple search rounds from synthesis', () => {
            const response = buildMockResponse({
                content: [
                    { type: 'text', text: 'Let me search...' },
                    {
                        type: 'web_search_tool_result',
                        content: [{ type: 'web_search_result', url: 'https://a.com', title: 'A' }],
                    },
                    { type: 'text', text: 'Let me refine...' },
                    {
                        type: 'web_search_tool_result',
                        content: [{ type: 'web_search_result', url: 'https://b.com', title: 'B' }],
                    },
                    { type: 'text', text: 'Final answer here.' },
                ],
            });
            const parsed = adapter.parseResponse(response);

            expect(parsed.synthesis).toBe('Final answer here.');
            expect(parsed.synthesis).not.toContain('Let me');
        });

        it('handles error blocks gracefully', () => {
            const response = buildMockResponse({
                content: [
                    {
                        type: 'web_search_tool_result',
                        content: {
                            type: 'web_search_tool_result_error',
                            error_code: 'max_uses_exceeded',
                        },
                    },
                    { type: 'text', text: 'Partial answer.' },
                ],
            });
            const parsed = adapter.parseResponse(response);

            // Error block's content is not an array, so no results extracted
            expect(parsed.searchResults).toEqual([]);
            expect(parsed.synthesis).toBe('Partial answer.');
        });
    });

    // ═══ isConfigured() ═══

    describe('isConfigured()', () => {
        it('returns true when API key is present', async () => {
            mockGetApiKey.mockResolvedValue('key-123');
            expect(await adapter.isConfigured()).toBe(true);
        });

        it('returns false when API key is null', async () => {
            mockGetApiKey.mockResolvedValue(null);
            expect(await adapter.isConfigured()).toBe(false);
        });

        it('returns false when API key is empty string', async () => {
            mockGetApiKey.mockResolvedValue('');
            expect(await adapter.isConfigured()).toBe(false);
        });
    });

    // ═══ searchAndSynthesize() ═══

    describe('searchAndSynthesize()', () => {
        it('sends correct request to Claude API', async () => {
            mockRequestUrl.mockResolvedValue({
                status: 200,
                json: buildMockResponse(),
            });

            await adapter.searchAndSynthesize('What is quantum computing?');

            expect(mockRequestUrl).toHaveBeenCalledOnce();
            const call = mockRequestUrl.mock.calls[0][0];
            expect(call.url).toBe('https://api.anthropic.com/v1/messages');
            expect(call.method).toBe('POST');
            expect(call.headers['x-api-key']).toBe('test-claude-key');
            expect(call.headers['anthropic-version']).toBe('2023-06-01');

            const body = JSON.parse(call.body);
            expect(body.model).toBe('claude-sonnet-4-6');
            expect(body.tools).toHaveLength(1);
            expect(body.tools[0].type).toBe('web_search_20260209');
            expect(body.tools[0].max_uses).toBe(5);
            expect(body.messages[0].content).toBe('What is quantum computing?');
        });

        it('includes beta header for dynamic filtering on Claude 4.6', async () => {
            mockRequestUrl.mockResolvedValue({
                status: 200,
                json: buildMockResponse(),
            });

            await adapter.searchAndSynthesize('test');

            const headers = mockRequestUrl.mock.calls[0][0].headers;
            expect(headers['anthropic-beta']).toBe('code-execution-web-tools-2026-02-09');
        });

        it('uses basic tool version for non-4.6 models', async () => {
            const basicAdapter = new ClaudeWebSearchAdapter(mockGetApiKey, {
                model: 'claude-haiku-4-5-20251001',
                useDynamicFiltering: true, // Should be ignored for Haiku
            });

            mockRequestUrl.mockResolvedValue({
                status: 200,
                json: buildMockResponse(),
            });

            await basicAdapter.searchAndSynthesize('test');

            const call = mockRequestUrl.mock.calls[0][0];
            const body = JSON.parse(call.body);
            expect(body.tools[0].type).toBe('web_search_20250305');
            // No beta header for basic version
            expect(call.headers['anthropic-beta']).toBeUndefined();
        });

        it('uses basic tool version when dynamic filtering disabled', async () => {
            const noFilterAdapter = new ClaudeWebSearchAdapter(mockGetApiKey, {
                model: 'claude-sonnet-4-6',
                useDynamicFiltering: false,
            });

            mockRequestUrl.mockResolvedValue({
                status: 200,
                json: buildMockResponse(),
            });

            await noFilterAdapter.searchAndSynthesize('test');

            const body = JSON.parse(mockRequestUrl.mock.calls[0][0].body);
            expect(body.tools[0].type).toBe('web_search_20250305');
        });

        it('throws on missing API key', async () => {
            mockGetApiKey.mockResolvedValue(null);
            await expect(adapter.searchAndSynthesize('test')).rejects.toThrow('Claude API key not configured');
        });

        it('throws on non-200 response', async () => {
            mockRequestUrl.mockResolvedValue({
                status: 400,
                json: { error: { message: 'Invalid request' } },
            });

            await expect(adapter.searchAndSynthesize('test')).rejects.toThrow('Claude Web Search failed: Invalid request');
        });

        it('maps excluded sites to blocked_domains', async () => {
            mockRequestUrl.mockResolvedValue({
                status: 200,
                json: buildMockResponse(),
            });

            await adapter.searchAndSynthesize('test', {
                excludedSites: ['pinterest.com', 'quora.com'],
            });

            const body = JSON.parse(mockRequestUrl.mock.calls[0][0].body);
            expect(body.tools[0].blocked_domains).toEqual(['pinterest.com', 'quora.com']);
            expect(body.tools[0].allowed_domains).toBeUndefined();
        });

        it('maps preferred sites to allowed_domains', async () => {
            mockRequestUrl.mockResolvedValue({
                status: 200,
                json: buildMockResponse(),
            });

            await adapter.searchAndSynthesize('test', {
                siteScope: 'preferred',
                preferredSites: ['nature.com', 'science.org'],
            });

            const body = JSON.parse(mockRequestUrl.mock.calls[0][0].body);
            expect(body.tools[0].allowed_domains).toEqual(['nature.com', 'science.org']);
            expect(body.tools[0].blocked_domains).toBeUndefined();
        });

        it('academic mode takes precedence over preferred-site scope', async () => {
            mockRequestUrl.mockResolvedValue({
                status: 200,
                json: buildMockResponse(),
            });

            await adapter.searchAndSynthesize('test', {
                siteScope: 'preferred',
                preferredSites: ['nature.com', 'science.org'],
                academicMode: true,
            });

            const body = JSON.parse(mockRequestUrl.mock.calls[0][0].body);
            // Academic domains should win, not preferred sites
            expect(body.tools[0].allowed_domains).toContain('scholar.google.com');
            expect(body.tools[0].allowed_domains).toContain('arxiv.org');
            expect(body.tools[0].allowed_domains).not.toEqual(['nature.com', 'science.org']);
        });

        it('maps academic mode to academic allowed_domains', async () => {
            mockRequestUrl.mockResolvedValue({
                status: 200,
                json: buildMockResponse(),
            });

            await adapter.searchAndSynthesize('test', { siteScope: 'academic' });

            const body = JSON.parse(mockRequestUrl.mock.calls[0][0].body);
            expect(body.tools[0].allowed_domains).toContain('scholar.google.com');
            expect(body.tools[0].allowed_domains).toContain('arxiv.org');
        });

        it('maps academicMode option to academic allowed_domains', async () => {
            mockRequestUrl.mockResolvedValue({
                status: 200,
                json: buildMockResponse(),
            });

            await adapter.searchAndSynthesize('test', { academicMode: true });

            const body = JSON.parse(mockRequestUrl.mock.calls[0][0].body);
            expect(body.tools[0].allowed_domains).toContain('scholar.google.com');
            expect(body.tools[0].allowed_domains).toContain('pubmed.ncbi.nlm.nih.gov');
            expect(body.tools[0].allowed_domains).toContain('arxiv.org');
            expect(body.tools[0].blocked_domains).toBeUndefined();
        });

        it('passes academic and perspective options to system prompt', async () => {
            mockRequestUrl.mockResolvedValue({
                status: 200,
                json: buildMockResponse(),
            });

            await adapter.searchAndSynthesize('test', {
                academicMode: true,
                perspectiveMode: true,
                perspectives: ['Economic', 'Social'],
            });

            const body = JSON.parse(mockRequestUrl.mock.calls[0][0].body);
            expect(body.system).toContain('peer-reviewed');
            expect(body.system).toContain('multiple perspectives');
            expect(body.system).toContain('Economic');
        });
    });

    // ═══ buildSystemPrompt() ═══

    describe('buildSystemPrompt()', () => {
        it('includes numbered citation style by default', () => {
            const prompt = adapter.buildSystemPrompt();
            expect(prompt).toContain('[1], [2]');
        });

        it('uses author-year citation style when specified', () => {
            const prompt = adapter.buildSystemPrompt({ citationStyle: 'author-year' });
            expect(prompt).toContain('(Author, Year)');
        });

        it('forces author-year citation style when academicMode is true', () => {
            const prompt = adapter.buildSystemPrompt({ academicMode: true });
            expect(prompt).toContain('(Author, Year)');
            expect(prompt).not.toContain('[1], [2]');
        });

        it('forces author-year even when citationStyle is explicitly numeric in academic mode', () => {
            const prompt = adapter.buildSystemPrompt({ academicMode: true, citationStyle: 'numeric' });
            expect(prompt).toContain('(Author, Year)');
            expect(prompt).not.toContain('[1], [2]');
        });

        it('defaults to English', () => {
            const prompt = adapter.buildSystemPrompt();
            expect(prompt).toContain('Respond in English');
        });

        it('respects language parameter', () => {
            const prompt = adapter.buildSystemPrompt({ language: '中文' });
            expect(prompt).toContain('Respond in 中文');
        });

        // ═══ Phase 3: Academic Mode ═══

        it('includes academic instructions when academicMode is true', () => {
            const prompt = adapter.buildSystemPrompt({ academicMode: true });
            expect(prompt).toContain('peer-reviewed sources');
            expect(prompt).toContain('DOIs');
            expect(prompt).toContain('academic databases');
        });

        it('does not include academic instructions when academicMode is false', () => {
            const prompt = adapter.buildSystemPrompt({ academicMode: false });
            expect(prompt).not.toContain('peer-reviewed');
        });

        it('does not include academic instructions by default', () => {
            const prompt = adapter.buildSystemPrompt();
            expect(prompt).not.toContain('peer-reviewed');
        });

        // ═══ Phase 3: Perspective Mode ═══

        it('includes perspective instructions when perspectiveMode is true with perspectives', () => {
            const prompt = adapter.buildSystemPrompt({
                perspectiveMode: true,
                perspectives: ['Scientific', 'Historical', 'Economic'],
            });
            expect(prompt).toContain('multiple perspectives');
            expect(prompt).toContain('Scientific');
            expect(prompt).toContain('Historical');
            expect(prompt).toContain('Economic');
            expect(prompt).toContain('agree and disagree');
        });

        it('does not include perspective instructions when perspectives array is empty', () => {
            const prompt = adapter.buildSystemPrompt({
                perspectiveMode: true,
                perspectives: [],
            });
            expect(prompt).not.toContain('multiple perspectives');
        });

        it('does not include perspective instructions when perspectiveMode is false', () => {
            const prompt = adapter.buildSystemPrompt({
                perspectiveMode: false,
                perspectives: ['A', 'B'],
            });
            expect(prompt).not.toContain('multiple perspectives');
        });

        it('combines academic and perspective modes', () => {
            const prompt = adapter.buildSystemPrompt({
                academicMode: true,
                perspectiveMode: true,
                perspectives: ['Biological', 'Chemical'],
            });
            expect(prompt).toContain('peer-reviewed');
            expect(prompt).toContain('multiple perspectives');
            expect(prompt).toContain('Biological');
        });
    });

    // ═══ Tool version selection ═══

    describe('tool version selection', () => {
        it('uses dynamic filtering for claude-opus-4-6', async () => {
            const opusAdapter = new ClaudeWebSearchAdapter(mockGetApiKey, { model: 'claude-opus-4-6' });
            mockRequestUrl.mockResolvedValue({ status: 200, json: buildMockResponse() });

            await opusAdapter.searchAndSynthesize('test');

            const body = JSON.parse(mockRequestUrl.mock.calls[0][0].body);
            expect(body.tools[0].type).toBe('web_search_20260209');
        });

        it('uses basic version for older models', async () => {
            const oldAdapter = new ClaudeWebSearchAdapter(mockGetApiKey, { model: 'claude-sonnet-4-5-20251001' });
            mockRequestUrl.mockResolvedValue({ status: 200, json: buildMockResponse() });

            await oldAdapter.searchAndSynthesize('test');

            const body = JSON.parse(mockRequestUrl.mock.calls[0][0].body);
            expect(body.tools[0].type).toBe('web_search_20250305');
        });

        it('defaults to claude-sonnet-4-6 when no model specified', async () => {
            const defaultAdapter = new ClaudeWebSearchAdapter(mockGetApiKey);
            mockRequestUrl.mockResolvedValue({ status: 200, json: buildMockResponse() });

            await defaultAdapter.searchAndSynthesize('test');

            const body = JSON.parse(mockRequestUrl.mock.calls[0][0].body);
            expect(body.model).toBe('claude-sonnet-4-6');
            expect(body.tools[0].type).toBe('web_search_20260209');
        });
    });

    // ═══ pause_turn handling ═══

    describe('pause_turn handling', () => {
        it('exposes maxContinuations as 3', () => {
            expect(adapter.maxContinuations).toBe(3);
        });

        it('continueSearch sends correct message structure', async () => {
            mockRequestUrl.mockResolvedValue({
                status: 200,
                json: buildMockResponse(),
            });

            const pausedContent = [{ type: 'text', text: 'Partial result...' }];
            await adapter.continueSearch('original question', pausedContent);

            const body = JSON.parse(mockRequestUrl.mock.calls[0][0].body);
            expect(body.messages).toHaveLength(3);
            expect(body.messages[0]).toEqual({ role: 'user', content: 'original question' });
            expect(body.messages[1]).toEqual({ role: 'assistant', content: pausedContent });
            expect(body.messages[2]).toEqual({ role: 'user', content: 'Please continue.' });
        });

        it('continueSearch preserves allowed_domains from academic scope', async () => {
            mockRequestUrl.mockResolvedValue({
                status: 200,
                json: buildMockResponse(),
            });

            await adapter.continueSearch('question', [{ type: 'text', text: 'partial' }], {
                siteScope: 'academic',
            });

            const body = JSON.parse(mockRequestUrl.mock.calls[0][0].body);
            expect(body.tools[0].allowed_domains).toContain('scholar.google.com');
            expect(body.tools[0].allowed_domains).toContain('arxiv.org');
            expect(body.tools[0].blocked_domains).toBeUndefined();
        });

        it('continueSearch preserves allowed_domains from preferred scope', async () => {
            mockRequestUrl.mockResolvedValue({
                status: 200,
                json: buildMockResponse(),
            });

            await adapter.continueSearch('question', [{ type: 'text', text: 'partial' }], {
                siteScope: 'preferred',
                preferredSites: ['nature.com'],
            });

            const body = JSON.parse(mockRequestUrl.mock.calls[0][0].body);
            expect(body.tools[0].allowed_domains).toEqual(['nature.com']);
        });
    });

    // ═══ searchAndSynthesizeMultiTurn() ═══

    describe('searchAndSynthesizeMultiTurn()', () => {
        it('sends messages array directly to API', async () => {
            mockRequestUrl.mockResolvedValue({
                status: 200,
                json: buildMockResponse(),
            });

            const messages = [
                { role: 'user', content: 'What is X?' },
                { role: 'assistant', content: [{ type: 'text', text: 'X is...' }] },
                { role: 'user', content: 'Tell me more about X.' },
            ];

            await adapter.searchAndSynthesizeMultiTurn(messages);

            const body = JSON.parse(mockRequestUrl.mock.calls[0][0].body);
            expect(body.messages).toEqual(messages);
            expect(body.messages).toHaveLength(3);
        });

        it('preserves domain filtering options in multi-turn', async () => {
            mockRequestUrl.mockResolvedValue({
                status: 200,
                json: buildMockResponse(),
            });

            await adapter.searchAndSynthesizeMultiTurn(
                [{ role: 'user', content: 'test' }],
                { academicMode: true },
            );

            const body = JSON.parse(mockRequestUrl.mock.calls[0][0].body);
            expect(body.tools[0].allowed_domains).toContain('arxiv.org');
        });

        it('throws on non-200 response', async () => {
            mockRequestUrl.mockResolvedValue({
                status: 400,
                json: { error: { message: 'Bad request' } },
            });

            await expect(adapter.searchAndSynthesizeMultiTurn(
                [{ role: 'user', content: 'test' }],
            )).rejects.toThrow('multi-turn');
        });

        it('throws on missing API key', async () => {
            mockGetApiKey.mockResolvedValue(null);
            await expect(adapter.searchAndSynthesizeMultiTurn(
                [{ role: 'user', content: 'test' }],
            )).rejects.toThrow('API key not configured');
        });
    });

    // ═══ buildToolDefinition() ═══

    describe('buildToolDefinition()', () => {
        it('academic mode takes priority over preferred siteScope', () => {
            const tool = adapter.buildToolDefinition('web_search_20260209', {
                siteScope: 'preferred',
                preferredSites: ['mysite.com'],
                academicMode: true,
            });
            expect(tool.allowed_domains).toContain('scholar.google.com');
            expect(tool.allowed_domains).not.toContain('mysite.com');
        });

        it('preferred sites used when no academic mode', () => {
            const tool = adapter.buildToolDefinition('web_search_20260209', {
                siteScope: 'preferred',
                preferredSites: ['mysite.com'],
                academicMode: false,
            });
            expect(tool.allowed_domains).toEqual(['mysite.com']);
        });

        it('excluded sites mapped to blocked_domains when no academic/preferred', () => {
            const tool = adapter.buildToolDefinition('web_search_20260209', {
                excludedSites: ['spam.com'],
            });
            expect(tool.blocked_domains).toEqual(['spam.com']);
            expect(tool.allowed_domains).toBeUndefined();
        });
    });

    // ═══ search() interface compatibility ═══

    describe('search()', () => {
        it('returns searchResults from searchAndSynthesize', async () => {
            mockRequestUrl.mockResolvedValue({
                status: 200,
                json: buildMockResponse(),
            });

            const results = await adapter.search('test query');

            expect(results).toHaveLength(2);
            expect(results[0].title).toBe('First Article');
        });
    });
});
