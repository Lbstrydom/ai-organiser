/**
 * QuickPeekService tests
 * Covers: provider resolution, extraction success/failure, LLM success/failure,
 *         fallback excerpt, AbortSignal, one-time fallback notice.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('obsidian', async () => {
    const actual = await vi.importActual('./mocks/obsidian');
    return {
        ...actual,
        Notice: vi.fn().mockImplementation(function MockNotice() { return {}; })
    };
});

const mockExtractContent = vi.fn();
// Must use `function` (not arrow) so it can be called with `new`
vi.mock('../src/services/contentExtractionService', () => ({
    ContentExtractionService: function MockCES() {
        return {
            extractContent: (...args: unknown[]) => mockExtractContent(...args),
            setAudioTranscriptionConfig: () => {}
        };
    }
}));

const mockGetYouTubeGeminiApiKey = vi.fn().mockResolvedValue(null);
const mockGetAudioTranscriptionApiKey = vi.fn().mockResolvedValue(null);
const mockGetQuickPeekProviderConfig = vi.fn().mockResolvedValue(null);
vi.mock('../src/services/apiKeyHelpers', () => ({
    getYouTubeGeminiApiKey: (...a: unknown[]) => mockGetYouTubeGeminiApiKey(...a),
    getAudioTranscriptionApiKey: (...a: unknown[]) => mockGetAudioTranscriptionApiKey(...a),
    getQuickPeekProviderConfig: (...a: unknown[]) => mockGetQuickPeekProviderConfig(...a)
}));

const mockSummarizeText = vi.fn();
const mockPluginContext = vi.fn().mockReturnValue({});
vi.mock('../src/services/llmFacade', () => ({
    summarizeText: (...a: unknown[]) => mockSummarizeText(...a),
    pluginContext: (...a: unknown[]) => mockPluginContext(...a)
}));

vi.mock('../src/services/prompts/triagePrompts', () => ({
    buildTriagePrompt: vi.fn().mockReturnValue('PROMPT_TEMPLATE'),
    insertContentIntoTriagePrompt: vi.fn().mockImplementation((_: string, content: string) => `PROMPT:${content}`)
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

import { QuickPeekService } from '../src/services/quickPeekService';
import type { DetectedContent } from '../src/utils/embeddedContentDetector';

function makePlugin(overrides: Record<string, unknown> = {}): unknown {
    return {
        app: {},
        settings: {
            quickPeekProvider: 'main',
            quickPeekModel: '',
            summaryLanguage: '',
            debugMode: false,
            youtubeGeminiModel: '',
            ...overrides
        },
        t: {
            messages: {
                quickPeekProviderFallback: 'Quick Peek specialist provider unavailable — using main provider'
            }
        }
    };
}

function makeItem(type = 'web-link', url = 'https://example.com'): DetectedContent {
    return {
        type,
        url,
        displayName: url,
        originalText: `[${url}](${url})`,
        lineNumber: 1,
        isExternal: true,
        isEmbedded: false
    } as DetectedContent;
}

function makeExtractResult(success: boolean, content?: string, error?: string) {
    return {
        textContent: [{ success, content: content ?? null, error: error ?? null }]
    };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('QuickPeekService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetQuickPeekProviderConfig.mockResolvedValue(null);
        mockSummarizeText.mockResolvedValue({ success: true, content: 'LLM summary.' });
    });

    describe('triageSources — extraction success + LLM success', () => {
        it('returns triage summary when extraction and LLM both succeed', async () => {
            mockExtractContent.mockResolvedValue(makeExtractResult(true, 'Article text'));
            const service = new QuickPeekService({} as never, makePlugin() as never);
            const result = await service.triageSources([makeItem()]);

            expect(result.sources).toHaveLength(1);
            expect(result.sources[0].triageSummary).toBe('LLM summary.');
            expect(result.sources[0].llmFailed).toBe(false);
            expect(result.sources[0].extractionError).toBeNull();
            expect(result.totalTriaged).toBe(1);
            expect(result.totalFailed).toBe(0);
        });

        it('truncates extracted text to QUICK_PEEK_MAX_EXTRACT_CHARS (3000 chars)', async () => {
            const longText = 'x'.repeat(5000);
            mockExtractContent.mockResolvedValue(makeExtractResult(true, longText));

            const { insertContentIntoTriagePrompt } = await import('../src/services/prompts/triagePrompts');
            const service = new QuickPeekService({} as never, makePlugin() as never);
            await service.triageSources([makeItem()]);

            const call = vi.mocked(insertContentIntoTriagePrompt).mock.calls[0];
            expect(String(call[1]).length).toBe(3000);
        });
    });

    describe('triageSources — extraction failure', () => {
        it('returns null triageSummary and extractionError when extraction fails', async () => {
            mockExtractContent.mockResolvedValue(makeExtractResult(false, undefined, 'Network error'));
            const service = new QuickPeekService({} as never, makePlugin() as never);
            const result = await service.triageSources([makeItem()]);

            expect(result.sources[0].triageSummary).toBeNull();
            expect(result.sources[0].extractionError).toBe('Network error');
            expect(result.totalFailed).toBe(1);
        });
    });

    describe('triageSources — LLM failure', () => {
        it('uses fallback excerpt (200 chars) when LLM fails', async () => {
            const text = 'A'.repeat(500);
            mockExtractContent.mockResolvedValue(makeExtractResult(true, text));
            mockSummarizeText.mockResolvedValue({ success: false });

            const service = new QuickPeekService({} as never, makePlugin() as never);
            const result = await service.triageSources([makeItem()]);

            expect(result.sources[0].llmFailed).toBe(true);
            expect(result.sources[0].triageSummary).toBe('A'.repeat(200));
        });

        it('uses fallback excerpt when LLM throws', async () => {
            const text = 'B'.repeat(300);
            mockExtractContent.mockResolvedValue(makeExtractResult(true, text));
            mockSummarizeText.mockRejectedValue(new Error('timeout'));

            const service = new QuickPeekService({} as never, makePlugin() as never);
            const result = await service.triageSources([makeItem()]);

            expect(result.sources[0].llmFailed).toBe(true);
            expect(result.sources[0].triageSummary).toBe('B'.repeat(200));
        });
    });

    describe('triageSources — AbortSignal', () => {
        it('stops processing when signal is aborted before an item', async () => {
            const controller = new AbortController();
            controller.abort();

            mockExtractContent.mockResolvedValue(makeExtractResult(true, 'text'));
            const service = new QuickPeekService({} as never, makePlugin() as never);
            const items = [makeItem(), makeItem('web-link', 'https://b.com')];
            const result = await service.triageSources(items, undefined, controller.signal);

            // Should process 0 items (signal already aborted)
            expect(result.sources).toHaveLength(0);
        });
    });

    describe('provider resolution', () => {
        it('uses main provider when quickPeekProvider is main', async () => {
            mockExtractContent.mockResolvedValue(makeExtractResult(true, 'text'));
            const service = new QuickPeekService({} as never, makePlugin() as never);
            await service.triageSources([makeItem()]);

            expect(mockSummarizeText).toHaveBeenCalledTimes(1);
        });

        it('shows one-time notice when specialist provider key is missing', async () => {
            const { Notice } = await import('obsidian');
            const plugin = makePlugin({ quickPeekProvider: 'gemini' });

            // Simulate missing key → getQuickPeekProviderConfig returns null
            mockGetQuickPeekProviderConfig.mockResolvedValue(null);
            mockExtractContent.mockResolvedValue(makeExtractResult(true, 'text'));

            const service = new QuickPeekService({} as never, plugin as never);
            await service.triageSources([makeItem()]);
            await service.triageSources([makeItem()]); // second run

            // Notice should appear only once per provider key
            expect(vi.mocked(Notice)).toHaveBeenCalledTimes(1);
        });
    });

    describe('onProgress callback', () => {
        it('calls onProgress for each item', async () => {
            mockExtractContent.mockResolvedValue(makeExtractResult(true, 'text'));
            const progress = vi.fn();
            const items = [makeItem(), makeItem('pdf', 'file.pdf')];
            const service = new QuickPeekService({} as never, makePlugin() as never);
            await service.triageSources(items, progress);

            expect(progress).toHaveBeenCalledTimes(2);
            expect(progress).toHaveBeenNthCalledWith(1, 1, 2, items[0]);
            expect(progress).toHaveBeenNthCalledWith(2, 2, 2, items[1]);
        });
    });
});
