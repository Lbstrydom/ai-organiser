/**
 * Integration LLM Auditor tests
 *
 * Covers: approve verdict, flag verdict, timeout/error fail-open,
 * parse failure, unsuccessful LLM response, severity mapping.
 */

import { describe, it, expect, vi } from 'vitest';
import { auditIntegrationWithLLM } from '../src/services/validators/integrationAuditor';
import type { IntegrationAuditResult } from '../src/services/validators/integrationAuditor';

// --- Helpers ---

function makeMockLLM(response: object) {
    return {
        summarizeText: vi.fn().mockResolvedValue({
            success: true,
            content: JSON.stringify(response)
        })
    } as any;
}

function makeMockLLMRaw(content: string) {
    return {
        summarizeText: vi.fn().mockResolvedValue({
            success: true,
            content
        })
    } as any;
}

function makeMockLLMFailing() {
    return {
        summarizeText: vi.fn().mockRejectedValue(new Error('Network timeout'))
    } as any;
}

function makeMockLLMUnsuccessful() {
    return {
        summarizeText: vi.fn().mockResolvedValue({
            success: false,
            content: null,
            error: 'Rate limited'
        })
    } as any;
}

const sampleOriginal = '# My Note\n\nSome existing content about AI research.';
const samplePending = '## New Findings\n\nRecent paper shows improved results with RAG.';
const sampleOutput = '# My Note\n\nSome existing content about AI research.\n\n## New Findings\n\nRecent paper shows improved results with RAG.';

// --- Tests ---

describe('auditIntegrationWithLLM', () => {

    // ═══════════════════════════════════════════
    // Approve verdict
    // ═══════════════════════════════════════════

    it('returns approved=true with no issues when verdict is approve', async () => {
        const mockLLM = makeMockLLM({
            verdict: 'approve',
            issues: [],
            summary: 'Integration looks good'
        });

        const result = await auditIntegrationWithLLM(
            sampleOutput, sampleOriginal, samplePending,
            'merge', 'prose', mockLLM
        );

        expect(result.approved).toBe(true);
        expect(result.issues).toEqual([]);
    });

    it('passes through audit info issues when verdict is approve with issues', async () => {
        const mockLLM = makeMockLLM({
            verdict: 'approve',
            issues: [
                { severity: 'info', field: 'format', message: 'Minor formatting inconsistency' }
            ],
            summary: 'Mostly good'
        });

        const result = await auditIntegrationWithLLM(
            sampleOutput, sampleOriginal, samplePending,
            'callout', 'bullets', mockLLM
        );

        expect(result.approved).toBe(true);
        expect(result.issues).toHaveLength(1);
        expect(result.issues[0].message).toContain('[Audit]');
    });

    // ═══════════════════════════════════════════
    // Flag verdict
    // ═══════════════════════════════════════════

    it('returns approved=false with issues when verdict is flag', async () => {
        const mockLLM = makeMockLLM({
            verdict: 'flag',
            issues: [
                { severity: 'warning', field: 'content', message: 'Original paragraph about AI removed' },
                { severity: 'warning', field: 'accuracy', message: 'Fabricated statistic detected' }
            ],
            summary: 'Content loss detected'
        });

        const result = await auditIntegrationWithLLM(
            sampleOutput, sampleOriginal, samplePending,
            'merge', 'prose', mockLLM
        );

        expect(result.approved).toBe(false);
        expect(result.issues).toHaveLength(2);
        expect(result.issues[0].severity).toBe('warning');
        expect(result.issues[0].message).toContain('[Audit]');
        expect(result.issues[1].message).toContain('Fabricated');
    });

    // ═══════════════════════════════════════════
    // Fail-open scenarios
    // ═══════════════════════════════════════════

    it('returns approved=true when LLM throws error (fail-open)', async () => {
        const mockLLM = makeMockLLMFailing();

        const result = await auditIntegrationWithLLM(
            sampleOutput, sampleOriginal, samplePending,
            'merge', 'prose', mockLLM
        );

        expect(result.approved).toBe(true);
        expect(result.issues).toEqual([]);
    });

    it('returns approved=true when LLM returns unsuccessful response (fail-open)', async () => {
        const mockLLM = makeMockLLMUnsuccessful();

        const result = await auditIntegrationWithLLM(
            sampleOutput, sampleOriginal, samplePending,
            'callout', 'table', mockLLM
        );

        expect(result.approved).toBe(true);
        expect(result.issues).toEqual([]);
    });

    it('returns approved=true when response is unparseable text (fail-open)', async () => {
        const mockLLM = makeMockLLMRaw('I cannot generate JSON right now, sorry.');

        const result = await auditIntegrationWithLLM(
            sampleOutput, sampleOriginal, samplePending,
            'merge', 'prose', mockLLM
        );

        expect(result.approved).toBe(true);
        expect(result.issues).toEqual([]);
    });

    it('returns approved=true when parsed JSON has no verdict field (fail-open)', async () => {
        const mockLLM = makeMockLLM({ analysis: 'looks fine' });

        const result = await auditIntegrationWithLLM(
            sampleOutput, sampleOriginal, samplePending,
            'merge', 'bullets', mockLLM
        );

        expect(result.approved).toBe(true);
        expect(result.issues).toEqual([]);
    });

    // ═══════════════════════════════════════════
    // LLM invocation verification
    // ═══════════════════════════════════════════

    // ═══════════════════════════════════════════
    // Provider override routing
    // ═══════════════════════════════════════════

    it('uses main llmService when providerConfig is null', async () => {
        const mockLLM = makeMockLLM({ verdict: 'approve', issues: [] });

        await auditIntegrationWithLLM(
            sampleOutput, sampleOriginal, samplePending,
            'merge', 'prose', mockLLM, null
        );

        expect(mockLLM.summarizeText).toHaveBeenCalledTimes(1);
    });

    it('uses main llmService when providerConfig provided but no app', async () => {
        const mockLLM = makeMockLLM({ verdict: 'approve', issues: [] });
        const config = { provider: 'claude' as any, apiKey: 'sk-test', model: 'claude-opus-4-6', endpoint: 'https://api.anthropic.com' };

        // No app provided → falls back to main service
        await auditIntegrationWithLLM(
            sampleOutput, sampleOriginal, samplePending,
            'merge', 'prose', mockLLM, config
        );

        expect(mockLLM.summarizeText).toHaveBeenCalledTimes(1);
    });

    it('calls llmService.summarizeText exactly once with correct content', async () => {
        const mockLLM = makeMockLLM({ verdict: 'approve', issues: [] });

        await auditIntegrationWithLLM(
            sampleOutput, sampleOriginal, samplePending,
            'merge', 'prose', mockLLM
        );

        expect(mockLLM.summarizeText).toHaveBeenCalledTimes(1);
        const prompt = mockLLM.summarizeText.mock.calls[0][0];
        expect(prompt).toContain('merge');
        expect(prompt).toContain('prose');
    });

    it('maps severity correctly — unknown severity becomes info', async () => {
        const mockLLM = makeMockLLM({
            verdict: 'flag',
            issues: [
                { severity: 'error', field: 'test', message: 'Should become info' },
                { severity: 'warning', field: 'test', message: 'Stays warning' },
                { severity: 'critical', field: 'test', message: 'Unknown becomes info' }
            ]
        });

        const result = await auditIntegrationWithLLM(
            sampleOutput, sampleOriginal, samplePending,
            'merge', 'prose', mockLLM
        );

        // 'error' and 'critical' severity from audit mapped to 'info'
        expect(result.issues[0].severity).toBe('info');
        expect(result.issues[1].severity).toBe('warning');
        expect(result.issues[2].severity).toBe('info');
    });
});
