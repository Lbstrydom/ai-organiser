/**
 * CloudService Claude routing tests (presentation-depth-controls Cluster A, Phase 1).
 *
 * Covers the core LLM-service contract:
 *  - resolveModelOverride: latest-* resolution, unresolved-alias drop, concrete
 *    passthrough, empty/blank → '' (use service model);
 *  - buildClaudeSummarizeBody honours options.modelOverride (the core bug fix) on
 *    both `claude` and `azure-claude`, drops it for `azure-openai`;
 *  - enableThinking forces thinking on a standard-mode service; disableThinking WINS;
 *  - a no-override call is byte-identical to the pre-change body;
 *  - the Azure pacer key buckets under the OVERRIDE model (Gemini-R2 G1 ripple).
 */

import { describe, it, expect } from 'vitest';
import {
    CloudLLMService,
    computeAvailableModelIds,
    resolveModelOverride,
} from '../src/services/cloudService';
import { buildAzureClaudeDeploymentKey } from '../src/services/azure/azureRequestPacer';
import { AdapterType } from '../src/services/adapters';
import { SummarizeOptions } from '../src/services/types';
import { App } from 'obsidian';

const mockApp = {} as App;

function makeClaude(modelName: string, thinkingMode?: 'standard' | 'adaptive') {
    return new CloudLLMService({
        type: 'claude' as AdapterType,
        endpoint: 'https://api.anthropic.com/v1/messages',
        apiKey: 'test-key',
        modelName,
        language: 'en',
        thinkingMode,
    }, mockApp);
}

function makeAzureClaude(modelName: string, thinkingMode?: 'standard' | 'adaptive') {
    return new CloudLLMService({
        type: 'azure-claude' as AdapterType,
        endpoint: 'https://test.services.ai.azure.com/anthropic/v1/messages',
        apiKey: 'test-key',
        modelName,
        language: 'en',
        thinkingMode,
    }, mockApp);
}

function makeAzureOpenAI(modelName: string) {
    return new CloudLLMService({
        type: 'azure-openai' as AdapterType,
        endpoint: 'https://test.openai.azure.com/openai/deployments/gpt-5.5/chat/completions?api-version=2024-10-21',
        apiKey: 'test-key',
        modelName,
        language: 'en',
    }, mockApp);
}

const buildBody = (svc: CloudLLMService, prompt: string, opts?: SummarizeOptions): Record<string, unknown> =>
    (svc as unknown as { buildSummarizeRequestBody(p: string, o?: SummarizeOptions): Record<string, unknown> })
        .buildSummarizeRequestBody(prompt, opts);

// ── resolveModelOverride (pure) ──────────────────────────────────────────────

describe('resolveModelOverride', () => {
    it('returns "" for empty / blank / undefined override', () => {
        const ids = computeAvailableModelIds('claude');
        expect(resolveModelOverride('claude', undefined, ids)).toBe('');
        expect(resolveModelOverride('claude', '', ids)).toBe('');
        expect(resolveModelOverride('claude', '   ', ids)).toBe('');
    });

    it('passes a concrete id through unchanged (even when absent from availableIds)', () => {
        expect(resolveModelOverride('claude', 'claude-opus-4-6', [])).toBe('claude-opus-4-6');
        expect(resolveModelOverride('claude', 'claude-opus-4-6', ['claude-sonnet-4-6'])).toBe('claude-opus-4-6');
    });

    it('resolves latest-opus → newest concrete opus on direct claude', () => {
        const resolved = resolveModelOverride('claude', 'latest-opus', ['claude-opus-4-6', 'claude-opus-4-7', 'claude-sonnet-4-6']);
        expect(resolved).toBe('claude-opus-4-7');
        expect(resolved.startsWith('latest-')).toBe(false);
    });

    it('resolves latest-opus against the live/static pool computed for claude', () => {
        const ids = computeAvailableModelIds('claude');
        const resolved = resolveModelOverride('claude', 'latest-opus', ids);
        expect(resolved).toMatch(/^claude-opus/);
        expect(resolved.startsWith('latest-')).toBe(false);
    });

    it('drops an unresolvable sentinel → "" (never sends a literal latest-*)', () => {
        // azure-claude has no resolver case → latest-* cannot resolve → dropped.
        expect(resolveModelOverride('azure-claude', 'latest-opus', ['claude-opus-4-7'])).toBe('');
        // genuinely-unknown tier on direct claude → dropped.
        expect(resolveModelOverride('claude', 'latest-unicorn', ['claude-opus-4-7'])).toBe('');
    });

    it('passes a concrete azure-claude opus id through unchanged', () => {
        expect(resolveModelOverride('azure-claude', 'claude-opus-4-7', ['claude-opus-4-7'])).toBe('claude-opus-4-7');
    });
});

// ── computeAvailableModelIds ─────────────────────────────────────────────────

describe('computeAvailableModelIds', () => {
    it('returns a non-empty static pool for claude with latest-* stripped', () => {
        const ids = computeAvailableModelIds('claude');
        expect(ids.length).toBeGreaterThan(0);
        expect(ids.some(id => id.startsWith('latest-'))).toBe(false);
    });
});

// ── buildClaudeSummarizeBody: modelOverride (the core bug fix) ────────────────

describe('buildClaudeSummarizeBody — modelOverride', () => {
    it('honours a concrete modelOverride on direct claude (previously ignored)', () => {
        const svc = makeClaude('claude-sonnet-4-6', 'standard');
        const body = buildBody(svc, 'hi', { modelOverride: 'claude-opus-4-6' });
        expect(body.model).toBe('claude-opus-4-6');
    });

    it('resolves a latest-* modelOverride to a concrete id on direct claude', () => {
        const svc = makeClaude('claude-sonnet-4-6', 'standard');
        const body = buildBody(svc, 'hi', { modelOverride: 'latest-opus' });
        expect(typeof body.model).toBe('string');
        expect(body.model as string).toMatch(/^claude-opus/);
        expect((body.model as string).startsWith('latest-')).toBe(false);
    });

    it('honours a concrete modelOverride on azure-claude (model-in-body, not deployment-routed)', () => {
        const svc = makeAzureClaude('claude-sonnet-4-6', 'standard');
        const body = buildBody(svc, 'hi', { modelOverride: 'claude-opus-4-7' });
        expect(body.model).toBe('claude-opus-4-7');
    });

    it('falls back to the service model when the override is an unresolvable sentinel', () => {
        const svc = makeAzureClaude('claude-sonnet-4-6', 'standard');
        const body = buildBody(svc, 'hi', { modelOverride: 'latest-opus' });
        expect(body.model).toBe('claude-sonnet-4-6');
    });

    it('no modelOverride → body.model is the service model (byte-identical baseline)', () => {
        const svc = makeClaude('claude-sonnet-4-6', 'standard');
        const baseline = buildBody(svc, 'hi');
        const withEmpty = buildBody(svc, 'hi', {});
        expect(baseline.model).toBe('claude-sonnet-4-6');
        expect(withEmpty).toEqual(baseline);
    });
});

// ── azure-openai still drops modelOverride (blockOverride) ────────────────────

describe('buildSummarizeRequestBody — azure-openai blockOverride', () => {
    it('drops modelOverride on azure-openai (deployment-routed URL ignores body.model)', () => {
        const svc = makeAzureOpenAI('gpt-5.5');
        const body = buildBody(svc, 'hi', { modelOverride: 'gpt-5.4-nano' });
        // The override is dropped → falls back to the configured service model.
        expect(body.model).toBe('gpt-5.5');
    });

    it('honours a concrete modelOverride on a non-azure OpenAI-compat provider', () => {
        const svc = new CloudLLMService({
            type: 'openai' as AdapterType,
            endpoint: 'https://api.openai.com/v1/chat/completions',
            apiKey: 'test-key', modelName: 'gpt-4o', language: 'en',
        }, mockApp);
        const body = buildBody(svc, 'hi', { modelOverride: 'gpt-4o-mini' });
        expect(body.model).toBe('gpt-4o-mini');
    });
});

// ── enableThinking / disableThinking contract (D1) ───────────────────────────

describe('buildClaudeSummarizeBody — thinking contract', () => {
    it('enableThinking forces thinking ON for a standard-mode adaptive-capable model', () => {
        const svc = makeClaude('claude-sonnet-4-6', 'standard');
        const baseline = buildBody(svc, 'hi');
        expect(baseline.thinking).toBeUndefined(); // default off

        const forced = buildBody(svc, 'hi', { enableThinking: true });
        expect(forced.thinking).toEqual({ type: 'adaptive' });
        expect(forced.max_tokens).toBe(64000); // thinking budget default
    });

    it('disableThinking WINS over enableThinking', () => {
        const svc = makeClaude('claude-sonnet-4-6', 'adaptive');
        const body = buildBody(svc, 'hi', { enableThinking: true, disableThinking: true, maxTokens: 4096 });
        expect(body.thinking).toBeUndefined();
        expect(body.max_tokens).toBe(4096);
    });

    it('enableThinking is a no-op on a non-adaptive-capable model (Haiku)', () => {
        const svc = makeClaude('claude-haiku-4-5', 'standard');
        const body = buildBody(svc, 'hi', { enableThinking: true });
        expect(body.thinking).toBeUndefined();
    });

    it('enableThinking re-enables thinking when a modelOverride upgrades to a capable model', () => {
        // Service model is Haiku (no thinking); override to Opus + enableThinking → thinking on.
        const svc = makeClaude('claude-haiku-4-5', 'standard');
        const body = buildBody(svc, 'hi', { enableThinking: true, modelOverride: 'claude-opus-4-6' });
        expect(body.model).toBe('claude-opus-4-6');
        expect(body.thinking).toEqual({ type: 'adaptive' });
    });

    it('a Haiku modelOverride disables thinking even when the service default is adaptive', () => {
        const svc = makeClaude('claude-opus-4-6', 'adaptive');
        const body = buildBody(svc, 'hi', { modelOverride: 'claude-haiku-4-5' });
        expect(body.model).toBe('claude-haiku-4-5');
        expect(body.thinking).toBeUndefined();
    });
});

// ── Azure pacer-key ripple (Gemini-R2 G1) ────────────────────────────────────

describe('azure pacer key reflects the per-call modelOverride', () => {
    it('buckets a Sonnet→Opus override under the OVERRIDE deployment, not the service model', () => {
        const svc = makeAzureClaude('claude-sonnet-4-6', 'standard');
        const endpoint = (svc as unknown as { adapter: { getEndpoint(): string } }).adapter.getEndpoint();
        const pacerKey = (m?: string): string =>
            (svc as unknown as { azurePacerKey(m?: string): string }).azurePacerKey(m);

        // The body the summarize path builds carries the override model…
        const body = buildBody(svc, 'hi', { modelOverride: 'claude-opus-4-7' });
        expect(body.model).toBe('claude-opus-4-7');

        // …and sendSummarizeRequest passes that body.model to azurePacerKey.
        const overrideKey = pacerKey(body.model as string);
        const serviceKey = pacerKey();
        expect(overrideKey).toBe(buildAzureClaudeDeploymentKey(endpoint, 'claude-opus-4-7'));
        expect(overrideKey).not.toBe(serviceKey);
        expect(serviceKey).toBe(buildAzureClaudeDeploymentKey(endpoint, 'claude-sonnet-4-6'));
    });

    it('summarizeText threads the resolved override model into the pacer (integration)', async () => {
        const svc = makeAzureClaude('claude-sonnet-4-6', 'standard');
        let capturedPacerModel: string | undefined;
        // Stub the paced request to capture the 4th arg (pacerModel) and return a valid Claude body.
        const stub = async (...a: unknown[]) => {
            capturedPacerModel = a[3] as string | undefined;
            return {
                status: 200,
                text: JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
                headers: {},
            };
        };
        (svc as unknown as { pacedRequestUrl: unknown }).pacedRequestUrl = stub;

        const res = await svc.summarizeText('hi', { modelOverride: 'claude-opus-4-7' });
        expect(res.success).toBe(true);
        expect(capturedPacerModel).toBe('claude-opus-4-7');
    });
});

// ── Opus 5.5: thinking cannot be turned off, so a no-thinking request goes low-effort ──
describe('Opus 5.5 always-thinking request shape', () => {
    it('standard-mode summarize on Opus 5.5 sends low effort and no disabled-thinking field', () => {
        const svc = makeClaude('claude-opus-5-5', 'standard');
        const body = buildBody(svc, 'hi');
        expect(body.output_config).toEqual({ effort: 'low' });
        expect(body).not.toHaveProperty('thinking');
        expect(body.max_tokens).toBe(8192);
    });

    it('disableThinking on Opus 5.5 degrades to low effort (a disabled field would 400)', () => {
        const svc = makeClaude('claude-opus-5-5', 'adaptive');
        const body = buildBody(svc, 'hi', { disableThinking: true });
        expect(body).not.toHaveProperty('thinking');
        expect(body.output_config).toEqual({ effort: 'low' });
    });

    it('adaptive mode on Opus 5.5 keeps adaptive thinking and adds no effort override', () => {
        const svc = makeClaude('claude-opus-5-5', 'adaptive');
        const body = buildBody(svc, 'hi');
        expect(body.thinking).toEqual({ type: 'adaptive' });
        expect(body).not.toHaveProperty('output_config');
    });

    it('Opus 4.7 standard-mode request is unchanged (no effort field)', () => {
        const body = buildBody(makeClaude('claude-opus-4-7', 'standard'), 'hi');
        expect(body).not.toHaveProperty('output_config');
        expect(body).not.toHaveProperty('thinking');
    });

    it('the bare 1024-token request is raised to 4096 with low effort on Opus 5.5, both adapters', () => {
        for (const svc of [makeClaude('claude-opus-5-5', 'standard'), makeAzureClaude('claude-opus-5-5', 'standard')]) {
            const req = (svc as unknown as { adapter: { formatRequest(p: string): Record<string, unknown> } }).adapter.formatRequest('hi');
            expect(req.max_tokens).toBe(4096);
            expect(req.output_config).toEqual({ effort: 'low' });
        }
        const old = (makeClaude('claude-opus-4-7', 'standard') as unknown as { adapter: { formatRequest(p: string): Record<string, unknown> } }).adapter.formatRequest('hi');
        expect(old.max_tokens).toBe(1024);
        expect(old).not.toHaveProperty('output_config');
    });

    it('latest-opus resolves to Opus 5.5 against the static claude pool', () => {
        expect(resolveModelOverride('claude', 'latest-opus', computeAvailableModelIds('claude'))).toBe('claude-opus-5-5');
    });
});

// ── fidelity report (llm-option-fidelity D1) ─────────────────────────────────

function stubOk(svc: CloudLLMService, body: Record<string, unknown>) {
    (svc as unknown as { pacedRequestUrl: unknown }).pacedRequestUrl = async () => ({
        status: 200, text: JSON.stringify(body), headers: {},
    });
}
const claudeOk = (extra: Record<string, unknown> = {}) => ({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', ...extra });

describe('summarizeText — fidelity', () => {
    it('claude override: per-call, requested vs reported model kept apart', async () => {
        const svc = makeClaude('claude-sonnet-4-6', 'standard');
        stubOk(svc, claudeOk({ model: 'claude-opus-4-6-20260101' }));
        const r = await svc.summarizeText('hi', { modelOverride: 'claude-opus-4-6' });
        expect(r.fidelity).toEqual({
            requestedModel: 'claude-opus-4-6',
            reportedModel: 'claude-opus-4-6-20260101',
            routing: 'per-call',
            provider: 'claude',
            dropped: [],
            adjusted: [],
        });
    });

    it('no override: service-config routing, no reportedModel when the body has none', async () => {
        const svc = makeClaude('claude-sonnet-4-6', 'standard');
        stubOk(svc, claudeOk());
        const r = await svc.summarizeText('hi');
        expect(r.success).toBe(true);
        expect(r.content).toBe('ok');
        expect(r.fidelity?.routing).toBe('service-config');
        expect(r.fidelity?.requestedModel).toBe('claude-sonnet-4-6');
        expect(r.fidelity).not.toHaveProperty('reportedModel');
    });

    it('azure-openai: the override drop is reported as deployment-routed', async () => {
        const svc = makeAzureOpenAI('gpt-5.5');
        stubOk(svc, { model: 'gpt-5.5-2026', choices: [{ message: { content: 'ok' } }] });
        const r = await svc.summarizeText('hi', { modelOverride: 'gpt-5.4-nano' });
        expect(r.fidelity?.dropped).toContainEqual({ option: 'modelOverride', reason: 'deployment-routed' });
        expect(r.fidelity?.routing).toBe('deployment');
        expect(r.fidelity?.requestedModel).toBe('gpt-5.5');
    });

    it('unresolved sentinel on azure-claude is reported, service model used', async () => {
        const svc = makeAzureClaude('claude-sonnet-4-6', 'standard');
        stubOk(svc, claudeOk());
        const r = await svc.summarizeText('hi', { modelOverride: 'latest-opus' });
        expect(r.fidelity?.dropped).toContainEqual({ option: 'modelOverride', reason: 'unresolved-sentinel' });
        expect(r.fidelity?.requestedModel).toBe('claude-sonnet-4-6');
    });

    it('a resolved sentinel is an adjustment', async () => {
        const svc = makeClaude('claude-sonnet-4-6', 'standard');
        stubOk(svc, claudeOk());
        const r = await svc.summarizeText('hi', { modelOverride: 'latest-opus' });
        const adj = r.fidelity?.adjusted.find(a => a.option === 'modelOverride');
        expect(adj).toMatchObject({ requested: 'latest-opus', reason: 'sentinel-resolved' });
        expect(r.fidelity?.requestedModel).toBe(adj?.effective);
    });

    it('enableThinking overruled by disableThinking is an adjustment, not a drop', async () => {
        const svc = makeClaude('claude-sonnet-4-6', 'adaptive');
        stubOk(svc, claudeOk());
        const r = await svc.summarizeText('hi', { enableThinking: true, disableThinking: true });
        expect(r.fidelity?.adjusted).toContainEqual({
            option: 'enableThinking', requested: true, effective: false, reason: 'overruled-by-disable-thinking',
        });
        expect(r.fidelity?.dropped.find(d => d.option === 'enableThinking')).toBeUndefined();
    });

    it('enableThinking on a model without adaptive thinking is dropped for no-model-capability', async () => {
        const svc = makeClaude('claude-haiku-4-5', 'standard');
        stubOk(svc, claudeOk());
        const r = await svc.summarizeText('hi', { enableThinking: true });
        expect(r.fidelity?.dropped).toContainEqual({ option: 'enableThinking', reason: 'no-model-capability' });
    });

    it('a clamp and an app-minimum raise are both reported', async () => {
        const clamp = makeClaude('claude-sonnet-4-6', 'standard');
        stubOk(clamp, claudeOk());
        const c = await clamp.summarizeText('hi', { maxTokens: 1_000_000 });
        const adj = c.fidelity?.adjusted.find(a => a.option === 'maxTokens');
        expect(adj).toMatchObject({ requested: 1_000_000, reason: 'clamped-to-model-limit' });
        expect(adj?.effective as number).toBeLessThan(1_000_000);

        const floor = makeClaude('claude-opus-5-5', 'standard');
        stubOk(floor, claudeOk());
        const f = await floor.summarizeText('hi', { maxTokens: 1024 });
        expect(f.fidelity?.adjusted).toContainEqual({
            option: 'maxTokens', requested: 1024, effective: 4096, reason: 'raised-to-app-minimum',
        });
    });

    it('a failed call returns the error and no fidelity', async () => {
        const svc = makeClaude('claude-sonnet-4-6', 'standard');
        (svc as unknown as { pacedRequestUrl: unknown }).pacedRequestUrl = async () => ({ status: 400, text: '{"error":{"message":"bad"}}', headers: {} });
        const r = await svc.summarizeText('hi');
        expect(r.success).toBe(false);
        expect(r.error).toBe('bad');
        expect(r).not.toHaveProperty('fidelity');
    });

    it('byte-identical: the request body with no override keeps its shape', () => {
        const svc = makeClaude('claude-sonnet-4-6', 'standard');
        expect(buildBody(svc, 'hi')).toEqual({
            model: 'claude-sonnet-4-6',
            max_tokens: 8192,
            system: expect.anything(),
            messages: [{ role: 'user', content: expect.anything() }],
        });
    });
});
