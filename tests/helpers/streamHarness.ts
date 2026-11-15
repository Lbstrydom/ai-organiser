/**
 * Shared harness for tests that drive `CloudLLMService.summarizeTextStream`
 * through a stubbed `window.fetch`, capturing the emitted request.
 */
import { vi } from 'vitest';
import { App } from 'obsidian';
import { CloudLLMService } from '../../src/services/cloudService';
import { AdapterType } from '../../src/services/adapters';
import { PROVIDER_ENDPOINT, PROVIDER_DEFAULT_MODEL } from '../../src/services/adapters/providerRegistry';

export type CapturedRequest = { url: string; headers: Record<string, string>; body: Record<string, unknown>; signal?: AbortSignal };

export function makeService(type: AdapterType, modelName?: string, extra: Record<string, unknown> = {}): CloudLLMService {
    return new CloudLLMService({
        type,
        endpoint: PROVIDER_ENDPOINT[type] || 'https://example.test/v1',
        apiKey: 'k',
        modelName: modelName ?? (PROVIDER_DEFAULT_MODEL[type] || 'm'),
        language: 'en',
        ...extra,
    } as never, {} as App);
}

/** Build a streaming Response from raw SSE lines (each already newline-terminated by the helper). */
export function sseResponse(lines: string[], opts: { delayMs?: number } = {}): Response {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            for (const l of lines) {
                if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs));
                controller.enqueue(enc.encode(l + '\n'));
            }
            controller.close();
        },
    });
    return new Response(stream, { status: 200 });
}

export const openAiLines = (text: string, model = 'reported-model'): string[] => [
    `data: ${JSON.stringify({ model, choices: [{ delta: { content: text } }] })}`,
    'data: [DONE]',
];

export const claudeLines = (text: string, model = 'claude-reported'): string[] => [
    'event: message_start',
    `data: ${JSON.stringify({ type: 'message_start', message: { model, usage: { input_tokens: 1 } } })}`,
    'event: content_block_delta',
    `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}`,
];

export function linesFor(type: AdapterType, text = 'hello'): string[] {
    return type === 'claude' || type === 'azure-claude' ? claudeLines(text) : openAiLines(text);
}

/** Stub window.fetch; returns the capture list. */
export function stubFetch(respond: (req: CapturedRequest) => Response | Promise<Response>): CapturedRequest[] {
    const captured: CapturedRequest[] = [];
    vi.stubGlobal('window', {
        fetch: vi.fn(async (url: string, init: { headers: Record<string, string>; body: string; signal?: AbortSignal }) => {
            const req: CapturedRequest = { url, headers: init.headers, body: JSON.parse(init.body), signal: init.signal };
            captured.push(req);
            return respond(req);
        }),
    });
    return captured;
}
