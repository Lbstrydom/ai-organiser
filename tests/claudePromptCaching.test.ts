/**
 * Claude Prompt Caching — buildSummarizeRequestBody integration tests.
 *
 * Phase 2: verifies `SummarizeOptions.stablePrefix` produces a Claude body
 * with `cache_control: { type: 'ephemeral' }` ONLY when the prefix clears
 * Anthropic's per-model token minimum. Below the threshold, it falls back
 * to concatenation (no cache_control marker, no 1.25x write penalty).
 *
 * Non-Claude providers receive `stablePrefix` concatenated onto the user
 * message — they don't have Anthropic-style ephemeral caching and shouldn't
 * see cache_control markers in the body.
 */

import { CloudLLMService } from '../src/services/cloudService';
import { AdapterType } from '../src/services/adapters';
import { App } from 'obsidian';

const mockApp = {} as App;

const makeClaudeService = (modelName = 'claude-sonnet-4-7') =>
    new CloudLLMService(
        {
            type: 'claude' as AdapterType,
            endpoint: 'https://api.anthropic.com/v1/messages',
            apiKey: 'test-key',
            modelName,
        },
        mockApp,
    );

interface ClaudeBody {
    model: string;
    max_tokens: number;
    system: string | Array<Record<string, unknown>>;
    messages: Array<{ role: string; content: string }>;
    thinking?: { type: string };
}

describe('Claude prompt caching — stablePrefix', () => {
    describe('no stablePrefix (regression — existing behaviour unchanged)', () => {
        it('produces a string system field and prompt-as-user', () => {
            const service = makeClaudeService();
            const body = (service as unknown as { buildSummarizeRequestBody(p: string, o?: unknown): ClaudeBody })
                .buildSummarizeRequestBody('hello world');

            expect(typeof body.system).toBe('string');
            expect(body.system).toContain('helpful assistant');
            expect(body.messages).toEqual([{ role: 'user', content: 'hello world' }]);
            const serialised = JSON.stringify(body);
            expect(serialised).not.toContain('cache_control');
        });
    });

    describe('stablePrefix below threshold', () => {
        it('Sonnet under 4096 chars → concatenates onto user, no cache_control', () => {
            const service = makeClaudeService('claude-sonnet-4-7');
            const shortPrefix = 'A'.repeat(2000); // below 4096
            const body = (service as unknown as { buildSummarizeRequestBody(p: string, o?: unknown): ClaudeBody })
                .buildSummarizeRequestBody('user content', { stablePrefix: shortPrefix });

            expect(typeof body.system).toBe('string');
            expect(body.messages[0].content).toBe(`${shortPrefix}\n\nuser content`);
            const serialised = JSON.stringify(body);
            expect(serialised).not.toContain('cache_control');
        });

        it('Haiku under 8192 chars → concatenates onto user, no cache_control', () => {
            const service = makeClaudeService('claude-haiku-4-5');
            // 5000 chars: above Sonnet threshold (4096) but below Haiku (8192)
            const mediumPrefix = 'B'.repeat(5000);
            const body = (service as unknown as { buildSummarizeRequestBody(p: string, o?: unknown): ClaudeBody })
                .buildSummarizeRequestBody('volatile', { stablePrefix: mediumPrefix });

            expect(typeof body.system).toBe('string');
            expect(body.messages[0].content).toBe(`${mediumPrefix}\n\nvolatile`);
            const serialised = JSON.stringify(body);
            expect(serialised).not.toContain('cache_control');
        });
    });

    describe('stablePrefix above threshold — cache_control emitted', () => {
        it('Sonnet at 4096+ chars → system becomes array with cache_control on prefix block', () => {
            const service = makeClaudeService('claude-sonnet-4-7');
            const longPrefix = 'C'.repeat(5000); // above Sonnet threshold (4096)
            const body = (service as unknown as { buildSummarizeRequestBody(p: string, o?: unknown): ClaudeBody })
                .buildSummarizeRequestBody('volatile chunk', { stablePrefix: longPrefix });

            expect(Array.isArray(body.system)).toBe(true);
            const systemArr = body.system as Array<Record<string, unknown>>;
            expect(systemArr).toHaveLength(2);
            // First block: original neutral system prompt, no cache_control
            expect(systemArr[0]).toEqual({ type: 'text', text: expect.stringContaining('helpful assistant') });
            expect(systemArr[0].cache_control).toBeUndefined();
            // Second block: stable prefix with cache_control marker
            expect(systemArr[1]).toEqual({
                type: 'text',
                text: longPrefix,
                cache_control: { type: 'ephemeral' },
            });
            // User message contains ONLY the volatile content
            expect(body.messages[0].content).toBe('volatile chunk');
        });

        it('Haiku at 8192+ chars → cache_control emitted', () => {
            const service = makeClaudeService('claude-haiku-4-5');
            const longPrefix = 'D'.repeat(9000); // above Haiku threshold (8192)
            const body = (service as unknown as { buildSummarizeRequestBody(p: string, o?: unknown): ClaudeBody })
                .buildSummarizeRequestBody('volatile', { stablePrefix: longPrefix });

            expect(Array.isArray(body.system)).toBe(true);
            const systemArr = body.system as Array<Record<string, unknown>>;
            expect(systemArr[1].cache_control).toEqual({ type: 'ephemeral' });
            expect(body.messages[0].content).toBe('volatile');
        });

        it('preserves max_tokens override when caching is active', () => {
            const service = makeClaudeService('claude-sonnet-4-7');
            const longPrefix = 'X'.repeat(5000);
            const body = (service as unknown as { buildSummarizeRequestBody(p: string, o?: unknown): ClaudeBody })
                .buildSummarizeRequestBody('v', { stablePrefix: longPrefix, maxTokens: 12288 });

            expect(body.max_tokens).toBe(12288);
            expect(Array.isArray(body.system)).toBe(true);
        });

        it('caching composes with adaptive thinking — both present in body', () => {
            const service = new CloudLLMService(
                {
                    type: 'claude' as AdapterType,
                    endpoint: 'https://api.anthropic.com/v1/messages',
                    apiKey: 'test-key',
                    modelName: 'claude-sonnet-4-6',
                    thinkingMode: 'adaptive',
                },
                mockApp,
            );
            const longPrefix = 'Z'.repeat(5000);
            const body = (service as unknown as { buildSummarizeRequestBody(p: string, o?: unknown): ClaudeBody })
                .buildSummarizeRequestBody('v', { stablePrefix: longPrefix });

            expect(body.thinking).toEqual({ type: 'adaptive' });
            expect(Array.isArray(body.system)).toBe(true);
            const systemArr = body.system as Array<Record<string, unknown>>;
            expect(systemArr[1].cache_control).toEqual({ type: 'ephemeral' });
        });
    });

    describe('non-Claude providers — concatenation only, never cache_control', () => {
        it('OpenAI: stablePrefix is concatenated onto user, no marker in body', () => {
            const service = new CloudLLMService(
                {
                    type: 'openai' as AdapterType,
                    endpoint: 'https://api.openai.com/v1/chat/completions',
                    apiKey: 'test-key',
                    modelName: 'gpt-4o-mini',
                },
                mockApp,
            );
            const longPrefix = 'P'.repeat(5000);
            const body = (service as unknown as { buildSummarizeRequestBody(p: string, o?: unknown): ClaudeBody })
                .buildSummarizeRequestBody('v', { stablePrefix: longPrefix });

            const userMsg = body.messages.find((m) => m.role === 'user');
            expect(userMsg?.content).toBe(`${longPrefix}\n\nv`);
            const serialised = JSON.stringify(body);
            expect(serialised).not.toContain('cache_control');
        });

        it('Gemini: stablePrefix is concatenated onto user, no marker in body', () => {
            const service = new CloudLLMService(
                {
                    type: 'gemini' as AdapterType,
                    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
                    apiKey: 'test-key',
                    modelName: 'gemini-2.0-flash-exp',
                },
                mockApp,
            );
            const longPrefix = 'G'.repeat(5000);
            const body = (service as unknown as { buildSummarizeRequestBody(p: string, o?: unknown): ClaudeBody })
                .buildSummarizeRequestBody('v', { stablePrefix: longPrefix });

            const userMsg = body.messages.find((m) => m.role === 'user');
            expect(userMsg?.content).toBe(`${longPrefix}\n\nv`);
            const serialised = JSON.stringify(body);
            expect(serialised).not.toContain('cache_control');
        });
    });

    describe('idempotence — same prefix produces byte-identical system field', () => {
        it('two calls with the same stablePrefix yield equal system arrays', () => {
            const service = makeClaudeService('claude-sonnet-4-7');
            const prefix = 'idempotent-'.repeat(500); // ~5500 chars, above threshold
            const body1 = (service as unknown as { buildSummarizeRequestBody(p: string, o?: unknown): ClaudeBody })
                .buildSummarizeRequestBody('first chunk', { stablePrefix: prefix });
            const body2 = (service as unknown as { buildSummarizeRequestBody(p: string, o?: unknown): ClaudeBody })
                .buildSummarizeRequestBody('second chunk', { stablePrefix: prefix });

            // System field MUST be byte-identical across calls — that's what
            // makes the cache hit on call 2+.
            expect(body1.system).toEqual(body2.system);
            // User messages differ — that's the point.
            expect(body1.messages[0].content).not.toEqual(body2.messages[0].content);
        });
    });
});
