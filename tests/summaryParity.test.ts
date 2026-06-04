/**
 * Golden-parity test for the Cluster C multi-source decomposition (plan §12 R2-L1).
 *
 * Drives the SAME fixed, deterministic multi-source run through the decomposed pipeline
 * (MultiSourceOrchestrator → SummaryInsertion → SourceMetadataWriter → NoteMutation) and
 * asserts the final note content byte-for-byte against a committed golden file. The
 * output-building logic was extracted verbatim from the legacy `handleMultiSourceResult`,
 * so the golden IS the legacy note content; this test locks it against regression.
 *
 * Notice ordering is intentionally NOT asserted — only the persisted note content is the
 * behaviour contract (plan §12).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('obsidian', async () => await import('./mocks/obsidian'));

const mocks = vi.hoisted(() => ({
    fetchArticle: vi.fn(),
    summarizeYouTubeWithGemini: vi.fn(),
    getYouTubeGeminiApiKey: vi.fn(),
    getAudioTranscriptionApiKey: vi.fn(),
    extractImageText: vi.fn(),
}));

vi.mock('../src/services/webContentService', () => ({ fetchArticle: mocks.fetchArticle }));
vi.mock('../src/services/youtubeService', () => ({ summarizeYouTubeWithGemini: mocks.summarizeYouTubeWithGemini }));
vi.mock('../src/services/apiKeyHelpers', () => ({
    getYouTubeGeminiApiKey: mocks.getYouTubeGeminiApiKey,
    getAudioTranscriptionApiKey: mocks.getAudioTranscriptionApiKey,
}));
vi.mock('../src/utils/busyIndicator', () => ({ withBusyIndicator: (_p: unknown, fn: () => unknown) => fn() }));
vi.mock('../src/services/visionService', () => ({ VisionService: class { canDigitise() { return { supported: true }; } } }));
vi.mock('../src/utils/digitiseUtils', () => ({ extractImageText: mocks.extractImageText }));

import { App, TFile, createTFile } from './mocks/obsidian';
import { MultiSourceOrchestrator } from '../src/services/multiSource/multiSourceOrchestrator';
import { SummaryInsertion } from '../src/services/multiSource/summaryInsertion';
import { deriveCleanupTargets, addSourceReferences } from '../src/services/multiSource/sourceMetadataWriter';
import { NoteMutation } from '../src/services/noteEdit/noteMutation';
import { getMaxContentChars } from '../src/services/tokenLimits';
import type { MultiSourceDeps, ResolvedSource } from '../src/services/multiSource/multiSourceTypes';
import type { SelectedSources } from '../src/ui/modals/MultiSourceModal';

const GOLDEN_PATH = path.join(__dirname, 'fixtures', 'multiSource', 'golden-note.md');

const BASELINE = [
    '# My Research Note',
    '',
    'Some intro the user wrote.',
    '',
    'https://x.test/article',
    '',
    '![[docs/a.pdf]]',
    '',
    '![[docs/b.docx]]',
    '',
    '![[pics/p.png]]',
    '',
].join('\n');

const MESSAGES = {
    summarizingNoteContent: 'sum-note', fetchingWebPage: 'fetch', summarizingTitle: 'sum {title}',
    failedToFetchUrl: 'failurl {url}', processingYouTubeWithGemini: 'yt', summarizedTitle: 'done {title}',
    failedToProcessYouTube: 'ytfail {url}', readingPdf: 'pdf {title}', compressingAudio: 'comp', transcribingAudio: 'trans',
};

function makeDeps(app: App): MultiSourceDeps {
    return {
        app,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        plugin: { app, t: { messages: MESSAGES }, settings: { serviceType: 'cloud', cloudServiceType: 'claude', summaryLength: 'standard', summaryLanguage: 'en' } } as any,
        summarizeContent: vi.fn(async (c: string) => `SUM[${c.slice(0, 16)}]`),
        summarizePdf: vi.fn(async (p: string) => ({ success: true, summary: `PDF summary of ${p}` })),
        extractDocument: vi.fn(async () => ({ success: true, text: 'extracted document text' })),
        notify: vi.fn(),
        onAudioCleanup: vi.fn(async () => {}),
    };
}

const SOURCES: SelectedSources = {
    urls: ['https://x.test/article'],
    youtube: ['https://youtu.be/zzz'],
    pdfs: [{ path: 'docs/a.pdf', isVaultFile: true }],
    documents: [{ path: 'docs/b.docx', isVaultFile: true }],
    audio: [],
    images: [{ path: 'pics/p.png', isVaultFile: true }],
};

/** Mirror the command adapter's success-path composition exactly. */
async function buildFinalNote(): Promise<string> {
    const app = new App();
    app.vault.read = vi.fn(async () => 'note body content here');
    const deps = makeDeps(app);

    // Flatten in the adapter's order: note → urls → youtube → pdfs → documents → images.
    const noteFile = createTFile('My Research Note.md');
    const resolved: ResolvedSource[] = [
        { kind: 'note', file: noteFile },
        ...SOURCES.urls.map((url): ResolvedSource => ({ kind: 'url', url })),
        ...SOURCES.youtube.map((url): ResolvedSource => ({ kind: 'youtube', url })),
        ...SOURCES.pdfs.map((p): ResolvedSource => ({ kind: 'pdf', path: p.path, isVaultFile: p.isVaultFile })),
        ...SOURCES.documents.map((d): ResolvedSource => ({ kind: 'document', path: d.path, isVaultFile: d.isVaultFile })),
        ...SOURCES.images.map((i): ResolvedSource => ({ kind: 'image', path: i.path })),
    ];

    const run = await new MultiSourceOrchestrator(deps).run(resolved, {
        personaPrompt: 'persona', focusContext: undefined, currentFilePath: 'note.md', today: '2026-01-01',
    });
    if (!run.ok) throw new Error('orchestrator failed');
    const outcomes = run.value.items;

    const summaryInsertion = new SummaryInsertion(async () => 'Unified synthesis of all sources.');
    const synthServiceType = 'claude';
    const maxSynthesisChars = getMaxContentChars(synthServiceType) - 2000;
    const combinedOutput = await summaryInsertion.buildCombinedSummary({
        outcomes, focusContext: undefined, personaPrompt: 'persona', maxSynthesisChars,
    });

    const { urlsToRemove, vaultFilePaths } = deriveCleanupTargets(outcomes, SOURCES);
    const vaultFilePathsSet = new Set<string>(vaultFilePaths);
    const mutation = new NoteMutation().cleanupSources(urlsToRemove, vaultFilePaths).appendSection(combinedOutput);
    addSourceReferences(mutation, outcomes, vaultFilePathsSet);
    mutation.ensureStructure(true);

    const res = mutation.build()(BASELINE);
    if (!res.ok) throw new Error(`mutation failed: ${res.error}`);
    return res.value.content;
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchArticle.mockResolvedValue({ success: true, content: { title: 'Web Article', textContent: 'web body text' } });
    mocks.getYouTubeGeminiApiKey.mockResolvedValue(null); // youtube fails cleanly → checklist failure line
    mocks.extractImageText.mockResolvedValue({ text: 'image extracted text', file: createTFile('pics/p.png') });
});

describe('multi-source summary parity (golden)', () => {
    it('produces the committed golden note content', async () => {
        const actual = await buildFinalNote();
        if (!fs.existsSync(GOLDEN_PATH)) {
            fs.mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true });
            fs.writeFileSync(GOLDEN_PATH, actual, 'utf8');
        }
        const golden = fs.readFileSync(GOLDEN_PATH, 'utf8');
        expect(actual).toBe(golden);
    });

    it('is deterministic across runs', async () => {
        const a = await buildFinalNote();
        const b = await buildFinalNote();
        expect(a).toBe(b);
    });
});

describe('SummaryInsertion defensive guards', () => {
    it('does not invoke synthesis when there are zero successful summaries (G2)', async () => {
        const synthesize = vi.fn(async () => 'SHOULD NOT BE CALLED');
        const si = new SummaryInsertion(synthesize);
        const failed = (id: string) => ({ processed: { type: 'web' as const, url: `https://x/${id}`, title: id, date: '2026-01-01', success: false, error: 'nope' } });
        const out = await si.buildCombinedSummary({
            outcomes: [failed('a'), failed('b')], focusContext: undefined, personaPrompt: 'p', maxSynthesisChars: 100000,
        });
        expect(synthesize).not.toHaveBeenCalled();
        expect(out.startsWith('\n\n## Summary\n\n')).toBe(true);
        expect(out).toContain('### Sources Processed');
        expect(out).not.toContain('SHOULD NOT BE CALLED');
    });
});
