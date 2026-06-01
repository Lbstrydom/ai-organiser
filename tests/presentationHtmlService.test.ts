import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/services/llmFacade', () => ({
    summarizeText: vi.fn(),
    pluginContext: vi.fn(),
}));

import { summarizeText } from '../src/services/llmFacade';
import type { LLMFacadeContext } from '../src/services/llmFacade';
import { runBrandAudit } from '../src/services/chat/presentationHtmlService';
import { getDefaultTheme } from '../src/services/chat/brandThemeService';

const mockSummarize = vi.mocked(summarizeText);
// summarizeText is mocked, so the context is only passed through — cast via
// `unknown` (repo rule forbids `any`) to a minimal LLMFacadeContext shape.
const dummyContext = {
    llmService: {},
    settings: { serviceType: 'cloud' as const, cloudServiceType: 'openai' },
} as unknown as LLMFacadeContext;
const defaultTheme = getDefaultTheme();

beforeEach(() => {
    mockSummarize.mockReset();
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
