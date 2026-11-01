/**
 * Claude rejects `temperature` / `top_p` / `top_k` (non-default values 400 on Opus 4.7+
 * and every 5.x model; any value on API version 2026-10-21), and 5.x models think when
 * `thinking` is omitted. These tests assert the EMITTED request bodies, not client config.
 */
import { describe, it, expect } from 'vitest';
import { App } from 'obsidian';
import { ClaudeAdapter } from '../src/services/adapters/claudeAdapter';
import { RequestyAdapter } from '../src/services/adapters/requestyAdapter';
import { OpenRouterAdapter } from '../src/services/adapters/openRouterAdapter';
import { CloudLLMService } from '../src/services/cloudService';
import { LocalLLMService } from '../src/services/localService';
import { AdapterType } from '../src/services/adapters';
import { isClaudeModelId } from '../src/services/adapters/modelCapabilities';

const mockApp = {} as App;
const SAMPLING = ['temperature', 'top_p', 'top_k', 'topP', 'topK'];
const noSampling = (body: Record<string, unknown>): void => {
    for (const k of SAMPLING) expect(body, k).not.toHaveProperty(k);
};

function cloud(type: AdapterType, modelName: string): CloudLLMService {
    return new CloudLLMService({ type, endpoint: 'https://example.test/v1', apiKey: 'k', modelName, language: 'en' }, mockApp);
}

describe('isClaudeModelId', () => {
    it('matches every provider spelling of a Claude id and nothing else', () => {
        for (const id of ['claude-sonnet-5-5', 'anthropic/claude-sonnet-4.6', 'anthropic.claude-sonnet-4-6', 'my-claude-proxy']) expect(isClaudeModelId(id), id).toBe(true);
        for (const id of ['gpt-5.2', 'openai/gpt-4o', 'gemini-3-pro', '', undefined]) expect(isClaudeModelId(id), String(id)).toBe(false);
    });
});

describe('direct Claude bodies', () => {
    it('a 5.x tag / multimodal request carries no sampling field, low effort and a 4096 floor', () => {
        const adapter = new ClaudeAdapter({ endpoint: '', apiKey: 'k', modelName: 'claude-sonnet-5-5' });
        const tag = adapter.formatRequest('p');
        noSampling(tag);
        expect(tag.output_config).toEqual({ effort: 'low' });
        expect(tag.max_tokens).toBe(4096);
        expect(tag).not.toHaveProperty('thinking');
        const mm = adapter.formatMultimodalRequest([{ type: 'text', text: 'x' }]);
        noSampling(mm);
        expect(mm.output_config).toEqual({ effort: 'low' });
    });

    it('a 4.x request is unchanged: no effort, no floor', () => {
        const tag = new ClaudeAdapter({ endpoint: '', apiKey: 'k', modelName: 'claude-sonnet-4-6' }).formatRequest('p');
        noSampling(tag);
        expect(tag).not.toHaveProperty('output_config');
        expect(tag.max_tokens).toBe(1024);
    });

    it('the Claude summarize body never carries sampling fields', () => {
        const body = (cloud('claude', 'claude-sonnet-5-5') as unknown as { buildSummarizeRequestBody(p: string, o?: unknown): Record<string, unknown> })
            .buildSummarizeRequestBody('p', { disableThinking: true });
        noSampling(body);
        expect(body.output_config).toEqual({ effort: 'low' });
    });
});

describe('OpenAI-shaped bodies drop temperature only for a Claude model', () => {
    const summarize = (type: AdapterType, model: string): Record<string, unknown> =>
        (cloud(type, model) as unknown as { buildSummarizeRequestBody(p: string): Record<string, unknown> }).buildSummarizeRequestBody('p');

    it('summarize via OpenRouter', () => {
        noSampling(summarize('openrouter', 'anthropic/claude-sonnet-4.6'));
        expect(summarize('openrouter', 'meta-llama/llama-4-scout').temperature).toBe(0.3);
    });

    it('Requesty tag request', () => {
        const claude = new RequestyAdapter({ endpoint: '', apiKey: 'k', modelName: 'anthropic/claude-sonnet-4-6' }).formatRequest('p');
        noSampling(claude);
        expect(claude.max_tokens).toBe(1024);
        expect(new RequestyAdapter({ endpoint: '', apiKey: 'k', modelName: 'gpt-5.2' }).formatRequest('p').temperature).toBe(0.7);
    });

    it('OpenRouter tag request', () => {
        noSampling(new OpenRouterAdapter({ endpoint: '', apiKey: 'k', modelName: 'anthropic/claude-sonnet-4.6' }).formatRequest('p'));
    });

    it('local endpoint proxying Claude', () => {
        const fields = (m: string): Record<string, unknown> =>
            (new LocalLLMService({ type: 'local', endpoint: 'http://localhost:1234', modelName: m, language: 'en' } as never, mockApp) as unknown as { samplingFields(): Record<string, unknown> }).samplingFields();
        expect(fields('claude-sonnet-5-5')).toEqual({});
        expect(fields('llama3')).toEqual({ temperature: 0.3 });
    });
});
