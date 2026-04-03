/**
 * Escalation tests
 *
 * Tests the smart escalation chain in ResearchOrchestrator.extractSources():
 * Tier 1 (requestUrl) → Tier 2 (Web Unlocker) → Tier 3 (Scraping Browser).
 * Verifies consent handling, tier fallback, Tavily shortcut, and mixed results.
 */

// ── Module-level mocks (hoisted by vitest) ──

const mockSummarizeText = vi.fn();
const mockRequestUrl = vi.fn();
const MockReadability = vi.fn();
const mockWebUnlockerFetchHTML = vi.fn();
const mockWebUnlockerIsConfigured = vi.fn();
const mockScrapingBrowserFetchHTML = vi.fn();
const mockScrapingBrowserIsConfigured = vi.fn();
const mockScrapingBrowserForceClose = vi.fn();

vi.mock('obsidian', async () => {
    const actual = await vi.importActual('./mocks/obsidian');
    return {
        ...actual,
        requestUrl: (...args: unknown[]) => mockRequestUrl(...args),
    };
});

vi.mock('../src/services/llmFacade', () => ({
    summarizeText: (...args: unknown[]) => mockSummarizeText(...args),
    pluginContext: () => ({ type: 'mock-context' }),
}));

vi.mock('@mozilla/readability', () => ({
    Readability: function (...args: unknown[]) { return MockReadability(...args); },
}));

vi.mock('../src/services/prompts/researchPrompts', () => ({
    buildQueryDecompositionPrompt: vi.fn().mockReturnValue('decompose-prompt'),
    buildContextualAnswerPrompt: vi.fn().mockReturnValue('contextual-prompt'),
    buildResultTriagePrompt: vi.fn().mockReturnValue('triage-prompt'),
    buildSourceExtractionPrompt: vi.fn().mockReturnValue('extraction-prompt'),
    buildSynthesisPrompt: vi.fn().mockReturnValue('synthesis-prompt'),
}));

vi.mock('../src/core/settings', () => ({
    resolvePluginPath: vi.fn().mockReturnValue('AI-Organiser/Config'),
    DEFAULT_SETTINGS: {},
}));

vi.mock('../src/utils/minutesUtils', () => ({
    ensureFolderExists: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/services/canvas/canvasUtils', () => ({
    generateId: vi.fn().mockReturnValue('abc123def456ghij'),
}));

vi.mock('../src/services/research/brightdata/webUnlocker', () => {
    class MockWebUnlocker {
        fetchHTML = (...args: unknown[]) => mockWebUnlockerFetchHTML(...args);
        isConfigured = () => mockWebUnlockerIsConfigured();
    }
    return { WebUnlocker: MockWebUnlocker };
});

vi.mock('../src/services/research/brightdata/scrapingBrowser', () => {
    class MockScrapingBrowser {
        fetchHTML = (...args: unknown[]) => mockScrapingBrowserFetchHTML(...args);
        isConfigured = () => mockScrapingBrowserIsConfigured();
        forceClose = () => mockScrapingBrowserForceClose();
    }
    return { ScrapingBrowser: MockScrapingBrowser };
});

import { ResearchOrchestrator } from '../src/services/research/researchOrchestrator';
import type { SearchResult } from '../src/services/research/researchTypes';

function makePlugin() {
    return {
        settings: { cloudServiceType: 'openai', summaryLanguage: '' },
        app: {
            vault: {
                getAbstractFileByPath: vi.fn(),
                read: vi.fn(),
                modify: vi.fn(),
                create: vi.fn(),
                delete: vi.fn(),
            },
        },
        secretStorageService: {
            getSecret: vi.fn().mockResolvedValue(null),
        },
    } as any;
}

function makeSearchService() {
    return { search: vi.fn() } as any;
}

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
    return {
        title: 'Test Page',
        url: 'https://example.com/page',
        snippet: 'A snippet.',
        source: 'web',
        domain: 'example.com',
        ...overrides,
    };
}

function setupReadability(text: string | null) {
    MockReadability.mockReturnValue({
        parse: () => text ? { textContent: text, title: 'Parsed Title' } : null,
    });
}

describe('Escalation in extractSources()', () => {
    let orchestrator: ResearchOrchestrator;

    beforeEach(() => {
        vi.clearAllMocks();
        mockWebUnlockerIsConfigured.mockResolvedValue(false);
        mockScrapingBrowserIsConfigured.mockResolvedValue(false);
        mockSummarizeText.mockResolvedValue({
            success: true,
            content: '- Finding 1\n- Finding 2',
        });
        setupReadability('Parsed content from page');

        // Provide global DOMParser for parseWithReadability
        const mockDoc = {
            head: { firstChild: null, insertBefore: vi.fn() },
            createElement: vi.fn().mockReturnValue({ href: '' }),
        };
        globalThis.DOMParser = class {
            parseFromString() { return mockDoc; }
        } as any;

        orchestrator = new ResearchOrchestrator(makeSearchService(), makePlugin());
    });

    it('uses Tier 1 (requestUrl+Readability) when it succeeds', async () => {
        mockRequestUrl.mockResolvedValue({ text: '<html>page</html>' });
        const result = makeResult();

        const extractions = await orchestrator.extractSources(
            ['https://example.com/page'], [result], 'question',
        );

        expect(extractions).toHaveLength(1);
        expect(extractions[0].extractionMethod).toBe('readability');
        expect(extractions[0].error).toBeUndefined();
        expect(mockWebUnlockerFetchHTML).not.toHaveBeenCalled();
        expect(mockScrapingBrowserFetchHTML).not.toHaveBeenCalled();
    });

    it('falls back to Tier 2 (Web Unlocker) when Tier 1 fails', async () => {
        mockRequestUrl.mockRejectedValue(new Error('403 Forbidden'));
        mockWebUnlockerIsConfigured.mockResolvedValue(true);
        mockWebUnlockerFetchHTML.mockResolvedValue('<html>unlocked</html>');
        const onEscalation = vi.fn().mockResolvedValue(true);

        const extractions = await orchestrator.extractSources(
            ['https://blocked.com/page'],
            [makeResult({ url: 'https://blocked.com/page' })],
            'question', undefined, undefined, onEscalation,
        );

        expect(extractions[0].extractionMethod).toBe('web-unlocker');
        expect(extractions[0].error).toBeUndefined();
        expect(onEscalation).toHaveBeenCalledWith('https://blocked.com/page', 'web-unlocker');
        expect(mockScrapingBrowserFetchHTML).not.toHaveBeenCalled();
    });

    it('falls back to Tier 3 (Scraping Browser) when Tiers 1+2 fail', async () => {
        mockRequestUrl.mockRejectedValue(new Error('403'));
        mockWebUnlockerIsConfigured.mockResolvedValue(true);
        mockWebUnlockerFetchHTML.mockRejectedValue(new Error('Unlocker also failed'));
        mockScrapingBrowserIsConfigured.mockResolvedValue(true);
        mockScrapingBrowserFetchHTML.mockResolvedValue('<html>browser-rendered</html>');
        const onEscalation = vi.fn().mockResolvedValue(true);

        const extractions = await orchestrator.extractSources(
            ['https://spa.example.com'],
            [makeResult({ url: 'https://spa.example.com' })],
            'question', undefined, undefined, onEscalation,
        );

        expect(extractions[0].extractionMethod).toBe('scraping-browser');
        expect(extractions[0].error).toBeUndefined();
        expect(onEscalation).toHaveBeenCalledTimes(2);
        expect(onEscalation).toHaveBeenCalledWith('https://spa.example.com', 'web-unlocker');
        expect(onEscalation).toHaveBeenCalledWith('https://spa.example.com', 'scraping-browser');
    });

    it('skips Tier 2 when Web Unlocker is not configured', async () => {
        mockRequestUrl.mockRejectedValue(new Error('403'));
        mockWebUnlockerIsConfigured.mockResolvedValue(false);
        mockScrapingBrowserIsConfigured.mockResolvedValue(true);
        mockScrapingBrowserFetchHTML.mockResolvedValue('<html>browser</html>');
        const onEscalation = vi.fn().mockResolvedValue(true);

        const extractions = await orchestrator.extractSources(
            ['https://example.com/page'],
            [makeResult()],
            'question', undefined, undefined, onEscalation,
        );

        expect(extractions[0].extractionMethod).toBe('scraping-browser');
        // Only called once for scraping-browser, not for web-unlocker
        expect(onEscalation).toHaveBeenCalledTimes(1);
        expect(onEscalation).toHaveBeenCalledWith('https://example.com/page', 'scraping-browser');
    });

    it('returns error when all tiers fail', async () => {
        mockRequestUrl.mockRejectedValue(new Error('403'));
        mockWebUnlockerIsConfigured.mockResolvedValue(true);
        mockWebUnlockerFetchHTML.mockRejectedValue(new Error('Unlocker failed'));
        mockScrapingBrowserIsConfigured.mockResolvedValue(true);
        mockScrapingBrowserFetchHTML.mockRejectedValue(new Error('Browser failed'));
        const onEscalation = vi.fn().mockResolvedValue(true);

        setupReadability(null); // Readability returns nothing

        const extractions = await orchestrator.extractSources(
            ['https://hopeless.com'],
            [makeResult({ url: 'https://hopeless.com' })],
            'question', undefined, undefined, onEscalation,
        );

        expect(extractions[0].error).toContain('Could not read');
        expect(extractions[0].findings).toBe('');
    });

    it('skips escalation when consent is denied', async () => {
        mockRequestUrl.mockRejectedValue(new Error('403'));
        mockWebUnlockerIsConfigured.mockResolvedValue(true);
        mockScrapingBrowserIsConfigured.mockResolvedValue(true);
        const onEscalation = vi.fn().mockResolvedValue(false);

        setupReadability(null);

        const extractions = await orchestrator.extractSources(
            ['https://blocked.com'],
            [makeResult({ url: 'https://blocked.com' })],
            'question', undefined, undefined, onEscalation,
        );

        expect(extractions[0].error).toContain('Could not read');
        expect(mockWebUnlockerFetchHTML).not.toHaveBeenCalled();
        expect(mockScrapingBrowserFetchHTML).not.toHaveBeenCalled();
    });

    it('skips all escalation when no consent callback provided', async () => {
        mockRequestUrl.mockRejectedValue(new Error('403'));
        mockWebUnlockerIsConfigured.mockResolvedValue(true);
        mockScrapingBrowserIsConfigured.mockResolvedValue(true);

        setupReadability(null);

        const extractions = await orchestrator.extractSources(
            ['https://blocked.com'],
            [makeResult({ url: 'https://blocked.com' })],
            'question',
        );

        expect(extractions[0].error).toContain('Could not read');
        expect(mockWebUnlockerFetchHTML).not.toHaveBeenCalled();
        expect(mockScrapingBrowserFetchHTML).not.toHaveBeenCalled();
    });

    it('Tavily inline content skips all escalation', async () => {
        const result = makeResult({ extractedContent: 'Tavily pre-extracted content' });
        mockWebUnlockerIsConfigured.mockResolvedValue(true);
        mockScrapingBrowserIsConfigured.mockResolvedValue(true);

        const extractions = await orchestrator.extractSources(
            ['https://example.com/page'], [result], 'question',
        );

        expect(extractions[0].extractionMethod).toBe('tavily-inline');
        expect(mockRequestUrl).not.toHaveBeenCalled();
        expect(mockWebUnlockerFetchHTML).not.toHaveBeenCalled();
        expect(mockScrapingBrowserFetchHTML).not.toHaveBeenCalled();
    });

    it('handles mixed success/failure across multiple sources', async () => {
        // Source 1: Tier 1 works
        // Source 2: Needs Web Unlocker
        // Source 3: All tiers fail
        mockRequestUrl
            .mockResolvedValueOnce({ text: '<html>success</html>' })
            .mockRejectedValueOnce(new Error('403'))
            .mockRejectedValueOnce(new Error('403'));

        mockWebUnlockerIsConfigured.mockResolvedValue(true);
        mockWebUnlockerFetchHTML
            .mockResolvedValueOnce('<html>unlocked</html>')
            .mockRejectedValueOnce(new Error('Also failed'));

        mockScrapingBrowserIsConfigured.mockResolvedValue(false);

        const onEscalation = vi.fn().mockResolvedValue(true);
        setupReadability('Parsed text');

        const results = [
            makeResult({ url: 'https://a.com' }),
            makeResult({ url: 'https://b.com' }),
            makeResult({ url: 'https://c.com' }),
        ];

        // Source 3 needs Readability to fail on the unlocked HTML too
        let readabilityCallCount = 0;
        MockReadability.mockImplementation(() => ({
            parse: () => {
                readabilityCallCount++;
                // Third call (source 3 via web unlocker) returns null
                if (readabilityCallCount === 4) return null;
                return { textContent: 'Parsed text', title: 'Title' };
            },
        }));

        const extractions = await orchestrator.extractSources(
            ['https://a.com', 'https://b.com', 'https://c.com'],
            results, 'question', undefined, undefined, onEscalation,
        );

        expect(extractions).toHaveLength(3);
        expect(extractions[0].extractionMethod).toBe('readability');
        expect(extractions[0].error).toBeUndefined();
        expect(extractions[1].extractionMethod).toBe('web-unlocker');
        expect(extractions[1].error).toBeUndefined();
        expect(extractions[2].error).toContain('Could not read');
    });

    it('forceCleanup calls scrapingBrowser.forceClose', () => {
        orchestrator.forceCleanup();

        expect(mockScrapingBrowserForceClose).toHaveBeenCalledOnce();
    });
});
