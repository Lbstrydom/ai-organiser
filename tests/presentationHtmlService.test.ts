import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/services/llmFacade', () => ({
    summarizeText: vi.fn(),
    pluginContext: vi.fn(),
}));

import { summarizeText } from '../src/services/llmFacade';
import { generateHtml, refineHtml, runBrandAudit } from '../src/services/chat/presentationHtmlService';
import { getDefaultTheme } from '../src/services/chat/brandThemeService';

const mockSummarize = vi.mocked(summarizeText);
const dummyContext = { llmService: {} as any, settings: { serviceType: 'cloud' as const, cloudServiceType: 'openai' } };
const defaultTheme = getDefaultTheme();

beforeEach(() => {
    mockSummarize.mockReset();
});

// ── generateHtml ────────────────────────────────────────────────────────────

describe('generateHtml', () => {
    it('generates HTML from LLM response', async () => {
        mockSummarize.mockResolvedValueOnce({
            success: true,
            content: '<div class="deck" data-title="Test"><section class="slide slide-title"><h1>Hello</h1></section></div>',
        });

        const result = await generateHtml(dummyContext, {
            userQuery: 'Make slides',
            theme: defaultTheme,
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value).toContain('<!DOCTYPE html>');
            expect(result.value).toContain('class="deck"');
        }
    });

    it('handles code-fenced HTML response', async () => {
        mockSummarize.mockResolvedValueOnce({
            success: true,
            content: '```html\n<div class="deck"><section class="slide">hi</section></div>\n```',
        });

        const result = await generateHtml(dummyContext, { userQuery: 'test', theme: defaultTheme });
        expect(result.ok).toBe(true);
    });

    it('returns error on LLM failure', async () => {
        mockSummarize.mockResolvedValueOnce({ success: false, error: 'Rate limit' });

        const result = await generateHtml(dummyContext, { userQuery: 'test', theme: defaultTheme });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain('Rate limit');
    });

    it('returns error when HTML extraction fails', async () => {
        mockSummarize.mockResolvedValueOnce({ success: true, content: 'Just text, no HTML' });

        const result = await generateHtml(dummyContext, { userQuery: 'test', theme: defaultTheme });
        expect(result.ok).toBe(false);
    });

    it('returns error when aborted', async () => {
        const abort = new AbortController();
        abort.abort();
        const result = await generateHtml(dummyContext, { userQuery: 'test', theme: defaultTheme, signal: abort.signal });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toBe('Aborted');
    });

    it('wraps extracted HTML in full document with CSS', async () => {
        mockSummarize.mockResolvedValueOnce({
            success: true,
            content: '<div class="deck"><section class="slide">x</section></div>',
        });

        const result = await generateHtml(dummyContext, { userQuery: 'test', theme: defaultTheme });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value).toContain('--brand-primary');
            expect(result.value).toContain('<style>');
        }
    });
});

// ── refineHtml ──────────────────────────────────────────────────────────────

describe('refineHtml', () => {
    it('returns updated HTML', async () => {
        mockSummarize.mockResolvedValueOnce({
            success: true,
            content: '<div class="deck"><section class="slide">updated</section></div>',
        });

        const result = await refineHtml(dummyContext, {
            currentHtml: '<div>old</div>',
            userRequest: 'make shorter',
            theme: defaultTheme,
        });

        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value).toContain('updated');
    });

    it('returns error on failure', async () => {
        mockSummarize.mockResolvedValueOnce({ success: false, error: 'Timeout' });

        const result = await refineHtml(dummyContext, {
            currentHtml: '<div>old</div>',
            userRequest: 'change',
            theme: defaultTheme,
        });
        expect(result.ok).toBe(false);
    });
});

// ── runBrandAudit ───────────────────────────────────────────────────────────

describe('runBrandAudit', () => {
    it('parses audit result with violations', async () => {
        mockSummarize.mockResolvedValueOnce({
            success: true,
            content: JSON.stringify({
                passed: ['rule-0'],
                violations: [
                    { selector: '.slide h2', property: 'color', value: '#000', reason: 'Orange used for text' },
                ],
            }),
        });

        const theme = { ...defaultTheme, auditChecklist: [{ id: 'r1', description: 'No orange text' }] };
        const result = await runBrandAudit(dummyContext, '<div>html</div>', theme);

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.violations).toHaveLength(1);
            expect(result.value.violations[0].property).toBe('color');
        }
    });

    it('returns empty when no audit checklist', async () => {
        const theme = { ...defaultTheme, auditChecklist: [] };
        const result = await runBrandAudit(dummyContext, '<div>', theme);

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.passed).toContain('all');
            expect(result.value.violations).toHaveLength(0);
        }
    });

    it('returns empty violations on LLM failure', async () => {
        mockSummarize.mockResolvedValueOnce({ success: false, error: 'Timeout' });

        const theme = { ...defaultTheme, auditChecklist: [{ id: 'r1', description: 'test' }] };
        const result = await runBrandAudit(dummyContext, '<div>', theme);

        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.violations).toHaveLength(0);
    });

    it('handles malformed JSON response gracefully', async () => {
        mockSummarize.mockResolvedValueOnce({ success: true, content: 'not json at all' });

        const theme = { ...defaultTheme, auditChecklist: [{ id: 'r1', description: 'test' }] };
        const result = await runBrandAudit(dummyContext, '<div>', theme);

        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.violations).toHaveLength(0);
    });
});
