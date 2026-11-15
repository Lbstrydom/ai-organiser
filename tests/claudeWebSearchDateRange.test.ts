/**
 * Claude web search honours `dateRange` by post-filtering on page_age and reporting
 * what it did (llm-option-fidelity D7).
 */
vi.mock('obsidian', async () => {
    const mod = await import('./mocks/obsidian');
    return { ...mod, requestUrl: vi.fn() };
});
vi.mock('../src/utils/abortableSleep', () => ({ abortableSleep: vi.fn(async () => {}) }));

import { requestUrl } from 'obsidian';
import { ClaudeWebSearchAdapter } from '../src/services/research/adapters/claudeWebSearchAdapter';
import { applyDateRange, parsePageAge, dateRangeWindowDays, mergeConstraintReports } from '../src/services/research/dateRangeFilter';
import type { SearchResult } from '../src/services/research/researchTypes';
import { en } from '../src/i18n/en';

const mockRequestUrl = requestUrl as unknown as ReturnType<typeof vi.fn>;
const NOW = Date.UTC(2026, 10, 15, 15, 30); // 15 Nov 2026 15:30 UTC

const r = (url: string, date?: string): SearchResult => ({ title: url, url, snippet: '', source: 'web', domain: 'example.com', date });

describe('parsePageAge', () => {
    it.each([
        ['February 15, 2026', Date.UTC(2026, 1, 15)],
        ['Feb 15, 2026', Date.UTC(2026, 1, 15)],
        ['February 5 2026', Date.UTC(2026, 1, 5)],
        ['2026-02-15', Date.UTC(2026, 1, 15)],
        ['2026-02-15T10:20:30Z', Date.UTC(2026, 1, 15)],
    ])('parses %s', (input, expected) => {
        expect(parsePageAge(input)).toBe(expected);
    });

    it.each(['', undefined, '3 days ago', 'last week', 'Febtober 3, 2026', 'February 30, 2026', '2026-13-01', 'garbage'])('treats %s as undated', (input) => {
        expect(parsePageAge(input as string | undefined)).toBeUndefined();
    });
});

describe('dateRangeWindowDays', () => {
    it('uses the same windows as Tavily and Bright Data', () => {
        expect(dateRangeWindowDays('recent')).toBe(7);
        expect(dateRangeWindowDays('year')).toBe(365);
        expect(dateRangeWindowDays('any')).toBeUndefined();
        expect(dateRangeWindowDays(undefined)).toBeUndefined();
    });
});

describe('applyDateRange', () => {
    it('keeps results inside the window, drops those outside, boundary inclusive', () => {
        const results = [
            r('in', 'November 14, 2026'),
            r('boundary', 'November 8, 2026'), // exactly 7 days ago (UTC day): kept
            r('out', 'November 7, 2026'),
            r('old', 'January 1, 2020'),
        ];
        const out = applyDateRange(results, 'recent', NOW);
        expect(out.results.map(x => x.url)).toEqual(['in', 'boundary']);
        expect(out.report).toEqual({ constraint: 'dateRange', outcome: 'applied', undatedCount: 0, filteredCount: 2 });
    });

    it('keeps undated results, counts them, and reports partial', () => {
        const out = applyDateRange([r('a', 'November 14, 2026'), r('b'), r('c', 'not a date')], 'recent', NOW);
        expect(out.results.map(x => x.url)).toEqual(['a', 'b', 'c']);
        expect(out.report).toMatchObject({ outcome: 'partial', undatedCount: 2, filteredCount: 0 });
    });

    it('reports unsupported when nothing has a readable date (and keeps everything)', () => {
        const out = applyDateRange([r('a'), r('b', 'yesterday')], 'year', NOW);
        expect(out.results).toHaveLength(2);
        expect(out.report).toMatchObject({ outcome: 'unsupported', undatedCount: 2 });
    });

    it('year window is 365 days', () => {
        const out = applyDateRange([r('in', 'November 16, 2025'), r('out', 'November 14, 2025')], 'year', NOW);
        expect(out.results.map(x => x.url)).toEqual(['in']);
    });

    it('any / undefined is a no-op with no filtering', () => {
        const input = [r('a', 'January 1, 2000')];
        expect(applyDateRange(input, 'any', NOW).results).toBe(input);
        expect(applyDateRange(input, undefined, NOW).results).toBe(input);
    });

    it('an empty list is applied, not unsupported', () => {
        expect(applyDateRange([], 'recent', NOW).report.outcome).toBe('applied');
    });
});

describe('mergeConstraintReports', () => {
    it('adds counts and keeps the worst outcome', () => {
        const merged = mergeConstraintReports(
            [{ constraint: 'dateRange', outcome: 'applied', undatedCount: 0, filteredCount: 2 }],
            undefined,
            [{ constraint: 'dateRange', outcome: 'partial', undatedCount: 3, filteredCount: 1 }],
        );
        expect(merged).toEqual([{ constraint: 'dateRange', outcome: 'partial', undatedCount: 3, filteredCount: 3 }]);
    });
});

function apiResponse(pageAges: Array<string | undefined>) {
    return {
        status: 200,
        headers: {},
        json: {
            content: [
                {
                    type: 'web_search_tool_result',
                    content: pageAges.map((age, i) => ({
                        type: 'web_search_result', url: `https://example.com/${i}`, title: `T${i}`, ...(age ? { page_age: age } : {}),
                    })),
                },
                { type: 'text', text: 'answer' },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
            stop_reason: 'end_turn',
        },
    };
}

describe('ClaudeWebSearchAdapter dateRange', () => {
    const adapter = new ClaudeWebSearchAdapter(async () => 'k', { model: 'claude-sonnet-4-6', maxSearches: 5, useDynamicFiltering: true });
    const today = (): string => new Date().toISOString().slice(0, 10);

    beforeEach(() => { vi.clearAllMocks(); });

    it('filters the returned list for recent and reports it (non-stream)', async () => {
        mockRequestUrl.mockResolvedValue(apiResponse([today(), '2019-01-01', undefined]));
        const res = await adapter.searchAndSynthesize('q', { dateRange: 'recent' });
        expect(res.searchResults.map(x => x.url)).toEqual(['https://example.com/0', 'https://example.com/2']);
        expect(res.constraintReports).toEqual([{ constraint: 'dateRange', outcome: 'partial', undatedCount: 1, filteredCount: 1 }]);
    });

    it('does nothing and reports nothing without a dateRange or with any', async () => {
        mockRequestUrl.mockResolvedValue(apiResponse(['2019-01-01']));
        const a = await adapter.searchAndSynthesize('q');
        const b = await adapter.searchAndSynthesize('q', { dateRange: 'any' });
        expect(a.searchResults).toHaveLength(1);
        expect(a.constraintReports).toBeUndefined();
        expect(b.searchResults).toHaveLength(1);
        expect(b.constraintReports).toBeUndefined();
    });

    it('the request body carries no date field (the API cannot take one)', async () => {
        mockRequestUrl.mockResolvedValue(apiResponse([today()]));
        await adapter.searchAndSynthesize('q', { dateRange: 'recent' });
        const body = JSON.parse(mockRequestUrl.mock.calls[0][0].body as string);
        expect(JSON.stringify(body.tools)).not.toMatch(/date|recent|days/i);
    });

    it('applies on the multi-turn and continuation paths too', async () => {
        mockRequestUrl.mockResolvedValue(apiResponse(['2019-01-01']));
        const m = await adapter.searchAndSynthesizeMultiTurn([{ role: 'user', content: 'q' }], { dateRange: 'year' });
        const c = await adapter.continueSearch('q', [], { dateRange: 'year' });
        expect(m.searchResults).toHaveLength(0);
        expect(c.searchResults).toHaveLength(0);
        expect(m.constraintReports?.[0].filteredCount).toBe(1);
    });

    it('search() hands the report to takeConstraintReports once', async () => {
        mockRequestUrl.mockResolvedValue(apiResponse([today(), undefined]));
        const results = await adapter.search('q', { dateRange: 'recent' });
        expect(results).toHaveLength(2);
        expect(adapter.takeConstraintReports()).toEqual([{ constraint: 'dateRange', outcome: 'partial', undatedCount: 1, filteredCount: 0 }]);
        expect(adapter.takeConstraintReports()).toEqual([]);
    });
});

describe('user-visible strings', () => {
    it('exist for every outcome and the partial one carries the count', () => {
        const t = en.modals.unifiedChat;
        expect(t.researchDateRangeApplied.length).toBeGreaterThan(10);
        expect(t.researchDateRangeUnsupported.length).toBeGreaterThan(10);
        expect(t.researchDateRangePartial).toContain('{count}');
    });
});

describe('ResearchSearchService aggregates constraint reports', () => {
    it('collects reports across queries and providers and hands them over once', async () => {
        const { ResearchSearchService } = await import('../src/services/research/researchSearchService');
        const svc = new ResearchSearchService({
            settings: { researchProvider: 'claude-web-search' },
            secretStorageService: { getSecret: vi.fn().mockResolvedValue('k') },
        } as never);
        const provider = {
            type: 'claude-web-search' as const,
            search: vi.fn().mockResolvedValue([r('https://example.com/a', 'November 14, 2026')]),
            isConfigured: vi.fn().mockResolvedValue(true),
            takeConstraintReports: vi.fn()
                .mockReturnValueOnce([{ constraint: 'dateRange', outcome: 'applied', undatedCount: 0, filteredCount: 2 }]),
        };
        (svc as unknown as { providers: Map<string, unknown> }).providers = new Map([['claude-web-search', provider]]);
        await svc.search(['q1', 'q2'], { dateRange: 'recent' });
        expect(svc.takeConstraintReports()).toEqual([{ constraint: 'dateRange', outcome: 'applied', undatedCount: 0, filteredCount: 2 }]);
        expect(svc.takeConstraintReports()).toEqual([]);
    });
});

describe('ResearchOrchestrator surfaces constraint reports', () => {
    it('returns the merged reports from the Claude web search result (continuations merge)', async () => {
        const { ResearchOrchestrator } = await import('../src/services/research/researchOrchestrator');
        vi.stubGlobal('window', { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) });
        const first = { searchResults: [], synthesis: 'a', citations: [], searchCount: 1, usage: { inputTokens: 0, outputTokens: 0 }, paused: true, rawContent: [],
            constraintReports: [{ constraint: 'dateRange', outcome: 'applied', undatedCount: 0, filteredCount: 1 }] };
        const second = { ...first, synthesis: 'b', paused: false, constraintReports: [{ constraint: 'dateRange', outcome: 'partial', undatedCount: 2, filteredCount: 0 }] };
        const provider = {
            maxContinuations: 3,
            searchAndSynthesize: vi.fn().mockResolvedValue(first),
            continueSearch: vi.fn().mockResolvedValue(second),
        };
        const orch = new ResearchOrchestrator({ getProvider: () => provider } as never, { settings: { enableResearchQualityScoring: false }, secretStorageService: { getSecret: vi.fn() } } as never);
        const out = await orch.executeClaudeWebSearch('q', { dateRange: 'recent' });
        expect(out.constraintReports).toEqual([{ constraint: 'dateRange', outcome: 'partial', undatedCount: 2, filteredCount: 1 }]);
        vi.unstubAllGlobals();
    });
});
