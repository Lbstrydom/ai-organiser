import { vi } from 'vitest';

vi.mock('obsidian', async () => await import('./mocks/obsidian'));

const mocks = vi.hoisted(() => ({
    ensurePrivacyConsentMock: vi.fn(),
    getYouTubeGeminiApiKeyMock: vi.fn(),
    getAudioTranscriptionApiKeyMock: vi.fn(),
    getMaxContentCharsMock: vi.fn(),
    getPdfProviderConfigMock: vi.fn()
}));

vi.mock('../src/services/privacyNotice', () => ({
    ensurePrivacyConsent: mocks.ensurePrivacyConsentMock
}));

vi.mock('../src/services/apiKeyHelpers', () => ({
    getYouTubeGeminiApiKey: mocks.getYouTubeGeminiApiKeyMock,
    getAudioTranscriptionApiKey: mocks.getAudioTranscriptionApiKeyMock
}));

vi.mock('../src/services/tokenLimits', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/services/tokenLimits')>();
    return {
        ...actual,
        getMaxContentChars: mocks.getMaxContentCharsMock
    };
});

vi.mock('../src/services/pdfTranslationService', () => ({
    getPdfProviderConfig: mocks.getPdfProviderConfigMock
}));

import { App, TFile, clearMockNotices, mockNotices } from './mocks/obsidian';
import { resolveAllPendingContent, truncatePendingContentForIntegration } from '../src/commands/integrationCommands';
import { ContentExtractionService, ExtractedContent, ExtractionResult } from '../src/services/contentExtractionService';
import { DocumentExtractionService } from '../src/services/documentExtractionService';
import * as embeddedDetector from '../src/utils/embeddedContentDetector';
import type { DetectedContent } from '../src/utils/embeddedContentDetector';

const baseMessages = {
    operationCancelled: 'Operation cancelled',
    integrationResolvingContent: 'Resolving embedded content...',
    integrationResolvingProgress: 'Resolving {current}/{total}: {item}',
    integrationResolutionComplete: 'Resolved {count} source(s)',
    integrationAudioKeyMissing: 'Audio transcription requires OpenAI/Groq API key — audio files will be skipped',
    integrationContentTruncated: 'Content was truncated to fit provider limits'
};

function createPlugin(app: App, overrides: Record<string, unknown> = {}) {
    return {
        app,
        t: { messages: baseMessages },
        settings: {
            serviceType: 'cloud',
            cloudServiceType: 'claude',
            youtubeGeminiModel: 'gemini-3-flash-preview',
            summarizeTimeoutSeconds: 120
        },
        pdfService: Object.create({}),
        documentExtractionService: Object.create(DocumentExtractionService.prototype),
        ...overrides
    } as any;
}

function buildExtractionResult(items: ExtractedContent[], errors: string[] = []): ExtractionResult {
    return {
        items,
        textContent: items.filter(item => item.success && !item.base64),
        binaryContent: items.filter(item => item.success && item.base64),
        errors
    };
}

describe('resolveAllPendingContent', () => {
    let app: App;
    let extractContentSpy: ReturnType<typeof vi.spyOn> | null = null;

    beforeEach(() => {
        app = new App();
        clearMockNotices();
        mocks.ensurePrivacyConsentMock.mockResolvedValue(true);
        mocks.getYouTubeGeminiApiKeyMock.mockResolvedValue(null);
        mocks.getAudioTranscriptionApiKeyMock.mockResolvedValue(null);
        mocks.getMaxContentCharsMock.mockReturnValue(10000);
        mocks.getPdfProviderConfigMock.mockResolvedValue(null);
        extractContentSpy = vi.spyOn(ContentExtractionService.prototype, 'extractContent');
    });

    afterEach(() => {
        extractContentSpy?.mockRestore();
        extractContentSpy = null;
        vi.clearAllMocks();
    });

    it('returns unchanged when no sources are detected', async () => {
        const plugin = createPlugin(app);
        const result = await resolveAllPendingContent(plugin, 'Just some text', undefined);

        expect(result.enrichedContent).toBe('Just some text');
        expect(result.resolvedCount).toBe(0);
        expect(extractContentSpy).not.toHaveBeenCalled();
    });

    it('replaces a web URL with extracted content', async () => {
        const plugin = createPlugin(app);
        extractContentSpy?.mockImplementation(async (items: DetectedContent[]) => buildExtractionResult(
            items.map((item: DetectedContent) => ({
                source: item,
                content: 'Extracted article text',
                success: true
            }) as ExtractedContent)
        ));

        const result = await resolveAllPendingContent(plugin, 'https://example.com', undefined);

        expect(result.enrichedContent).toContain('### Content: https://example.com');
        expect(result.enrichedContent).toContain('Extracted article text');
        expect(result.resolvedCount).toBe(1);
    });

    it('processes YouTube links without Gemini key (fallback)', async () => {
        const plugin = createPlugin(app);
        extractContentSpy?.mockImplementation(async (items: DetectedContent[]) => buildExtractionResult(
            items.map((item: DetectedContent) => ({ source: item, content: 'Transcript', success: true }) as ExtractedContent)
        ));

        const setYouTubeConfigSpy = vi.spyOn(ContentExtractionService.prototype, 'setYouTubeGeminiConfig');

        const result = await resolveAllPendingContent(plugin, 'https://youtu.be/dQw4w9WgXcQ', undefined);

        expect(result.resolvedCount).toBe(1);
        expect(setYouTubeConfigSpy).toHaveBeenCalledWith(undefined);

        setYouTubeConfigSpy.mockRestore();
    });

    it('uses Gemini config when YouTube key is available', async () => {
        const plugin = createPlugin(app);
        mocks.getYouTubeGeminiApiKeyMock.mockResolvedValue('gemini-key');
        extractContentSpy?.mockImplementation(async (items: DetectedContent[]) => buildExtractionResult(
            items.map((item: DetectedContent) => ({ source: item, content: 'Transcript', success: true }) as ExtractedContent)
        ));

        const setYouTubeConfigSpy = vi.spyOn(ContentExtractionService.prototype, 'setYouTubeGeminiConfig');

        await resolveAllPendingContent(plugin, 'https://youtu.be/dQw4w9WgXcQ', undefined);

        expect(setYouTubeConfigSpy).toHaveBeenCalledWith({
            apiKey: 'gemini-key',
            model: 'gemini-3-flash-preview',
            timeoutMs: 120000
        });

        setYouTubeConfigSpy.mockRestore();
    });

    it('extracts embedded PDF content as text-only when no multimodal provider', async () => {
        const plugin = createPlugin(app);
        mocks.getPdfProviderConfigMock.mockResolvedValue(null);
        extractContentSpy?.mockImplementation(async (items: DetectedContent[]) => buildExtractionResult(
            items.map((item: DetectedContent) => ({ source: item, content: 'PDF text', success: true }) as ExtractedContent)
        ));

        const result = await resolveAllPendingContent(plugin, '![[report.pdf]]', undefined);

        expect(result.enrichedContent).toContain('### Content: report.pdf');
        // textOnly=true when no PDF provider config
        expect(extractContentSpy?.mock.calls[0][2]).toBe(true);
    });

    it('transcribes embedded audio when key is available', async () => {
        const plugin = createPlugin(app);
        mocks.getAudioTranscriptionApiKeyMock.mockResolvedValue({ key: 'audio-key', provider: 'openai' });
        extractContentSpy?.mockImplementation(async (items: DetectedContent[]) => buildExtractionResult(
            items.map((item: DetectedContent) => ({ source: item, content: 'Audio transcript', success: true }) as ExtractedContent)
        ));

        const setAudioConfigSpy = vi.spyOn(ContentExtractionService.prototype, 'setAudioTranscriptionConfig');

        const result = await resolveAllPendingContent(plugin, '![[recording.wav]]', undefined);

        expect(result.resolvedCount).toBe(1);
        expect(setAudioConfigSpy).toHaveBeenCalledWith({ provider: 'openai', apiKey: 'audio-key' });

        setAudioConfigSpy.mockRestore();
    });

    it('uses multimodal PDF extraction when provider is available', async () => {
        const plugin = createPlugin(app);
        mocks.getPdfProviderConfigMock.mockResolvedValue({
            provider: 'gemini',
            apiKey: 'gemini-key',
            model: 'gemini-3-flash-preview'
        });
        extractContentSpy?.mockImplementation(async (items: DetectedContent[]) => buildExtractionResult(
            items.map((item: DetectedContent) => ({ source: item, content: 'Multimodal PDF content', success: true }) as ExtractedContent)
        ));

        const setPdfConfigSpy = vi.spyOn(ContentExtractionService.prototype, 'setPdfExtractionConfig');

        const result = await resolveAllPendingContent(plugin, '![[report.pdf]]', undefined);

        expect(result.resolvedCount).toBe(1);
        expect(result.enrichedContent).toContain('Multimodal PDF content');
        expect(setPdfConfigSpy).toHaveBeenCalledWith({
            provider: 'gemini',
            apiKey: 'gemini-key',
            model: 'gemini-3-flash-preview',
            language: undefined
        });
        // textOnly=false when PDF provider is available
        expect(extractContentSpy?.mock.calls[0][2]).toBe(false);

        setPdfConfigSpy.mockRestore();
    });

    it('requests consent for PDF provider (Gemini) separate from main provider', async () => {
        const plugin = createPlugin(app, {
            settings: {
                serviceType: 'cloud',
                cloudServiceType: 'claude',
                youtubeGeminiModel: 'gemini-3-flash-preview',
                summarizeTimeoutSeconds: 120,
                summaryLanguage: 'auto'
            }
        });
        mocks.getPdfProviderConfigMock.mockResolvedValue({
            provider: 'gemini',
            apiKey: 'gemini-key',
            model: 'gemini-3-flash-preview'
        });
        extractContentSpy?.mockResolvedValue(buildExtractionResult([]));

        await resolveAllPendingContent(plugin, '![[report.pdf]]', undefined);

        expect(mocks.ensurePrivacyConsentMock).toHaveBeenCalledWith(plugin, 'claude');
        expect(mocks.ensurePrivacyConsentMock).toHaveBeenCalledWith(plugin, 'gemini');
    });

    it('passes summary language to PDF extraction config when set', async () => {
        const plugin = createPlugin(app, {
            settings: {
                serviceType: 'cloud',
                cloudServiceType: 'claude',
                youtubeGeminiModel: 'gemini-3-flash-preview',
                summarizeTimeoutSeconds: 120,
                summaryLanguage: 'Chinese'
            }
        });
        mocks.getPdfProviderConfigMock.mockResolvedValue({
            provider: 'claude',
            apiKey: 'claude-key',
            model: 'claude-sonnet-4-6'
        });
        extractContentSpy?.mockResolvedValue(buildExtractionResult([]));

        const setPdfConfigSpy = vi.spyOn(ContentExtractionService.prototype, 'setPdfExtractionConfig');

        await resolveAllPendingContent(plugin, '![[report.pdf]]', undefined);

        expect(setPdfConfigSpy).toHaveBeenCalledWith({
            provider: 'claude',
            apiKey: 'claude-key',
            model: 'claude-sonnet-4-6',
            language: 'Chinese'
        });

        setPdfConfigSpy.mockRestore();
    });

    it('resolves mixed sources in one pass', async () => {
        const plugin = createPlugin(app);
        mocks.getYouTubeGeminiApiKeyMock.mockResolvedValue('gemini-key');
        extractContentSpy?.mockImplementation(async (items: DetectedContent[]) => buildExtractionResult(
            items.map((item: DetectedContent) => ({ source: item, content: `${item.type} content`, success: true }) as ExtractedContent)
        ));

        const pending = 'https://example.com\n![[report.pdf]]\nhttps://youtu.be/dQw4w9WgXcQ';
        const result = await resolveAllPendingContent(plugin, pending, undefined);

        expect(result.resolvedCount).toBe(3);
        expect(result.enrichedContent).toContain('web-link content');
        expect(result.enrichedContent).toContain('pdf content');
        expect(result.enrichedContent).toContain('youtube content');
    });

    it('leaves failed sources unchanged and counts failures', async () => {
        const plugin = createPlugin(app);
        extractContentSpy?.mockImplementation(async (items: DetectedContent[]) => buildExtractionResult(
            items.map((item: DetectedContent) => item.type === 'pdf'
                ? ({ source: item, content: '', success: false, error: 'fail' } as ExtractedContent)
                : ({ source: item, content: 'Web content', success: true } as ExtractedContent)
            ),
            ['report.pdf: fail']
        ));

        const pending = 'https://example.com\n![[report.pdf]]';
        const result = await resolveAllPendingContent(plugin, pending, undefined);

        expect(result.failedCount).toBe(1);
        expect(result.enrichedContent).toContain('Web content');
        expect(result.enrichedContent).toContain('![[report.pdf]]');
    });

    it('skips audio when transcription key is missing', async () => {
        const plugin = createPlugin(app);
        extractContentSpy?.mockImplementation(async (items: DetectedContent[]) => {
            expect(items.some((item: DetectedContent) => item.type === 'audio')).toBe(false);
            return buildExtractionResult([]);
        });

        await resolveAllPendingContent(plugin, '![[recording.wav]]', undefined);

        expect(mockNotices).toContain(baseMessages.integrationAudioKeyMissing);
    });

    it('replaces repeated URLs on different lines using positional mapping', async () => {
        const plugin = createPlugin(app);
        const detectSpy = vi.spyOn(embeddedDetector, 'detectEmbeddedContent').mockReturnValue({
            items: [
                {
                    type: 'web-link',
                    originalText: 'https://example.com',
                    url: 'https://example.com',
                    displayName: 'example.com',
                    isEmbedded: false,
                    isExternal: true,
                    lineNumber: 1
                },
                {
                    type: 'web-link',
                    originalText: 'https://example.com',
                    url: 'https://example.com',
                    displayName: 'example.com',
                    isEmbedded: false,
                    isExternal: true,
                    lineNumber: 3
                }
            ],
            hasImages: false,
            hasPdfs: false,
            hasYouTube: false,
            hasWebLinks: true,
            hasInternalLinks: false,
            hasAudio: false,
            hasDocuments: false
        });

        extractContentSpy?.mockImplementation(async (items: DetectedContent[]) => buildExtractionResult(
            items.map((item: DetectedContent) => ({ source: item, content: 'Article', success: true }) as ExtractedContent)
        ));

        const pending = 'https://example.com\n\nhttps://example.com';
        const result = await resolveAllPendingContent(plugin, pending, undefined);

        expect(result.enrichedContent.match(/### Content:/g)?.length).toBe(2);

        detectSpy.mockRestore();
    });

    it('deduplicates structured and bare URLs, replacing once', async () => {
        const plugin = createPlugin(app);
        extractContentSpy?.mockImplementation(async (items: DetectedContent[]) => buildExtractionResult(
            items.map((item: DetectedContent) => ({ source: item, content: 'Article', success: true }) as ExtractedContent)
        ));

        const pending = '> From: https://example.com\nhttps://example.com';
        const result = await resolveAllPendingContent(plugin, pending, undefined);

        expect(result.enrichedContent.match(/### Content:/g)?.length).toBe(1);
        expect(result.enrichedContent).toContain('https://example.com');
    });

    it('does not cross-replace URL substrings', async () => {
        const plugin = createPlugin(app);
        extractContentSpy?.mockImplementation(async (items: DetectedContent[]) => buildExtractionResult(
            items.map((item: DetectedContent) => ({ source: item, content: `${item.url} content`, success: true }) as ExtractedContent)
        ));

        const pending = 'https://example.com\nhttps://example.com/abc';
        const result = await resolveAllPendingContent(plugin, pending, undefined);

        expect(result.enrichedContent.match(/### Content:/g)?.length).toBe(2);
        expect(result.enrichedContent).toContain('https://example.com content');
        expect(result.enrichedContent).toContain('https://example.com/abc content');
    });

    it('requests consent for Gemini + OpenAI when main provider is local', async () => {
        const plugin = createPlugin(app, {
            settings: {
                serviceType: 'local',
                cloudServiceType: 'claude',
                youtubeGeminiModel: 'gemini-3-flash-preview',
                summarizeTimeoutSeconds: 120
            }
        });
        mocks.getYouTubeGeminiApiKeyMock.mockResolvedValue('gemini-key');
        mocks.getAudioTranscriptionApiKeyMock.mockResolvedValue({ key: 'audio-key', provider: 'openai' });
        extractContentSpy?.mockResolvedValue(buildExtractionResult([]));

        await resolveAllPendingContent(plugin, 'https://youtu.be/dQw4w9WgXcQ\n![[recording.wav]]', undefined);

        expect(mocks.ensurePrivacyConsentMock).toHaveBeenCalledWith(plugin, 'gemini');
        expect(mocks.ensurePrivacyConsentMock).toHaveBeenCalledWith(plugin, 'openai');
        expect(mocks.ensurePrivacyConsentMock).not.toHaveBeenCalledWith(plugin, 'local');
    });

    it('requests consent for main cloud provider when no other sources', async () => {
        const plugin = createPlugin(app, {
            settings: {
                serviceType: 'cloud',
                cloudServiceType: 'claude',
                youtubeGeminiModel: 'gemini-3-flash-preview',
                summarizeTimeoutSeconds: 120
            }
        });

        await resolveAllPendingContent(plugin, 'No links here', undefined);

        expect(mocks.ensurePrivacyConsentMock).toHaveBeenCalledWith(plugin, 'claude');
    });

    it('returns early when privacy consent is declined', async () => {
        const plugin = createPlugin(app);
        mocks.ensurePrivacyConsentMock.mockResolvedValueOnce(false);

        const result = await resolveAllPendingContent(plugin, 'https://example.com', undefined);

        expect(result.errors).toContain(baseMessages.operationCancelled);
        expect(extractContentSpy).not.toHaveBeenCalled();
    });

    it('truncates enriched content based on placement and prompt budget', () => {
        mocks.getMaxContentCharsMock.mockReturnValue(2100);

        const result = truncatePendingContentForIntegration(
            'x'.repeat(120),
            'main',
            'merge',
            'claude'
        );

        expect(result.wasTruncated).toBe(true);
        expect(result.content.length).toBeLessThanOrEqual(result.availableForPending);
    });

    it('does not count main content for cursor placement budget', () => {
        mocks.getMaxContentCharsMock.mockReturnValue(50);

        const result = truncatePendingContentForIntegration(
            'x'.repeat(30),
            'y'.repeat(40),
            'cursor',
            'claude'
        );

        expect(result.wasTruncated).toBe(false);
    });

    it('counts main content for merge placement budget', () => {
        mocks.getMaxContentCharsMock.mockReturnValue(50);

        const result = truncatePendingContentForIntegration(
            'x'.repeat(30),
            'y'.repeat(40),
            'merge',
            'claude'
        );

        expect(result.availableForPending).toBeLessThan(50);
    });

    it('handles already-enriched pending text with URLs', async () => {
        const plugin = createPlugin(app);
        extractContentSpy?.mockImplementation(async (items: DetectedContent[]) => buildExtractionResult(
            items.map((item: DetectedContent) => ({ source: item, content: 'Article', success: true }) as ExtractedContent)
        ));

        const pending = '### Content: article\n\nhttps://example.com in body';
        const result = await resolveAllPendingContent(plugin, pending, undefined);

        expect(result.enrichedContent).toContain('### Content: https://example.com');
        expect(result.enrichedContent).toContain('Article');
    });

    it('extracts text from external PDFs via DocumentExtractionService', async () => {
        const plugin = createPlugin(app);
        extractContentSpy?.mockRestore();
        extractContentSpy = null;

        const extractFromUrlSpy = vi.spyOn(DocumentExtractionService.prototype, 'extractFromUrl')
            .mockResolvedValue({ success: true, text: 'PDF text' });

        const result = await resolveAllPendingContent(plugin, 'https://example.com/report.pdf', undefined);

        expect(extractFromUrlSpy).toHaveBeenCalledWith('https://example.com/report.pdf');
        expect(result.enrichedContent).toContain('PDF text');

        extractFromUrlSpy.mockRestore();
    });
});
