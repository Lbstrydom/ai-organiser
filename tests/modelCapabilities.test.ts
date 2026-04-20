/**
 * Model Capability Tests
 *
 * Explicit goal: prove that future model releases in known families pick up
 * capabilities automatically without code edits. If Anthropic ships Opus 5.0
 * or Opus 4.8, these tests fail LOUDLY if we accidentally regressed to
 * hardcoded-ID matching.
 */

import { describe, it, expect } from 'vitest';
import {
    parseClaudeModel,
    claudeSupportsAdaptiveThinking,
    claudeHas1MContext,
    claudeSupportsDynamicWebSearch,
    parseOpenAIModel,
    openaiIsReasoningModel,
    parseGeminiModel,
    geminiSupportsThinking,
    pickNewestClaude,
    pickNewestGemini,
    pickNewestOpenAI,
    resolveLatestModel,
} from '../src/services/adapters/modelCapabilities';

describe('parseClaudeModel', () => {
    it('parses current Claude model IDs', () => {
        expect(parseClaudeModel('claude-opus-4-7')).toEqual({ tier: 'opus', major: 4, minor: 7 });
        expect(parseClaudeModel('claude-opus-4-6')).toEqual({ tier: 'opus', major: 4, minor: 6 });
        expect(parseClaudeModel('claude-sonnet-4-6')).toEqual({ tier: 'sonnet', major: 4, minor: 6 });
        expect(parseClaudeModel('claude-haiku-4-5-20251001')).toEqual({ tier: 'haiku', major: 4, minor: 5 });
        expect(parseClaudeModel('claude-opus-4-5-20251101')).toEqual({ tier: 'opus', major: 4, minor: 5 });
    });

    it('rejects non-Claude or malformed IDs', () => {
        expect(parseClaudeModel('gpt-5.2')).toBeNull();
        expect(parseClaudeModel('gemini-3.1-flash')).toBeNull();
        expect(parseClaudeModel('')).toBeNull();
        expect(parseClaudeModel(undefined)).toBeNull();
        expect(parseClaudeModel(null)).toBeNull();
        expect(parseClaudeModel('claude-random')).toBeNull();
    });
});

describe('claudeSupportsAdaptiveThinking — future-proof future Claude releases', () => {
    it('opus 4.6 and newer (4.5 and older do NOT)', () => {
        expect(claudeSupportsAdaptiveThinking('claude-opus-4-5-20251101')).toBe(false);
        expect(claudeSupportsAdaptiveThinking('claude-opus-4-6')).toBe(true);
        expect(claudeSupportsAdaptiveThinking('claude-opus-4-7')).toBe(true);
    });

    it('auto-picks up hypothetical future opus 4.8 and 5.0', () => {
        expect(claudeSupportsAdaptiveThinking('claude-opus-4-8')).toBe(true);
        expect(claudeSupportsAdaptiveThinking('claude-opus-5-0')).toBe(true);
        expect(claudeSupportsAdaptiveThinking('claude-opus-6-1-20280101')).toBe(true);
    });

    it('sonnet 4.6 and newer (but not 4.5)', () => {
        expect(claudeSupportsAdaptiveThinking('claude-sonnet-4-5-20250929')).toBe(false);
        expect(claudeSupportsAdaptiveThinking('claude-sonnet-4-6')).toBe(true);
        expect(claudeSupportsAdaptiveThinking('claude-sonnet-4-7')).toBe(true);  // future
        expect(claudeSupportsAdaptiveThinking('claude-sonnet-5-0')).toBe(true);  // future
    });

    it('haiku does NOT support adaptive thinking (today)', () => {
        expect(claudeSupportsAdaptiveThinking('claude-haiku-4-5-20251001')).toBe(false);
    });

    it('rejects non-Claude IDs', () => {
        expect(claudeSupportsAdaptiveThinking('gpt-5.2')).toBe(false);
        expect(claudeSupportsAdaptiveThinking('')).toBe(false);
        expect(claudeSupportsAdaptiveThinking(undefined)).toBe(false);
    });
});

describe('claudeHas1MContext — 4.6+ opus/sonnet', () => {
    it('opus/sonnet 4.6 and newer', () => {
        expect(claudeHas1MContext('claude-opus-4-6')).toBe(true);
        expect(claudeHas1MContext('claude-opus-4-7')).toBe(true);
        expect(claudeHas1MContext('claude-sonnet-4-6')).toBe(true);
    });

    it('auto-picks up future 4.8 / 5.0 / 6.x', () => {
        expect(claudeHas1MContext('claude-opus-4-8')).toBe(true);
        expect(claudeHas1MContext('claude-opus-5-0')).toBe(true);
        expect(claudeHas1MContext('claude-sonnet-5-2')).toBe(true);
    });

    it('4.5 and older do NOT have 1M', () => {
        expect(claudeHas1MContext('claude-opus-4-5-20251101')).toBe(false);
        expect(claudeHas1MContext('claude-sonnet-4-5-20250929')).toBe(false);
    });

    it('haiku never has 1M (today)', () => {
        expect(claudeHas1MContext('claude-haiku-4-5-20251001')).toBe(false);
    });
});

describe('claudeSupportsDynamicWebSearch — aliased to adaptive-thinking gate', () => {
    it('tracks the same capability profile', () => {
        expect(claudeSupportsDynamicWebSearch('claude-opus-4-7')).toBe(true);
        expect(claudeSupportsDynamicWebSearch('claude-opus-5-0')).toBe(true);
        expect(claudeSupportsDynamicWebSearch('claude-haiku-4-5-20251001')).toBe(false);
    });
});

describe('parseOpenAIModel', () => {
    it('parses GPT family with dot-separated version', () => {
        expect(parseOpenAIModel('gpt-5.2')).toEqual({ family: 'gpt', major: 5, minor: 2, variant: undefined });
        expect(parseOpenAIModel('gpt-5.2-pro')).toMatchObject({ family: 'gpt', major: 5, minor: 2, variant: 'pro' });
        expect(parseOpenAIModel('gpt-5-mini')).toMatchObject({ family: 'gpt', major: 5, minor: 0, variant: 'mini' });
        // Note: legacy `gpt-4o` / `gpt-4o-mini` naming without `.` or `-` between
        // major and the `o` suffix returns null here. This is intentional —
        // OpenAI's current naming (gpt-5.x, gpt-5-mini, gpt-5-nano) uses
        // separators, and we don't want to re-hardcode a legacy exception.
    });

    it('parses o-series reasoning models', () => {
        expect(parseOpenAIModel('o3')).toMatchObject({ family: 'o', major: 3 });
        expect(parseOpenAIModel('o3-deep-research')).toMatchObject({ family: 'o', major: 3, variant: 'deep-research' });
        expect(parseOpenAIModel('o1-mini')).toMatchObject({ family: 'o', major: 1, variant: 'mini' });
    });

    it('openaiIsReasoningModel picks up o-series', () => {
        expect(openaiIsReasoningModel('o3')).toBe(true);
        expect(openaiIsReasoningModel('o4-mini')).toBe(true);  // future
        expect(openaiIsReasoningModel('gpt-5.2')).toBe(false);
        expect(openaiIsReasoningModel('gpt-5.2-pro')).toBe(false);
    });

    it('rejects non-OpenAI IDs', () => {
        expect(parseOpenAIModel('claude-opus-4-7')).toBeNull();
        expect(parseOpenAIModel('gemini-3.1-flash')).toBeNull();
    });
});

describe('parseGeminiModel', () => {
    it('parses current Gemini 2.5/3.x IDs', () => {
        expect(parseGeminiModel('gemini-3.1-pro-preview')).toMatchObject({ major: 3, minor: 1, tier: 'pro', isPreview: true });
        expect(parseGeminiModel('gemini-3-flash-preview')).toMatchObject({ major: 3, minor: 0, tier: 'flash', isPreview: true });
        expect(parseGeminiModel('gemini-2.5-flash')).toMatchObject({ major: 2, minor: 5, tier: 'flash', isPreview: false });
    });

    it('flags TTS variants', () => {
        expect(parseGeminiModel('gemini-2.5-flash-preview-tts')).toMatchObject({ major: 2, minor: 5, tier: 'flash', isTts: true });
        expect(parseGeminiModel('gemini-3.1-flash-tts-preview')).toMatchObject({ major: 3, minor: 1, tier: 'flash', isTts: true, isPreview: true });
    });

    it('geminiSupportsThinking — 2.5+ pro/flash', () => {
        expect(geminiSupportsThinking('gemini-2.5-pro')).toBe(true);
        expect(geminiSupportsThinking('gemini-3.1-pro-preview')).toBe(true);
        expect(geminiSupportsThinking('gemini-4.0-pro')).toBe(true);  // future
        expect(geminiSupportsThinking('gemini-1.5-pro')).toBe(false);
        expect(geminiSupportsThinking('gemini-1.5-flash')).toBe(false);
    });
});

describe('pickNewestClaude — tier-aware latest-wins selection', () => {
    const pool = [
        'claude-opus-4-5-20251101',
        'claude-opus-4-6',
        'claude-opus-4-7',
        'claude-sonnet-4-5-20250929',
        'claude-sonnet-4-6',
        'claude-haiku-4-5-20251001',
    ];

    it('picks the newest opus in the pool', () => {
        expect(pickNewestClaude(pool, 'opus')).toBe('claude-opus-4-7');
    });

    it('picks the newest sonnet', () => {
        expect(pickNewestClaude(pool, 'sonnet')).toBe('claude-sonnet-4-6');
    });

    it('picks haiku (only one in pool)', () => {
        expect(pickNewestClaude(pool, 'haiku')).toBe('claude-haiku-4-5-20251001');
    });

    it('returns null when no models of that tier exist', () => {
        expect(pickNewestClaude(['claude-haiku-4-5-20251001'], 'opus')).toBeNull();
    });

    it('auto-picks future releases — adding opus 5.0 wins over 4.7', () => {
        expect(pickNewestClaude([...pool, 'claude-opus-5-0'], 'opus')).toBe('claude-opus-5-0');
    });

    it('ignores non-Claude IDs in the pool', () => {
        expect(pickNewestClaude([...pool, 'gpt-5.2', 'gemini-3.1-pro'], 'opus'))
            .toBe('claude-opus-4-7');
    });
});

describe('pickNewestGemini', () => {
    const pool = [
        'gemini-2.5-flash',
        'gemini-2.5-pro',
        'gemini-3-flash',
        'gemini-3.1-pro-preview',
        'gemini-3.1-flash-tts-preview',  // TTS — should be excluded
    ];

    it('picks the newest pro, excluding TTS variants', () => {
        expect(pickNewestGemini(pool, 'pro')).toBe('gemini-3.1-pro-preview');
    });

    it('picks the newest flash, excluding TTS variants', () => {
        expect(pickNewestGemini(pool, 'flash')).toBe('gemini-3-flash');
    });

    it('auto-picks Gemini 4.0 pro when added', () => {
        expect(pickNewestGemini([...pool, 'gemini-4.0-pro'], 'pro')).toBe('gemini-4.0-pro');
    });
});

describe('pickNewestOpenAI', () => {
    const pool = [
        'gpt-5.2',
        'gpt-5.2-pro',
        'gpt-5-mini',
        'o3',
        'o3-deep-research',
        'o3-mini',
    ];

    it('picks the newest flagship gpt (no variant)', () => {
        expect(pickNewestOpenAI(pool, 'gpt')).toBe('gpt-5.2');
    });

    it('picks the newest gpt-mini variant', () => {
        expect(pickNewestOpenAI(pool, 'gpt-mini')).toBe('gpt-5-mini');
    });

    it('picks the newest o-series base model (no variant)', () => {
        expect(pickNewestOpenAI(pool, 'o')).toBe('o3');
    });

    it('auto-picks o5 when added', () => {
        expect(pickNewestOpenAI([...pool, 'o5'], 'o')).toBe('o5');
    });
});

describe('resolveLatestModel — symbolic IDs become concrete', () => {
    const claudePool = ['claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];

    it('resolves latest-opus to the newest opus in the pool', () => {
        expect(resolveLatestModel('claude', 'latest-opus', claudePool)).toBe('claude-opus-4-7');
    });

    it('resolves latest-sonnet / latest-haiku likewise', () => {
        expect(resolveLatestModel('claude', 'latest-sonnet', claudePool)).toBe('claude-sonnet-4-6');
        expect(resolveLatestModel('claude', 'latest-haiku', claudePool)).toBe('claude-haiku-4-5-20251001');
    });

    it('passes concrete IDs through unchanged', () => {
        expect(resolveLatestModel('claude', 'claude-opus-4-6', claudePool)).toBe('claude-opus-4-6');
    });

    it('returns null for latest-* that cannot be resolved (empty pool)', () => {
        expect(resolveLatestModel('claude', 'latest-opus', [])).toBeNull();
    });

    it('returns null for latest-<unknown tier>', () => {
        expect(resolveLatestModel('claude', 'latest-nonsense', claudePool)).toBeNull();
    });

    it('handles Gemini and OpenAI tiers', () => {
        expect(resolveLatestModel('gemini', 'latest-pro', ['gemini-3.1-pro-preview', 'gemini-2.5-pro']))
            .toBe('gemini-3.1-pro-preview');
        expect(resolveLatestModel('openai', 'latest-o', ['o3', 'o2']))
            .toBe('o3');
    });

    it('undefined/null input returns null', () => {
        expect(resolveLatestModel('claude', undefined, claudePool)).toBeNull();
        expect(resolveLatestModel('claude', null, claudePool)).toBeNull();
    });
});
