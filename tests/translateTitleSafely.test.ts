/**
 * translateTitleSafely unit tests.
 *
 * Covers the 4 cases from docs/plans/post-op-metadata-helper.md §6:
 *   1. empty / whitespace-only title → returns input unchanged, no LLM call
 *   2. LLM success → returns trimmed translation
 *   3. LLM failure (response.success === false) → returns original, fellBack=true
 *   4. LLM throws → returns original, fellBack=true (no propagation)
 *
 * Plus: cache hit short-circuits the LLM call, over-length response falls back.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockSummarizeText = vi.fn();

vi.mock('../src/services/llmFacade', () => ({
    summarizeText: (...args: unknown[]) => mockSummarizeText(...args),
    pluginContext: () => ({ type: 'mock-context' }),
}));

vi.mock('../src/utils/busyIndicator', () => ({
    withBusyIndicator: <T>(_plugin: unknown, operation: () => Promise<T>) => operation(),
}));

import { translateTitleSafely, TitleTranslationResult } from '../src/commands/translateCommands';

function makePlugin() {
    return { settings: {}, app: {} } as never;
}

describe('translateTitleSafely', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('short-circuits on empty / whitespace-only title (no LLM call)', async () => {
        const cache = new Map<string, TitleTranslationResult>();
        const r1 = await translateTitleSafely(makePlugin(), 'src1', '', 'English', cache);
        const r2 = await translateTitleSafely(makePlugin(), 'src2', '   \n\t  ', 'English', cache);
        expect(mockSummarizeText).not.toHaveBeenCalled();
        expect(r1.fellBack).toBe(false);
        expect(r1.translatedTitle).toBe('');
        expect(r2.translatedTitle).toBe('   \n\t  ');
    });

    it('returns trimmed translation on LLM success', async () => {
        mockSummarizeText.mockResolvedValueOnce({ success: true, content: '  De Markt  \n' });
        const cache = new Map<string, TitleTranslationResult>();
        const r = await translateTitleSafely(makePlugin(), 'src1', 'The Market', 'Dutch', cache);
        expect(r.translatedTitle).toBe('De Markt');
        expect(r.fellBack).toBe(false);
        expect(r.sourceId).toBe('src1');
        expect(r.originalTitle).toBe('The Market');
    });

    it('falls back to original title when LLM returns success=false', async () => {
        mockSummarizeText.mockResolvedValueOnce({ success: false, error: 'rate limit' });
        const cache = new Map<string, TitleTranslationResult>();
        const r = await translateTitleSafely(makePlugin(), 'src1', 'Original', 'French', cache);
        expect(r.translatedTitle).toBe('Original');
        expect(r.fellBack).toBe(true);
    });

    it('falls back to original title when LLM throws (no propagation)', async () => {
        mockSummarizeText.mockRejectedValueOnce(new Error('network failure'));
        const cache = new Map<string, TitleTranslationResult>();
        const r = await translateTitleSafely(makePlugin(), 'src1', 'Original', 'Spanish', cache);
        expect(r.translatedTitle).toBe('Original');
        expect(r.fellBack).toBe(true);
    });

    it('caches by sourceId+targetLanguage and short-circuits on hit', async () => {
        mockSummarizeText.mockResolvedValueOnce({ success: true, content: 'Bonjour' });
        const cache = new Map<string, TitleTranslationResult>();
        await translateTitleSafely(makePlugin(), 'src1', 'Hello', 'French', cache);
        await translateTitleSafely(makePlugin(), 'src1', 'Hello', 'French', cache);
        await translateTitleSafely(makePlugin(), 'src1', 'Hello', 'French', cache);
        expect(mockSummarizeText).toHaveBeenCalledTimes(1);
    });

    it('falls back when LLM returns over-length content (>200 chars)', async () => {
        const runaway = 'a'.repeat(250);
        mockSummarizeText.mockResolvedValueOnce({ success: true, content: runaway });
        const cache = new Map<string, TitleTranslationResult>();
        const r = await translateTitleSafely(makePlugin(), 'src1', 'Title', 'English', cache);
        expect(r.translatedTitle).toBe('Title');
        expect(r.fellBack).toBe(true);
    });
});
