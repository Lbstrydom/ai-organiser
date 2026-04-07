import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LLMFacadeContext } from '../src/services/llmFacade';
import type { QualityFinding } from '../src/services/chat/presentationTypes';

vi.mock('../src/services/llmFacade', () => ({
    summarizeText: vi.fn(),
}));

vi.mock('../src/utils/logger', () => ({
    logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { summarizeText } from '../src/services/llmFacade';
import {
    runFastScan,
    runDeepScan,
    deduplicateFindings,
    sampleLargeDeck,
} from '../src/services/chat/presentationQualityService';

// ── Fixtures ───────────────────────────────────────────────────────────────

const mockContext: LLMFacadeContext = {
    llmService: {} as LLMFacadeContext['llmService'],
    settings: { serviceType: 'cloud', cloudServiceType: 'claude' },
};

function makeFinding(overrides: Partial<QualityFinding> = {}): QualityFinding {
    return {
        issue: 'Test issue',
        suggestion: 'Test suggestion',
        severity: 'MEDIUM',
        ...overrides,
    };
}

function makeSlideHtml(count: number): string {
    const slides = Array.from({ length: count }, (_, i) =>
        `<div class="slide"><h1>Slide ${i}</h1><p>Content for slide ${i}</p></div>`
    ).join('\n');
    return `<html><body><div class="deck">${slides}</div></body></html>`;
}

function mockLLMResponse(findings: QualityFinding[]): void {
    vi.mocked(summarizeText).mockResolvedValue({
        success: true,
        content: JSON.stringify({ findings }),
    });
}

// ── deduplicateFindings ────────────────────────────────────────────────────

describe('deduplicateFindings', () => {
    it('combines non-overlapping findings from both passes', () => {
        const pass1 = [makeFinding({ issue: 'Colour clash', category: 'colour', slideIndex: 0 })];
        const pass2 = [makeFinding({ issue: 'Poor spacing', category: 'spacing', slideIndex: 1 })];
        const result = deduplicateFindings(pass1, pass2);
        expect(result).toHaveLength(2);
    });

    it('pass2 wins on full overlap (same key)', () => {
        const pass1 = [makeFinding({ issue: 'Font too small', category: 'typography', slideIndex: 0, severity: 'LOW' })];
        const pass2 = [makeFinding({ issue: 'Font too small', category: 'typography', slideIndex: 0, severity: 'HIGH' })];
        const result = deduplicateFindings(pass1, pass2);
        expect(result).toHaveLength(1);
        expect(result[0].severity).toBe('HIGH');
    });

    it('keeps non-overlapping from both and replaces overlapping with pass2', () => {
        const shared = { issue: 'Overflow detected', category: 'overflow' as const, slideIndex: 2 };
        const pass1 = [
            makeFinding({ issue: 'Colour issue', category: 'colour', slideIndex: 0 }),
            makeFinding({ ...shared, severity: 'LOW' }),
        ];
        const pass2 = [
            makeFinding({ ...shared, severity: 'HIGH' }),
            makeFinding({ issue: 'Contrast fail', category: 'contrast', slideIndex: 3 }),
        ];
        const result = deduplicateFindings(pass1, pass2);
        expect(result).toHaveLength(3);
        const overflow = result.find(f => f.issue === 'Overflow detected');
        expect(overflow?.severity).toBe('HIGH');
    });

    it('returns empty array when both inputs are empty', () => {
        expect(deduplicateFindings([], [])).toEqual([]);
    });
});

// ── sampleLargeDeck ────────────────────────────────────────────────────────

describe('sampleLargeDeck', () => {
    it('returns original HTML when slideCount <= 30', () => {
        const html = makeSlideHtml(5);
        expect(sampleLargeDeck(html, 5)).toBe(html);
    });

    it('returns original HTML when slideCount is exactly 30', () => {
        const html = makeSlideHtml(30);
        expect(sampleLargeDeck(html, 30)).toBe(html);
    });

    it('returns sampled HTML for 31+ slides', () => {
        const html = makeSlideHtml(40);
        const sampled = sampleLargeDeck(html, 40);
        // Sampled should be shorter than original
        expect(sampled.length).toBeLessThan(html.length);
    });

    it('preserves first slides in sample', () => {
        const html = makeSlideHtml(40);
        const sampled = sampleLargeDeck(html, 40);
        expect(sampled).toContain('Slide 0');
        expect(sampled).toContain('Slide 1');
    });

    it('preserves last slides in sample', () => {
        const html = makeSlideHtml(40);
        const sampled = sampleLargeDeck(html, 40);
        expect(sampled).toContain('Slide 39');
    });

    it('returns original HTML when regex cannot parse slides', () => {
        // HTML without proper slide div structure
        const html = '<html><body><p>No slides here</p></body></html>';
        expect(sampleLargeDeck(html, 40)).toBe(html);
    });
});

// ── runFastScan ────────────────────────────────────────────────────────────

describe('runFastScan', () => {
    beforeEach(() => {
        vi.mocked(summarizeText).mockReset();
    });

    it('returns parsed findings on valid JSON response', async () => {
        const findings = [
            makeFinding({ issue: 'Colour clash', category: 'colour', slideIndex: 0 }),
        ];
        mockLLMResponse(findings);

        const result = await runFastScan(mockContext, '<html></html>', 5);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.pass).toBe('fast');
            expect(result.value.findings).toHaveLength(1);
            expect(result.value.findings[0].issue).toBe('Colour clash');
        }
    });

    it('returns empty findings on malformed JSON', async () => {
        vi.mocked(summarizeText).mockResolvedValue({
            success: true,
            content: 'This is not valid JSON at all',
        });

        const result = await runFastScan(mockContext, '<html></html>', 5);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.findings).toHaveLength(0);
        }
    });

    it('returns empty findings when LLM call fails', async () => {
        vi.mocked(summarizeText).mockResolvedValue({
            success: false,
            error: 'API timeout',
        });

        const result = await runFastScan(mockContext, '<html></html>', 5);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.findings).toHaveLength(0);
        }
    });

    it('returns ok with empty findings array from LLM', async () => {
        mockLLMResponse([]);

        const result = await runFastScan(mockContext, '<html></html>', 5);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.findings).toEqual([]);
        }
    });

    it('returns err when signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();

        const result = await runFastScan(mockContext, '<html></html>', 5, controller.signal);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toBe('Aborted');
        }
    });

    it('strips findings with invalid severity', async () => {
        vi.mocked(summarizeText).mockResolvedValue({
            success: true,
            content: JSON.stringify({
                findings: [
                    { issue: 'Good', suggestion: 'Fix', severity: 'HIGH', category: 'colour' },
                    { issue: 'Bad', suggestion: 'Fix', severity: 'CRITICAL' },
                ],
            }),
        });

        const result = await runFastScan(mockContext, '<html></html>', 5);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.findings).toHaveLength(1);
            expect(result.value.findings[0].issue).toBe('Good');
        }
    });

    it('strips findings with invalid category but keeps valid ones', async () => {
        vi.mocked(summarizeText).mockResolvedValue({
            success: true,
            content: JSON.stringify({
                findings: [
                    { issue: 'Valid', suggestion: 'Fix', severity: 'LOW', category: 'invalid-cat' },
                ],
            }),
        });

        const result = await runFastScan(mockContext, '<html></html>', 5);
        expect(result.ok).toBe(true);
        if (result.ok) {
            // Finding is kept but category is stripped (not set on output)
            expect(result.value.findings).toHaveLength(1);
            expect(result.value.findings[0].category).toBeUndefined();
        }
    });
});

// ── runDeepScan ────────────────────────────────────────────────────────────

describe('runDeepScan', () => {
    beforeEach(() => {
        vi.mocked(summarizeText).mockReset();
    });

    it('returns parsed findings on valid JSON response', async () => {
        const findings = [
            makeFinding({ issue: 'Poor spacing', category: 'spacing', slideIndex: 1 }),
        ];
        mockLLMResponse(findings);

        const result = await runDeepScan(mockContext, '<html></html>', 5);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.pass).toBe('deep');
            expect(result.value.findings).toHaveLength(1);
        }
    });

    it('returns empty findings on malformed JSON', async () => {
        vi.mocked(summarizeText).mockResolvedValue({
            success: true,
            content: '```not json```',
        });

        const result = await runDeepScan(mockContext, '<html></html>', 5);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.findings).toHaveLength(0);
        }
    });

    it('returns err when signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();

        const result = await runDeepScan(mockContext, '<html></html>', 5, controller.signal);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toBe('Aborted');
        }
    });

    it('returns err when LLM throws an exception', async () => {
        vi.mocked(summarizeText).mockRejectedValue(new Error('Network failure'));

        const result = await runDeepScan(mockContext, '<html></html>', 5);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain('Network failure');
        }
    });
});
