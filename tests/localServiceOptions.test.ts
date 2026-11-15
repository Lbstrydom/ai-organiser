/**
 * Local provider honours its per-call options and reports what it did
 * (llm-option-fidelity D6).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('obsidian', async () => {
    const mod = await import('./mocks/obsidian');
    return { ...mod, requestUrl: vi.fn() };
});
import { requestUrl, App } from 'obsidian';
import { LocalLLMService } from '../src/services/localService';
import { getProviderLimits } from '../src/services/tokenLimits';
import { getOptionCapabilities, canHonourModelOverride, routeRole } from '../src/services/llm/optionCapabilities';
import { StreamFirstByteTimeoutError, activeStreamLifecycleCount } from '../src/services/llm/streamLifecycle';
import { summarizeTextStream as facadeStream } from '../src/services/llmFacade';
import { stubFetch, sseResponse, openAiLines } from './helpers/streamHarness';

const mockRequestUrl = requestUrl as unknown as ReturnType<typeof vi.fn>;
const local = (modelName = 'llama3'): LocalLLMService => new LocalLLMService({
    type: 'ollama', endpoint: 'http://localhost:11434', modelName, language: 'en',
} as never, {} as App);

const ok = (extra: Record<string, unknown> = {}): void => {
    mockRequestUrl.mockResolvedValue({
        status: 200, headers: {},
        text: JSON.stringify({ choices: [{ message: { content: 'answer' } }], ...extra }),
    });
};
const lastBody = (): Record<string, unknown> => {
    const calls = mockRequestUrl.mock.calls;
    return JSON.parse(calls[calls.length - 1][0].body as string);
};

beforeEach(() => {
    vi.clearAllMocks();
    // the service's timeout helper uses window.setTimeout; the node test env has no window
    vi.stubGlobal('window', { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('capability table row', () => {
    it('local honours a per-call modelOverride and routes the critic per-call', () => {
        expect(getOptionCapabilities('local').modelOverride).toBe('per-call');
        expect(canHonourModelOverride('local')).toBe(true);
        expect(routeRole('local', true)).toEqual({ route: 'per-call' });
    });

    it('local cross-provider stays a downgrade (a specialist would need an endpoint the role does not carry)', () => {
        expect(routeRole('local', false)).toEqual({ route: 'downgrade', reason: 'override-unsupported' });
    });

    it('local still cannot think', () => {
        expect(getOptionCapabilities('local').thinking).toBe('none');
    });
});

describe('summarizeText', () => {
    it('sends a concrete modelOverride instead of the service model', async () => {
        ok();
        const r = await local('llama3').summarizeText('p', { modelOverride: 'qwen2.5:14b' });
        expect(lastBody().model).toBe('qwen2.5:14b');
        expect(r.fidelity).toMatchObject({ requestedModel: 'qwen2.5:14b', routing: 'per-call', provider: 'local' });
        expect(r.fidelity?.dropped).toEqual([]);
    });

    it('an unresolved latest-* sentinel is never sent and is reported', async () => {
        ok();
        const r = await local('llama3').summarizeText('p', { modelOverride: 'latest-flash' });
        expect(lastBody().model).toBe('llama3');
        expect(r.fidelity?.dropped).toContainEqual({ option: 'modelOverride', reason: 'unresolved-sentinel' });
    });

    it('with no override the request is unchanged and the routing is the service config', async () => {
        ok();
        const r = await local('llama3').summarizeText('p');
        expect(lastBody().model).toBe('llama3');
        expect(r.fidelity).toMatchObject({ requestedModel: 'llama3', routing: 'service-config', dropped: [], adjusted: [] });
    });

    it('reports the thinking flags as dropped (no-model-capability)', async () => {
        ok();
        const r = await local().summarizeText('p', { enableThinking: true, disableThinking: false });
        expect(r.fidelity?.dropped).toContainEqual({ option: 'enableThinking', reason: 'no-model-capability' });
        expect(lastBody()).not.toHaveProperty('thinking');
    });

    it('disableThinking needs no report (nothing to switch off), enableThinking+disable is overruled', async () => {
        ok();
        const r = await local().summarizeText('p', { enableThinking: true, disableThinking: true });
        expect(r.fidelity?.adjusted.some(a => a.option === 'enableThinking' && a.reason === 'overruled-by-disable-thinking')).toBe(true);
    });

    it('clamps maxTokens to the local ceiling and reports the adjustment', async () => {
        ok();
        const ceiling = getProviderLimits('local').maxOutputTokens;
        const r = await local().summarizeText('p', { maxTokens: ceiling + 5000 });
        expect(lastBody().max_tokens).toBe(ceiling);
        expect(r.fidelity?.adjusted).toContainEqual({ option: 'maxTokens', requested: ceiling + 5000, effective: ceiling, reason: 'clamped-to-model-limit' });
    });

    it('carries the reported model from the response, apart from the requested one', async () => {
        ok({ model: 'llama3:8b-instruct-q4' });
        const r = await local('llama3').summarizeText('p');
        expect(r.fidelity).toMatchObject({ requestedModel: 'llama3', reportedModel: 'llama3:8b-instruct-q4' });
    });

    it('a signal that aborts cancels the call, even while a request is pending', async () => {
        mockRequestUrl.mockReturnValue(new Promise(() => { /* never settles */ }));
        const ac = new AbortController();
        const p = local().summarizeText('p', { signal: ac.signal });
        ac.abort();
        const r = await p;
        expect(r.success).toBe(false);
        expect(mockRequestUrl).toHaveBeenCalledTimes(1); // no retries after an abort
    });

    it('an already-aborted signal sends nothing', async () => {
        const ac = new AbortController();
        ac.abort();
        const r = await local().summarizeText('p', { signal: ac.signal });
        expect(r.success).toBe(false);
        expect(mockRequestUrl).not.toHaveBeenCalled();
    });
});

describe('summarizeTextStream', () => {
    it('honours stablePrefix, maxTokens (clamped) and modelOverride in the stream body', async () => {
        const cap = stubFetch(() => sseResponse(openAiLines('hi', 'qwen-reported')));
        const ceiling = getProviderLimits('local').maxOutputTokens;
        const r = await local('llama3').summarizeTextStream('tail', () => undefined, undefined, {
            stablePrefix: 'HEAD', maxTokens: ceiling + 1, modelOverride: 'qwen2.5:14b',
        });
        const body = cap[0].body as { model: string; max_tokens: number; stream: boolean; messages: Array<{ role: string; content: string }> };
        expect(body.stream).toBe(true);
        expect(body.model).toBe('qwen2.5:14b');
        expect(body.max_tokens).toBe(ceiling);
        expect(body.messages.find(m => m.role === 'user')?.content).toBe('HEAD\n\ntail');
        expect(r.fidelity).toMatchObject({ requestedModel: 'qwen2.5:14b', reportedModel: 'qwen-reported', routing: 'per-call', provider: 'local' });
        expect(r.fidelity?.adjusted.some(a => a.option === 'maxTokens')).toBe(true);
    });

    it('an option-less stream body is unchanged from today (model, messages, temperature, stream)', async () => {
        const cap = stubFetch(() => sseResponse(openAiLines('hi')));
        await local('llama3').summarizeTextStream('tail', () => undefined);
        expect(cap[0].body).toEqual({
            model: 'llama3',
            messages: [
                { role: 'system', content: 'Complete the task in the user message and follow its output format exactly.' },
                { role: 'user', content: 'tail' },
            ],
            temperature: 0.3,
            stream: true,
        });
    });

    it('a first-byte deadline fails a hung stream with the timeout error and clears its timers', async () => {
        vi.stubGlobal('window', {
            setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis),
            fetch: vi.fn((_u: string, init: { signal: AbortSignal }) => new Promise((_res, rej) => {
                init.signal.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')), { once: true });
            })),
        });
        await expect(local().summarizeTextStream('p', () => undefined, undefined, { timeoutMs: 30 }))
            .rejects.toBeInstanceOf(StreamFirstByteTimeoutError);
        expect(activeStreamLifecycleCount()).toBe(0);
    });

    it('a caller abort rejects with AbortError', async () => {
        vi.stubGlobal('window', {
            setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis),
            fetch: vi.fn((_u: string, init: { signal: AbortSignal }) => new Promise((_res, rej) => {
                init.signal.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')), { once: true });
            })),
        });
        const ac = new AbortController();
        const p = local().summarizeTextStream('p', () => undefined, ac.signal);
        ac.abort();
        await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('an empty stream is a failed result with a stable code, and the facade falls back with the fallback fidelity', async () => {
        stubFetch(() => sseResponse(['data: [DONE]']));
        ok({ model: 'fallback-model' });
        const svc = local('llama3');
        const direct = await svc.summarizeTextStream('p', () => undefined);
        expect(direct).toMatchObject({ success: false, code: 'STREAM_EMPTY' });
        const chunks: string[] = [];
        const r = await facadeStream({ llmService: svc, settings: { serviceType: 'local', cloudServiceType: '' } }, 'p', c => chunks.push(c));
        expect(chunks).toEqual(['answer']);
        expect(r.fidelity?.reportedModel).toBe('fallback-model');
    });

    it('a non-OK HTTP status still throws before the first chunk (fallback-eligible), as today', async () => {
        stubFetch(() => new Response('nope', { status: 503 }));
        await expect(local().summarizeTextStream('p', () => undefined)).rejects.toThrow('HTTP 503');
    });
});
