/**
 * Bedrock adapter: the request bodies it EMITS. InvokeModel on bedrock-runtime
 * with the Anthropic Messages shape — `anthropic_version: bedrock-2023-05-31`,
 * model in the URL (never the body), no sampling fields, no prefill, adaptive
 * thinking only where the first-party Claude paths use it.
 */

import { describe, it, expect } from 'vitest';
import { BedrockAdapter, BEDROCK_ANTHROPIC_VERSION } from '../src/services/adapters/bedrockAdapter';
import { createAdapter } from '../src/services/adapters';
import { bedrockToClaudeModelId } from '../src/services/adapters/modelCapabilities';
import type { AdapterConfig } from '../src/services/adapters/types';

const SAMPLING = ['temperature', 'top_p', 'top_k'] as const;

function make(overrides: Partial<AdapterConfig> = {}): BedrockAdapter {
    return new BedrockAdapter({
        endpoint: 'https://bedrock-runtime.eu-west-1.amazonaws.com',
        apiKey: 'bedrock-key-not-real',
        modelName: 'global.anthropic.claude-sonnet-4-6',
        ...overrides,
    });
}

/** Round-trip through JSON so the assertion is on exactly what goes on the wire. */
function wire(body: Record<string, unknown>): Record<string, unknown> {
    return JSON.parse(JSON.stringify(body));
}

function expectMessagesShape(body: Record<string, unknown>): void {
    expect(body.anthropic_version).toBe(BEDROCK_ANTHROPIC_VERSION);
    expect(BEDROCK_ANTHROPIC_VERSION).toBe('bedrock-2023-05-31');
    expect(body).not.toHaveProperty('model');
    expect(body).not.toHaveProperty('prompt');
    expect(typeof body.max_tokens).toBe('number');
    for (const k of SAMPLING) expect(body, k).not.toHaveProperty(k);
    const messages = body.messages as Array<{ role: string }>;
    expect(Array.isArray(messages)).toBe(true);
    expect(messages.length).toBe(1);
    // No prefill: the conversation ends on the user turn.
    expect(messages[messages.length - 1].role).toBe('user');
    expect(body).not.toHaveProperty('thinking.budget_tokens');
}

describe('BedrockAdapter — emitted request bodies', () => {
    it('tag request: Messages shape, system separate, no sampling, no model in body', () => {
        const body = wire(make().formatRequest('tag this note'));
        expectMessagesShape(body);
        expect(typeof body.system).toBe('string');
        expect(body.messages).toEqual([{ role: 'user', content: 'tag this note' }]);
        expect(body.max_tokens).toBe(1024);
        expect(body).not.toHaveProperty('thinking');
        expect(body).not.toHaveProperty('output_config');
    });

    it('summarize request: neutral system prompt, caller budget, no sampling', () => {
        const body = wire(make().formatSummarizeRequest('summarise', { maxTokens: 2000 }));
        expectMessagesShape(body);
        expect(body.system).toBe('Complete the task in the user message and follow its output format exactly.');
        expect(body.max_tokens).toBe(2000);
        expect(body.messages).toEqual([{ role: 'user', content: 'summarise' }]);
    });

    it('multimodal request: base64 image and document blocks in the user turn', () => {
        const body = wire(make().formatMultimodalRequest([
            { type: 'image', data: 'IMG', mediaType: 'image/png' },
            { type: 'document', data: 'DOC', mediaType: 'application/pdf' },
            { type: 'text', text: 'describe' },
        ]));
        expectMessagesShape(body);
        expect(body.messages).toEqual([{
            role: 'user',
            content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'IMG' } },
                { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'DOC' } },
                { type: 'text', text: 'describe' },
            ],
        }]);
    });

    it('adaptive mode on Sonnet 4.6: thinking adaptive and a 64K budget, never budget_tokens', () => {
        const adapter = make({ thinkingMode: 'adaptive' });
        for (const body of [adapter.formatRequest('x'), adapter.formatSummarizeRequest('x')].map(wire)) {
            expectMessagesShape(body);
            expect(body.thinking).toEqual({ type: 'adaptive' });
            expect(body.max_tokens).toBe(64000);
        }
    });

    it('every path clamps the budget to the model output ceiling; a caller budget is kept under thinking', () => {
        const adapter = make({ thinkingMode: 'adaptive' });
        expect(wire(adapter.formatMultimodalRequest([{ type: 'text', text: 'x' }], { maxTokens: 500_000 })).max_tokens).toBe(64000);
        expect(wire(make().formatSummarizeRequest('x', { maxTokens: 500_000 })).max_tokens).toBe(64000);
        const withBudget = wire(adapter.formatSummarizeRequest('x', { maxTokens: 12000 }));
        expect(withBudget.thinking).toEqual({ type: 'adaptive' });
        expect(withBudget.max_tokens).toBe(12000);
    });

    it('disableThinking wins over adaptive mode on the summarize path', () => {
        const body = wire(make({ thinkingMode: 'adaptive' }).formatSummarizeRequest('x', { disableThinking: true }));
        expect(body).not.toHaveProperty('thinking');
        expect(body.max_tokens).toBe(8192);
    });

    it('Haiku 4.5 in adaptive mode gets no thinking field (no adaptive support)', () => {
        const body = wire(make({ modelName: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', thinkingMode: 'adaptive' }).formatRequest('x'));
        expectMessagesShape(body);
        expect(body).not.toHaveProperty('thinking');
        expect(body).not.toHaveProperty('output_config');
    });

    it('a 5.x model in standard mode gets low effort and a 4096 floor, never thinking: disabled', () => {
        const body = wire(make({ modelName: 'anthropic.claude-opus-5-5' }).formatRequest('x'));
        expectMessagesShape(body);
        expect(body.output_config).toEqual({ effort: 'low' });
        expect(body.max_tokens).toBe(4096);
        expect(body).not.toHaveProperty('thinking');
    });

    it('a large stable prefix on a documented model becomes an explicit cache breakpoint', () => {
        const prefix = 'stable instructions '.repeat(1000);
        const body = wire(make().formatCachedRequest('per-note text', prefix));
        expectMessagesShape(body);
        expect(body.system).toEqual([
            { type: 'text', text: expect.any(String) },
            { type: 'text', text: prefix, cache_control: { type: 'ephemeral' } },
        ]);
        expect(body).not.toHaveProperty('cache_control');
    });
});

describe('BedrockAdapter — endpoint, headers, config', () => {
    it('InvokeModel URL carries the encoded model id', () => {
        expect(make().getEndpoint())
            .toBe('https://bedrock-runtime.eu-west-1.amazonaws.com/model/global.anthropic.claude-sonnet-4-6/invoke');
        expect(make({ modelName: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', endpoint: 'https://bedrock-runtime.us-east-1.amazonaws.com/' }).getEndpoint())
            .toBe('https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-haiku-4-5-20251001-v1%3A0/invoke');
    });

    it('the region-less legacy default is replaced by a regional host, whitespace and slashes ignored', () => {
        for (const endpoint of ['https://bedrock-runtime.amazonaws.com', ' https://bedrock-runtime.amazonaws.com/ ']) {
            expect(make({ endpoint }).getEndpoint())
                .toMatch(/^https:\/\/bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com\/model\/global\.anthropic\.claude-sonnet-4-6\/invoke$/);
        }
    });

    it('a pasted full InvokeModel URL is cut to its host, so the configured model is the one invoked', () => {
        const adapter = make({
            endpoint: 'https://bedrock-runtime.eu-west-1.amazonaws.com/model/anthropic.claude-haiku-4-5/invoke',
            modelName: 'anthropic.claude-opus-5-5',
        });
        expect(adapter.getEndpoint())
            .toBe('https://bedrock-runtime.eu-west-1.amazonaws.com/model/anthropic.claude-opus-5-5/invoke');
        // Capability checks follow the same id: Opus 5.5 thinks by default → low effort.
        expect(wire(adapter.formatRequest('x')).output_config).toEqual({ effort: 'low' });
        // …and the conflict is not silent: the URL names a different model.
        expect(adapter.validateConfig()).toMatch(/endpoint names model anthropic\.claude-haiku-4-5/);
    });

    it('a pasted full URL naming the configured model (encoded or not) is accepted', () => {
        for (const endpoint of [
            'https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-haiku-4-5-20251001-v1%3A0/invoke',
            'https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-haiku-4-5-20251001-v1:0/invoke/',
        ]) {
            const adapter = make({ endpoint, modelName: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' });
            expect(adapter.validateConfig()).toBeNull();
            expect(adapter.getEndpoint())
                .toBe('https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-haiku-4-5-20251001-v1%3A0/invoke');
        }
    });

    it('a dated 4.0 id is not mistaken for a 4.x model with adaptive thinking', () => {
        const body = wire(make({ modelName: 'us.anthropic.claude-sonnet-4-20250514-v1:0', thinkingMode: 'adaptive' }).formatRequest('x'));
        expect(body).not.toHaveProperty('thinking');
        expect(body.max_tokens).toBe(1024);
    });

    it('the factory default builds a working URL and a Claude model', () => {
        const adapter = createAdapter('bedrock', { endpoint: '', apiKey: 'k', modelName: '' });
        expect(adapter.getEndpoint()).toMatch(/^https:\/\/bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com\/model\/[^/]+\/invoke$/);
        expect(adapter.validateConfig()).toBeNull();
    });

    it('authenticates with the Bedrock API key as a bearer token, no anthropic-version header', () => {
        const headers = make().getHeaders();
        expect(headers.Authorization).toBe('Bearer bedrock-key-not-real');
        expect(headers['Content-Type']).toBe('application/json');
        expect(headers).not.toHaveProperty('anthropic-version');
    });

    it('rejects a non-Claude model with a clear message', () => {
        expect(make({ modelName: 'amazon.titan-text-express-v1' }).validateConfig()).toMatch(/Claude/);
        expect(make({ modelName: 'not-a-claude-model' }).validateConfig()).toMatch(/Claude/);
        expect(make({ apiKey: '' }).validateConfig()).toMatch(/API key/);
    });
});

describe('BedrockAdapter — responses', () => {
    const response = {
        content: [
            { type: 'thinking', thinking: '' },
            { type: 'text', text: '{"matchedTags":["a"],"newTags":["b"]}' },
        ],
        stop_reason: 'end_turn',
    };

    it('parseResponseContent skips thinking blocks', () => {
        expect(make().parseResponseContent(response)).toBe('{"matchedTags":["a"],"newTags":["b"]}');
    });

    it('parseResponse extracts the tag arrays', () => {
        const parsed = make().parseResponse(response);
        expect(parsed.matchedExistingTags).toEqual(['a']);
        expect(parsed.suggestedTags).toEqual(['b']);
    });

    it('parseResponse degrades a partial tag payload and never stringifies non-strings into tags', () => {
        const res = (json: string) => ({ content: [{ type: 'text', text: json }] });
        const partial = make().parseResponse(res('{"matchedTags":["a"]}'));
        expect(partial.matchedExistingTags).toEqual(['a']);
        expect(partial.suggestedTags).toEqual([]);
        const mixed = make().parseResponse(res('{"matchedTags":[{"x":1},null," b "],"newTags":[7,"c"]}'));
        expect(mixed.matchedExistingTags).toEqual(['b']);
        expect(mixed.suggestedTags).toEqual(['c']);
        expect(() => make().parseResponse(res('{"tags":["a"]}'))).toThrow(/neither matchedTags nor newTags/);
    });
});

describe('bedrockToClaudeModelId', () => {
    it.each([
        ['anthropic.claude-sonnet-4-6', 'claude-sonnet-4-6'],
        ['global.anthropic.claude-opus-4-6-v1', 'claude-opus-4-6'],
        ['us.anthropic.claude-haiku-4-5-20251001-v1:0', 'claude-haiku-4-5-20251001'],
        ['anthropic.claude-opus-5-5', 'claude-opus-5-5'],
        ['arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-6', 'claude-sonnet-4-6'],
        ['claude-sonnet-4-6', 'claude-sonnet-4-6'],
        ['amazon.titan-text-express-v1', 'amazon.titan-text-express-v1'],
    ])('%s → %s', (input, expected) => {
        expect(bedrockToClaudeModelId(input)).toBe(expected);
    });
});
