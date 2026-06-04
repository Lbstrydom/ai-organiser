import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('obsidian', async () => await import('./mocks/obsidian'));

const mocks = vi.hoisted(() => ({
    fetchArticle: vi.fn(),
    summarizeYouTubeWithGemini: vi.fn(),
    transcribeAudioWithFullWorkflow: vi.fn(),
    getYouTubeGeminiApiKey: vi.fn(),
    getAudioTranscriptionApiKey: vi.fn(),
    extractImageText: vi.fn(),
    canDigitise: vi.fn((): { supported: boolean; reason?: string } => ({ supported: true })),
}));

vi.mock('../src/services/webContentService', () => ({ fetchArticle: mocks.fetchArticle }));
vi.mock('../src/services/youtubeService', () => ({ summarizeYouTubeWithGemini: mocks.summarizeYouTubeWithGemini }));
vi.mock('../src/services/audioTranscriptionService', () => ({ transcribeAudioWithFullWorkflow: mocks.transcribeAudioWithFullWorkflow }));
vi.mock('../src/services/apiKeyHelpers', () => ({
    getYouTubeGeminiApiKey: mocks.getYouTubeGeminiApiKey,
    getAudioTranscriptionApiKey: mocks.getAudioTranscriptionApiKey,
}));
vi.mock('../src/utils/busyIndicator', () => ({ withBusyIndicator: (_p: unknown, fn: () => unknown) => fn() }));
vi.mock('../src/services/visionService', () => ({ VisionService: class { canDigitise() { return mocks.canDigitise(); } } }));
vi.mock('../src/utils/digitiseUtils', () => ({ extractImageText: mocks.extractImageText }));

import { App, TFile, createTFile } from './mocks/obsidian';
import { MultiSourceOrchestrator } from '../src/services/multiSource/multiSourceOrchestrator';
import type { MultiSourceDeps, MultiSourceRunOptions, ResolvedSource } from '../src/services/multiSource/multiSourceTypes';

const MESSAGES = {
    summarizingNoteContent: 'sum-note',
    fetchingWebPage: 'fetch',
    summarizingTitle: 'sum {title}',
    failedToFetchUrl: 'failurl {url}',
    processingYouTubeWithGemini: 'yt',
    summarizedTitle: 'done {title}',
    failedToProcessYouTube: 'ytfail {url}',
    readingPdf: 'pdf {title}',
    compressingAudio: 'comp',
    transcribingAudio: 'trans',
};

function makePlugin(app: App) {
    return {
        app,
        t: { messages: MESSAGES },
        settings: {
            serviceType: 'cloud',
            cloudServiceType: 'claude',
            summaryLength: 'standard',
            summaryLanguage: 'en',
            youtubeGeminiModel: 'gemini',
            summarizeTimeoutSeconds: 120,
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
}

function makeDeps(app: App, overrides: Partial<MultiSourceDeps> = {}): MultiSourceDeps {
    const plugin = makePlugin(app);
    return {
        app,
        plugin,
        summarizeContent: vi.fn(async (c: string) => `S:${c}`),
        summarizePdf: vi.fn(async () => ({ success: true, summary: 'PDFSUM' })),
        extractDocument: vi.fn(async () => ({ success: true, text: 'DOCTEXT' })),
        notify: vi.fn(),
        onAudioCleanup: vi.fn(async () => {}),
        ...overrides,
    };
}

const baseOpts = (over: Partial<MultiSourceRunOptions> = {}): MultiSourceRunOptions => ({
    personaPrompt: 'persona',
    focusContext: undefined,
    currentFilePath: 'note.md',
    today: '2026-01-01',
    ...over,
});

beforeEach(() => {
    vi.clearAllMocks();
    mocks.canDigitise.mockReturnValue({ supported: true });
});

describe('MultiSourceOrchestrator', () => {
    it('processes sources in order and reports a full-success batch', async () => {
        const app = new App();
        const deps = makeDeps(app);
        const file = createTFile('My Note.md');
        const sources: ResolvedSource[] = [
            { kind: 'note', file },
            { kind: 'pdf', path: 'docs/a.pdf', isVaultFile: true },
            { kind: 'document', path: 'docs/b.docx', isVaultFile: true },
        ];
        app.vault.read = vi.fn(async () => 'note body');

        const r = await new MultiSourceOrchestrator(deps).run(sources, baseOpts());
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.items.map((o) => o.label)).toEqual([
            'Current Note: My Note',
            'PDF: a.pdf',
            'Document: b.docx',
        ]);
        expect(r.value.items.map((o) => o.processed.type)).toEqual(['note', 'pdf', 'document']);
        expect(r.value.items[0].processed.url).toBeUndefined(); // note carries no url
        expect(r.value.errors).toHaveLength(0);
        expect(r.value.isPartial).toBe(false);
    });

    it('isolates a per-source failure (one throws, the rest succeed) → isPartial', async () => {
        const app = new App();
        const summarizeContent = vi.fn(async (c: string) => {
            if (c === 'note body') throw new Error('boom');
            return `S:${c}`;
        });
        const deps = makeDeps(app, { summarizeContent });
        app.vault.read = vi.fn(async () => 'note body');
        const file = createTFile('N.md');
        const sources: ResolvedSource[] = [
            { kind: 'note', file },
            { kind: 'pdf', path: 'a.pdf', isVaultFile: true },
        ];

        const r = await new MultiSourceOrchestrator(deps).run(sources, baseOpts());
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.items[0].processed.success).toBe(false);
        expect(r.value.items[0].processed.error).toBe('boom');
        expect(r.value.items[1].processed.success).toBe(true);
        expect(r.value.isPartial).toBe(true);
        expect(r.value.errors).toEqual([{ source: 'N', error: 'boom' }]);
    });

    it('reports a non-partial all-failed batch', async () => {
        const app = new App();
        const deps = makeDeps(app, { summarizePdf: vi.fn(async () => ({ success: false, error: 'nope' })) });
        const sources: ResolvedSource[] = [
            { kind: 'pdf', path: 'a.pdf', isVaultFile: true },
            { kind: 'pdf', path: 'b.pdf', isVaultFile: true },
        ];
        const r = await new MultiSourceOrchestrator(deps).run(sources, baseOpts());
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.items.every((o) => !o.processed.success)).toBe(true);
        expect(r.value.isPartial).toBe(false);
        expect(r.value.errors).toHaveLength(2);
    });

    it('fires onProgress before each source with the running count', async () => {
        const app = new App();
        const deps = makeDeps(app);
        const onProgress = vi.fn();
        const sources: ResolvedSource[] = [
            { kind: 'pdf', path: 'a.pdf', isVaultFile: true },
            { kind: 'pdf', path: 'b.pdf', isVaultFile: true },
        ];
        await new MultiSourceOrchestrator(deps).run(sources, baseOpts({ onProgress }));
        expect(onProgress.mock.calls).toEqual([[0, 2], [1, 2]]);
    });

    it('refuses a cancelled run with err(aborted) instead of a partial result (G1)', async () => {
        const app = new App();
        const deps = makeDeps(app);
        const controller = new AbortController();
        controller.abort();
        const sources: ResolvedSource[] = [{ kind: 'pdf', path: 'a.pdf', isVaultFile: true }];
        const r = await new MultiSourceOrchestrator(deps).run(sources, baseOpts({ signal: controller.signal }));
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toBe('aborted');
        expect(deps.summarizePdf).not.toHaveBeenCalled();
    });

    it('isolates a throwing credential fetch to the affected sources (G3)', async () => {
        const app = new App();
        const deps = makeDeps(app);
        mocks.getYouTubeGeminiApiKey.mockRejectedValue(new Error('vault locked'));
        const sources: ResolvedSource[] = [
            { kind: 'youtube', url: 'https://youtu.be/x' },
            { kind: 'pdf', path: 'a.pdf', isVaultFile: true },
        ];
        const r = await new MultiSourceOrchestrator(deps).run(sources, baseOpts());
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        // YouTube degrades to a "no key" failure; the pdf still succeeds — batch not aborted.
        expect(r.value.items[0].processed.type).toBe('youtube');
        expect(r.value.items[0].processed.success).toBe(false);
        expect(r.value.items[1].processed.type).toBe('pdf');
        expect(r.value.items[1].processed.success).toBe(true);
    });

    it('summarizes a web URL via fetchArticle with a full-title label', async () => {
        const app = new App();
        const deps = makeDeps(app);
        mocks.fetchArticle.mockResolvedValue({ success: true, content: { title: 'Some Long Article Title That Exceeds Forty Chars Easily', textContent: 'web body' } });
        const r = await new MultiSourceOrchestrator(deps).run([{ kind: 'url', url: 'https://x.test/a' }], baseOpts());
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const o = r.value.items[0];
        expect(o.processed.type).toBe('web');
        expect(o.processed.success).toBe(true);
        expect(o.label).toBe('URL: Some Long Article Title That Exceeds Forty Chars Easily');
        expect(o.processed.title).toBe('Some Long Article Title That Exceeds For'); // 40-char truncation
        expect(deps.summarizeContent).toHaveBeenCalledWith('web body', 'persona', undefined, false, undefined);
    });

    it('fails YouTube cleanly when no Gemini key is configured', async () => {
        const app = new App();
        const deps = makeDeps(app);
        mocks.getYouTubeGeminiApiKey.mockResolvedValue(null);
        const r = await new MultiSourceOrchestrator(deps).run([{ kind: 'youtube', url: 'https://youtu.be/x' }], baseOpts());
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.items[0].processed.success).toBe(false);
        expect(r.value.items[0].processed.error).toContain('Configure Gemini API key');
        expect(mocks.summarizeYouTubeWithGemini).not.toHaveBeenCalled();
    });

    it('transcribes audio (vault file) then summarizes the transcript + offers cleanup', async () => {
        const app = new App();
        const onAudioCleanup = vi.fn(async () => {});
        const deps = makeDeps(app, { onAudioCleanup });
        const audioFile = createTFile('rec.mp3');
        app.metadataCache.getFirstLinkpathDest = vi.fn(() => audioFile);
        mocks.getAudioTranscriptionApiKey.mockResolvedValue({ provider: 'openai', key: 'k', azureEndpoint: undefined });
        mocks.transcribeAudioWithFullWorkflow.mockResolvedValue({ success: true, transcript: 'TRANSCRIPT' });

        const r = await new MultiSourceOrchestrator(deps).run([{ kind: 'audio', path: 'rec.mp3', isVaultFile: true }], baseOpts());
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.items[0].label).toBe('Audio: rec.mp3');
        expect(r.value.items[0].summary).toBe('S:TRANSCRIPT');
        expect(onAudioCleanup).toHaveBeenCalledWith(audioFile, expect.objectContaining({ transcript: 'TRANSCRIPT' }));
    });

    it('fails audio when no transcription key is configured', async () => {
        const app = new App();
        const deps = makeDeps(app);
        mocks.getAudioTranscriptionApiKey.mockResolvedValue(null);
        const r = await new MultiSourceOrchestrator(deps).run([{ kind: 'audio', path: 'rec.mp3', isVaultFile: true }], baseOpts());
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.items[0].processed.success).toBe(false);
        expect(r.value.items[0].processed.error).toContain('Audio transcription requires');
    });

    it('digitises an image then summarizes the extracted text', async () => {
        const app = new App();
        const deps = makeDeps(app);
        mocks.extractImageText.mockResolvedValue({ text: 'IMGTEXT', file: createTFile('p.png') });
        const r = await new MultiSourceOrchestrator(deps).run([{ kind: 'image', path: 'p.png' }], baseOpts());
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.items[0].label).toBe('Image: p.png');
        expect(r.value.items[0].summary).toBe('S:IMGTEXT');
    });

    it('fails an image when the provider cannot digitise', async () => {
        const app = new App();
        const deps = makeDeps(app);
        mocks.canDigitise.mockReturnValue({ supported: false, reason: 'no multimodal' });
        const r = await new MultiSourceOrchestrator(deps).run([{ kind: 'image', path: 'p.png' }], baseOpts());
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.items[0].processed.success).toBe(false);
        expect(r.value.items[0].processed.error).toBe('no multimodal');
        expect(deps.summarizeContent).not.toHaveBeenCalled();
    });

    it('threads the abort signal into the summarize seam (G1)', async () => {
        const app = new App();
        const summarizeContent = vi.fn(async () => 'S');
        const deps = makeDeps(app, { summarizeContent });
        app.vault.read = vi.fn(async () => 'body');
        const controller = new AbortController();
        await new MultiSourceOrchestrator(deps).run(
            [{ kind: 'note', file: createTFile('n.md') }],
            baseOpts({ signal: controller.signal }),
        );
        expect(summarizeContent).toHaveBeenCalledWith('body', 'persona', undefined, false, controller.signal);
    });

    it('isolates a vision-init failure to the image outcome, not the whole batch (G2)', async () => {
        const app = new App();
        const deps = makeDeps(app);
        // initVision() calls VisionService.canDigitise(); make it throw → init throws.
        mocks.canDigitise.mockImplementation(() => { throw new Error('vision import failed'); });
        const sources: ResolvedSource[] = [
            { kind: 'pdf', path: 'a.pdf', isVaultFile: true },
            { kind: 'image', path: 'p.png' },
        ];
        const r = await new MultiSourceOrchestrator(deps).run(sources, baseOpts());
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        // The pdf still succeeded; the image failed gracefully (batch NOT aborted).
        expect(r.value.items).toHaveLength(2);
        expect(r.value.items[0].processed.type).toBe('pdf');
        expect(r.value.items[0].processed.success).toBe(true);
        expect(r.value.items[1].processed.type).toBe('image');
        expect(r.value.items[1].processed.success).toBe(false);
        expect(r.value.items[1].processed.error).toContain('vision import failed');
    });

    it('treats a null summary as a per-source failure (not a throw)', async () => {
        const app = new App();
        const deps = makeDeps(app, { summarizeContent: vi.fn(async () => null) });
        app.vault.read = vi.fn(async () => 'body');
        const r = await new MultiSourceOrchestrator(deps).run([{ kind: 'note', file: createTFile('n.md') }], baseOpts());
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.items[0].processed.success).toBe(false);
        expect(r.value.items[0].processed.error).toBe('Failed to generate summary');
    });
});
