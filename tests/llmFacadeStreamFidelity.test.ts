/**
 * The stream result carries the fidelity of the attempt that produced the content
 * (llm-option-fidelity D5): success, pre-first-chunk fallback, partial failure,
 * empty output, and a metadata-only initial event.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { summarizeTextStream } from '../src/services/llmFacade';
import type { Fidelity, SummarizableLLMService } from '../src/services/types';
import { makeService, stubFetch, sseResponse, claudeLines } from './helpers/streamHarness';

afterEach(() => { vi.unstubAllGlobals(); });

const fid = (requestedModel: string, reportedModel?: string): Fidelity => ({
    requestedModel, ...(reportedModel ? { reportedModel } : {}), routing: 'service-config', provider: 'claude', dropped: [], adjusted: [],
});

function ctx(service: Partial<SummarizableLLMService>) {
    return { llmService: service as SummarizableLLMService, settings: { serviceType: 'cloud' as const, cloudServiceType: 'claude' } };
}

describe('facade summarizeTextStream fidelity', () => {
    it('returns the stream attempt fidelity on success', async () => {
        const r = await summarizeTextStream(ctx({
            summarizeText: vi.fn(),
            summarizeTextStream: async (_p, onChunk) => { onChunk('x'); return { success: true, content: 'x', fidelity: fid('stream-model', 'stream-reported') }; },
        }), 'p', () => undefined);
        expect(r.fidelity?.requestedModel).toBe('stream-model');
    });

    it('a pre-first-chunk failure returns the FALLBACK fidelity, never the failed stream', async () => {
        const r = await summarizeTextStream(ctx({
            summarizeText: async () => ({ success: true, content: 'fb', fidelity: fid('fallback-model') }),
            summarizeTextStream: async () => { throw new Error('connect failed'); },
        }), 'p', () => undefined);
        expect(r.fidelity?.requestedModel).toBe('fallback-model');
    });

    it('a partial-stream failure keeps the stream attempt fidelity and flags partial', async () => {
        const summarize = vi.fn();
        const r = await summarizeTextStream(ctx({
            summarizeText: summarize,
            summarizeTextStream: async (_p, onChunk) => {
                onChunk('some');
                return { success: false, error: 'Partial stream failure: reset', partial: true, fidelity: fid('stream-model') };
            },
        }), 'p', () => undefined);
        expect(r).toMatchObject({ success: false, partial: true });
        expect(r.fidelity?.requestedModel).toBe('stream-model');
        expect(summarize).not.toHaveBeenCalled();
    });

    it('empty output falls back (no duplicate chunk) and reports the fallback fidelity', async () => {
        const chunks: string[] = [];
        const r = await summarizeTextStream(ctx({
            summarizeText: async () => ({ success: true, content: 'answer', fidelity: fid('fallback-model') }),
            summarizeTextStream: async () => ({ success: false, error: 'empty', code: 'STREAM_EMPTY', fidelity: fid('stream-model') }),
        }), 'p', c => chunks.push(c));
        expect(chunks).toEqual(['answer']);
        expect(r.fidelity?.requestedModel).toBe('fallback-model');
    });

    it('an empty-output code AFTER chunks were delivered does not fall back', async () => {
        const summarize = vi.fn();
        const r = await summarizeTextStream(ctx({
            summarizeText: summarize,
            summarizeTextStream: async (_p, onChunk) => { onChunk('a'); return { success: false, error: 'x', code: 'STREAM_EMPTY' }; },
        }), 'p', () => undefined);
        expect(r.success).toBe(false);
        expect(summarize).not.toHaveBeenCalled();
    });
});

describe('stream reportedModel channel (real service)', () => {
    it('a metadata-only message_start sets reportedModel without emitting a content chunk', async () => {
        stubFetch(() => sseResponse([
            ...claudeLines('', 'claude-version-x').slice(0, 2), // message_start only
            'event: content_block_delta',
            `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'body' } })}`,
        ]));
        const chunks: string[] = [];
        const r = await makeService('claude').summarizeTextStream('p', c => chunks.push(c));
        expect(chunks).toEqual(['body']);
        expect(r.fidelity?.reportedModel).toBe('claude-version-x');
    });

    it('reportedModel stays absent when the stream carries no model (unknown, never different)', async () => {
        stubFetch(() => sseResponse([`data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}`]));
        const r = await makeService('groq').summarizeTextStream('p', () => undefined);
        expect(r.success).toBe(true);
        expect(r.fidelity?.reportedModel).toBeUndefined();
    });

    it('a fallback attempt replaces the stream attempt reportedModel', async () => {
        stubFetch(() => sseResponse([`data: ${JSON.stringify({ model: 'stream-seen', choices: [{ delta: { content: '' } }] })}`]));
        const svc = makeService('groq');
        (svc as unknown as { pacedRequestUrl: unknown }).pacedRequestUrl = async () => ({
            status: 200, text: JSON.stringify({ model: 'fallback-seen', choices: [{ message: { content: 'ok' } }] }), headers: {},
        });
        const r = await summarizeTextStream({ llmService: svc, settings: { serviceType: 'cloud', cloudServiceType: 'groq' } }, 'p', () => undefined);
        expect(r.success).toBe(true);
        expect(r.fidelity?.reportedModel).toBe('fallback-seen');
    });
});

describe('audit R1 fixes: terminal-result contract', () => {
    it('a throw after content was delivered is a partial failure', async () => {
        const r = await summarizeTextStream(ctx({
            summarizeText: vi.fn(),
            summarizeTextStream: async (_p, onChunk) => { onChunk('some'); throw new Error('reset'); },
        }), 'p', () => undefined);
        expect(r).toMatchObject({ success: false, partial: true });
        expect(r.error).toMatch(/Partial stream failure/);
    });

    it('options.signal is honoured when no positional signal is passed, in the fallback too', async () => {
        const ac = new AbortController();
        const seen: Array<AbortSignal | undefined> = [];
        await summarizeTextStream(ctx({
            summarizeText: async (_p, o) => { seen.push(o?.signal); return { success: true, content: 'x' }; },
            summarizeTextStream: async (_p, _c, s) => { seen.push(s); throw new Error('connect'); },
        }), 'p', () => undefined, undefined, { signal: ac.signal });
        expect(seen).toEqual([ac.signal, ac.signal]);
    });

    it('an abort after content is flagged partial', async () => {
        const ac = new AbortController();
        const r = await summarizeTextStream(ctx({
            summarizeText: vi.fn(),
            summarizeTextStream: async (_p, onChunk) => { onChunk('a'); ac.abort(); throw new DOMException('x', 'AbortError'); },
        }), 'p', () => undefined, ac.signal);
        expect(r).toMatchObject({ success: false, error: 'Aborted', partial: true });
    });
});

describe('audit R1 fixes: response body ownership', () => {
    it('a non-OK response body is cancelled (cloud)', async () => {
        const cancel = vi.fn().mockResolvedValue(undefined);
        stubFetch(() => ({ ok: false, status: 503, body: { cancel } } as unknown as Response));
        const r = await makeService('groq').summarizeTextStream('p', () => undefined);
        expect(r).toMatchObject({ success: false, error: 'HTTP 503' });
        expect(cancel).toHaveBeenCalled();
    });

    it('a throwing onChunk still releases the reader (lock freed, body cancelled)', async () => {
        let cancelled = false;
        const enc = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
            start(c) { c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}\n`)); },
            cancel() { cancelled = true; },
        });
        stubFetch(() => new Response(body, { status: 200 }));
        const r = await makeService('groq').summarizeTextStream('p', () => { throw new Error('ui blew up'); });
        expect(r).toMatchObject({ success: false, partial: true });
        expect(cancelled).toBe(true);
        expect(body.locked).toBe(false);
    });
});
