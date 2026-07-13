// @vitest-environment jsdom
// jsdom (not happy-dom): this file exercises sanitizePresentation()/DOMPurify
// via buildHtmlFromDeckIr; happy-dom+DOMPurify silently under-sanitizes (only
// purifies parent elements, not children — see
// https://github.com/capricorn86/happy-dom/issues/1810). Real-Chromium
// behavior independently verified correct (2026-07-13 audit).
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/services/llmFacade', () => ({
    summarizeText: vi.fn(),
    summarizeTextStream: vi.fn(),
    pluginContext: vi.fn(),
}));

import { summarizeText } from '../src/services/llmFacade';
import { generateDeckIr, buildHtmlFromDeckIr } from '../src/services/chat/presentationHtmlService';
import { resolveTheme } from '../src/services/export/exportTheme';
import { IR_SCHEMA_VERSION, type SlideDeckIr } from '../src/services/presentationIr/slideIr';

const mockSummarize = vi.mocked(summarizeText);
// Loose context — the mocked summarizeText ignores it (matches existing service tests).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = { llmService: {} as any, settings: { serviceType: 'cloud' as const, cloudServiceType: 'openai' } };
const exportTheme = resolveTheme('navy-gold', '', '', 'Inter', 14);

const validDeck = JSON.stringify({
    schemaVersion: IR_SCHEMA_VERSION,
    title: 'Coffee',
    slides: [
        { id: 's1', type: 'title', title: 'Coffee', subtitle: 'Market', blocks: [] },
        { id: 's2', type: 'content', title: 'Scale', blocks: [
            { kind: 'stat-grid', cards: [{ value: '$100B', label: 'Market' }, { value: '125M', label: 'People' }] },
        ] },
    ],
});

beforeEach(() => mockSummarize.mockReset());

describe('generateDeckIr', () => {
    it('returns the parsed deck when the LLM emits valid IR', async () => {
        mockSummarize.mockResolvedValueOnce({ success: true, content: validDeck });
        const r = await generateDeckIr(ctx, { userQuery: 'coffee deck' });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.slides).toHaveLength(2);
        expect(mockSummarize).toHaveBeenCalledTimes(1);
    });

    it('repairs once when the first response is invalid, then succeeds', async () => {
        mockSummarize
            .mockResolvedValueOnce({ success: true, content: '{ "schemaVersion": 1, "slides": [] }' }) // invalid (min 1)
            .mockResolvedValueOnce({ success: true, content: validDeck });
        const r = await generateDeckIr(ctx, { userQuery: 'coffee deck' });
        expect(r.ok).toBe(true);
        expect(mockSummarize).toHaveBeenCalledTimes(2);
    });

    it('errors when both attempts are invalid', async () => {
        mockSummarize
            .mockResolvedValueOnce({ success: true, content: 'garbage' })
            .mockResolvedValueOnce({ success: true, content: 'still garbage' });
        const r = await generateDeckIr(ctx, { userQuery: 'x' });
        expect(r.ok).toBe(false);
    });

    it('errors when the LLM call fails', async () => {
        mockSummarize.mockResolvedValueOnce({ success: false, error: 'rate limited' });
        const r = await generateDeckIr(ctx, { userQuery: 'x' });
        expect(r.ok).toBe(false);
    });

    it('short-circuits on an already-aborted signal', async () => {
        const ac = new AbortController();
        ac.abort();
        const r = await generateDeckIr(ctx, { userQuery: 'x', signal: ac.signal });
        expect(r.ok).toBe(false);
        expect(mockSummarize).not.toHaveBeenCalled();
    });
});

describe('buildHtmlFromDeckIr', () => {
    const deck: SlideDeckIr = JSON.parse(validDeck);

    it('produces a sanitized, wrapped, CSP-injected document', () => {
        const r = buildHtmlFromDeckIr(deck, exportTheme, 'body{}', 'English');
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value).toContain('<!DOCTYPE html>');
        expect(r.value).toContain('class="deck"');
        expect(r.value).toContain('Content-Security-Policy');
        expect((r.value.match(/<section data-slide/g) ?? []).length).toBe(2);
    });
});
