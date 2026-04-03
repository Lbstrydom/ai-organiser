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
