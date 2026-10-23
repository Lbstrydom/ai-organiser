/**
 * Prompt caching rollout — pipeline wiring.
 *
 * Byte identity is asserted against `tests/fixtures/prompt-caching-baseline`,
 * the prompts rendered BEFORE the rollout, so the oracle does not depend on
 * the code under test.
 */

vi.mock('obsidian', async () => {
    const mod = await import('./mocks/obsidian');
    return { ...mod, requestUrl: vi.fn() };
});

import { vi } from 'vitest';
import { requestUrl, App } from 'obsidian';
import baseline from './fixtures/prompt-caching-baseline/baseline.json';
import { TAG_CASES, TAG_LEGACY_CASES } from './fixtures/prompt-caching-baseline/cases';
import { buildTaxonomyTagPrompt, buildTaxonomyTagPromptParts, buildTagPrompt } from '../src/services/prompts/tagPrompts';
import { joinPromptParts } from '../src/services/prompts/promptParts';
import { CloudLLMService } from '../src/services/cloudService';
import { LocalLLMService } from '../src/services/localService';
import { ConfigurationService, DEFAULT_TAXONOMY } from '../src/services/configurationService';
import { AdapterType } from '../src/services/adapters';
import { ClaudeAdapter } from '../src/services/adapters/claudeAdapter';
import { AzureClaudeAdapter } from '../src/services/adapters/azureClaudeAdapter';

const fixture = baseline as Record<string, string>;
const mockRequestUrl = requestUrl as unknown as ReturnType<typeof vi.fn>;
const app = {} as App;

beforeEach(() => { vi.clearAllMocks(); });

// ── Tagging prompt builders ─────────────────────────────────────────────────

describe('tagging prompt — byte identity with the pre-rollout baseline', () => {
    for (const [name, c] of Object.entries(TAG_CASES)) {
        it(`buildTaxonomyTagPrompt and join(parts) match the baseline: ${name}`, () => {
            const expected = fixture[`tag:${name}`];
            expect(expected).toBeTruthy();
            const legacy = buildTaxonomyTagPrompt(c.content, c.taxonomyPrompt, c.maxTags, c.language, c.folderContext);
            const parts = buildTaxonomyTagPromptParts(c.content, c.taxonomyPrompt, c.maxTags, c.language, c.folderContext);
            expect(legacy).toBe(expected);
            expect(joinPromptParts(parts.stablePrefix, parts.prompt)).toBe(expected);
        });
    }

    for (const [name, c] of Object.entries(TAG_LEGACY_CASES)) {
        it(`buildTagPrompt matches the baseline: ${name}`, () => {
            expect(buildTagPrompt(c.content, c.candidateTags, undefined, c.maxTags, c.language)).toBe(fixture[`tagLegacy:${name}`]);
        });
    }
});

describe('tagging prompt — the stable head is byte-stable across a batch', () => {
    it('two different notes produce an identical stablePrefix and different prompts', () => {
        const base = TAG_CASES['default-5'];
        const a = buildTaxonomyTagPromptParts('first note body', base.taxonomyPrompt, base.maxTags);
        const b = buildTaxonomyTagPromptParts('a completely different second note', base.taxonomyPrompt, base.maxTags);
        expect(a.stablePrefix).toBe(b.stablePrefix);
        expect(a.prompt).not.toBe(b.prompt);
    });

    it('the head contains no note content and the tail carries it', () => {
        const parts = buildTaxonomyTagPromptParts('UNIQUE-NOTE-BODY', TAG_CASES['default-5'].taxonomyPrompt, 5);
        expect(parts.stablePrefix).not.toContain('UNIQUE-NOTE-BODY');
        expect(parts.prompt).toContain('UNIQUE-NOTE-BODY');
    });

    it('with the plugin default taxonomy the head clears a 512-token model minimum (2048 chars)', async () => {
        const config = new ConfigurationService({} as App);
        (config as unknown as { loadConfig: () => Promise<unknown> }).loadConfig = async () => ({ taxonomy: DEFAULT_TAXONOMY });
        const taxonomyPrompt = await config.getTaxonomyForPrompt();
        const parts = buildTaxonomyTagPromptParts('x', taxonomyPrompt, 5);
        expect((parts.stablePrefix ?? '').length).toBeGreaterThanOrEqual(2048);
    });
});

// ── Tagging transport ───────────────────────────────────────────────────────

interface SentBody {
    model?: string;
    max_tokens?: number;
    system?: string | Array<Record<string, unknown>>;
    messages: Array<{ role: string; content: string }>;
    [k: string]: unknown;
}

function lastBody(): SentBody {
    const calls = mockRequestUrl.mock.calls;
    return JSON.parse(calls[calls.length - 1][0].body as string) as SentBody;
}

const okResponse = (): void => {
    mockRequestUrl.mockResolvedValue({
        status: 200,
        headers: {},
        text: JSON.stringify({
            content: [{ type: 'text', text: '{"tags":["a"]}' }],
            choices: [{ message: { content: '{"tags":["a"]}' } }],
        }),
    });
};

const PREFIX = 'H'.repeat(5000);   // 1250 tokens: clears 512 and 1024, not 2048+
const PROMPT = 'per-note tail';

function service(type: AdapterType, modelName: string, endpoint: string): CloudLLMService {
    return new CloudLLMService({ type, endpoint, apiKey: 'k', modelName, language: 'en' }, app);
}

describe('generateTags transport', () => {
    it('claude above the minimum: system = [SYSTEM, prefix+cache_control]; user = tail only; max_tokens 1024', async () => {
        okResponse();
        await service('claude' as AdapterType, 'claude-sonnet-5-5', 'https://api.anthropic.com/v1/messages')
            .generateTags(PROMPT, { stablePrefix: PREFIX });
        const body = lastBody();
        expect(Array.isArray(body.system)).toBe(true);
        const sys = body.system as Array<Record<string, unknown>>;
        expect(sys).toHaveLength(2);
        expect(sys[0].cache_control).toBeUndefined();
        expect(sys[1]).toEqual({ type: 'text', text: PREFIX, cache_control: { type: 'ephemeral' } });
        expect(body.messages).toEqual([{ role: 'user', content: PROMPT }]);
        expect(body.max_tokens).toBe(1024);
    });

    it('azure-claude builds the same shape as direct claude (cache_control reaches the gateway body)', async () => {
        okResponse();
        await service('azure-claude' as AdapterType, 'claude-sonnet-5-5', 'https://res.services.ai.azure.com/anthropic/v1/messages')
            .generateTags(PROMPT, { stablePrefix: PREFIX });
        const body = lastBody();
        const sys = body.system as Array<Record<string, unknown>>;
        expect(sys[1]).toEqual({ type: 'text', text: PREFIX, cache_control: { type: 'ephemeral' } });
        expect(body.messages).toEqual([{ role: 'user', content: PROMPT }]);
    });

    it('claude below the model minimum: body is exactly formatRequest(joined)', async () => {
        okResponse();
        const svc = service('claude' as AdapterType, 'claude-haiku-4-5', 'https://api.anthropic.com/v1/messages');
        await svc.generateTags(PROMPT, { stablePrefix: PREFIX });
        const sent = lastBody();
        expect(JSON.stringify(sent)).not.toContain('cache_control');
        const adapter = (svc as unknown as { adapter: { formatRequest(p: string): unknown } }).adapter;
        expect(sent).toEqual(adapter.formatRequest(joinPromptParts(PREFIX, PROMPT)));
    });

    it('an undocumented Claude model never caches', async () => {
        okResponse();
        await service('claude' as AdapterType, 'claude-sonnet-4-7', 'https://api.anthropic.com/v1/messages')
            .generateTags(PROMPT, { stablePrefix: 'P'.repeat(100_000) });
        expect(JSON.stringify(lastBody())).not.toContain('cache_control');
    });

    it('no stablePrefix: body is byte-identical to the legacy formatRequest(prompt)', async () => {
        okResponse();
        const svc = service('claude' as AdapterType, 'claude-sonnet-5-5', 'https://api.anthropic.com/v1/messages');
        await svc.generateTags(PROMPT);
        const adapter = (svc as unknown as { adapter: { formatRequest(p: string): unknown } }).adapter;
        expect(lastBody()).toEqual(adapter.formatRequest(PROMPT));
    });

    it.each([
        ['openai', 'gpt-4o-mini', 'https://api.openai.com/v1/chat/completions'],
        ['gemini', 'gemini-2.0-flash', 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'],
        ['azure-openai', 'gpt-5.5', 'https://res.openai.azure.com/openai/deployments/gpt-5-5/chat/completions?api-version=2025-03-01-preview'],
    ])('%s: prefix is joined into the user message; no cache_control / prompt_cache_* anywhere', async (type, model, endpoint) => {
        okResponse();
        await service(type as AdapterType, model, endpoint).generateTags(PROMPT, { stablePrefix: PREFIX });
        const body = lastBody();
        const serialised = JSON.stringify(body);
        expect(serialised).not.toContain('cache_control');
        expect(serialised).not.toContain('prompt_cache');
        const user = body.messages.find(m => m.role === 'user');
        expect(user?.content).toBe(joinPromptParts(PREFIX, PROMPT));
    });
});

// ── Local provider drop fix ─────────────────────────────────────────────────

describe('LocalLLMService sends a stablePrefix instead of dropping it', () => {
    const local = (): LocalLLMService => new LocalLLMService({
        type: 'ollama', endpoint: 'http://localhost:11434', modelName: 'llama3', language: 'en',
    } as never, app);

    const okLocal = (): void => {
        mockRequestUrl.mockResolvedValue({
            status: 200, headers: {},
            text: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
            json: { choices: [{ message: { content: 'ok' } }] },
        });
    };

    it('summarizeText joins the prefix ahead of the prompt', async () => {
        okLocal();
        const r = await local().summarizeText('tail', { stablePrefix: 'HEADER' });
        expect(r.success).toBe(true);
        const user = lastBody().messages.find(m => m.role === 'user');
        expect(user?.content).toBe('HEADER\n\ntail');
    });

    it('summarizeText without a prefix is unchanged', async () => {
        okLocal();
        await local().summarizeText('tail');
        expect(lastBody().messages.find(m => m.role === 'user')?.content).toBe('tail');
    });

    it('generateTags joins the prefix ahead of the prompt', async () => {
        okLocal();
        await local().generateTags('tail', { stablePrefix: 'HEADER' });
        expect(lastBody().messages.find(m => m.role === 'user')?.content).toBe('HEADER\n\ntail');
    });
});

// ── Streaming path ──────────────────────────────────────────────────────────

describe('summarizeTextStream does not drop a stablePrefix', () => {
    it('hands the joined prompt to formatStreamingRequest', async () => {
        const svc = service('claude' as AdapterType, 'claude-sonnet-5-5', 'https://api.anthropic.com/v1/messages');
        const adapter = (svc as unknown as { adapter: { formatStreamingRequest: unknown } }).adapter;
        const spy = vi.fn(() => ({ url: 'https://x.test', headers: {}, body: {} }));
        adapter.formatStreamingRequest = spy;
        const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
        const originalWindow = (globalThis as unknown as { window?: unknown }).window;
        (globalThis as unknown as { window: unknown }).window = { fetch: vi.fn().mockRejectedValue(new Error('stop')) };
        try {
            await expect(svc.summarizeTextStream('tail', () => {}, undefined, { stablePrefix: 'HEADER' })).rejects.toThrow('stop');
            expect(spy).toHaveBeenCalledWith('HEADER\n\ntail');
        } finally {
            if (hadWindow) (globalThis as unknown as { window?: unknown }).window = originalWindow;
            else delete (globalThis as unknown as { window?: unknown }).window;
        }
    });
});

// ── Adapter envelope parity (ordinary vs cached tagging request) ────────────

describe.each([
    ['ClaudeAdapter', ClaudeAdapter],
    ['AzureClaudeAdapter', AzureClaudeAdapter],
])('%s tagging request envelope', (_name, Adapter) => {
    const make = (modelName: string, thinkingMode?: 'standard' | 'adaptive') =>
        new Adapter({ endpoint: 'https://example.test/v1/messages', apiKey: 'k', modelName, thinkingMode });

    it('below the model minimum, formatCachedRequest equals formatRequest(joined) — incl. adaptive thinking params', () => {
        for (const thinkingMode of [undefined, 'adaptive'] as const) {
            const adapter = make('claude-haiku-4-5', thinkingMode);
            expect(adapter.formatCachedRequest(PROMPT, 'short head'))
                .toEqual(adapter.formatRequest(joinPromptParts('short head', PROMPT)));
        }
    });

    it('an undocumented model equals formatRequest(joined) however long the head', () => {
        const adapter = make('sonnet-prod');
        expect(adapter.formatCachedRequest(PROMPT, PREFIX.repeat(40)))
            .toEqual(adapter.formatRequest(joinPromptParts(PREFIX.repeat(40), PROMPT)));
    });

    it('above the minimum, only system and the user message differ from the ordinary request', () => {
        const adapter = make('claude-sonnet-5-5', 'adaptive');
        const cached = adapter.formatCachedRequest(PROMPT, PREFIX);
        const plain = adapter.formatRequest(PROMPT);
        expect({ ...cached, system: undefined }).toEqual({ ...plain, system: undefined });
        expect(Array.isArray(cached.system)).toBe(true);
    });
});
