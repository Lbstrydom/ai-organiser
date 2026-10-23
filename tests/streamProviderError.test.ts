/**
 * Provider errors inside an SSE stream.
 *
 * Anthropic can answer HTTP 200 and then end the stream with
 *   event: error
 *   data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}
 * The decoders used to drop that as an unknown event, so a stream that died
 * mid-way was reported as a successful (short) answer. It is a failed call.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { App } from 'obsidian';
import { parseAnthropicSseLine, StreamProviderError } from '../src/services/adapters/anthropicStream';
import { ClaudeAdapter } from '../src/services/adapters/claudeAdapter';
import { AzureClaudeAdapter } from '../src/services/adapters/azureClaudeAdapter';
import { CloudLLMService } from '../src/services/cloudService';
import { AdapterType } from '../src/services/adapters';
import { summarizeTextStream } from '../src/services/llmFacade';
import { disposeAzurePacers } from '../src/services/azure/azureRequestPacer';
import { logger } from '../src/utils/logger';

const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}`;
const delta = (text: string): string => sse({ type: 'content_block_delta', delta: { type: 'text_delta', text } });
const OVERLOADED = { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } };

describe('parseAnthropicSseLine', () => {
    it('returns the text of a text_delta', () => {
        expect(parseAnthropicSseLine(delta('hello'), 'claude', 'm')).toBe('hello');
    });

    it('throws a StreamProviderError carrying the provider type and message for an error event', () => {
        let caught: unknown;
        try { parseAnthropicSseLine(sse(OVERLOADED), 'claude', 'm'); } catch (e) { caught = e; }
        expect(caught).toBeInstanceOf(StreamProviderError);
        const err = caught as StreamProviderError;
        expect(err.message).toBe('claude stream error (overloaded_error): Overloaded');
        expect(err.errorType).toBe('overloaded_error');
        expect(err.provider).toBe('claude');
    });

    it('also recognises an untyped {error:{...}} envelope (gateway re-wrap) and a message-less error', () => {
        expect(() => parseAnthropicSseLine(sse({ error: { type: 'api_error', message: 'boom' } }), 'azure-claude', 'm'))
            .toThrow('azure-claude stream error (api_error): boom');
        expect(() => parseAnthropicSseLine(sse({ type: 'error' }), 'claude', 'm'))
            .toThrow(/the provider ended the stream with an error/);
    });

    it.each([
        ['an event: line', 'event: error'],
        ['a blank line', ''],
        ['a non-JSON data line', 'data: [DONE]'],
        ['a null payload', 'data: null'],
        ['a ping', sse({ type: 'ping' })],
        ['a thinking delta', sse({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '…' } })],
        ['a typed non-error event with an error-looking field', sse({ type: 'message_delta', error: { message: 'x' } })],
    ])('yields nothing and does not throw for %s', (_what, line) => {
        expect(parseAnthropicSseLine(line, 'claude', 'm')).toBeNull();
    });

    it('still logs cache usage on message_start', () => {
        logger.setDebugMode(true);
        const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
        try {
            parseAnthropicSseLine(sse({ type: 'message_start', message: { usage: { input_tokens: 5, cache_read_input_tokens: 9, output_tokens: 1 } } }), 'claude', 'claude-sonnet-5-5');
            expect(String(spy.mock.calls[0][0])).toContain('[Cache] stream-start claude model=claude-sonnet-5-5 in=5 cache_write=0 cache_read=9 out=1');
        } finally {
            spy.mockRestore();
            logger.setDebugMode(false);
        }
    });
});

describe.each([
    ['ClaudeAdapter', 'claude', ClaudeAdapter],
    ['AzureClaudeAdapter', 'azure-claude', AzureClaudeAdapter],
])('%s.parseStreamingChunk', (_name, provider, Adapter) => {
    const adapter = new Adapter({ endpoint: 'https://example.test/v1/messages', apiKey: 'k', modelName: 'claude-sonnet-5-5' });

    it('passes text deltas through', () => {
        expect(adapter.parseStreamingChunk(delta('hi'))).toBe('hi');
    });

    it('throws on an error event, naming the provider', () => {
        expect(() => adapter.parseStreamingChunk(sse(OVERLOADED)))
            .toThrow(`${provider} stream error (overloaded_error): Overloaded`);
    });
});

// ── End to end through CloudLLMService.summarizeTextStream ──────────────────

describe.each([
    ['claude', 'claude' as AdapterType, 'https://api.anthropic.com/v1/messages'],
    ['azure-claude', 'azure-claude' as AdapterType, 'https://res.services.ai.azure.com/anthropic/v1/messages'],
])('%s stream that ends in an error event', (provider, type, endpoint) => {
    let hadWindow = false;
    let originalWindow: unknown;
    const respondWith = (body: string): void => {
        (globalThis as unknown as { window: unknown }).window = {
            fetch: vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })),
        };
    };
    const service = (): CloudLLMService => new CloudLLMService({
        type, endpoint, apiKey: 'k', modelName: 'claude-sonnet-5-5', language: 'en',
    }, {} as App);

    beforeEach(() => {
        hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
        originalWindow = (globalThis as unknown as { window?: unknown }).window;
        disposeAzurePacers();
    });
    afterEach(() => {
        if (hadWindow) (globalThis as unknown as { window?: unknown }).window = originalWindow;
        else delete (globalThis as unknown as { window?: unknown }).window;
        disposeAzurePacers();
    });

    const stream = (...events: string[]): string => events.join('\n\n') + '\n\n';

    it('text, then error: a FAILED call with the provider message; partial text was streamed, none returned as success', async () => {
        respondWith(stream(delta('Partial '), delta('answer'), `event: error\n${sse(OVERLOADED)}`));
        const chunks: string[] = [];
        const result = await service().summarizeTextStream('p', (c) => chunks.push(c));
        expect(result.success).toBe(false);
        expect(result.content).toBeUndefined();
        expect(result.error).toBe(`${provider} stream error (overloaded_error): Overloaded`);
        expect(chunks.join('')).toBe('Partial answer');
    });

    it('error as the very first event', async () => {
        respondWith(stream(`event: error\n${sse(OVERLOADED)}`));
        const result = await service().summarizeTextStream('p', () => {});
        expect(result).toEqual({ success: false, error: `${provider} stream error (overloaded_error): Overloaded` });
    });

    it('error event in the final buffer without a trailing newline', async () => {
        respondWith(`${delta('x')}\n\n${sse(OVERLOADED)}`);
        const result = await service().summarizeTextStream('p', () => {});
        expect(result.success).toBe(false);
        expect(result.error).toContain('overloaded_error');
    });

    it('the facade reports the failure and does not fall back to a non-stream success', async () => {
        respondWith(stream(delta('Partial'), sse(OVERLOADED)));
        const svc = service();
        const nonStream = vi.spyOn(svc, 'summarizeText');
        const result = await summarizeTextStream(
            { llmService: svc, settings: { serviceType: 'cloud', cloudServiceType: provider } },
            'p', () => {},
        );
        expect(result.success).toBe(false);
        expect(result.error).toContain('overloaded_error');
        expect(nonStream).not.toHaveBeenCalled();
    });

    it('control: the same stream without the error event succeeds with the full text', async () => {
        respondWith(stream(delta('Partial '), delta('answer'), sse({ type: 'message_stop' })));
        const result = await service().summarizeTextStream('p', () => {});
        expect(result).toEqual({ success: true, content: 'Partial answer' });
    });
});
