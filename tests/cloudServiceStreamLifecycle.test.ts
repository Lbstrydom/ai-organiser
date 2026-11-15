/**
 * Stream request lifecycle (llm-option-fidelity D5): abort before headers, after headers
 * and mid-stream; the first-byte deadline; disposal; nothing left behind; empty stream.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { makeService, stubFetch, sseResponse, openAiLines, claudeLines } from './helpers/streamHarness';
import { activeStreamLifecycleCount, disposeStreamLifecycles, StreamLifecycle, StreamFirstByteTimeoutError } from '../src/services/llm/streamLifecycle';
import { summarizeTextStream as facadeStream } from '../src/services/llmFacade';
import { CloudLLMService } from '../src/services/cloudService';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

/** A fetch that never answers until its signal aborts, like a real hung connection. */
function hangingFetch(): void {
    vi.stubGlobal('window', {
        fetch: vi.fn((_u: string, init: { signal: AbortSignal }) => new Promise((_res, rej) => {
            init.signal.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')), { once: true });
        })),
    });
}

/** A body that sends one chunk then stalls until its signal aborts. */
function stallingBody(signal: AbortSignal, first: string[]): Response {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        start(c) {
            for (const l of first) c.enqueue(enc.encode(l + '\n'));
            signal.addEventListener('abort', () => c.error(new DOMException('Aborted', 'AbortError')), { once: true });
        },
    });
    return new Response(stream, { status: 200 });
}

describe('StreamLifecycle', () => {
    it('clears its timer and listener on dispose', () => {
        const caller = new AbortController();
        const before = activeStreamLifecycleCount();
        const lc = new StreamLifecycle(caller.signal, 60_000);
        expect(activeStreamLifecycleCount()).toBe(before + 1);
        lc.dispose();
        expect(activeStreamLifecycleCount()).toBe(before);
        caller.abort(); // listener was removed: the lifecycle's own signal stays untouched
        expect(lc.signal.aborted).toBe(false);
    });

    it('the first byte cancels the deadline', async () => {
        vi.useFakeTimers();
        const lc = new StreamLifecycle(undefined, 1000);
        lc.markFirstByte();
        await vi.advanceTimersByTimeAsync(5000);
        expect(lc.signal.aborted).toBe(false);
        lc.dispose();
    });

    it('the deadline aborts and classifies as a first-byte timeout, not an abort', async () => {
        vi.useFakeTimers();
        const lc = new StreamLifecycle(undefined, 1000);
        await vi.advanceTimersByTimeAsync(1001);
        expect(lc.signal.aborted).toBe(true);
        expect(lc.classify(new DOMException('x', 'AbortError'))).toBeInstanceOf(StreamFirstByteTimeoutError);
        lc.dispose();
    });

    it('a caller abort that races the deadline wins (no fallback)', async () => {
        vi.useFakeTimers();
        const caller = new AbortController();
        const lc = new StreamLifecycle(caller.signal, 1000);
        await vi.advanceTimersByTimeAsync(1001);
        caller.abort();
        const err = lc.classify(new DOMException('x', 'AbortError'));
        expect(err).toBeInstanceOf(DOMException);
        expect((err as DOMException).name).toBe('AbortError');
        lc.dispose();
    });
});

describe('CloudLLMService.summarizeTextStream lifecycle', () => {
    it('abort before headers: rejects with AbortError and leaves nothing behind', async () => {
        hangingFetch();
        const before = activeStreamLifecycleCount();
        const ac = new AbortController();
        const svc = makeService('claude');
        const p = svc.summarizeTextStream('p', () => undefined, ac.signal);
        ac.abort();
        await expect(p).rejects.toMatchObject({ name: 'AbortError' });
        expect(activeStreamLifecycleCount()).toBe(before);
    });

    it('abort after headers, before the first chunk: AbortError, nothing left behind', async () => {
        const ac = new AbortController();
        stubFetch((req) => stallingBody(req.signal!, []));
        const before = activeStreamLifecycleCount();
        const svc = makeService('groq');
        const p = svc.summarizeTextStream('p', () => undefined, ac.signal);
        await new Promise(r => setTimeout(r, 5));
        ac.abort();
        await expect(p).rejects.toMatchObject({ name: 'AbortError' });
        expect(activeStreamLifecycleCount()).toBe(before);
    });

    it('abort mid-stream: AbortError after content was delivered', async () => {
        const ac = new AbortController();
        stubFetch((req) => stallingBody(req.signal!, openAiLines('first')));
        const chunks: string[] = [];
        const svc = makeService('groq');
        const p = svc.summarizeTextStream('p', c => { chunks.push(c); ac.abort(); }, ac.signal);
        await expect(p).rejects.toMatchObject({ name: 'AbortError' });
        expect(chunks).toEqual(['first']);
        expect(activeStreamLifecycleCount()).toBe(0);
    });

    it('first-byte deadline: a hung request fails with the timeout error, not an abort', async () => {
        hangingFetch();
        const svc = makeService('claude');
        const p = svc.summarizeTextStream('p', () => undefined, undefined, { timeoutMs: 30 });
        await expect(p).rejects.toBeInstanceOf(StreamFirstByteTimeoutError);
        expect(activeStreamLifecycleCount()).toBe(0);
    });

    it('a deadline set but cleared by an early first byte never aborts a slow stream', async () => {
        const enc = new TextEncoder();
        stubFetch(() => new Response(new ReadableStream<Uint8Array>({
            async start(c) {
                c.enqueue(enc.encode(openAiLines('a')[0] + '\n'));
                await new Promise(r => setTimeout(r, 120)); // longer than the 50ms deadline
                c.enqueue(enc.encode(openAiLines('b')[0] + '\n'));
                c.close();
            },
        }), { status: 200 }));
        const svc = makeService('groq');
        const r = await svc.summarizeTextStream('p', () => undefined, undefined, { timeoutMs: 50 });
        expect(r.success).toBe(true);
        expect(r.content).toBe('ab');
    });

    it('disposal on unload aborts an in-flight stream without a fallback signal', async () => {
        hangingFetch();
        const svc = makeService('claude');
        const p = svc.summarizeTextStream('p', () => undefined);
        await new Promise(r => setTimeout(r, 5));
        disposeStreamLifecycles();
        await expect(p).rejects.toMatchObject({ name: 'AbortError' });
        expect(activeStreamLifecycleCount()).toBe(0);
    });

    it('an empty stream is a failed result with a stable code', async () => {
        stubFetch(() => sseResponse(['data: [DONE]']));
        const svc = makeService('groq');
        const r = await svc.summarizeTextStream('p', () => undefined);
        expect(r).toMatchObject({ success: false, code: 'STREAM_EMPTY' });
        expect(r.fidelity).toBeTruthy();
        expect(activeStreamLifecycleCount()).toBe(0);
    });

    it('a mid-stream provider error after content is partial and keeps the attempt fidelity', async () => {
        stubFetch(() => sseResponse([
            ...claudeLines('some text'),
            'event: error',
            'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
        ]));
        const svc = makeService('claude');
        const r = await svc.summarizeTextStream('p', () => undefined);
        expect(r.success).toBe(false);
        expect(r.partial).toBe(true);
        expect(r.fidelity?.reportedModel).toBe('claude-reported');
    });
});

describe('facade fallback with the lifecycle', () => {
    const ctx = (svc: CloudLLMService) => ({ llmService: svc, settings: { serviceType: 'cloud' as const, cloudServiceType: 'groq' } });

    it('empty stream falls back to non-stream and returns the FALLBACK attempt fidelity', async () => {
        stubFetch(() => sseResponse(['data: [DONE]']));
        const svc = makeService('groq');
        (svc as unknown as { pacedRequestUrl: unknown }).pacedRequestUrl = async () => ({
            status: 200, text: JSON.stringify({ model: 'fallback-model', choices: [{ message: { content: 'from fallback' } }] }), headers: {},
        });
        const chunks: string[] = [];
        const r = await facadeStream(ctx(svc), 'p', c => chunks.push(c));
        expect(r.success).toBe(true);
        expect(chunks).toEqual(['from fallback']);
        expect(r.fidelity?.reportedModel).toBe('fallback-model');
    });

    it('a caller abort racing the first-byte deadline sends no fallback request', async () => {
        hangingFetch();
        const svc = makeService('groq');
        const fallback = vi.fn();
        (svc as unknown as { pacedRequestUrl: unknown }).pacedRequestUrl = fallback;
        const ac = new AbortController();
        const p = facadeStream(ctx(svc), 'p', () => undefined, ac.signal, { timeoutMs: 30 });
        await new Promise(r => setTimeout(r, 29));
        ac.abort();
        const r = await p;
        expect(r).toMatchObject({ success: false, error: 'Aborted' });
        expect(fallback).not.toHaveBeenCalled();
    });

    it('a first-byte timeout falls back to non-stream', async () => {
        hangingFetch();
        const svc = makeService('groq');
        (svc as unknown as { pacedRequestUrl: unknown }).pacedRequestUrl = async () => ({
            status: 200, text: JSON.stringify({ choices: [{ message: { content: 'recovered' } }] }), headers: {},
        });
        const r = await facadeStream(ctx(svc), 'p', () => undefined, undefined, { timeoutMs: 30 });
        expect(r).toMatchObject({ success: true, content: 'recovered' });
    });
});
