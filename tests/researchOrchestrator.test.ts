/**
 * ResearchOrchestrator tests
 *
 * Tests all orchestrator phases: decompose, triage, contextual answer,
 * extraction, synthesis, citation verification, and session management.
 * Mocks: llmFacade, obsidian (requestUrl), @mozilla/readability, plus injected search service.
 */

// ── Module-level mocks (hoisted by vitest) ──

const mockSummarizeText = vi.fn();
const mockRequestUrl = vi.fn();
const MockReadability = vi.fn();

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
    PERSPECTIVE_PRESETS: {
        balanced: ['practitioner', 'critic', 'historian', 'futurist'],
        critical: ['proponent', 'skeptic', 'ethicist', 'empiricist'],
    },
}));

const MockRAGService = vi.fn();
vi.mock('../src/services/ragService', () => ({
    RAGService: function (...args: unknown[]) { return MockRAGService(...args); },
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

import { ResearchOrchestrator } from '../src/services/research/researchOrchestrator';
import { TFolder, createTFile } from './mocks/obsidian';
import type { SearchResult, ResearchSessionState, SourceExtraction, PerspectiveQuery } from '../src/services/research/researchTypes';

// ── Fixtures ──

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
            fileManager: {
                trashFile: vi.fn().mockResolvedValue(undefined),
            },
        },
        secretStorageService: {
            getSecret: vi.fn().mockResolvedValue(null),
        },
    } as any;
}

function makeSearchService() {
    return {
        search: vi.fn(),
    } as any;
}

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
    return {
        title: 'Test Page',
        url: 'https://example.com/page',
        snippet: 'A snippet about the topic.',
        source: 'web',
        domain: 'example.com',
        ...overrides,
    };
}

function makeSessionState(overrides: Partial<ResearchSessionState> = {}): ResearchSessionState {
    return {
        question: 'What is quantum computing?',
        searchResults: [],
        selectedUrls: [],
        sourceSummaries: {},
        provider: 'tavily',
        siteScope: 'all',
        phase: 'searching',
        timestamp: Date.now(),
        ...overrides,
    };
}

// ── Test suites ──

describe('ResearchOrchestrator', () => {
    let orchestrator: ResearchOrchestrator;
    let plugin: ReturnType<typeof makePlugin>;
    let searchService: ReturnType<typeof makeSearchService>;

    beforeEach(() => {
        vi.clearAllMocks();
        plugin = makePlugin();
        searchService = makeSearchService();
        orchestrator = new ResearchOrchestrator(searchService, plugin);
    });

    // ═══ decomposeQuestion ═══

    describe('decomposeQuestion', () => {
        it('returns parsed JSON queries from LLM', async () => {
            mockSummarizeText.mockResolvedValue({
                success: true,
                content: '["query A", "query B", "query C"]',
            });

            const result = await orchestrator.decomposeQuestion('What is quantum computing?');

            expect(result).toEqual(['query A', 'query B', 'query C']);
        });

        it('caps at 5 queries even if LLM returns more', async () => {
            mockSummarizeText.mockResolvedValue({
                success: true,
                content: '["q1","q2","q3","q4","q5","q6","q7"]',
            });

            const result = await orchestrator.decomposeQuestion('topic');

            expect(result).toHaveLength(5);
        });

        it('falls back to [question] when LLM fails', async () => {
            mockSummarizeText.mockResolvedValue({ success: false, content: '' });

            const result = await orchestrator.decomposeQuestion('My question');

            expect(result).toEqual(['My question']);
        });

        it('falls back to [question] on invalid JSON response', async () => {
            mockSummarizeText.mockResolvedValue({
                success: true,
                content: 'This is not JSON at all',
            });

            const result = await orchestrator.decomposeQuestion('My question');

            expect(result).toEqual(['My question']);
        });

        it('falls back to [question] when LLM returns non-array JSON', async () => {
            mockSummarizeText.mockResolvedValue({
                success: true,
                content: '{"queries": ["a", "b"]}',
            });

            const result = await orchestrator.decomposeQuestion('My question');

            expect(result).toEqual(['My question']);
        });
    });

    // ═══ triageResults ═══

    describe('triageResults', () => {
        it('returns empty for no results', async () => {
            const result = await orchestrator.triageResults([], 'question');

            expect(result).toEqual({ results: [], preSelectedUrls: [] });
            expect(mockSummarizeText).not.toHaveBeenCalled();
        });

        it('updates scores from LLM assessment', async () => {
            const results = [
                makeResult({ url: 'https://a.com', title: 'A' }),
                makeResult({ url: 'https://b.com', title: 'B' }),
            ];

            mockSummarizeText.mockResolvedValue({
                success: true,
                content: JSON.stringify([
                    { url: 'https://a.com', score: 8, assessment: 'Highly relevant', selected: true },
                    { url: 'https://b.com', score: 3, assessment: 'Tangential', selected: false },
                ]),
            });

            const { results: triaged, preSelectedUrls } = await orchestrator.triageResults(results, 'question');

            expect(triaged[0].url).toBe('https://a.com');
            expect(triaged[0].score).toBe(0.8);
            expect(triaged[0].triageAssessment).toBe('Highly relevant');
            expect(triaged[1].score).toBe(0.3);
            expect(preSelectedUrls).toEqual(['https://a.com']);
        });

        it('sorts results by score descending after triage', async () => {
            const results = [
                makeResult({ url: 'https://low.com' }),
                makeResult({ url: 'https://high.com' }),
            ];

            mockSummarizeText.mockResolvedValue({
                success: true,
                content: JSON.stringify([
                    { url: 'https://low.com', score: 2, assessment: 'Low', selected: false },
                    { url: 'https://high.com', score: 9, assessment: 'High', selected: true },
                ]),
            });

            const { results: triaged } = await orchestrator.triageResults(results, 'question');

            expect(triaged[0].url).toBe('https://high.com');
            expect(triaged[1].url).toBe('https://low.com');
        });

        it('falls back to first 3 URLs on LLM failure', async () => {
            const results = [
                makeResult({ url: 'https://a.com' }),
                makeResult({ url: 'https://b.com' }),
                makeResult({ url: 'https://c.com' }),
                makeResult({ url: 'https://d.com' }),
            ];

            mockSummarizeText.mockResolvedValue({ success: false, content: '' });

            const { preSelectedUrls } = await orchestrator.triageResults(results, 'question');

            expect(preSelectedUrls).toEqual(['https://a.com', 'https://b.com', 'https://c.com']);
        });

        it('falls back to first 3 on JSON parse failure', async () => {
            const results = [
                makeResult({ url: 'https://a.com' }),
                makeResult({ url: 'https://b.com' }),
                makeResult({ url: 'https://c.com' }),
                makeResult({ url: 'https://d.com' }),
            ];

            mockSummarizeText.mockResolvedValue({
                success: true,
                content: 'not valid json',
            });

            const { preSelectedUrls } = await orchestrator.triageResults(results, 'question');

            expect(preSelectedUrls).toEqual(['https://a.com', 'https://b.com', 'https://c.com']);
        });

        it('falls back to first 3 when no assessments have selected=true', async () => {
            const results = [
                makeResult({ url: 'https://a.com' }),
                makeResult({ url: 'https://b.com' }),
                makeResult({ url: 'https://c.com' }),
                makeResult({ url: 'https://d.com' }),
            ];

            mockSummarizeText.mockResolvedValue({
                success: true,
                content: JSON.stringify([
                    { url: 'https://a.com', score: 5, assessment: 'OK', selected: false },
                    { url: 'https://b.com', score: 4, assessment: 'OK', selected: false },
                    { url: 'https://c.com', score: 3, assessment: 'OK', selected: false },
                    { url: 'https://d.com', score: 2, assessment: 'OK', selected: false },
                ]),
            });

            const { preSelectedUrls } = await orchestrator.triageResults(results, 'question');

            // Falls back to top 3 by score since none selected
            expect(preSelectedUrls).toHaveLength(3);
        });
    });

    // ═══ tryAnswerFromContext ═══

    describe('tryAnswerFromContext', () => {
        it('returns answer when answerable', async () => {
            mockSummarizeText.mockResolvedValue({
                success: true,
                content: JSON.stringify({ answerable: true, answer: 'The answer is 42.' }),
            });

            const result = await orchestrator.tryAnswerFromContext(
                'What is the answer?',
                [makeResult()],
            );

            expect(result).toBe('The answer is 42.');
        });

        it('returns null when not answerable', async () => {
            mockSummarizeText.mockResolvedValue({
                success: true,
                content: JSON.stringify({ answerable: false, answer: '' }),
            });

            const result = await orchestrator.tryAnswerFromContext(
                'What is the answer?',
                [makeResult()],
            );

            expect(result).toBeNull();
        });

        it('returns null on LLM failure', async () => {
            mockSummarizeText.mockResolvedValue({ success: false, content: '' });

            const result = await orchestrator.tryAnswerFromContext(
                'What is the answer?',
                [makeResult()],
            );

            expect(result).toBeNull();
        });

        it('returns null on invalid JSON response', async () => {
            mockSummarizeText.mockResolvedValue({
                success: true,
                content: 'not json',
            });

            const result = await orchestrator.tryAnswerFromContext(
                'What is the answer?',
                [makeResult()],
            );

            expect(result).toBeNull();
        });
    });

    // ═══ extractSources ═══

    describe('extractSources', () => {
        it('extracts from Tavily inline content (skips fetch)', async () => {
            const results = [
                makeResult({
                    url: 'https://tavily.com/article',
                    extractedContent: 'Pre-extracted article text',
                }),
            ];

            mockSummarizeText.mockResolvedValue({
                success: true,
                content: '- Finding 1\n- Finding 2',
            });

            const extractions = await orchestrator.extractSources(
                ['https://tavily.com/article'],
                results,
                'What is X?',
            );

            expect(extractions).toHaveLength(1);
            expect(extractions[0].extractionMethod).toBe('tavily-inline');
            expect(extractions[0].findings).toBe('- Finding 1\n- Finding 2');
            expect(mockRequestUrl).not.toHaveBeenCalled();
        });

        it('calls requestUrl for non-Tavily results', async () => {
            const results = [makeResult({ url: 'https://example.com/page' })];

            mockRequestUrl.mockResolvedValue({
                text: '<html><body><p>Article content</p></body></html>',
                status: 200,
            });

            MockReadability.mockReturnValue({
                parse: () => ({
                    textContent: 'Parsed article content',
                    title: 'Example Page',
                }),
            });

            // Provide a global DOMParser class for parseWithReadability
            const mockDoc = {
                head: { firstChild: null, insertBefore: vi.fn() },
                createElement: vi.fn().mockReturnValue({ href: '' }),
            };
            globalThis.DOMParser = class {
                parseFromString() { return mockDoc; }
            } as any;

            mockSummarizeText.mockResolvedValue({
                success: true,
                content: '- Key finding from web',
            });

            const extractions = await orchestrator.extractSources(
                ['https://example.com/page'],
                results,
                'What is X?',
            );

            expect(mockRequestUrl).toHaveBeenCalledWith({ url: 'https://example.com/page' });
            expect(extractions[0].extractionMethod).toBe('readability');
            expect(extractions[0].findings).toBe('- Key finding from web');
        });

        it('handles fetch failures gracefully', async () => {
            const results = [makeResult({ url: 'https://fail.com' })];

            mockRequestUrl.mockRejectedValue(new Error('Network error'));

            const extractions = await orchestrator.extractSources(
                ['https://fail.com'],
                results,
                'question',
            );

            expect(extractions).toHaveLength(1);
            expect(extractions[0].error).toContain('Could not read');
        });

        it('calls onProgress callback', async () => {
            const results = [
                makeResult({ url: 'https://a.com', extractedContent: 'content A' }),
                makeResult({ url: 'https://b.com', extractedContent: 'content B' }),
            ];

            mockSummarizeText.mockResolvedValue({ success: true, content: '- finding' });

            const onProgress = vi.fn();

            await orchestrator.extractSources(
                ['https://a.com', 'https://b.com'],
                results,
                'question',
                onProgress,
            );

            expect(onProgress).toHaveBeenCalledTimes(2);
            expect(onProgress).toHaveBeenCalledWith(1, 2, 'https://a.com');
            expect(onProgress).toHaveBeenCalledWith(2, 2, 'https://b.com');
        });

        it('respects concurrency of 3 (batches requests)', async () => {
            // Create 5 URLs to verify batching: batch [0,1,2] then batch [3,4]
            const urls = Array.from({ length: 5 }, (_, i) => `https://site${i}.com`);
            const results = urls.map(url =>
                makeResult({ url, extractedContent: 'content' }),
            );

            mockSummarizeText.mockResolvedValue({ success: true, content: '- finding' });

            const extractions = await orchestrator.extractSources(urls, results, 'question');

            // All 5 URLs processed
            expect(extractions).toHaveLength(5);
            // 5 LLM extraction calls (one per URL)
            expect(mockSummarizeText).toHaveBeenCalledTimes(5);
        });

        it('returns extraction error when LLM extraction fails', async () => {
            const results = [
                makeResult({
                    url: 'https://example.com',
                    extractedContent: 'has content',
                }),
            ];

            mockSummarizeText.mockResolvedValue({ success: false, content: '' });

            const extractions = await orchestrator.extractSources(
                ['https://example.com'],
                results,
                'question',
            );

            expect(extractions[0].findings).toBe('Extraction failed');
        });
    });

    // ═══ synthesize ═══

    describe('synthesize', () => {
        const extractions: SourceExtraction[] = [
            {
                url: 'https://source1.com',
                title: 'Source One',
                findings: '- Finding from source 1',
                extractionMethod: 'readability',
            },
            {
                url: 'https://source2.com',
                title: 'Source Two',
                findings: '- Finding from source 2',
                extractionMethod: 'tavily-inline',
            },
        ];

        it('returns synthesized content from LLM', async () => {
            mockSummarizeText.mockResolvedValue({
                success: true,
                content: '## Research: Topic\n\nSynthesis paragraph [1][2].\n\n### Sources\n1. [Source One](https://source1.com)\n2. [Source Two](https://source2.com)',
            });

            const result = await orchestrator.synthesize(extractions, 'What is X?');

            expect(result.synthesis).toContain('Research: Topic');
            expect(result.synthesis).toContain('Source One');
        });

        it('filters out extractions with errors', async () => {
            const withError: SourceExtraction[] = [
                ...extractions,
                {
                    url: 'https://broken.com',
                    title: 'Broken',
                    findings: '',
                    extractionMethod: 'readability',
                    error: 'Could not read',
                },
            ];

            mockSummarizeText.mockResolvedValue({
                success: true,
                content: '## Research\n\nContent [1][2].\n\n### Sources\n1. [Source One](https://source1.com)\n2. [Source Two](https://source2.com)',
            });

            await orchestrator.synthesize(withError, 'question');

            // buildSynthesisPrompt receives 2 sources (error source filtered out)
            expect(mockSummarizeText).toHaveBeenCalledTimes(1);
        });

        it('passes includeCitations=false to skip citation verification', async () => {
            mockSummarizeText.mockResolvedValue({
                success: true,
                content: 'Clean synthesis without citations.',
            });

            const result = await orchestrator.synthesize(
                extractions,
                'question',
                undefined,
                undefined,
                false,
            );

            // When includeCitations is false, verifyCitations is NOT called,
            // so no Sources section is appended
            expect(result.synthesis).toBe('Clean synthesis without citations.');
            expect(result.synthesis).not.toContain('### Sources');
        });

        it('returns error message on LLM failure', async () => {
            mockSummarizeText.mockResolvedValue({ success: false, content: '' });

            const result = await orchestrator.synthesize(extractions, 'question');

            expect(result.synthesis).toBe('Synthesis failed. Please try again.');
        });
    });

    // ═══ verifyCitations (tested via synthesize) ═══

    describe('verifyCitations', () => {
        const extractions: SourceExtraction[] = [
            {
                url: 'https://source1.com',
                title: 'Source One',
                findings: '- Finding 1',
                extractionMethod: 'readability',
            },
            {
                url: 'https://source2.com',
                title: 'Source Two',
                findings: '- Finding 2',
                extractionMethod: 'readability',
            },
        ];

        it('strips hallucinated citations (index out of range)', async () => {
            mockSummarizeText.mockResolvedValue({
                success: true,
                content: 'Some text [1] with hallucinated [5] and [0] refs.\n\n### Sources\n1. [Source One](https://source1.com)\n2. [Source Two](https://source2.com)',
            });

            const result = await orchestrator.synthesize(extractions, 'question');

            // [1] is valid (2 sources), [5] and [0] are out of range
            expect(result.synthesis).toContain('[1]');
            expect(result.synthesis).not.toContain('[5]');
            expect(result.synthesis).not.toContain('[0]');
        });

        it('adds Sources section if missing', async () => {
            mockSummarizeText.mockResolvedValue({
                success: true,
                content: 'Synthesis text [1] with valid refs [2] but no sources section.',
            });

            const result = await orchestrator.synthesize(extractions, 'question');

            expect(result.synthesis).toContain('### Sources');
            expect(result.synthesis).toContain('1. [Source One](https://source1.com)');
            expect(result.synthesis).toContain('2. [Source Two](https://source2.com)');
        });

        it('does not duplicate Sources section if already present', async () => {
            const existingSourcesContent =
                'Text [1][2].\n\n### Sources\n1. [Source One](https://source1.com)\n2. [Source Two](https://source2.com)';
            mockSummarizeText.mockResolvedValue({
                success: true,
                content: existingSourcesContent,
            });

            const result = await orchestrator.synthesize(extractions, 'question');

            // Count occurrences of "### Sources"
            const matches = result.synthesis.match(/### Sources/g);
            expect(matches).toHaveLength(1);
        });
    });

    // ═══ Session management ═══

    describe('Session management', () => {
        it('saveSession creates file when none exists', async () => {
            plugin.app.vault.getAbstractFileByPath.mockReturnValue(null);
            plugin.app.vault.create.mockResolvedValue({});

            const state = makeSessionState();
            await orchestrator.saveSession(state);

            expect(plugin.app.vault.create).toHaveBeenCalledWith(
                expect.stringContaining('.research-session-'),
                expect.stringContaining('"question"'),
            );
        });

        it('saveSession modifies file when it already exists', async () => {
            const existingFile = createTFile('AI-Organiser/Config/.research-session-abc123.json');
            plugin.app.vault.getAbstractFileByPath.mockReturnValue(existingFile);
            plugin.app.vault.modify.mockResolvedValue(undefined);

            const state = makeSessionState();
            await orchestrator.saveSession(state);

            expect(plugin.app.vault.modify).toHaveBeenCalledWith(
                existingFile,
                expect.stringContaining('"question"'),
            );
        });

        it('clearSession deletes the session file', async () => {
            const existingFile = createTFile('AI-Organiser/Config/.research-session-abc123.json');
            plugin.app.vault.getAbstractFileByPath.mockReturnValue(existingFile);
            plugin.app.fileManager.trashFile.mockResolvedValue(undefined);

            await orchestrator.clearSession();

            expect(plugin.app.fileManager.trashFile).toHaveBeenCalledWith(existingFile);
        });

        it('clearSession does nothing if no session file exists', async () => {
            plugin.app.vault.getAbstractFileByPath.mockReturnValue(null);

            await orchestrator.clearSession();

            expect(plugin.app.fileManager.trashFile).not.toHaveBeenCalled();
        });

        it('findResumableSession returns null if config folder does not exist', async () => {
            plugin.app.vault.getAbstractFileByPath.mockReturnValue(null);

            const result = await orchestrator.findResumableSession();

            expect(result).toBeNull();
        });

        it('findResumableSession returns recent session within 1 hour', async () => {
            const state = makeSessionState({ timestamp: Date.now() - 1000 }); // 1 second ago
            const sessionFile = createTFile('AI-Organiser/Config/.research-session-abc123.json');
            sessionFile.stat = { mtime: Date.now(), ctime: Date.now(), size: 0 };

            const folder = new TFolder();
            folder.children = [sessionFile];
            plugin.app.vault.getAbstractFileByPath.mockReturnValue(folder);
            plugin.app.vault.read.mockResolvedValue(JSON.stringify(state));

            const result = await orchestrator.findResumableSession();

            expect(result).not.toBeNull();
            expect(result?.question).toBe('What is quantum computing?');
        });

        it('findResumableSession deletes expired sessions (>1 hour)', async () => {
            const state = makeSessionState({ timestamp: Date.now() - 4_000_000 }); // >1 hour
            const sessionFile = createTFile('AI-Organiser/Config/.research-session-old.json');
            sessionFile.stat = { mtime: Date.now() - 4_000_000, ctime: 0, size: 0 };

            const folder = new TFolder();
            folder.children = [sessionFile];
            plugin.app.vault.getAbstractFileByPath.mockReturnValue(folder);
            plugin.app.vault.read.mockResolvedValue(JSON.stringify(state));
            plugin.app.fileManager.trashFile.mockResolvedValue(undefined);

            const result = await orchestrator.findResumableSession();

            expect(result).toBeNull();
            expect(plugin.app.fileManager.trashFile).toHaveBeenCalled();
        });

        it('findResumableSession handles corrupted session files', async () => {
            const sessionFile = createTFile('AI-Organiser/Config/.research-session-corrupt.json');
            sessionFile.stat = { mtime: Date.now(), ctime: Date.now(), size: 0 };

            const folder = new TFolder();
            folder.children = [sessionFile];
            plugin.app.vault.getAbstractFileByPath.mockReturnValue(folder);
            plugin.app.vault.read.mockResolvedValue('not valid json{{{');
            plugin.app.fileManager.trashFile.mockResolvedValue(undefined);

            const result = await orchestrator.findResumableSession();

            expect(result).toBeNull();
            expect(plugin.app.fileManager.trashFile).toHaveBeenCalled();
        });
    });

    // ═══ executeSearch (delegates to search service) ═══

    describe('executeSearch', () => {
        it('delegates to search service', async () => {
            const mockResults = [makeResult()];
            searchService.search.mockResolvedValue(mockResults);

            const result = await orchestrator.executeSearch(['query'], { maxResults: 10 });

            expect(searchService.search).toHaveBeenCalledWith(['query'], { maxResults: 10 });
            expect(result).toEqual(mockResults);
        });
    });

    // ═══ Phase 3 features ═══

    describe('Phase 3 features', () => {
        const makeUsageService = () => ({
            checkBudget: vi.fn().mockReturnValue({ allowed: true }),
            recordOperation: vi.fn().mockResolvedValue(undefined),
        }) as any;

        const makeQualityService = () => ({
            scoreResults: vi.fn(),
        }) as any;

        // ── SERP Budget Tracking ──

        describe('SERP Budget Tracking', () => {
            it('executeSearch should check budget when brightdata-serp is provider', async () => {
                const usageService = makeUsageService();
                plugin.settings.researchProvider = 'brightdata-serp';
                searchService.search.mockResolvedValue([makeResult()]);

                const orch = new ResearchOrchestrator(searchService, plugin, { usageService });
                await orch.executeSearch(['query'], { maxResults: 10 });

                expect(usageService.checkBudget).toHaveBeenCalledWith('brightdata-serp');
            });

            it('executeSearch should throw when budget is blocked for brightdata-serp', async () => {
                const usageService = makeUsageService();
                usageService.checkBudget.mockReturnValue({
                    allowed: false,
                    message: 'Monthly budget limit reached.',
                });
                plugin.settings.researchProvider = 'brightdata-serp';

                const orch = new ResearchOrchestrator(searchService, plugin, { usageService });

                await expect(orch.executeSearch(['query'], { maxResults: 10 }))
                    .rejects.toThrow('Monthly budget limit reached');
            });

            it('executeSearch should record operation after successful brightdata-serp search', async () => {
                const usageService = makeUsageService();
                plugin.settings.researchProvider = 'brightdata-serp';
                searchService.search.mockResolvedValue([makeResult()]);

                const orch = new ResearchOrchestrator(searchService, plugin, { usageService });
                await orch.executeSearch(['query'], { maxResults: 10 });

                expect(usageService.recordOperation).toHaveBeenCalledWith('brightdata-serp');
            });

            it('executeSearch should NOT check/record budget for non-paid providers', async () => {
                const usageService = makeUsageService();
                searchService.search.mockResolvedValue([makeResult()]);

                for (const provider of ['tavily'] as const) {
                    vi.clearAllMocks();
                    plugin.settings.researchProvider = provider;
                    usageService.checkBudget.mockReturnValue({ allowed: true });
                    usageService.recordOperation.mockResolvedValue(undefined);
                    searchService.search.mockResolvedValue([makeResult()]);

                    const orch = new ResearchOrchestrator(searchService, plugin, { usageService });
                    await orch.executeSearch(['query'], { maxResults: 10 });

                    expect(usageService.checkBudget).not.toHaveBeenCalled();
                    expect(usageService.recordOperation).not.toHaveBeenCalled();
                }
            });
        });

        // ── Vault Pre-check ──

        describe('Vault Pre-check', () => {
            it('precheckVaultContext returns null when vectorStore is null', async () => {
                plugin.vectorStore = null;
                plugin.embeddingService = {};
                plugin.settings.enableSemanticSearch = true;

                const result = await orchestrator.precheckVaultContext('What is X?');

                expect(result).toBeNull();
            });

            it('precheckVaultContext returns null when semantic search is disabled', async () => {
                plugin.vectorStore = {};
                plugin.embeddingService = {};
                plugin.settings.enableSemanticSearch = false;

                const result = await orchestrator.precheckVaultContext('What is X?');

                expect(result).toBeNull();
            });

            it('precheckVaultContext returns results when RAG context found', async () => {
                plugin.vectorStore = {};
                plugin.embeddingService = {};
                plugin.settings.enableSemanticSearch = true;
                plugin.settings.researchVaultPrecheckMinSimilarity = 0.65;

                MockRAGService.mockReturnValue({
                    retrieveContext: vi.fn().mockResolvedValue({
                        chunks: [
                            { filePath: 'notes/quantum.md', similarity: 0.85, content: 'Quantum computing uses qubits...' },
                            { filePath: 'notes/physics.md', similarity: 0.72, content: 'Physics of computation...' },
                        ],
                        formattedContext: 'Related vault context here',
                    }),
                });

                const result = await orchestrator.precheckVaultContext('What is quantum computing?');

                expect(result).not.toBeNull();
                expect(result!.confidence).toBe(0.85);
                expect(result!.relatedNotes).toHaveLength(2);
                expect(result!.relatedNotes[0].path).toBe('notes/quantum.md');
                expect(result!.formattedContext).toBe('Related vault context here');
            });
        });

        // ── Perspective Decomposition ──

        describe('Perspective Decomposition', () => {
            it('wraps plain array with perspective labels when perspectiveMode is on', async () => {
                mockSummarizeText.mockResolvedValue({
                    success: true,
                    content: '["query A", "query B", "query C", "query D"]',
                });

                const result = await orchestrator.decomposeQuestion(
                    'What is quantum computing?',
                    undefined,
                    undefined,
                    undefined,
                    { perspectiveMode: true, perspectivePreset: 'balanced' },
                );

                // Should wrap plain strings with perspective labels
                expect(result).toHaveLength(4);
                const perspectiveResults = result as PerspectiveQuery[];
                expect(perspectiveResults[0]).toEqual({ query: 'query A', perspective: 'practitioner' });
                expect(perspectiveResults[1]).toEqual({ query: 'query B', perspective: 'critic' });
                expect(perspectiveResults[2]).toEqual({ query: 'query C', perspective: 'historian' });
                expect(perspectiveResults[3]).toEqual({ query: 'query D', perspective: 'futurist' });
            });

            it('returns PerspectiveQuery[] when LLM returns objects', async () => {
                const perspectiveObjects = [
                    { query: 'practitioner view on X', perspective: 'practitioner' },
                    { query: 'critical analysis of X', perspective: 'critic' },
                ];
                mockSummarizeText.mockResolvedValue({
                    success: true,
                    content: JSON.stringify(perspectiveObjects),
                });

                const result = await orchestrator.decomposeQuestion(
                    'What is X?',
                    undefined,
                    undefined,
                    undefined,
                    { perspectiveMode: true, perspectivePreset: 'balanced' },
                );

                expect(result).toHaveLength(2);
                const perspectiveResults = result as PerspectiveQuery[];
                expect(perspectiveResults[0].query).toBe('practitioner view on X');
                expect(perspectiveResults[0].perspective).toBe('practitioner');
                expect(perspectiveResults[1].query).toBe('critical analysis of X');
                expect(perspectiveResults[1].perspective).toBe('critic');
            });

            it('falls back to [question] on parse error', async () => {
                mockSummarizeText.mockResolvedValue({
                    success: true,
                    content: 'totally invalid response %%%',
                });

                const result = await orchestrator.decomposeQuestion(
                    'My question',
                    undefined,
                    undefined,
                    undefined,
                    { perspectiveMode: true, perspectivePreset: 'balanced' },
                );

                expect(result).toEqual(['My question']);
            });
        });

        // ── Quality Scoring Integration ──

        describe('Quality Scoring Integration', () => {
            it('triageResults calls qualityService.scoreResults when enabled', async () => {
                const qualityService = makeQualityService();
                plugin.settings.enableResearchQualityScoring = true;

                const orch = new ResearchOrchestrator(searchService, plugin, { qualityService });

                const results = [
                    makeResult({ url: 'https://a.com', title: 'A' }),
                ];

                mockSummarizeText.mockResolvedValue({
                    success: true,
                    content: JSON.stringify([
                        { url: 'https://a.com', score: 8, assessment: 'Relevant', selected: true },
                    ]),
                });

                await orch.triageResults(results, 'question');

                expect(qualityService.scoreResults).toHaveBeenCalledWith(results);
            });

            it('triageResults does NOT call qualityService when disabled', async () => {
                const qualityService = makeQualityService();
                plugin.settings.enableResearchQualityScoring = false;

                const orch = new ResearchOrchestrator(searchService, plugin, { qualityService });

                const results = [
                    makeResult({ url: 'https://a.com', title: 'A' }),
                ];

                mockSummarizeText.mockResolvedValue({
                    success: true,
                    content: JSON.stringify([
                        { url: 'https://a.com', score: 8, assessment: 'Relevant', selected: true },
                    ]),
                });

                await orch.triageResults(results, 'question');

                expect(qualityService.scoreResults).not.toHaveBeenCalled();
            });
        });

        // ── Academic Enrichment ──

        describe('Academic Enrichment', () => {
            it('enrichAcademicMetadata sets doi/year/authors on results', () => {
                const results = [
                    makeResult({
                        url: 'https://arxiv.org/abs/10.1234/test',
                        snippet: 'Smith et al. published in 2024 about quantum computing',
                    }),
                ];

                orchestrator.enrichAcademicMetadata(results);

                expect(results[0].doi).toBe('10.1234/test');
                expect(results[0].year).toBe(2024);
                expect(results[0].authors).toContain('Smith');
            });

            it('synthesize includes academic metadata in source metadata', async () => {
                const extractions: SourceExtraction[] = [
                    {
                        url: 'https://example.com/paper',
                        title: 'A Paper',
                        findings: '- Key finding',
                        extractionMethod: 'readability',
                    },
                ];

                const searchResults: SearchResult[] = [
                    makeResult({
                        url: 'https://example.com/paper',
                        title: 'A Paper',
                        doi: '10.1234/paper',
                        authors: ['Smith', 'Jones'],
                        year: 2024,
                    }),
                ];

                mockSummarizeText.mockResolvedValue({
                    success: true,
                    content: 'Synthesis text [1].\n\n### Sources\n1. [A Paper](https://example.com/paper)',
                });

                const result = await orchestrator.synthesize(
                    extractions,
                    'question',
                    undefined,
                    undefined,
                    true,
                    { searchResults },
                );

                expect(result.sourceMetadata).toHaveLength(1);
                expect(result.sourceMetadata[0].doi).toBe('10.1234/paper');
                expect(result.sourceMetadata[0].authors).toEqual(['Smith', 'Jones']);
                expect(result.sourceMetadata[0].year).toBe(2024);
                expect(result.sourceMetadata[0].accessedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            });
        });

        // ── Budget Enforcement in Extraction ──

        describe('Budget Enforcement in Extraction', () => {
            it('fetchWithEscalation returns null when budget is blocked', async () => {
                const usageService = makeUsageService();
                usageService.checkBudget.mockReturnValue({ allowed: false, message: 'Budget exceeded' });

                // Configure secrets so WebUnlocker/ScrapingBrowser report isConfigured() = true
                plugin.secretStorageService.getSecret.mockResolvedValue('zone-key');

                const orch = new ResearchOrchestrator(searchService, plugin, { usageService });

                // Tier 1 (requestUrl) fails so fetchContent tries escalation
                mockRequestUrl.mockRejectedValue(new Error('Network error'));

                const results = [makeResult({ url: 'https://blocked.com' })];

                const extractions = await orch.extractSources(
                    ['https://blocked.com'],
                    results,
                    'question',
                );

                // The source should fail because tier 1 failed and paid tiers are blocked by budget
                expect(extractions[0].error).toContain('Could not read');
                expect(usageService.checkBudget).toHaveBeenCalled();
            });

            it('fetchWithEscalation records operation after successful fetch', async () => {
                const usageService = makeUsageService();

                // Configure the secret so WebUnlocker.isConfigured() returns true
                plugin.secretStorageService.getSecret.mockResolvedValue('zone-key');

                const orch = new ResearchOrchestrator(searchService, plugin, { usageService });

                // Tier 1 (requestUrl) fails to force escalation
                mockRequestUrl.mockRejectedValue(new Error('Blocked'));

                // Set up DOMParser mock for Readability parsing
                const mockDoc = {
                    head: { firstChild: null, insertBefore: vi.fn() },
                    createElement: vi.fn().mockReturnValue({ href: '' }),
                };
                globalThis.DOMParser = class {
                    parseFromString() { return mockDoc; }
                } as any;

                MockReadability.mockReturnValue({
                    parse: () => ({
                        textContent: 'Unlocked content from web unlocker',
                        title: 'Page Title',
                    }),
                });

                mockSummarizeText.mockResolvedValue({
                    success: true,
                    content: '- Finding from unlocked content',
                });

                // Consent callback approves escalation
                const onEscalation = vi.fn().mockResolvedValue(true);

                const results = [makeResult({ url: 'https://example.com/locked' })];

                await orch.extractSources(
                    ['https://example.com/locked'],
                    results,
                    'question',
                    undefined,
                    undefined,
                    onEscalation,
                );

                // Budget check should have been called for a paid tier
                expect(usageService.checkBudget).toHaveBeenCalled();
            });
        });
    });
});
