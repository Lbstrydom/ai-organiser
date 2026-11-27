/**
 * Streaming parity (llm-option-fidelity D5): the stream request is built from the
 * same body as the non-stream request, plus `stream: true`.
 *
 * `tests/fixtures/stream-body-baseline.json` was recorded from the code BEFORE the
 * extraction (adapter `formatStreamingRequest` vs the non-stream summarize body), so
 * the oracle does not depend on the code under test.
 *
 * Intentional, provider-specific differences from the old stream body (all adopt the
 * non-stream body shape; the adapter's own serialisation is unchanged):
 *  - Claude / Azure Claude: `max_tokens` 4096 -> the non-stream default (8192, or 64000
 *    with thinking) or the caller's cap. The 4096 cap was the bug.
 *  - OpenAI-shaped: gain the token cap field (`max_tokens` / `max_completion_tokens`)
 *    and, where the non-stream body carries one, `temperature`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import baseline from './fixtures/stream-body-baseline.json';
import { ALL_ADAPTERS, PROVIDER_DEFAULT_MODEL } from '../src/services/adapters/providerRegistry';
import { AdapterType } from '../src/services/adapters';
import { makeService, stubFetch, sseResponse, linesFor } from './helpers/streamHarness';

type Row = { streams: boolean; endpoint: string; stream: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | null; nonStream: Record<string, unknown> };
const rows = baseline as unknown as Record<string, Row>;
const STREAMING = ALL_ADAPTERS.filter(t => rows[t]?.streams);

afterEach(() => { vi.unstubAllGlobals(); });

async function emit(type: AdapterType, options?: Parameters<ReturnType<typeof makeService>['summarizeTextStream']>[3], model?: string) {
    const svc = makeService(type, model);
    const cap = stubFetch(() => sseResponse(linesFor(type)));
    const chunks: string[] = [];
    const result = await svc.summarizeTextStream('PROMPT', c => chunks.push(c), undefined, options);
    return { cap: cap[0], result, chunks };
}

describe('stream body baseline (option-less)', () => {
    it('has a baseline row for EVERY adapter in the registry (a missing row must fail, not be filtered out)', () => {
        for (const t of ALL_ADAPTERS) expect(rows[t], `[${t}] missing in fixtures/stream-body-baseline.json`).toBeDefined();
        expect(STREAMING.length).toBeGreaterThan(8);
    });

    for (const type of STREAMING) {
        it(`[${type}] option-less stream = non-stream body + stream:true; url and headers unchanged`, async () => {
            const row = rows[type];
            // Pin the recorded model where the default is a `latest-*` sentinel: it moves
            // with the registry, and this baseline is about the body shape.
            const sentinel = PROVIDER_DEFAULT_MODEL[type]?.startsWith('latest-');
            const { cap, result } = await emit(type, undefined, sentinel ? row.nonStream.model as string | undefined : undefined);
            expect(result.success).toBe(true);
            expect(cap.url).toBe(row.stream!.url);
            expect(cap.headers).toEqual(row.stream!.headers);
            expect(cap.body).toEqual({ ...row.nonStream, stream: true });
            // every key the old stream body carried is still present (superset)
            for (const k of Object.keys(row.stream!.body)) expect(cap.body).toHaveProperty(k);
        });
    }
});

describe('stream options are honoured (previously dropped)', () => {
    it('Claude: caller maxTokens reaches the body (was hard-coded 4096)', async () => {
        const { cap } = await emit('claude', { maxTokens: 30000 });
        expect(cap.body.max_tokens).toBe(30000);
    });

    it('Claude: option-less stream no longer carries the 4096 cap', async () => {
        const { cap } = await emit('claude');
        expect(cap.body.max_tokens).not.toBe(4096);
    });

    it('Claude: enableThinking sends adaptive thinking on a capable model (Deep thinking)', async () => {
        const { cap } = await emit('claude', { enableThinking: true }, 'claude-opus-4-7');
        expect(cap.body.thinking).toEqual({ type: 'adaptive' });
    });

    it('Claude: disableThinking wins over enableThinking', async () => {
        const { cap, result } = await emit('claude', { enableThinking: true, disableThinking: true }, 'claude-opus-4-7');
        expect(cap.body.thinking).toBeUndefined();
        expect(result.fidelity?.adjusted.some(a => a.option === 'enableThinking')).toBe(true);
    });

    it('Claude: modelOverride selects the model on the wire', async () => {
        const { cap, result } = await emit('claude', { modelOverride: 'claude-haiku-4-5' });
        expect(cap.body.model).toBe('claude-haiku-4-5');
        expect(result.fidelity?.routing).toBe('per-call');
        expect(result.fidelity?.requestedModel).toBe('claude-haiku-4-5');
    });

    it('Claude: stablePrefix is carried as a cacheable system block or joined, never dropped', async () => {
        const { cap } = await emit('claude', { stablePrefix: 'STABLE_PREFIX_MARK' });
        expect(JSON.stringify(cap.body)).toContain('STABLE_PREFIX_MARK');
    });

    it('OpenAI-shaped: maxTokens and modelOverride reach the body', async () => {
        const { cap } = await emit('groq', { maxTokens: 1234, modelOverride: 'llama-3.3-70b-versatile' });
        expect(cap.body.max_tokens ?? cap.body.max_completion_tokens).toBe(1234);
        expect(cap.body.model).toBe('llama-3.3-70b-versatile');
    });

    it('Gemini: modelOverride reaches the stream body', async () => {
        const { cap } = await emit('gemini', { modelOverride: 'gemini-2.5-flash' });
        expect(cap.body.model).toBe('gemini-2.5-flash');
    });

    it('Azure OpenAI: a modelOverride is reported dropped (deployment-routed)', async () => {
        const { result } = await emit('azure-openai', { modelOverride: 'gpt-4o' });
        expect(result.fidelity?.dropped).toContainEqual({ option: 'modelOverride', reason: 'deployment-routed' });
    });

    it('reports the model the stream carried separately from the one requested', async () => {
        const { result } = await emit('claude');
        expect(result.fidelity?.reportedModel).toBe('claude-reported');
        const o = await emit('groq');
        expect(o.result.fidelity?.reportedModel).toBe('reported-model');
    });
});

describe('research Deep thinking reaches the emitted stream body (D5, red-first proof)', () => {
    it('the checkbox -> buildResearchSynthesisOptions -> stream body has adaptive thinking; off sends none', async () => {
        const { buildResearchSynthesisOptions } = await import('../src/services/research/researchOrchestrator');
        const on = await emit('claude', buildResearchSynthesisOptions({ deepThinking: true }), 'claude-opus-4-7');
        expect(on.cap.body.thinking).toEqual({ type: 'adaptive' });
        expect(on.cap.body.max_tokens).toBeGreaterThan(8192);
        const off = await emit('claude', buildResearchSynthesisOptions({ deepThinking: false }), 'claude-opus-4-7');
        expect(off.cap.body.thinking).toBeUndefined();
    });

    it('a model without thinking support reports the request as dropped, not silently ignored', async () => {
        const r = await emit('claude', { enableThinking: true }, 'claude-haiku-4-5');
        expect(r.cap.body.thinking).toBeUndefined();
        expect(r.result.fidelity?.dropped.some(d => d.option === 'enableThinking')).toBe(true);
    });
});
