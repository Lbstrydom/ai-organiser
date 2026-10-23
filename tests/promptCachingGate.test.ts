/**
 * Prompt caching — per-model minimum gate and Claude message shaping.
 *
 * `claudeMinCacheableTokens` is an exact (tier, major, minor) table of
 * Anthropic's documented minimum cacheable prefix; anything outside it is
 * `undefined` and must fail closed (no marker, no instruction move).
 */

import { claudeMinCacheableTokens } from '../src/services/adapters/modelCapabilities';
import { buildClaudeCachedPrompt, CHARS_PER_TOKEN_ESTIMATE } from '../src/services/adapters/claudePromptCache';
import { joinPromptParts } from '../src/services/prompts/promptParts';

describe('claudeMinCacheableTokens', () => {
    it.each([
        ['claude-opus-5-5', 512],
        ['claude-opus-5', 512],
        ['claude-sonnet-5-5', 512],
        ['claude-haiku-5-5', 512],
        ['claude-fable-5-1', 512],
        ['claude-fable-5', 512],
        ['claude-mythos-5-1', 512],
        ['claude-opus-4-8', 1024],
        ['claude-sonnet-5', 1024],
        ['claude-sonnet-4-6', 1024],
        ['claude-sonnet-4-5-20250929', 1024],
        ['claude-sonnet-4-20250514', 1024],
        ['claude-opus-4-1', 1024],
        ['claude-opus-4-7', 2048],
        ['claude-3-5-haiku-20241022', 2048],
        ['claude-3-5-haiku', 2048],
        ['claude-mythos-preview', 2048],
        ['claude-opus-4-6', 4096],
        ['claude-opus-4-5', 4096],
        ['claude-haiku-4-5-20251001', 4096],
        ['claude-haiku-4-5', 4096],
    ])('%s → %i tokens', (id, expected) => {
        expect(claudeMinCacheableTokens(id)).toBe(expected);
    });

    it.each([
        ['an unknown deployment name', 'sonnet-prod'],
        ['a non-Claude id', 'gpt-5.6-terra'],
        ['an undocumented minor version', 'claude-sonnet-4-7'],
        ['a future generation', 'claude-opus-6'],
        ['a future minor of a known generation', 'claude-opus-5-6'],
        ['an unresolved latest-* sentinel', 'latest-sonnet'],
        ['a legacy 3.x id that has no documented minimum', 'claude-3-7-sonnet-20250219'],
        ['the haiku 3.5 -latest alias', 'claude-3-5-haiku-latest'],
        ['a prefixed mythos preview id', 'anthropic.claude-mythos-preview'],
        ['an id with a trailing -latest alias', 'claude-sonnet-5-5-latest'],
        ['the empty string', ''],
    ])('%s is undocumented → undefined', (_what, id) => {
        expect(claudeMinCacheableTokens(id)).toBeUndefined();
    });

    it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'])('an inherited property name (%s) is not a model → undefined', (name) => {
        expect(claudeMinCacheableTokens(name)).toBeUndefined();
    });

    it('is undefined for null / undefined', () => {
        expect(claudeMinCacheableTokens(undefined)).toBeUndefined();
        expect(claudeMinCacheableTokens(null)).toBeUndefined();
    });
});

describe('joinPromptParts', () => {
    it('joins prefix and prompt with a blank line', () => {
        expect(joinPromptParts('HEAD', 'tail')).toBe('HEAD\n\ntail');
    });
    it('returns the prompt unchanged without a prefix', () => {
        expect(joinPromptParts(undefined, 'tail')).toBe('tail');
        expect(joinPromptParts('', 'tail')).toBe('tail');
    });
});

describe('buildClaudeCachedPrompt', () => {
    const SYSTEM = 'SYSTEM';
    const minChars = (model: string): number => (claudeMinCacheableTokens(model) as number) * CHARS_PER_TOKEN_ESTIMATE;

    it('without a prefix is the identity', () => {
        expect(buildClaudeCachedPrompt(SYSTEM, 'p', 'claude-sonnet-5-5', undefined))
            .toEqual({ systemField: SYSTEM, userContent: 'p' });
    });

    it('at the minimum: system = [system, prefix + cache_control] in that order; user = volatile only', () => {
        const prefix = 'P'.repeat(minChars('claude-sonnet-5-5'));
        const out = buildClaudeCachedPrompt(SYSTEM, 'volatile', 'claude-sonnet-5-5', prefix);
        expect(out.systemField).toEqual([
            { type: 'text', text: SYSTEM },
            { type: 'text', text: prefix, cache_control: { type: 'ephemeral' } },
        ]);
        expect(out.userContent).toBe('volatile');
    });

    it('one char under the minimum: no cache_control, user = joined', () => {
        const prefix = 'P'.repeat(minChars('claude-sonnet-5-5') - 1);
        const out = buildClaudeCachedPrompt(SYSTEM, 'volatile', 'claude-sonnet-5-5', prefix);
        expect(out.systemField).toBe(SYSTEM);
        expect(out.userContent).toBe(joinPromptParts(prefix, 'volatile'));
        expect(JSON.stringify(out)).not.toContain('cache_control');
    });

    it('applies each model its own minimum (same prefix, different outcome)', () => {
        const prefix = 'P'.repeat(5000); // 1250 tokens
        const cached = (m: string) => Array.isArray(buildClaudeCachedPrompt(SYSTEM, 'v', m, prefix).systemField);
        expect(cached('claude-sonnet-5-5')).toBe(true);  // 512
        expect(cached('claude-sonnet-4-6')).toBe(true);  // 1024
        expect(cached('claude-opus-4-7')).toBe(false);   // 2048
        expect(cached('claude-haiku-4-5')).toBe(false);  // 4096
    });

    it('an undocumented model never caches, however long the prefix', () => {
        const prefix = 'P'.repeat(200_000);
        for (const model of ['sonnet-prod', 'claude-opus-6', 'claude-sonnet-4-7', 'latest-sonnet', undefined]) {
            const out = buildClaudeCachedPrompt(SYSTEM, 'v', model, prefix);
            expect(out.systemField).toBe(SYSTEM);
            expect(out.userContent).toBe(joinPromptParts(prefix, 'v'));
            expect(JSON.stringify(out)).not.toContain('cache_control');
        }
    });

    it('is deterministic: the same prefix yields a deep-equal system field', () => {
        const prefix = 'stable-'.repeat(600);
        const a = buildClaudeCachedPrompt(SYSTEM, 'first', 'claude-sonnet-5-5', prefix);
        const b = buildClaudeCachedPrompt(SYSTEM, 'second', 'claude-sonnet-5-5', prefix);
        expect(a.systemField).toEqual(b.systemField);
        expect(a.userContent).not.toEqual(b.userContent);
    });
});
