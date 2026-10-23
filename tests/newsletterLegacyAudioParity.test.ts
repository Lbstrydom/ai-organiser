// @vitest-environment happy-dom
/**
 * Legacy daily-audio parity — the byte-identical proof for `daily` mode.
 *
 * Written BEFORE the catch-up work touched `newsletterService.ts`, against the unchanged
 * pipeline, and kept green through every later change: a `daily` install must see the same
 * prompt, the same TTS call, the same file name, the same embed and NO new writes.
 * Synthetic content only.
 */

const noticeSpy = vi.hoisted(() => vi.fn());

vi.mock('obsidian', () => ({
    normalizePath: (p: string) => p.replace(/\\/g, '/'),
    requestUrl: vi.fn(),
    TFile: class TFile { path = ''; name = ''; },
    TAbstractFile: class TAbstractFile {},
    Notice: class Notice { constructor(msg: string, ms?: number) { noticeSpy(msg, ms); } },
}));

vi.mock('../src/utils/htmlToMarkdown', () => ({
    htmlToMarkdown: (h: string) => h,
    cleanMarkdown: (m: string) => m,
    cleanNewsletterMarkdown: (m: string) => m,
    extractNewsletterText: (m: string) => m,
    extractLinks: () => [],
}));

vi.mock('../src/services/llmFacade', () => ({
    summarizeText: vi.fn(),
    pluginContext: (p: unknown) => p,
}));

vi.mock('../src/utils/minutesUtils', () => ({
    sanitizeFileName: (n: string) => n,
    ensureFolderExists: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/core/settings', () => ({
    getNewsletterOutputFullPath: () => 'AI-Organiser/Newsletter Inbox',
}));

vi.mock('../src/utils/frontmatterUtils', () => ({
    updateAIOMetadata: vi.fn(),
    createSummaryHook: (t: string) => t,
}));

const generateAudioPodcast = vi.hoisted(() => vi.fn());
vi.mock('../src/services/newsletter/newsletterAudioService', () => ({ generateAudioPodcast }));

const azureState = vi.hoisted(() => ({ azure: false }));
vi.mock('../src/services/azure/endpointResolver', () => ({ isAzureMode: () => azureState.azure }));

const resolveAzureCapability = vi.hoisted(() => vi.fn());
vi.mock('../src/services/azure/resolveAzureCapability', () => ({ resolveAzureCapability }));

const createCognitive = vi.hoisted(() => vi.fn());
vi.mock('../src/services/tts/cognitiveSpeechTtsEngine', () => ({ createCognitiveSpeechTtsEngine: createCognitive }));

const createAzureSpeech = vi.hoisted(() => vi.fn());
vi.mock('../src/services/tts/azureSpeechTtsEngine', () => ({ createAzureSpeechTtsEngine: createAzureSpeech }));

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TFile } from 'obsidian';
import { NewsletterService } from '../src/services/newsletter/newsletterService';
import { summarizeText } from '../src/services/llmFacade';
import { ensureFolderExists } from '../src/utils/minutesUtils';
import { buildPodcastScriptPrompt, insertPodcastContent } from '../src/services/prompts/newsletterPrompts';

const ROOT = 'AI-Organiser/Newsletter Inbox';
const DATE = '2026-04-23';
const DIGEST = `${ROOT}/Digest — ${DATE}.md`;
const BRIEF = '### Markets\n\n- **Index closes higher**: Synthetic markets rose on invented earnings. (Sources: Fixture A, Fixture B)\n- **Rates held**: A fictional central bank left rates unchanged.\n';

const DIGEST_BODY = `# Newsletter Digest — April 23, 2026\n\n<!-- DAILY_BRIEF_START -->\n## Daily Brief\n\n${BRIEF}\n<!-- DAILY_BRIEF_END -->\n\n## Sources\n`;

function makeVault(initial: Record<string, string>) {
    const files = new Map<string, string>(Object.entries(initial));
    const tfiles = new Map<string, TFile>();
    const tf = (path: string) => {
        let f = tfiles.get(path);
        if (!f) { f = new TFile(); f.path = path; (f as { name: string }).name = path.split('/').pop() ?? path; tfiles.set(path, f); }
        return f;
    };
    return {
        files,
        getAbstractFileByPath: (p: string) => (files.has(p) ? tf(p) : null),
        cachedRead: vi.fn(async (f: { path: string }) => files.get(f.path) ?? ''),
        read: vi.fn(async (f: { path: string }) => files.get(f.path) ?? ''),
        modify: vi.fn(async (f: { path: string }, c: string) => { files.set(f.path, c); }),
        create: vi.fn(async (p: string, c: string) => { files.set(p, c); return tf(p); }),
    };
}

function makePlugin(vault: ReturnType<typeof makeVault>, settings: Record<string, unknown> = {}) {
    return {
        app: { vault, workspace: {}, fileManager: { trashFile: vi.fn() }, metadataCache: { getFileCache: vi.fn() } },
        settings: {
            newsletterAudioPodcast: true,
            newsletterAudioMode: 'daily',
            newsletterDailyBrief: true,
            newsletterStoryMemory: false,
            newsletterPreferredLanguage: 'en',
            newsletterPodcastVoice: 'Charon',
            newsletterPodcastMaxMins: 5,
            newsletterBriefCutoffHour: 6,
            newsletterBriefCutoffMinute: 0,
            cloudServiceType: 'openai',
            providerSettings: { gemini: { apiKey: 'fixture-gemini-key' } },
            ...settings,
        },
        secretStorageService: { isAvailable: () => false, getProviderKey: vi.fn() },
        loadData: vi.fn().mockResolvedValue({}),
        saveData: vi.fn().mockResolvedValue(undefined),
        newsletterSeenIds: [],
    } as never;
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 23, 12, 0, 0));
    noticeSpy.mockClear();
    generateAudioPodcast.mockReset();
    resolveAzureCapability.mockReset();
    createCognitive.mockReset();
    createAzureSpeech.mockReset();
    (summarizeText as ReturnType<typeof vi.fn>).mockReset();
    (summarizeText as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, content: 'Fixture podcast script.' });
    generateAudioPodcast.mockResolvedValue({ success: true, filePath: `${ROOT}/${DATE}/brief-${DATE}-abcd1234.mp3` });
    azureState.azure = false;
    (ensureFolderExists as ReturnType<typeof vi.fn>).mockClear();
});

afterEach(() => { vi.useRealTimers(); });

describe('legacy daily audio — script prompt', () => {
    it('sends exactly the podcast prompt built from the brief, with the configured length', async () => {
        const vault = makeVault({ [DIGEST]: DIGEST_BODY });
        const plugin = makePlugin(vault);
        const res = await new NewsletterService(plugin).regenerateAudioForToday();
        expect(res.ok).toBe(true);

        expect(summarizeText).toHaveBeenCalledTimes(1);
        const prompt = (summarizeText as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
        const expected = insertPodcastContent(buildPodcastScriptPrompt({ language: 'English', maxMins: 5 }), BRIEF.trim());
        expect(prompt).toBe(expected);
        // Literal anchors so a drift in the shared builder cannot hide behind the tautology above.
        expect(prompt).toContain('<task>Rewrite this daily news brief as a spoken podcast script for a solo news briefing.</task>');
        expect(prompt).toContain('Maximum 650 words');
        expect(prompt).toContain('- Open with one sentence previewing the 2-3 biggest stories of the day');
        expect(prompt).not.toContain('<story_memory>');
    });
});

describe('legacy daily audio — TTS call and artefacts', () => {
    it('calls generateAudioPodcast with exactly the legacy options (no episode identity, no extras)', async () => {
        const vault = makeVault({ [DIGEST]: DIGEST_BODY });
        const plugin = makePlugin(vault);
        await new NewsletterService(plugin).regenerateAudioForToday();

        expect(generateAudioPodcast).toHaveBeenCalledTimes(1);
        const [app, script, opts] = generateAudioPodcast.mock.calls[0];
        expect(app).toBe((plugin as { app: unknown }).app);
        expect(script).toBe('Fixture podcast script.');
        expect(opts).toEqual({
            apiKey: 'fixture-gemini-key',
            engine: undefined,
            modelId: undefined,
            voice: 'Charon',
            outputFolder: `${ROOT}/${DATE}`,
            dateStr: DATE,
        });
    });

    it('embeds the legacy brief-<date>-<fp>.mp3 link right under the H1 and nowhere else', async () => {
        const vault = makeVault({ [DIGEST]: DIGEST_BODY });
        await new NewsletterService(makePlugin(vault)).regenerateAudioForToday();

        const out = vault.files.get(DIGEST) as string;
        expect(out).toContain(`# Newsletter Digest — April 23, 2026\n\n🎧 **Listen:** ![[brief-${DATE}-abcd1234.mp3]]\n`);
        expect(out.match(/🎧/g)).toHaveLength(1);
        // The managed brief block is untouched.
        expect(out).toContain(`<!-- DAILY_BRIEF_START -->\n## Daily Brief\n\n${BRIEF}\n<!-- DAILY_BRIEF_END -->`);
    });

    it('writes nothing new: no Catch-up folder, no episode note, no plugin-data write, no frontmatter', async () => {
        const vault = makeVault({ [DIGEST]: DIGEST_BODY });
        const plugin = makePlugin(vault);
        await new NewsletterService(plugin).regenerateAudioForToday();

        expect(vault.create).not.toHaveBeenCalled();
        expect([...vault.files.keys()]).toEqual([DIGEST]);
        expect((plugin as { saveData: ReturnType<typeof vi.fn> }).saveData).not.toHaveBeenCalled();
        expect((ensureFolderExists as ReturnType<typeof vi.fn>).mock.calls.flat().join('|')).not.toMatch(/Catch-up/);
        expect(vault.files.get(DIGEST)).not.toMatch(/catchup_|aio_type/);
    });

    it('is refused when the master audio toggle is off (unchanged)', async () => {
        const vault = makeVault({ [DIGEST]: DIGEST_BODY });
        const res = await new NewsletterService(makePlugin(vault, { newsletterAudioPodcast: false })).regenerateAudioForToday();
        expect(res.ok).toBe(false);
        expect(generateAudioPodcast).not.toHaveBeenCalled();
    });
});

describe('legacy daily audio — TTS engine resolution (characterization)', () => {
    it('byo/Gemini: key from providerSettings, no engine, no model id', async () => {
        await new NewsletterService(makePlugin(makeVault({ [DIGEST]: DIGEST_BODY }))).regenerateAudioForToday();
        const opts = generateAudioPodcast.mock.calls[0][2];
        expect(opts.apiKey).toBe('fixture-gemini-key');
        expect(opts.engine).toBeUndefined();
        expect(opts.modelId).toBeUndefined();
    });

    it('falls back to the main key only when the main provider IS gemini', async () => {
        const plugin = makePlugin(makeVault({ [DIGEST]: DIGEST_BODY }), {
            providerSettings: {}, cloudServiceType: 'gemini', cloudApiKey: 'fixture-main-key',
        });
        await new NewsletterService(plugin).regenerateAudioForToday();
        expect(generateAudioPodcast.mock.calls[0][2].apiKey).toBe('fixture-main-key');
    });

    it('does NOT borrow a non-gemini main key', async () => {
        const plugin = makePlugin(makeVault({ [DIGEST]: DIGEST_BODY }), {
            providerSettings: {}, cloudServiceType: 'openai', cloudApiKey: 'fixture-openai-key',
        });
        await new NewsletterService(plugin).regenerateAudioForToday();
        expect(generateAudioPodcast).not.toHaveBeenCalled();
        expect(noticeSpy).toHaveBeenCalledWith('Audio podcast skipped — add a gemini key in settings to enable', 6000);
    });

    it('prefers the SecretStorage key when available', async () => {
        const plugin = makePlugin(makeVault({ [DIGEST]: DIGEST_BODY }));
        (plugin as { secretStorageService: unknown }).secretStorageService = {
            isAvailable: () => true,
            getProviderKey: vi.fn().mockResolvedValue('fixture-secret-key'),
        };
        await new NewsletterService(plugin).regenerateAudioForToday();
        expect(generateAudioPodcast.mock.calls[0][2].apiKey).toBe('fixture-secret-key');
    });

    describe('Azure mode', () => {
        beforeEach(() => { azureState.azure = true; });

        it('azure-speech surface: Cognitive Speech engine + its model id', async () => {
            const engine = { providerId: 'azure-cognitive' };
            resolveAzureCapability.mockResolvedValue({ kind: 'azure', surface: 'azure-speech' });
            createCognitive.mockResolvedValue(engine);
            await new NewsletterService(makePlugin(makeVault({ [DIGEST]: DIGEST_BODY }))).regenerateAudioForToday();
            const opts = generateAudioPodcast.mock.calls[0][2];
            expect(opts.engine).toBe(engine);
            expect(opts.modelId).toBe('azure-cognitive-speech-v1');
            expect(opts.apiKey).toBe('');
        });

        it('azure-speech surface without credentials: skip with the exact notice', async () => {
            resolveAzureCapability.mockResolvedValue({ kind: 'azure', surface: 'azure-speech' });
            createCognitive.mockResolvedValue(null);
            await new NewsletterService(makePlugin(makeVault({ [DIGEST]: DIGEST_BODY }))).regenerateAudioForToday();
            expect(generateAudioPodcast).not.toHaveBeenCalled();
            expect(noticeSpy).toHaveBeenCalledWith('Audio podcast skipped — azure AI speech needs a region, key, and voice (set them under azure capabilities)', 6000);
        });

        it('azure deployment surface: Azure speech engine + deployment as model id', async () => {
            const engine = { providerId: 'azure-openai' };
            resolveAzureCapability.mockResolvedValue({ kind: 'azure', surface: 'azure-openai', deployment: 'fixture-tts' });
            createAzureSpeech.mockResolvedValue(engine);
            await new NewsletterService(makePlugin(makeVault({ [DIGEST]: DIGEST_BODY }))).regenerateAudioForToday();
            const opts = generateAudioPodcast.mock.calls[0][2];
            expect(opts.engine).toBe(engine);
            expect(opts.modelId).toBe('fixture-tts');
        });

        it('azure deployment surface without a deployment: skip with the exact notice', async () => {
            resolveAzureCapability.mockResolvedValue({ kind: 'azure', surface: 'azure-openai' });
            createAzureSpeech.mockResolvedValue(null);
            await new NewsletterService(makePlugin(makeVault({ [DIGEST]: DIGEST_BODY }))).regenerateAudioForToday();
            expect(generateAudioPodcast).not.toHaveBeenCalled();
            expect(noticeSpy).toHaveBeenCalledWith('Audio podcast skipped — azure speech needs a tts deployment (set it under azure capabilities)', 6000);
        });

        it('unavailable: skip with the exact notice and never borrow a personal key', async () => {
            resolveAzureCapability.mockResolvedValue({ kind: 'unavailable' });
            await new NewsletterService(makePlugin(makeVault({ [DIGEST]: DIGEST_BODY }))).regenerateAudioForToday();
            expect(generateAudioPodcast).not.toHaveBeenCalled();
            expect(noticeSpy).toHaveBeenCalledWith("Audio podcast isn't configured for azure — set audio narration to a tts deployment, or add a Gemini key, in settings", 6000);
        });

        it('byo: falls through to the Gemini key chain', async () => {
            resolveAzureCapability.mockResolvedValue({ kind: 'byo' });
            await new NewsletterService(makePlugin(makeVault({ [DIGEST]: DIGEST_BODY }))).regenerateAudioForToday();
            expect(generateAudioPodcast.mock.calls[0][2].apiKey).toBe('fixture-gemini-key');
            expect(generateAudioPodcast.mock.calls[0][2].engine).toBeUndefined();
        });
    });
});

describe('the daily pipeline runs ONLY in daily mode', () => {
    const YESTERDAY = '2026-04-22';
    const YESTERDAY_DIGEST = `${ROOT}/Digest — ${YESTERDAY}.md`;
    const yesterdayBody = DIGEST_BODY.replaceAll(DATE, YESTERDAY).replace('April 23', 'April 22');

    const sweep = (service: NewsletterService) => (service as unknown as { recoverMissedAudioPodcasts(): Promise<void> }).recoverMissedAudioPodcasts();

    it('daily: the recovery sweep still voices a closed day that has a brief but no audio (the original behaviour)', async () => {
        const vault = makeVault({ [YESTERDAY_DIGEST]: yesterdayBody });
        await sweep(new NewsletterService(makePlugin(vault, { newsletterAudioMode: 'daily' })));
        expect(generateAudioPodcast).toHaveBeenCalledTimes(1);
        expect(generateAudioPodcast.mock.calls[0][2].dateStr).toBe(YESTERDAY);
        expect(vault.files.get(YESTERDAY_DIGEST)).toMatch(/🎧 \*\*Listen:\*\* !\[\[brief-[^\]]+\.mp3\]\]/);
    });

    it.each(['on-demand', 'smart-daily'])('%s: the sweep never creates a daily recording', async (mode) => {
        const vault = makeVault({ [YESTERDAY_DIGEST]: yesterdayBody });
        await sweep(new NewsletterService(makePlugin(vault, { newsletterAudioMode: mode })));
        expect(generateAudioPodcast).not.toHaveBeenCalled();
        expect(summarizeText).not.toHaveBeenCalled();
        expect(vault.files.get(YESTERDAY_DIGEST)).toBe(yesterdayBody);
    });

    it('audio off: the sweep does nothing in any mode', async () => {
        for (const mode of ['daily', 'on-demand', 'smart-daily']) {
            const vault = makeVault({ [YESTERDAY_DIGEST]: yesterdayBody });
            await sweep(new NewsletterService(makePlugin(vault, { newsletterAudioPodcast: false, newsletterAudioMode: mode })));
        }
        expect(generateAudioPodcast).not.toHaveBeenCalled();
    });

    it.each(['on-demand', 'smart-daily'])('%s: "regenerate today" is refused with an explanation, not honoured', async (mode) => {
        const vault = makeVault({ [DIGEST]: DIGEST_BODY });
        const res = await new NewsletterService(makePlugin(vault, { newsletterAudioMode: mode })).regenerateAudioForToday();
        expect(res.ok).toBe(false);
        expect((res as { error: string }).error).toContain('Newsletter audio');
        expect(generateAudioPodcast).not.toHaveBeenCalled();
        expect(vault.files.get(DIGEST)).toBe(DIGEST_BODY);
    });

    it('a missing mode behaves as the default (on-demand), never as daily', async () => {
        const vault = makeVault({ [YESTERDAY_DIGEST]: yesterdayBody });
        const plugin = makePlugin(vault);
        delete (plugin as unknown as { settings: Record<string, unknown> }).settings.newsletterAudioMode;
        await sweep(new NewsletterService(plugin));
        expect(generateAudioPodcast).not.toHaveBeenCalled();
    });
});
