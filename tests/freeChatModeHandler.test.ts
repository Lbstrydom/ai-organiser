/**
 * freeChatModeHandler.test.ts
 *
 * Unit tests for FreeChatModeHandler:
 *  - Static properties (mode, isAvailable, getIntroMessage, getPlaceholder)
 *  - Attachment budget (getMaxContentCharsForModel)
 */

import { vi, describe, it, expect } from 'vitest';
import { FreeChatModeHandler } from '../src/ui/chat/FreeChatModeHandler';
import { getMaxContentCharsForModel } from '../src/services/tokenLimits';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('obsidian', async () => {
    const actual = await vi.importActual('./mocks/obsidian') as any;
    return { ...actual, Notice: class { constructor() {} } };
});

vi.mock('../src/services/documentExtractionService', () => ({
    DocumentExtractionService: class {
        constructor() {}
    },
}));

vi.mock('../src/services/llmFacade', () => ({
    summarizeText: vi.fn(),
    pluginContext: vi.fn(),
}));

// ── Mock plugin factory ───────────────────────────────────────────────────────

function makePlugin(settingsOverride: Record<string, any> = {}): any {
    return {
        app: {
            vault: {
                getAbstractFileByPath: () => null,
                createBinary: vi.fn(),
                cachedRead: vi.fn(),
            },
            fileManager: {},
        },
        settings: {
            serviceType:       'cloud',
            cloudServiceType:  'claude',
            aichatOutputFolder: 'AI Chat',
            interfaceLanguage: 'en',
            ...settingsOverride,
        },
        t: {
            modals: {
                unifiedChat: {
                    freeUnavailable:  'AI Chat requires a configured provider',
                    introFree:        'Hello from AI Chat',
                    placeholderFree:  'Type here…',
                },
            },
        } as any,
    };
}

function makeContext(serviceType = 'cloud', cloudServiceType = 'claude'): any {
    return {
        plugin: makePlugin({ serviceType, cloudServiceType }),
        app: {},
        fullPlugin: {},
        options: {},
    };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('FreeChatModeHandler.mode', () => {
    it('reports mode as "free"', () => {
        const handler = new FreeChatModeHandler(makePlugin());
        expect(handler.mode).toBe('free');
    });
});

describe('FreeChatModeHandler.isAvailable', () => {
    it('returns true regardless of provider', () => {
        const handler = new FreeChatModeHandler(makePlugin());
        expect(handler.isAvailable(makeContext('cloud', 'claude'))).toBe(true);
        expect(handler.isAvailable(makeContext('cloud', 'openai'))).toBe(true);
        expect(handler.isAvailable(makeContext('local', 'ollama'))).toBe(true);
    });
});

describe('FreeChatModeHandler.getIntroMessage', () => {
    it('returns the introFree translation string', () => {
        const plugin = makePlugin();
        const handler = new FreeChatModeHandler(plugin);
        expect(handler.getIntroMessage(plugin.t)).toContain('Hello');
    });
});

describe('FreeChatModeHandler.getPlaceholder', () => {
    it('returns the placeholderFree translation string', () => {
        const plugin = makePlugin();
        const handler = new FreeChatModeHandler(plugin);
        expect(handler.getPlaceholder(plugin.t)).toContain('Type');
    });
});

// ── Attachment budget ─────────────────────────────────────────────────────────

describe('attachment budget — getMaxContentCharsForModel', () => {
    it('claude + claude-sonnet-4-6 budget exceeds 40 000 chars', () => {
        const total = getMaxContentCharsForModel('claude', 'claude-sonnet-4-6');
        expect(total).toBeGreaterThan(40_000);
    });

    it('openai + gpt-5.2 returns a positive budget', () => {
        const total = getMaxContentCharsForModel('openai', 'gpt-5.2');
        expect(total).toBeGreaterThan(0);
    });

    it('per-file cap (1/3 of total) stays below total budget', () => {
        const providers: Array<[string, string]> = [
            ['claude', 'claude-sonnet-4-6'],
            ['openai', 'gpt-5.2'],
            ['gemini', 'gemini-3-flash'],
        ];
        for (const [provider, model] of providers) {
            const total   = getMaxContentCharsForModel(provider, model);
            const perFile = Math.floor(total / 3);
            expect(perFile).toBeLessThan(total);
            expect(perFile).toBeGreaterThan(0);
        }
    });
});

// ── buildPrompt: stable/volatile split (prompt caching) ───────────────────────

describe('FreeChatModeHandler.buildPrompt — stable/volatile split', () => {
    it('returns prompt only when no stable context exists (no project, no memory)', async () => {
        const handler = new FreeChatModeHandler(makePlugin());
        const result = await handler.buildPrompt('what is up?', '', makeContext());
        expect(result.prompt).toContain('<question>');
        expect(result.prompt).toContain('what is up?');
        expect(result.stablePrefix).toBeUndefined();
    });

    it('emits stablePrefix when global memory is present, with volatile-only prompt', async () => {
        const handler = new FreeChatModeHandler(makePlugin());
        (handler as unknown as { globalMemory: string[] }).globalMemory = [
            'User prefers concise answers',
            'User works in TypeScript',
        ];

        const result = await handler.buildPrompt('hello', '', makeContext());

        expect(result.stablePrefix).toBeDefined();
        expect(result.stablePrefix).toContain('<auto_memory_instruction>');
        expect(result.stablePrefix).toContain('<global_memory>');
        expect(result.stablePrefix).toContain('User prefers concise answers');
        // Stable bits must NOT leak into the volatile prompt
        expect(result.prompt).not.toContain('<auto_memory_instruction>');
        expect(result.prompt).not.toContain('<global_memory>');
        // Volatile portion still contains the question
        expect(result.prompt).toContain('<question>');
        expect(result.prompt).toContain('hello');
    });

    it('history goes into volatile prompt, NOT stable prefix', async () => {
        const handler = new FreeChatModeHandler(makePlugin());
        (handler as unknown as { globalMemory: string[] }).globalMemory = ['fact one'];

        const result = await handler.buildPrompt(
            'follow-up question',
            'user: previous turn\nassistant: previous response',
            makeContext(),
        );

        expect(result.stablePrefix).toBeDefined();
        expect(result.stablePrefix).not.toContain('<conversation_history>');
        expect(result.prompt).toContain('<conversation_history>');
        expect(result.prompt).toContain('previous turn');
    });

    it('two turns with same stable context produce byte-identical stablePrefix (cache key)', async () => {
        const handler = new FreeChatModeHandler(makePlugin());
        (handler as unknown as { globalMemory: string[] }).globalMemory = [
            'Stable fact A',
            'Stable fact B',
        ];

        const turn1 = await handler.buildPrompt('first question', '', makeContext());
        const turn2 = await handler.buildPrompt(
            'second question',
            'user: first question\nassistant: first answer',
            makeContext(),
        );

        // This is the entire point of the split: the prefix must be IDENTICAL
        // across turns so the Anthropic cache hashes match. Different
        // questions and different conversation histories live in `prompt`.
        expect(turn1.stablePrefix).toEqual(turn2.stablePrefix);
        expect(turn1.prompt).not.toEqual(turn2.prompt);
    });

    it('adding a memory between turns busts the prefix (expected cache invalidation)', async () => {
        const handler = new FreeChatModeHandler(makePlugin());
        (handler as unknown as { globalMemory: string[] }).globalMemory = ['fact one'];

        const turn1 = await handler.buildPrompt('q1', '', makeContext());
        (handler as unknown as { globalMemory: string[] }).globalMemory.push('fact two');
        const turn2 = await handler.buildPrompt('q2', '', makeContext());

        expect(turn1.stablePrefix).not.toEqual(turn2.stablePrefix);
    });
});
