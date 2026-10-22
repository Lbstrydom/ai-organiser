/**
 * Prompt caching — per-call usage logging.
 *
 * One debug line per response carrying the call label, provider, model and
 * token counts (including cache_read / cache_write) — and never any prompt or
 * response text.
 */

vi.mock('obsidian', async () => {
    const mod = await import('./mocks/obsidian');
    return { ...mod, requestUrl: vi.fn() };
});

import { vi } from 'vitest';
import { requestUrl, App } from 'obsidian';
import { logLlmUsage } from '../src/services/llm/llmUsageLog';
import { CloudLLMService } from '../src/services/cloudService';
import { AdapterType } from '../src/services/adapters';
import { logger } from '../src/utils/logger';

const mockRequestUrl = requestUrl as unknown as ReturnType<typeof vi.fn>;

let debugSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
    vi.clearAllMocks();
    logger.setDebugMode(true);
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterEach(() => {
    debugSpy.mockRestore();
    logger.setDebugMode(false);
});

const cacheLines = (): string[] =>
    debugSpy.mock.calls.map(c => String(c[0])).filter(l => l.includes('[Cache]'));

describe('logLlmUsage', () => {
    it('logs the Anthropic usage shape with label, provider and model', () => {
        logLlmUsage('tagging', 'claude', 'claude-sonnet-5-5', {
            input_tokens: 100, cache_creation_input_tokens: 3000, cache_read_input_tokens: 0, output_tokens: 50,
        });
        expect(cacheLines()).toEqual([
            '[AI Organiser][Cache] tagging claude model=claude-sonnet-5-5 in=100 cache_write=3000 cache_read=0 out=50',
        ]);
    });

    it('logs zeros for missing Anthropic cache fields', () => {
        logLlmUsage('chat', 'claude', 'claude-haiku-4-5', { input_tokens: 4096, output_tokens: 200 });
        expect(cacheLines()[0]).toContain('in=4096 cache_write=0 cache_read=0 out=200');
    });

    it('reads the OpenAI-compatible shape (Azure OpenAI cached_tokens / cache_write_tokens)', () => {
        logLlmUsage('tagging', 'azure-openai', 'gpt-5.6-terra', {
            prompt_tokens: 1566, completion_tokens: 40,
            prompt_tokens_details: { cached_tokens: 1408, cache_write_tokens: 0 },
        });
        expect(cacheLines()[0]).toContain('azure-openai model=gpt-5.6-terra in=1566 cache_write=0 cache_read=1408 out=40');
    });

    it('is silent without a usage object', () => {
        logLlmUsage('chat', 'claude', 'm', undefined);
        logLlmUsage('chat', 'claude', 'm', null);
        logLlmUsage('chat', 'claude', 'm', 'nope');
        expect(cacheLines()).toEqual([]);
    });

    it('is silent when debug mode is off', () => {
        logger.setDebugMode(false);
        logLlmUsage('chat', 'claude', 'm', { input_tokens: 1, output_tokens: 1 });
        expect(debugSpy).not.toHaveBeenCalled();
    });
});

describe('CloudLLMService usage logging', () => {
    const SENTINEL = 'ZQX-SENTINEL-NOTE-CONTENT';
    const app = {} as App;
    const claude = (): CloudLLMService => new CloudLLMService({
        type: 'claude' as AdapterType,
        endpoint: 'https://api.anthropic.com/v1/messages',
        apiKey: 'k', modelName: 'claude-sonnet-5-5', language: 'en',
    }, app);

    // Scope: the usage lines this change adds. Other debug logging (e.g. the
    // raw-response preview in BaseLLMService.generateTags) is existing behaviour,
    // already gated behind debug mode, and is outside this test.
    const respond = (usage: unknown): void => {
        mockRequestUrl.mockResolvedValue({
            status: 200,
            headers: {},
            text: JSON.stringify({
                model: 'claude-sonnet-5-5',
                content: [{ type: 'text', text: `reply mentioning ${SENTINEL}` }],
                usage,
            }),
        });
    };

    it('summarizeText logs the caller-supplied label, defaulting to chat', async () => {
        respond({ input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 2800, output_tokens: 5 });
        await claude().summarizeText('hello', { label: 'presentation-refine' });
        await claude().summarizeText('hello');
        const lines = cacheLines();
        expect(lines[0]).toContain('presentation-refine claude model=claude-sonnet-5-5 in=10 cache_write=0 cache_read=2800 out=5');
        expect(lines[1]).toContain('[Cache] chat claude');
    });

    it('generateTags logs the tagging label', async () => {
        respond({ input_tokens: 900, cache_creation_input_tokens: 850, output_tokens: 30 });
        await claude().generateTags('prompt');
        expect(cacheLines()[0]).toContain('[Cache] tagging claude model=claude-sonnet-5-5 in=900 cache_write=850 cache_read=0 out=30');
    });

    it('the [Cache] usage lines never contain prompt or response text', async () => {
        respond({ input_tokens: 1, output_tokens: 1 });
        await claude().summarizeText(`prompt with ${SENTINEL}`, { label: 'x' });
        await claude().generateTags(`tag prompt with ${SENTINEL}`, { stablePrefix: `head ${SENTINEL}` });
        expect(cacheLines().length).toBe(2);
        for (const line of cacheLines()) expect(line).not.toContain(SENTINEL);
    });
});
