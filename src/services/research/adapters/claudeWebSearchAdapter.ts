/**
 * Claude Web Search Adapter
 *
 * Unified search + synthesis provider using Anthropic's web_search tool.
 * Dynamic filtering version (web_search_20260209) available on Claude 4.6 models.
 * Basic version (web_search_20250305) works on all Claude models.
 *
 * AD-1: Provider-level integration — one API call replaces decompose → search → triage → extract → synthesize.
 * AD-2: Dual-mode response parsing — returns both SearchResult[] and synthesis text.
 */

import { requestUrl } from 'obsidian';
import type { SearchProvider, SearchResult, SearchOptions, ClaudeWebSearchResponse, ParsedCitation, ClaudeWebSearchStreamCallbacks } from '../researchTypes';
import { classifyUrlSource, extractDomain } from '../../../utils/urlUtils';
import { ACADEMIC_DOMAINS } from '../academicUtils';

/** Internal state tracked during SSE stream parsing. */
interface StreamState {
    currentBlockIndex: number;
    currentBlockType: string | null;
    searchResults: SearchResult[];
    textParts: string[];
    citations: ParsedCitation[];
    searchQueries: string[];
    rawContent: unknown[];
    inputJsonBuffer: string;
    currentTextBlock: { text: string; citations: unknown[] } | null;
    currentServerToolUse: { id: string; name: string; input: unknown } | null;
    currentSearchToolResult: unknown;
    usage: { inputTokens: number; outputTokens: number; searchRequests: number };
    stopReason: string | null;
    lastSearchResultBlockIndex: number;
}

/** Shared options for all Claude Web Search methods. */
export type ClaudeWebSearchOptions = SearchOptions & {
    systemPrompt?: string;
    language?: string;
    citationStyle?: 'numeric' | 'author-year';
    maxTokens?: number;
    perspectiveMode?: boolean;
    perspectives?: string[];
};

const CLAUDE_API_BASE = 'https://api.anthropic.com';
const TOOL_VERSION_DYNAMIC = 'web_search_20260209';
const TOOL_VERSION_BASIC = 'web_search_20250305';
const BETA_HEADER = 'code-execution-web-tools-2026-02-09';
const MAX_CONTINUATIONS = 3;

/** Default max output tokens for Claude Web Search responses. */
const CLAUDE_WS_DEFAULT_MAX_TOKENS = 16384;

export class ClaudeWebSearchAdapter implements SearchProvider {
    readonly type = 'claude-web-search' as const;

    constructor(
        private getApiKey: () => Promise<string | null>,
        private options: {
            model?: string;
            maxSearches?: number;
            useDynamicFiltering?: boolean;
        } = {},
    ) {}

    async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
        // For compatibility with the SearchProvider interface.
        // In practice, the orchestrator calls searchAndSynthesize() directly.
        const result = await this.searchAndSynthesize(query, options);
        return result.searchResults;
    }

    async isConfigured(): Promise<boolean> {
        const key = await this.getApiKey();
        return !!key;
    }

    /**
     * Unified search + synthesis call.
     * Sends a single Claude API request with the web_search tool.
     * Returns both search results and synthesized answer.
     */
    async searchAndSynthesize(
        question: string,
        options?: ClaudeWebSearchOptions,
    ): Promise<ClaudeWebSearchResponse> {
        const { headers, body } = await this.buildRequestParts(options);
        body.messages = [{ role: 'user', content: question }];
        return this.sendNonStreaming(headers, body, 'Claude Web Search failed');
    }

    /**
     * Continue a paused research turn (AD-9: pause_turn handling).
     * Appends paused response as assistant message, sends follow-up to continue.
     */
    async continueSearch(
        originalQuestion: string,
        pausedContent: unknown[],
        options?: ClaudeWebSearchOptions,
    ): Promise<ClaudeWebSearchResponse> {
        const { headers, body } = await this.buildRequestParts(options);
        body.messages = [
            { role: 'user', content: originalQuestion },
            { role: 'assistant', content: pausedContent },
            { role: 'user', content: 'Please continue.' },
        ];
        return this.sendNonStreaming(headers, body, 'Claude Web Search continuation failed');
    }

    /**
     * Streaming search + synthesis call.
     * Uses native fetch() for SSE streaming (requestUrl doesn't support ReadableStream).
     * Reconstructs full content blocks in rawContent for pause_turn continuation fidelity.
     */
    async searchAndSynthesizeStream(
        question: string,
        options?: ClaudeWebSearchOptions,
        callbacks?: ClaudeWebSearchStreamCallbacks,
        signal?: AbortSignal,
    ): Promise<ClaudeWebSearchResponse> {
        const { headers, body } = await this.buildRequestParts(options);
        body.stream = true;
        body.messages = [{ role: 'user', content: question }];
        return this.runStreamLoop(headers, body, callbacks, signal);
    }

    /**
     * Streaming continuation for a paused research turn.
     * Same as continueSearch() but with SSE streaming.
     */
    async continueSearchStream(
        originalQuestion: string,
        pausedContent: unknown[],
        options?: ClaudeWebSearchOptions,
        callbacks?: ClaudeWebSearchStreamCallbacks,
        signal?: AbortSignal,
    ): Promise<ClaudeWebSearchResponse> {
        const { headers, body } = await this.buildRequestParts(options);
        body.stream = true;
        body.messages = [
            { role: 'user', content: originalQuestion },
            { role: 'assistant', content: pausedContent },
            { role: 'user', content: 'Please continue.' },
        ];
        return this.runStreamLoop(headers, body, callbacks, signal);
    }

    /**
     * Multi-turn search: send a follow-up question with full conversation history.
     * Enables Claude to reference previous search results via encrypted_content/encrypted_index.
     */
    async searchAndSynthesizeMultiTurn(
        messages: Array<{ role: string; content: unknown }>,
        options?: ClaudeWebSearchOptions,
    ): Promise<ClaudeWebSearchResponse> {
        const { headers, body } = await this.buildRequestParts(options);
        body.messages = messages;
        return this.sendNonStreaming(headers, body, 'Claude Web Search multi-turn failed');
    }

    /**
     * Streaming multi-turn search with full conversation history.
     */
    async searchAndSynthesizeMultiTurnStream(
        messages: Array<{ role: string; content: unknown }>,
        options?: ClaudeWebSearchOptions,
        callbacks?: ClaudeWebSearchStreamCallbacks,
        signal?: AbortSignal,
    ): Promise<ClaudeWebSearchResponse> {
        const { headers, body } = await this.buildRequestParts(options);
        body.stream = true;
        body.messages = messages;
        return this.runStreamLoop(headers, body, callbacks, signal);
    }

    /** Maximum number of auto-continuations for pause_turn responses. */
    get maxContinuations(): number {
        return MAX_CONTINUATIONS;
    }

    /**
     * Parse Claude's response into structured search results + synthesis.
     * Extracts web_search_tool_result blocks for SearchResult[], text blocks for synthesis,
     * and citation objects for ParsedCitation[].
     * Assigns implicit scores based on citation frequency (AD-2).
     */
    parseResponse(response: Record<string, unknown>): ClaudeWebSearchResponse {
        const content = (response.content as unknown[]) || [];
        const searchResults: SearchResult[] = [];
        const citations: ParsedCitation[] = [];
        const textParts: string[] = [];

        // Find the index of the last web_search_tool_result block so we can
        // exclude pre-search preamble text ("I'll search for...") from synthesis.
        const lastSearchResultIdx = this.findLastSearchResultIndex(content);

        for (let i = 0; i < content.length; i++) {
            const b = content[i] as Record<string, unknown>;
            if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
                this.extractSearchResults(b.content, searchResults);
            }
            // Only include text blocks AFTER the last search result block (skip pre-search preamble)
            if (b.type === 'text' && i > lastSearchResultIdx) {
                textParts.push((b.text as string) || '');
                this.extractCitations(b, citations, searchResults);
            }
        }

        this.assignCitationScores(citations, searchResults);

        const usage = response.usage as Record<string, unknown> | undefined;
        const serverToolUse = usage?.server_tool_use as Record<string, unknown> | undefined;

        return {
            searchResults,
            synthesis: textParts.join(''),
            citations,
            searchCount: (serverToolUse?.web_search_requests as number) || 0,
            usage: {
                inputTokens: (usage?.input_tokens as number) || 0,
                outputTokens: (usage?.output_tokens as number) || 0,
            },
            paused: response.stop_reason === 'pause_turn',
            rawContent: content,
        };
    }

    /** Find the index of the last web_search_tool_result block in the content array. */
    private findLastSearchResultIndex(content: unknown[]): number {
        for (let i = content.length - 1; i >= 0; i--) {
            if ((content[i] as Record<string, unknown>).type === 'web_search_tool_result') return i;
        }
        return -1;
    }

    /** Extract SearchResult entries from a web_search_tool_result block's content array. */
    private extractSearchResults(resultContent: unknown[], out: SearchResult[]): void {
        for (const result of resultContent) {
            const r = result as Record<string, unknown>;
            if (r.type === 'web_search_result') {
                const url = (r.url as string) || '';
                out.push({
                    title: (r.title as string) || '',
                    url,
                    snippet: '',
                    source: classifyUrlSource(url),
                    date: r.page_age as string | undefined,
                    domain: extractDomain(url),
                    score: undefined,
                });
            }
        }
    }

    /** Extract citations from a text block and enrich search results with cited text as snippets. */
    private extractCitations(block: Record<string, unknown>, citations: ParsedCitation[], searchResults: SearchResult[]): void {
        if (!Array.isArray(block.citations)) return;
        for (const cit of block.citations) {
            const c = cit as Record<string, unknown>;
            if (c.type !== 'web_search_result_location') continue;
            const citUrl = (c.url as string) || '';
            const citText = (c.cited_text as string) || '';
            citations.push({ url: citUrl, title: (c.title as string) || '', citedText: citText });
            const match = searchResults.find(sr => sr.url === citUrl);
            if (match && !match.snippet) match.snippet = citText;
        }
    }

    /** Assign implicit quality scores based on citation frequency. */
    private assignCitationScores(citations: ParsedCitation[], searchResults: SearchResult[]): void {
        const counts = new Map<string, number>();
        for (const cit of citations) counts.set(cit.url, (counts.get(cit.url) || 0) + 1);
        const max = Math.max(...counts.values(), 1);
        for (const result of searchResults) {
            const count = counts.get(result.url) || 0;
            result.score = count > 0 ? count / max : 0.1;
        }
    }

    /** Build web_search tool definition with domain filtering (AD-5).
     *  Academic mode takes precedence over preferred-site scope to prevent bypass. */
    buildToolDefinition(toolType: string, options?: SearchOptions): Record<string, unknown> {
        const tool: Record<string, unknown> = {
            type: toolType,
            name: 'web_search',
            max_uses: this.options.maxSearches ?? 5,
        };

        // Academic domains take priority — prevents preferred-site scope from bypassing academic filtering
        if (options?.siteScope === 'academic' || options?.academicMode) {
            tool.allowed_domains = [...ACADEMIC_DOMAINS];
        } else if (options?.siteScope === 'preferred' && options.preferredSites?.length) {
            tool.allowed_domains = options.preferredSites;
        } else if (options?.excludedSites?.length) {
            tool.blocked_domains = options.excludedSites;
        }

        return tool;
    }

    buildSystemPrompt(options?: {
        language?: string;
        citationStyle?: string;
        academicMode?: boolean;
        perspectiveMode?: boolean;
        perspectives?: string[];
    }): string {
        const lang = options?.language || 'English';
        // Academic mode forces author-year citation style per plan spec
        const effectiveStyle = options?.academicMode
            ? 'author-year'
            : (options?.citationStyle || 'numeric');
        const style = effectiveStyle === 'author-year'
            ? 'Use (Author, Year) citation style.'
            : 'Use numbered [1], [2] citation style.';
        const parts = [
            'You are a thorough research assistant. Search the web to answer the user\'s question comprehensively.',
            'Provide a well-structured answer with clear sections.',
            style,
            'Always cite your sources inline.',
        ];

        if (options?.academicMode) {
            parts.push(
                'Focus on peer-reviewed sources, academic papers, and institutional publications.',
                'Extract DOIs, author names, and publication years when available.',
                'Prefer academic databases and scholarly sources.',
            );
        }

        if (options?.perspectiveMode && options.perspectives?.length) {
            parts.push(
                `Research this question from multiple perspectives: ${options.perspectives.join(', ')}.`,
                'Organize your findings by perspective, showing where experts agree and disagree.',
            );
        }

        parts.push(`Respond in ${lang}.`);
        return parts.join(' ');
    }

    // ═══ STREAMING INTERNALS ═══

    /** Send a non-streaming request and parse the response. */
    private async sendNonStreaming(
        headers: Record<string, string>,
        body: Record<string, unknown>,
        errorPrefix: string,
    ): Promise<ClaudeWebSearchResponse> {
        const response = await requestUrl({
            url: `${CLAUDE_API_BASE}/v1/messages`,
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });

        if (response.status !== 200) {
            const errMsg = response.json?.error?.message || `HTTP ${response.status}`;
            throw new Error(`${errorPrefix}: ${errMsg}`);
        }

        return this.parseResponse(response.json);
    }

    /** Build shared request parts (headers, body without messages) for both streaming and non-streaming. */
    private async buildRequestParts(options?: ClaudeWebSearchOptions): Promise<{ headers: Record<string, string>; body: Record<string, unknown> }> {
        const apiKey = await this.getApiKey();
        if (!apiKey) throw new Error('Claude API key not configured for web search');

        const model = this.options.model || 'claude-sonnet-4-6';
        const useDynamic = this.options.useDynamicFiltering !== false
            && (model.startsWith('claude-opus-4-6') || model.startsWith('claude-sonnet-4-6'));
        const toolType = useDynamic ? TOOL_VERSION_DYNAMIC : TOOL_VERSION_BASIC;
        const tool = this.buildToolDefinition(toolType, options);
        const systemPrompt = options?.systemPrompt || this.buildSystemPrompt(options);

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            'x-api-key': apiKey,
        };
        if (useDynamic) {
            headers['anthropic-beta'] = BETA_HEADER;
        }

        const body: Record<string, unknown> = {
            model,
            max_tokens: options?.maxTokens ?? CLAUDE_WS_DEFAULT_MAX_TOKENS,
            system: systemPrompt,
            tools: [tool],
        };

        return { headers, body };
    }

    /** Execute an SSE streaming request and parse events into a ClaudeWebSearchResponse. */
    private async runStreamLoop(
        headers: Record<string, string>,
        body: Record<string, unknown>,
        callbacks?: ClaudeWebSearchStreamCallbacks,
        signal?: AbortSignal,
    ): Promise<ClaudeWebSearchResponse> {
        // eslint-disable-next-line no-restricted-globals -- SSE streaming requires native fetch(); requestUrl doesn't support ReadableStream
        const response = await fetch(`${CLAUDE_API_BASE}/v1/messages`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal,
        });

        if (!response.ok) {
            throw new Error(`Claude Web Search streaming failed: HTTP ${response.status}`);
        }

        const state = this.createStreamState();
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    this.parseStreamingLine(line, state, callbacks);
                }
            }
            // Process remaining buffer
            if (buffer.trim()) {
                this.parseStreamingLine(buffer, state, callbacks);
            }
        } finally {
            reader.releaseLock();
        }

        return this.assembleStreamResponse(state);
    }

    private createStreamState(): StreamState {
        return {
            currentBlockIndex: -1,
            currentBlockType: null,
            searchResults: [],
            textParts: [],
            citations: [],
            searchQueries: [],
            rawContent: [],
            inputJsonBuffer: '',
            currentTextBlock: null,
            currentServerToolUse: null,
            currentSearchToolResult: null,
            usage: { inputTokens: 0, outputTokens: 0, searchRequests: 0 },
            stopReason: null,
            lastSearchResultBlockIndex: -1,
        };
    }

    /** Parse a single SSE line and update stream state. */
    parseStreamingLine(line: string, state: StreamState, callbacks?: ClaudeWebSearchStreamCallbacks): void {
        if (!line.startsWith('data: ')) return;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') return;

        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(data); } catch { return; }

        switch (parsed.type) {
            case 'message_start':
                this.handleMessageStart(parsed, state);
                break;
            case 'content_block_start':
                this.handleContentBlockStart(parsed, state, callbacks);
                break;
            case 'content_block_delta':
                this.handleContentBlockDelta(parsed, state, callbacks);
                break;
            case 'content_block_stop':
                this.handleContentBlockStop(state, callbacks);
                break;
            case 'message_delta':
                this.handleMessageDelta(parsed, state);
                break;
        }
    }

    private handleMessageStart(data: Record<string, unknown>, state: StreamState): void {
        const message = data.message as Record<string, unknown> | undefined;
        if (!message) return;
        const usage = message.usage as Record<string, unknown> | undefined;
        if (usage) {
            state.usage.inputTokens = (usage.input_tokens as number) || 0;
        }
    }

    private handleContentBlockStart(data: Record<string, unknown>, state: StreamState, callbacks?: ClaudeWebSearchStreamCallbacks): void {
        state.currentBlockIndex = (data.index as number) ?? state.currentBlockIndex + 1;
        const block = data.content_block as Record<string, unknown> | undefined;
        if (!block) return;
        const blockType = block.type as string;
        state.currentBlockType = blockType;

        if (blockType === 'server_tool_use') {
            state.currentServerToolUse = {
                id: (block.id as string) || '',
                name: (block.name as string) || '',
                input: {},
            };
            state.inputJsonBuffer = '';
        } else if (blockType === 'web_search_tool_result') {
            state.lastSearchResultBlockIndex = state.rawContent.length;
            // Extract search results from the block immediately
            if (Array.isArray(block.content)) {
                const prevCount = state.searchResults.length;
                this.extractSearchResults(block.content, state.searchResults);
                // Only emit newly added results, not all accumulated
                for (let i = prevCount; i < state.searchResults.length; i++) {
                    callbacks?.onSearchResult?.(state.searchResults[i]);
                }
            }
            // Store full block for rawContent (pause_turn fidelity)
            state.currentSearchToolResult = block;
        } else if (blockType === 'text') {
            state.currentTextBlock = { text: '', citations: [] };
        }
    }

    private handleContentBlockDelta(data: Record<string, unknown>, state: StreamState, callbacks?: ClaudeWebSearchStreamCallbacks): void {
        const delta = data.delta as Record<string, unknown> | undefined;
        if (!delta) return;
        const deltaType = delta.type as string;

        if (deltaType === 'input_json_delta' && state.currentBlockType === 'server_tool_use') {
            state.inputJsonBuffer += (delta.partial_json as string) || '';
        } else if (deltaType === 'text_delta' && state.currentTextBlock) {
            const text = (delta.text as string) || '';
            state.currentTextBlock.text += text;
            // Only fire text chunk callback for text after search results (preamble filtering).
            // When no search results seen yet (index === -1), this is preamble — suppress.
            if (state.lastSearchResultBlockIndex >= 0 && state.rawContent.length > state.lastSearchResultBlockIndex) {
                callbacks?.onTextChunk?.(text);
            }
        } else if (deltaType === 'citations_delta' && state.currentTextBlock) {
            // Anthropic SSE delivers citations as individual deltas during the text block.
            const citation = delta.citation as Record<string, unknown> | undefined;
            if (citation) {
                state.currentTextBlock.citations.push(citation);
            }
        }
    }

    private handleContentBlockStop(state: StreamState, callbacks?: ClaudeWebSearchStreamCallbacks): void {
        if (state.currentBlockType === 'server_tool_use' && state.currentServerToolUse) {
            this.finalizeServerToolUseBlock(state, callbacks);
        } else if (state.currentBlockType === 'web_search_tool_result' && state.currentSearchToolResult) {
            state.rawContent.push(state.currentSearchToolResult);
            state.currentSearchToolResult = null;
        } else if (state.currentBlockType === 'text' && state.currentTextBlock) {
            this.finalizeTextBlock(state);
        }
        state.currentBlockType = null;
    }

    private finalizeServerToolUseBlock(state: StreamState, callbacks?: ClaudeWebSearchStreamCallbacks): void {
        try {
            const input = JSON.parse(state.inputJsonBuffer || '{}');
            state.currentServerToolUse!.input = input;
            if (input.query) {
                state.searchQueries.push(input.query);
                callbacks?.onSearchQuery?.(input.query);
            }
        } catch { /* partial JSON — best effort */ }
        state.rawContent.push({
            type: 'server_tool_use',
            id: state.currentServerToolUse!.id,
            name: state.currentServerToolUse!.name,
            input: state.currentServerToolUse!.input,
        });
        state.currentServerToolUse = null;
        state.inputJsonBuffer = '';
    }

    private finalizeTextBlock(state: StreamState): void {
        // Only include text after search results in synthesis (preamble filtering).
        // When no search results seen (index === -1), all text blocks have no search context yet.
        const isAfterSearchResults = state.lastSearchResultBlockIndex >= 0
            && state.rawContent.length > state.lastSearchResultBlockIndex;

        if (isAfterSearchResults) {
            state.textParts.push(state.currentTextBlock!.text);
        }

        const rawTextBlock: Record<string, unknown> = {
            type: 'text',
            text: state.currentTextBlock!.text,
        };
        if (state.currentTextBlock!.citations.length > 0) {
            rawTextBlock.citations = state.currentTextBlock!.citations;
            if (isAfterSearchResults) {
                this.extractCitations(rawTextBlock, state.citations, state.searchResults);
            }
        }
        state.rawContent.push(rawTextBlock);
        state.currentTextBlock = null;
    }

    private handleMessageDelta(data: Record<string, unknown>, state: StreamState): void {
        const delta = data.delta as Record<string, unknown> | undefined;
        if (delta?.stop_reason) {
            state.stopReason = delta.stop_reason as string;
        }
        const usage = data.usage as Record<string, unknown> | undefined;
        if (usage) {
            state.usage.outputTokens = (usage.output_tokens as number) || state.usage.outputTokens;
        }
        // Extract server_tool_use search count from usage if available
        const serverToolUse = (usage ?? delta)
            ?.server_tool_use as Record<string, unknown> | undefined;
        if (serverToolUse?.web_search_requests) {
            state.usage.searchRequests = serverToolUse.web_search_requests as number;
        }
    }

    /** Convert stream state into a ClaudeWebSearchResponse. */
    private assembleStreamResponse(state: StreamState): ClaudeWebSearchResponse {
        this.assignCitationScores(state.citations, state.searchResults);
        return {
            searchResults: state.searchResults,
            synthesis: state.textParts.join(''),
            citations: state.citations,
            searchCount: state.usage.searchRequests,
            usage: {
                inputTokens: state.usage.inputTokens,
                outputTokens: state.usage.outputTokens,
            },
            paused: state.stopReason === 'pause_turn',
            rawContent: state.rawContent,
        };
    }
}
