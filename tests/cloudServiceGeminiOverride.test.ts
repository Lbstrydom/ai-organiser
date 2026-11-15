/**
 * Gemini summarize honours modelOverride and clamps the output cap
 * (llm-option-fidelity D4), and every summarize result reports `fidelity` (D1).
 */
import { describe, it, expect } from 'vitest';
import { CloudLLMService } from '../src/services/cloudService';
import { AdapterType } from '../src/services/adapters';
import { SummarizeOptions } from '../src/services/types';
import { getModelOutputLimit } from '../src/services/tokenLimits';
import { App } from 'obsidian';

const mockApp = {} as App;

function makeGemini(modelName = 'gemini-2.5-pro') {
    return new CloudLLMService({
        type: 'gemini' as AdapterType,
        endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        apiKey: 'k',
        modelName,
        language: 'en',
    }, mockApp);
}

const buildBody = (svc: CloudLLMService, opts?: SummarizeOptions): Record<string, unknown> =>
    (svc as unknown as { buildSummarizeRequestBody(p: string, o?: SummarizeOptions): Record<string, unknown> })
        .buildSummarizeRequestBody('hi', opts);

function stubResponse(svc: CloudLLMService, body: Record<string, unknown>) {
    (svc as unknown as { pacedRequestUrl: unknown }).pacedRequestUrl = async () => ({
        status: 200, text: JSON.stringify(body), headers: {},
    });
}

describe('Gemini summarize — modelOverride', () => {
    it('sends the override model instead of the service model', () => {
        const body = buildBody(makeGemini('gemini-2.5-pro'), { modelOverride: 'gemini-2.5-flash' });
        expect(body.model).toBe('gemini-2.5-flash');
    });

    it('resolves a latest-* override to a concrete id', () => {
        const body = buildBody(makeGemini(), { modelOverride: 'latest-flash' });
        expect(typeof body.model).toBe('string');
        expect((body.model as string).startsWith('latest-')).toBe(false);
        expect(body.model).not.toBe('gemini-2.5-pro');
    });

    it('an unresolvable sentinel falls back to the service model', () => {
        const body = buildBody(makeGemini('gemini-2.5-pro'), { modelOverride: 'latest-unicorn' });
        expect(body.model).toBe('gemini-2.5-pro');
    });

    it('clamps max_tokens to the resolved model output limit', () => {
        const limit = getModelOutputLimit('gemini', 'gemini-2.5-flash');
        const body = buildBody(makeGemini(), { modelOverride: 'gemini-2.5-flash', maxTokens: limit + 50_000 });
        expect(body.max_tokens).toBe(limit);
    });

    it('no options: body is byte-identical to the pre-change shape', () => {
        const body = buildBody(makeGemini('gemini-2.5-pro'));
        expect(body).toEqual({
            model: 'gemini-2.5-pro',
            messages: [
                { role: 'system', content: 'Complete the task in the user message and follow its output format exactly.' },
                { role: 'user', content: 'hi' },
            ],
            max_tokens: 8192,
        });
    });

    it('an explicit maxTokens below the limit is sent unchanged', () => {
        expect(buildBody(makeGemini(), { maxTokens: 1234 }).max_tokens).toBe(1234);
    });
});

describe('Gemini summarize — fidelity', () => {
    it('reports the override as per-call and reads reportedModel from the response', async () => {
        const svc = makeGemini('gemini-2.5-pro');
        stubResponse(svc, { model: 'gemini-2.5-flash-001', choices: [{ message: { content: 'ok' } }] });
        const r = await svc.summarizeText('hi', { modelOverride: 'gemini-2.5-flash' });
        expect(r.success).toBe(true);
        expect(r.fidelity).toMatchObject({
            requestedModel: 'gemini-2.5-flash',
            reportedModel: 'gemini-2.5-flash-001',
            routing: 'per-call',
            provider: 'gemini',
            dropped: [],
        });
    });

    it('omits reportedModel when the body has no top-level string model', async () => {
        const svc = makeGemini('gemini-2.5-pro');
        stubResponse(svc, { model: 7, choices: [{ message: { content: 'ok' } }] });
        const r = await svc.summarizeText('hi');
        expect(r.fidelity?.reportedModel).toBeUndefined();
        expect(r.fidelity?.routing).toBe('service-config');
        expect(r.fidelity?.requestedModel).toBe('gemini-2.5-pro');
    });

    it('records a clamped maxTokens as adjusted and enableThinking as dropped', async () => {
        const svc = makeGemini();
        stubResponse(svc, { choices: [{ message: { content: 'ok' } }] });
        const limit = getModelOutputLimit('gemini', 'gemini-2.5-pro');
        const r = await svc.summarizeText('hi', { maxTokens: limit + 1000, enableThinking: true });
        expect(r.fidelity?.adjusted).toContainEqual({
            option: 'maxTokens', requested: limit + 1000, effective: limit, reason: 'clamped-to-model-limit',
        });
        expect(r.fidelity?.dropped).toContainEqual({ option: 'enableThinking', reason: 'unsupported-by-provider' });
    });

    it('an unresolved sentinel is reported as dropped', async () => {
        const svc = makeGemini('gemini-2.5-pro');
        stubResponse(svc, { choices: [{ message: { content: 'ok' } }] });
        const r = await svc.summarizeText('hi', { modelOverride: 'latest-unicorn' });
        expect(r.fidelity?.dropped).toContainEqual({ option: 'modelOverride', reason: 'unresolved-sentinel' });
        expect(r.fidelity?.routing).toBe('service-config');
    });
});
