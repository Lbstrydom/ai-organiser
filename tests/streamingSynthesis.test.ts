/**
 * Streaming Synthesis & P2 Fix Tests
 *
 * Tests: P2-5 (ScrapingBrowser race condition), P2-7 (configurable settleMs),
 * P2-8 (search retry logic), §3.7 streaming synthesis (facade, adapters, orchestrator).
 */

// ── Module-level mocks ──

const mockSummarizeText = vi.fn();
const mockSummarizeTextStream = vi.fn();

vi.mock('../src/services/llmFacade', () => ({
    summarizeText: (...args: unknown[]) => mockSummarizeText(...args),
    summarizeTextStream: (...args: unknown[]) => mockSummarizeTextStream(...args),
    pluginContext: () => ({ type: 'mock-context' }),
}));

vi.mock('obsidian', async () => {
    const actual = await vi.importActual('./mocks/obsidian');
    return {
        ...actual,
        requestUrl: vi.fn().mockResolvedValue({ status: 200, text: '{}' }),
    };
});

vi.mock('../src/services/prompts/researchPrompts', () => ({
    buildQueryDecompositionPrompt: vi.fn().mockReturnValue('decompose-prompt'),
    buildContextualAnswerPrompt: vi.fn().mockReturnValue('contextual-prompt'),
    buildResultTriagePrompt: vi.fn().mockReturnValue('triage-prompt'),
    buildSourceExtractionPrompt: vi.fn().mockReturnValue('extraction-prompt'),
    buildSynthesisPrompt: vi.fn().mockReturnValue('synthesis-prompt'),
    PERSPECTIVE_PRESETS: { balanced: ['a', 'b', 'c', 'd'] },
}));

vi.mock('../src/services/ragService', () => ({
    RAGService: vi.fn(),
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
vi.mock('@mozilla/readability', () => ({
    Readability: vi.fn(),
}));

import { BaseAdapter } from '../src/services/adapters/baseAdapter';
import { OpenAIAdapter } from '../src/services/adapters/openaiAdapter';
import { ClaudeAdapter } from '../src/services/adapters/claudeAdapter';
import { GeminiAdapter } from '../src/services/adapters/geminiAdapter';
import { GroqAdapter } from '../src/services/adapters/groqAdapter';
import { DeepseekAdapter } from '../src/services/adapters/deepseekAdapter';
import { MistralAdapter } from '../src/services/adapters/mistralAdapter';
import { GrokAdapter } from '../src/services/adapters/grokAdapter';
import { OpenRouterAdapter } from '../src/services/adapters/openRouterAdapter';
import { RequestyAdapter } from '../src/services/adapters/requestyAdapter';
import { AliyunAdapter } from '../src/services/adapters/aliyunAdapter';
import { SiliconflowAdapter } from '../src/services/adapters/siliconflowAdapter';
import { OpenAICompatibleAdapter } from '../src/services/adapters/openaiCompatibleAdapter';
import { CDPClient } from '../src/services/research/brightdata/cdpClient';
import { ScrapingBrowser } from '../src/services/research/brightdata/scrapingBrowser';
import { ResearchOrchestrator } from '../src/services/research/researchOrchestrator';
import type { SourceExtraction } from '../src/services/research/researchTypes';
// Facade imports unused here — facade is mocked for orchestrator tests.
// Direct facade tests would go in a separate file without the module mock.

// ── Helpers ──

const adapterConfig = (apiKey = 'test-key', modelName = 'test-model') => ({
    endpoint: 'https://api.test.com/v1/chat/completions',
    apiKey,
    modelName,
});

function makePlugin() {
    return {
        settings: { cloudServiceType: 'openai', summaryLanguage: '' },
        app: {
            vault: {
                getAbstractFileByPath: vi.fn(),
                read: vi.fn(),
                modify: vi.fn(),
                create: vi.fn(),
                delete: vi.fn(),
            },
        },
        secretStorageService: { getSecret: vi.fn().mockResolvedValue(null) },
    } as any;
}

function makeSearchService() {
    return { search: vi.fn() } as any;
}

// ══════════════════════════════════════════════════════════════════════════════
// P2-5: ScrapingBrowser race condition
// ══════════════════════════════════════════════════════════════════════════════

describe('P2-5: ScrapingBrowser race condition', () => {
    let origWS: typeof WebSocket;

    beforeEach(() => {
        origWS = globalThis.WebSocket;
        // Mock WebSocket that immediately fires onerror (simulates connection failure)
        (globalThis as any).WebSocket = class {
            onopen: (() => void) | null = null;
            onerror: (() => void) | null = null;
            onmessage: ((e: any) => void) | null = null;
            readyState = 3; // CLOSED
            constructor() { Promise.resolve().then(() => this.onerror?.()); }
            send() { /* no-op */ }
            close() { this.readyState = 3; }
        };
    });

    afterEach(() => { globalThis.WebSocket = origWS; });

    it('does not set activeClient before connect succeeds', async () => {
        const browser = new ScrapingBrowser(async () => 'wss://fake-endpoint');

        // forceClose should be a no-op when connect hasn't succeeded
        await browser.forceClose(); // should not throw

        // fetchHTML will fail because mock WebSocket fires onerror immediately
        await expect(browser.fetchHTML('https://example.com')).rejects.toThrow();

        // After failed fetch, forceClose should still be safe
        await browser.forceClose();
    });

    it('forceClose is safe when no active connection', async () => {
        const browser = new ScrapingBrowser(async () => null);
        await browser.forceClose(); // no-op, should not throw
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// P2-7: Configurable settleMs in CDP navigate()
// ══════════════════════════════════════════════════════════════════════════════

describe('P2-7: CDP navigate settleMs', () => {
    it('navigate() accepts optional settleMs parameter', () => {
        const client = new CDPClient(5000);
        // Method signature should accept settleMs
        expect(typeof client.navigate).toBe('function');
        expect(client.navigate.length).toBeGreaterThanOrEqual(1); // at least url param
    });

    it('settleMs=0 skips the settle delay', async () => {
        const client = new CDPClient(5000);
        // Stub send and waitForEvent so navigate() doesn't need a real WS
        (client as any).send = vi.fn().mockResolvedValue({});
        (client as any).waitForEvent = vi.fn().mockResolvedValue(undefined);

        const start = Date.now();
        await client.navigate('https://example.com', 0);
        const elapsed = Date.now() - start;

        // With settleMs=0 the method should return almost instantly (no 2000ms wait)
        expect(elapsed).toBeLessThan(500);
        expect((client as any).send).toHaveBeenCalledWith('Page.enable');
        expect((client as any).send).toHaveBeenCalledWith('Page.navigate', { url: 'https://example.com' });
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// P2-8: Search retry logic
// ══════════════════════════════════════════════════════════════════════════════

describe('P2-8: Search retry logic', () => {
    it('retries once on 429 error then succeeds', async () => {
        const mockPlugin = {
            settings: { researchProvider: 'tavily' },
            secretStorageService: { getSecret: vi.fn().mockResolvedValue('key') },
        } as any;

        // Dynamic import to get the actual class with retry logic
        const { ResearchSearchService } = await import('../src/services/research/researchSearchService');
        const service = new ResearchSearchService(mockPlugin);

        // Create a mock provider that fails first then succeeds
        const mockProvider = {
            type: 'tavily',
            search: vi.fn()
                .mockRejectedValueOnce(Object.assign(new Error('429 Too Many Requests'), { status: 429 }))
                .mockResolvedValueOnce([{
                    title: 'Result',
                    url: 'https://example.com',
                    snippet: 'test',
                    source: 'web',
                    domain: 'example.com',
                }]),
            isConfigured: vi.fn().mockResolvedValue(true),
        };

        // Inject mock provider
        (service as any).providers.set('tavily', mockProvider);

        const results = await service.search(['test query']);
        expect(results.length).toBe(1);
        expect(mockProvider.search).toHaveBeenCalledTimes(2); // initial + 1 retry
    });

    it('surfaces error when retry also fails', async () => {
        const mockPlugin = {
            settings: { researchProvider: 'tavily' },
            secretStorageService: { getSecret: vi.fn().mockResolvedValue('key') },
        } as any;

        const { ResearchSearchService } = await import('../src/services/research/researchSearchService');
        const service = new ResearchSearchService(mockPlugin);

        const mockProvider = {
            type: 'tavily',
            search: vi.fn()
                .mockRejectedValueOnce(Object.assign(new Error('500 Server Error'), { status: 500 }))
                .mockRejectedValueOnce(new Error('500 Server Error again')),
            isConfigured: vi.fn().mockResolvedValue(true),
        };

        (service as any).providers.set('tavily', mockProvider);

        await expect(service.search(['test query'])).rejects.toThrow();
        expect(mockProvider.search).toHaveBeenCalledTimes(2);
    });

    it('does not retry on non-retryable errors', async () => {
        const mockPlugin = {
            settings: { researchProvider: 'tavily' },
            secretStorageService: { getSecret: vi.fn().mockResolvedValue('key') },
        } as any;

        const { ResearchSearchService } = await import('../src/services/research/researchSearchService');
        const service = new ResearchSearchService(mockPlugin);

        const mockProvider = {
            type: 'tavily',
            search: vi.fn()
                .mockRejectedValueOnce(new Error('Invalid API key')),
            isConfigured: vi.fn().mockResolvedValue(true),
        };

        (service as any).providers.set('tavily', mockProvider);

        await expect(service.search(['test query'])).rejects.toThrow('Invalid API key');
        expect(mockProvider.search).toHaveBeenCalledTimes(1); // no retry
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// §3.7: Adapter streaming support
// ══════════════════════════════════════════════════════════════════════════════

describe('Adapter streaming support', () => {
    const openaiCompatibleAdapters = [
        ['OpenAI', OpenAIAdapter],
        ['Groq', GroqAdapter],
        ['DeepSeek', DeepseekAdapter],
        ['Mistral', MistralAdapter],
        ['Grok', GrokAdapter],
        ['OpenRouter', OpenRouterAdapter],
        ['Requesty', RequestyAdapter],
        ['Aliyun', AliyunAdapter],
        ['Siliconflow', SiliconflowAdapter],
        ['OpenAI-Compatible', OpenAICompatibleAdapter],
        ['Gemini', GeminiAdapter],
    ] as const;

    describe.each(openaiCompatibleAdapters)('%s adapter', (_name, AdapterClass) => {
        it('supports streaming', () => {
            const adapter = new (AdapterClass as any)(adapterConfig());
            expect(adapter.supportsStreaming()).toBe(true);
        });

        it('formatStreamingRequest returns url, headers, and body with stream:true', () => {
            const adapter = new (AdapterClass as any)(adapterConfig());
            const req = adapter.formatStreamingRequest('test prompt');
            expect(req).toHaveProperty('url');
            expect(req).toHaveProperty('headers');
            expect(req).toHaveProperty('body');
            expect((req.body as any).stream).toBe(true);
        });

        it('parseStreamingChunk extracts content from OpenAI SSE', () => {
            const adapter = new (AdapterClass as any)(adapterConfig());
            const chunk = adapter.parseStreamingChunk(
                'data: {"choices":[{"delta":{"content":"Hello"}}]}'
            );
            expect(chunk).toBe('Hello');
        });

        it('parseStreamingChunk returns null for [DONE]', () => {
            const adapter = new (AdapterClass as any)(adapterConfig());
            expect(adapter.parseStreamingChunk('data: [DONE]')).toBeNull();
        });

        it('parseStreamingChunk returns null for non-data lines', () => {
            const adapter = new (AdapterClass as any)(adapterConfig());
            expect(adapter.parseStreamingChunk('')).toBeNull();
            expect(adapter.parseStreamingChunk('event: message')).toBeNull();
        });
    });

    describe('Claude adapter', () => {
        it('supports streaming', () => {
            const adapter = new ClaudeAdapter(adapterConfig());
            expect(adapter.supportsStreaming()).toBe(true);
        });

        it('formatStreamingRequest includes stream:true and anthropic headers', () => {
            const adapter = new ClaudeAdapter(adapterConfig());
            const req = adapter.formatStreamingRequest('test prompt');
            expect((req.body as any).stream).toBe(true);
            expect(req.headers).toHaveProperty('x-api-key');
            expect(req.headers).toHaveProperty('anthropic-version');
        });

        it('parseStreamingChunk extracts text from content_block_delta', () => {
            const adapter = new ClaudeAdapter(adapterConfig());
            const chunk = adapter.parseStreamingChunk(
                'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"world"}}'
            );
            expect(chunk).toBe('world');
        });

        it('parseStreamingChunk ignores non-delta events', () => {
            const adapter = new ClaudeAdapter(adapterConfig());
            expect(adapter.parseStreamingChunk(
                'data: {"type":"message_start","message":{}}'
            )).toBeNull();
        });

        it('parseStreamingChunk returns null for [DONE]', () => {
            const adapter = new ClaudeAdapter(adapterConfig());
            expect(adapter.parseStreamingChunk('data: [DONE]')).toBeNull();
        });
    });

    describe('BaseAdapter.parseOpenAISSEChunk (static)', () => {
        it('extracts content from valid SSE line', () => {
            const chunk = BaseAdapter.parseOpenAISSEChunk(
                'data: {"choices":[{"delta":{"content":"test"}}]}'
            );
            expect(chunk).toBe('test');
        });

        it('returns null for [DONE]', () => {
            expect(BaseAdapter.parseOpenAISSEChunk('data: [DONE]')).toBeNull();
        });

        it('returns null for non-data lines', () => {
            expect(BaseAdapter.parseOpenAISSEChunk('event: message')).toBeNull();
            expect(BaseAdapter.parseOpenAISSEChunk('')).toBeNull();
        });

        it('returns null for malformed JSON', () => {
            expect(BaseAdapter.parseOpenAISSEChunk('data: {invalid}')).toBeNull();
        });

        it('returns null when delta has no content', () => {
            expect(BaseAdapter.parseOpenAISSEChunk(
                'data: {"choices":[{"delta":{"role":"assistant"}}]}'
            )).toBeNull();
        });
    });
});

// Note: Facade summarizeTextStream is tested indirectly via orchestrator.synthesizeStream tests
// (the llmFacade module is mocked at module level for orchestrator testing).
// Direct facade unit tests are in tests/llmFacade.test.ts.

// ══════════════════════════════════════════════════════════════════════════════
// §3.7: Orchestrator synthesizeStream
// ══════════════════════════════════════════════════════════════════════════════

describe('Orchestrator synthesizeStream', () => {
    let orchestrator: ResearchOrchestrator;

    beforeEach(() => {
        vi.clearAllMocks();
        orchestrator = new ResearchOrchestrator(makeSearchService(), makePlugin());
    });

    it('calls summarizeTextStream and returns final synthesis', async () => {
        mockSummarizeTextStream.mockResolvedValue({
            success: true,
            content: 'Streamed synthesis [1].',
        });

        const chunks: string[] = [];
        const extractions: SourceExtraction[] = [{
            url: 'https://example.com',
            title: 'Test',
            findings: 'Some findings',
            extractionMethod: 'readability',
        }];

        const result = await orchestrator.synthesizeStream(
            extractions, 'What is X?',
            (chunk) => chunks.push(chunk),
            { language: 'en', includeCitations: true },
        );

        expect(result.synthesis).toBeTruthy();
        expect(result.sourceMetadata).toHaveLength(1);
        expect(result.sourceMetadata[0].url).toBe('https://example.com');
    });

    it('returns failure message when LLM fails', async () => {
        mockSummarizeTextStream.mockResolvedValue({
            success: false,
            content: '',
        });

        const result = await orchestrator.synthesizeStream(
            [{ url: 'https://ex.com', title: 'T', findings: 'F', extractionMethod: 'readability' }],
            'question',
            () => {},
        );

        expect(result.synthesis).toBe('Synthesis failed. Please try again.');
    });

    it('passes signal through to the facade', async () => {
        mockSummarizeTextStream.mockResolvedValue({ success: true, content: 'OK' });

        const controller = new AbortController();
        await orchestrator.synthesizeStream(
            [{ url: 'https://ex.com', title: 'T', findings: 'F', extractionMethod: 'readability' }],
            'question',
            () => {},
            { signal: controller.signal },
        );

        // Verify the signal was passed to the facade
        expect(mockSummarizeTextStream).toHaveBeenCalledWith(
            expect.anything(),
            expect.any(String),
            expect.any(Function),
            controller.signal,
        );
    });

    it('builds sourceMetadata with academic fields from searchResults', async () => {
        mockSummarizeTextStream.mockResolvedValue({ success: true, content: 'result' });

        const result = await orchestrator.synthesizeStream(
            [{ url: 'https://arxiv.org/paper', title: 'Paper', findings: 'abstract', extractionMethod: 'readability' }],
            'review papers',
            () => {},
            {
                searchResults: [{
                    url: 'https://arxiv.org/paper',
                    title: 'Paper',
                    snippet: '',
                    source: 'web',
                    domain: 'arxiv.org',
                    authors: ['Smith, J.'],
                    year: 2024,
                    doi: '10.1234/test',
                }],
            },
        );

        expect(result.sourceMetadata[0].authors).toEqual(['Smith, J.']);
        expect(result.sourceMetadata[0].doi).toBe('10.1234/test');
    });
});
