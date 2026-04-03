/**
 * Token Limits Tests
 *
 * Verifies model-aware token budgets (Fix 1):
 * - Provider-level defaults
 * - Model-specific overrides for Claude 4.6
 * - Fallback behavior for unknown providers/models
 */

import { getMaxContentChars, getMaxContentCharsForModel, truncateAtBoundary, PROVIDER_LIMITS } from '../src/services/tokenLimits';

describe('getMaxContentChars', () => {
    it('returns correct chars for known provider', () => {
        const result = getMaxContentChars('claude');
        const expected = (PROVIDER_LIMITS.claude.maxInputTokens - 500 - 2000) * PROVIDER_LIMITS.claude.charsPerToken;
        expect(result).toBe(expected);
    });

    it('falls back to local limits for unknown provider', () => {
        const result = getMaxContentChars('unknown-provider');
        const expected = (PROVIDER_LIMITS.local.maxInputTokens - 500 - 2000) * PROVIDER_LIMITS.local.charsPerToken;
        expect(result).toBe(expected);
    });

    it('is case-insensitive', () => {
        expect(getMaxContentChars('Claude')).toBe(getMaxContentChars('claude'));
        expect(getMaxContentChars('OPENAI')).toBe(getMaxContentChars('openai'));
    });
});

describe('getMaxContentCharsForModel', () => {
    it('returns provider default when no model specified', () => {
        expect(getMaxContentCharsForModel('claude')).toBe(getMaxContentChars('claude'));
    });

    it('returns higher budget for claude-opus-4-6', () => {
        const withModel = getMaxContentCharsForModel('claude', 'claude-opus-4-6');
        const withoutModel = getMaxContentChars('claude');
        expect(withModel).toBeGreaterThan(withoutModel);
    });

    it('returns higher budget for claude-sonnet-4-6', () => {
        const withModel = getMaxContentCharsForModel('claude', 'claude-sonnet-4-6');
        const withoutModel = getMaxContentChars('claude');
        expect(withModel).toBeGreaterThan(withoutModel);
    });

    it('returns 1M-token-based budget for Claude 4.6 models', () => {
        const result = getMaxContentCharsForModel('claude', 'claude-opus-4-6');
        // (1_000_000 - 500 - 2000) * 4 = 3_994_000
        expect(result).toBe((1_000_000 - 500 - 2000) * 4);
    });

    it('falls back to provider default for unmatched model', () => {
        const result = getMaxContentCharsForModel('claude', 'claude-3-haiku-20240307');
        expect(result).toBe(getMaxContentChars('claude'));
    });

    it('falls back to local for unknown provider even with model', () => {
        const result = getMaxContentCharsForModel('unknown', 'some-model');
        expect(result).toBe(getMaxContentChars('unknown'));
    });

    it('is case-insensitive on provider', () => {
        expect(getMaxContentCharsForModel('Claude', 'claude-opus-4-6'))
            .toBe(getMaxContentCharsForModel('claude', 'claude-opus-4-6'));
    });

    it('matches model by prefix', () => {
        // A hypothetical future model variant should still match
        const result = getMaxContentCharsForModel('claude', 'claude-sonnet-4-6-20260215');
        const expected = (1_000_000 - 500 - 2000) * 4;
        expect(result).toBe(expected);
    });
});

describe('truncateAtBoundary', () => {
    it('returns text unchanged when within limit', () => {
        const text = 'Short text.';
        expect(truncateAtBoundary(text, 100)).toBe(text);
    });

    it('returns text unchanged when exactly at limit', () => {
        const text = 'A'.repeat(50);
        expect(truncateAtBoundary(text, 50)).toBe(text);
    });

    it('truncates at paragraph boundary when available', () => {
        // Build text with \n\n at position 82 (inside 80% window of effectiveMax=100)
        const text = 'A'.repeat(40) + '\n\n' + 'B'.repeat(40) + '\n\n' + 'C'.repeat(40);
        // Length = 124; maxChars=100, suffix='', effectiveMax=100, threshold=80
        // \n\n at positions 40 and 82; 82 > 80 → paragraph boundary
        const result = truncateAtBoundary(text, 100, '');
        expect(result).toBe('A'.repeat(40) + '\n\n' + 'B'.repeat(40));
    });

    it('truncates at sentence boundary when no paragraph boundary', () => {
        // No \n\n in text; '. ' at position 62 in window of effectiveMax=70
        const text = 'A'.repeat(30) + '. ' + 'B'.repeat(30) + '. ' + 'C'.repeat(30);
        // Length=94; maxChars=70, suffix='', effectiveMax=70, threshold=56
        // '. ' at positions 30 and 62; 62 > 56 → sentence boundary at 62+1=63
        const result = truncateAtBoundary(text, 70, '');
        expect(result).toBe('A'.repeat(30) + '. ' + 'B'.repeat(30) + '.');
        expect(result.length).toBe(63);
    });

    it('truncates at word boundary when no sentence boundary in window', () => {
        const words = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
        const result = truncateAtBoundary(words, 80);
        expect(result).toContain('[Content truncated...]');
        // Before the suffix, the text should end with a complete word (not mid-word)
        const beforeSuffix = result.replace('\n\n[Content truncated...]', '');
        expect(beforeSuffix).toMatch(/word\d+$/);
    });

    it('hard-truncates pathological content (no spaces)', () => {
        const text = 'A'.repeat(200);
        const result = truncateAtBoundary(text, 100);
        expect(result).toContain('[Content truncated...]');
        expect(result.length).toBeLessThanOrEqual(100);
    });

    it('accounts for suffix length in budget', () => {
        const text = 'A'.repeat(200);
        const suffix = '\n\n[Content truncated...]';
        const result = truncateAtBoundary(text, 100, suffix);
        expect(result.length).toBeLessThanOrEqual(100);
        expect(result.endsWith(suffix)).toBe(true);
    });

    it('works with empty suffix', () => {
        const text = 'First sentence. Second sentence. Third sentence is very long indeed.';
        const result = truncateAtBoundary(text, 35, '');
        expect(result.length).toBeLessThanOrEqual(35);
        // Should end cleanly, not mid-word
        expect(result).toMatch(/\.$/);
    });

    it('works with custom suffix text', () => {
        const text = 'A'.repeat(200);
        const result = truncateAtBoundary(text, 100, ' [TRUNCATED]');
        expect(result.endsWith('[TRUNCATED]')).toBe(true);
        expect(result.length).toBeLessThanOrEqual(100);
    });

    it('handles edge case where maxChars is smaller than suffix', () => {
        const text = 'Some long text here.';
        const result = truncateAtBoundary(text, 5, '\n\n[Content truncated...]');
        // Should return something within budget
        expect(result.length).toBeLessThanOrEqual(5);
    });

    it('prefers sentence boundary with question/exclamation marks', () => {
        // '! ' at position 44 (inside 80% window of effectiveMax=54)
        const text = 'Is this real? ' + 'X'.repeat(30) + '! ' + 'Y'.repeat(30);
        // Length=76; maxChars=54, suffix='', effectiveMax=54, threshold=43.2
        // '? ' at 12, '! ' at 44; max=44; 44 > 43.2 → sentence boundary at 44+1=45
        const result = truncateAtBoundary(text, 54, '');
        expect(result).toBe('Is this real? ' + 'X'.repeat(30) + '!');
        expect(result.length).toBe(45);
    });
});
