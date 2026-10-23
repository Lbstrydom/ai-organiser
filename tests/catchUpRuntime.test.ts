import { describe, it, expect, vi, beforeEach } from 'vitest';

const azure = vi.hoisted(() => ({ on: false }));
vi.mock('../src/services/azure/endpointResolver', () => ({ isAzureMode: () => azure.on }));

const resolveAzureCapability = vi.hoisted(() => vi.fn());
vi.mock('../src/services/azure/resolveAzureCapability', () => ({ resolveAzureCapability }));
const createCognitive = vi.hoisted(() => vi.fn());
vi.mock('../src/services/tts/cognitiveSpeechTtsEngine', () => ({ createCognitiveSpeechTtsEngine: createCognitive }));
const createAzureSpeech = vi.hoisted(() => vi.fn());
vi.mock('../src/services/tts/azureSpeechTtsEngine', () => ({ createAzureSpeechTtsEngine: createAzureSpeech }));

const summarizeText = vi.hoisted(() => vi.fn());
vi.mock('../src/services/llmFacade', () => ({ summarizeText, pluginContext: (p: unknown) => p }));

import { DEFAULT_SETTINGS } from '../src/core/settings';
import { resolveNewsletterTts } from '../src/services/newsletter/resolveNewsletterTts';
import { createCatchUpPorts, cleanSpokenScript, previewCost } from '../src/services/newsletter/catchUp/catchUpRuntime';
import type { CatchUpPlan } from '../src/services/newsletter/catchUp/catchUpTypes';

function plugin(over: Record<string, unknown> = {}, secret: { available?: boolean; key?: string | null } = {}) {
    const data: Record<string, unknown> = {
        'newsletter-story-ledger': {
            version: 1,
            buckets: {
                '2026-10-18': { revision: 1, updatedAt: 1, audio: {}, stories: [{ key: 'old tale', title: 'Old tale', gist: 'Told before', firstRevision: 1, contentRevision: 1 }] },
                '2026-10-22': { revision: 1, updatedAt: 1, audio: {}, stories: [{ key: 'pending tale', title: 'Pending tale', gist: 'Not told', firstRevision: 1, contentRevision: 1 }] },
            },
        },
        'newsletter-consumed-briefs': {
            version: 1,
            consumed: { '2026-10-18': { firstAt: 1, lastAt: 1, firstVia: 'audio', lastVia: 'audio', revision: 1 } },
        },
    };
    return {
        app: {},
        settings: {
            ...DEFAULT_SETTINGS,
            featureFlags: { newsletter: true },
            newsletterStoryMemory: true,
            serviceType: 'cloud',
            cloudServiceType: 'openai',
            providerSettings: { gemini: { apiKey: 'fixture-gemini' } },
            newsletterPreferredLanguage: 'en',
            ...over,
        },
        secretStorageService: {
            isAvailable: () => secret.available ?? false,
            getProviderKey: vi.fn(async () => secret.key ?? null),
        },
        loadData: async () => structuredClone(data),
        saveData: vi.fn(),
    } as never;
}

const plan = (): CatchUpPlan => ({
    entries: [
        { date: '2026-10-22', kind: 'full', coverage: { kind: 'revision', rev: 1 }, text: '- **Pending tale**: A synthetic story long enough to be kept as a source block.', newsletters: 2, titles: ['Pending tale'] },
    ],
    unresolved: [], noStoredDates: [], windowDates: ['2026-10-22'],
    length: { capMinutes: 15, wordBudget: 1950 },
    from: '2026-10-22', to: '2026-10-22', createdAt: 1, planHash: 'abcd1234',
});

beforeEach(() => {
    azure.on = false;
    summarizeText.mockReset();
    resolveAzureCapability.mockReset();
    createCognitive.mockReset();
    createAzureSpeech.mockReset();
});

describe('resolveNewsletterTts (the shared authority)', () => {
    it('Gemini key chain: SecretStorage first', async () => {
        const r = await resolveNewsletterTts(plugin({}, { available: true, key: 'fixture-secret' }));
        expect(r).toMatchObject({ ok: true, apiKey: 'fixture-secret' });
    });

    it('then providerSettings', async () => {
        expect(await resolveNewsletterTts(plugin())).toMatchObject({ ok: true, apiKey: 'fixture-gemini' });
    });

    it('then the main key only when the main provider IS gemini', async () => {
        const ok1 = await resolveNewsletterTts(plugin({ providerSettings: {}, cloudServiceType: 'gemini', cloudApiKey: 'fixture-main' }));
        expect(ok1).toMatchObject({ ok: true, apiKey: 'fixture-main' });
        const no = await resolveNewsletterTts(plugin({ providerSettings: {}, cloudServiceType: 'openai', cloudApiKey: 'fixture-openai' }));
        expect(no).toMatchObject({ ok: false, notice: 'Audio podcast skipped — add a gemini key in settings to enable', noticeMs: 6000 });
        expect((no as { logWarn?: string }).logWarn).toMatch(/no Gemini API key/);
    });

    describe('Azure mode never falls back to a personal key silently', () => {
        beforeEach(() => { azure.on = true; });

        it('azure-speech surface', async () => {
            const engine = { providerId: 'azure-cognitive' };
            resolveAzureCapability.mockResolvedValue({ kind: 'azure', surface: 'azure-speech' });
            createCognitive.mockResolvedValue(engine);
            expect(await resolveNewsletterTts(plugin())).toMatchObject({ ok: true, engine, modelId: 'azure-cognitive-speech-v1', apiKey: '' });
        });

        it('azure-speech surface without credentials', async () => {
            resolveAzureCapability.mockResolvedValue({ kind: 'azure', surface: 'azure-speech' });
            createCognitive.mockResolvedValue(null);
            expect(await resolveNewsletterTts(plugin())).toMatchObject({ ok: false, notice: expect.stringContaining('azure AI speech needs a region') });
        });

        it('azure deployment surface', async () => {
            const engine = { providerId: 'azure-openai' };
            resolveAzureCapability.mockResolvedValue({ kind: 'azure', surface: 'azure-openai', deployment: 'fixture-tts' });
            createAzureSpeech.mockResolvedValue(engine);
            expect(await resolveNewsletterTts(plugin())).toMatchObject({ ok: true, engine, modelId: 'fixture-tts' });
        });

        it('azure deployment surface without a deployment', async () => {
            resolveAzureCapability.mockResolvedValue({ kind: 'azure', surface: 'azure-openai' });
            createAzureSpeech.mockResolvedValue(null);
            expect(await resolveNewsletterTts(plugin())).toMatchObject({ ok: false, notice: expect.stringContaining('azure speech needs a tts deployment') });
        });

        it('unavailable', async () => {
            resolveAzureCapability.mockResolvedValue({ kind: 'unavailable' });
            expect(await resolveNewsletterTts(plugin())).toMatchObject({ ok: false, notice: expect.stringContaining("isn't configured for azure") });
        });

        it('byo falls through to the Gemini chain', async () => {
            resolveAzureCapability.mockResolvedValue({ kind: 'byo' });
            expect(await resolveNewsletterTts(plugin())).toMatchObject({ ok: true, apiKey: 'fixture-gemini' });
        });

        it('byo with no key explains the Azure case', async () => {
            resolveAzureCapability.mockResolvedValue({ kind: 'byo' });
            const r = await resolveNewsletterTts(plugin({ providerSettings: {} }));
            expect(r).toMatchObject({ ok: false, notice: expect.stringContaining("isn't configured for Azure") });
        });
    });
});

describe('createCatchUpPorts', () => {
    it('resolveTts maps a missing setup to the guidance code and a Gemini key to a Gemini handle', async () => {
        const good = await createCatchUpPorts(plugin()).resolveTts();
        expect(good).toMatchObject({ ok: true, tts: { providerId: 'gemini' } });
        const bad = await createCatchUpPorts(plugin({ providerSettings: {} })).resolveTts();
        expect(bad).toEqual({ ok: false, code: 'catchup-no-tts' });
    });

    it('an Azure engine carries its own provider id and model', async () => {
        azure.on = true;
        const engine = { providerId: 'azure-cognitive' };
        resolveAzureCapability.mockResolvedValue({ kind: 'azure', surface: 'azure-speech' });
        createCognitive.mockResolvedValue(engine);
        const r = await createCatchUpPorts(plugin()).resolveTts();
        expect(r).toMatchObject({ ok: true, tts: { engine, providerId: 'azure-cognitive', modelId: 'azure-cognitive-speech-v1' } });
    });

    it('writes the script from the frozen plan, with memory for OLDER days but not the pending day', async () => {
        summarizeText.mockResolvedValue({ success: true, content: '# Heading\n**Bold** words.\n- a bullet' });
        const signal = new AbortController().signal;
        const res = await createCatchUpPorts(plugin()).generateScript(plan(), signal);
        expect(res).toEqual({ ok: true, value: 'Heading\nBold words.\na bullet' });
        const [, prompt, options] = summarizeText.mock.calls[0];
        expect(options).toEqual({ signal });
        expect(prompt).toContain('2026-10-22 (1 day of newsletters)');
        expect(prompt).toContain('--- SOURCE: Day 2026-10-22 ---');
        expect(prompt).toContain('[ALREADY_TOLD_THEM_ON_A_PREVIOUS_DAY]\n[2026-10-18] Old tale');
        // The pending day's own story is an input, so it must not also appear as memory.
        expect(prompt).not.toContain('[THEY_MISSED_THESE_ENTIRELY]');
        expect(prompt.match(/Pending tale/g)).toHaveLength(1);
        expect(prompt).toContain('Maximum 1950 words');
    });

    it('with story memory off the prompt has no memory block and reads no ledger', async () => {
        summarizeText.mockResolvedValue({ success: true, content: 'A script.' });
        await createCatchUpPorts(plugin({ newsletterStoryMemory: false })).generateScript(plan());
        expect(summarizeText.mock.calls[0][1]).not.toContain('<story_memory>');
    });

    it('passes the configured language and home region', async () => {
        summarizeText.mockResolvedValue({ success: true, content: 'Een script.' });
        await createCatchUpPorts(plugin({ newsletterPreferredLanguage: 'nl', newsletterHomeRegion: ' Fictionville ' })).generateScript(plan());
        const prompt = summarizeText.mock.calls[0][1] as string;
        expect(prompt).toContain('Speak entirely in');
        expect(prompt).toContain('close to home (Fictionville)');
    });

    it('an LLM failure or an empty reply is an error result, never a throw', async () => {
        summarizeText.mockResolvedValueOnce({ success: false, error: 'rate limited' });
        expect(await createCatchUpPorts(plugin()).generateScript(plan())).toEqual({ ok: false, error: 'rate limited' });
        summarizeText.mockResolvedValueOnce({ success: true, content: '' });
        expect((await createCatchUpPorts(plugin()).generateScript(plan())).ok).toBe(false);
        summarizeText.mockRejectedValueOnce(new Error('network'));
        expect(await createCatchUpPorts(plugin()).generateScript(plan())).toEqual({ ok: false, error: 'network' });
    });

    it('shortenScript asks for the budget', async () => {
        summarizeText.mockResolvedValue({ success: true, content: 'Short.' });
        const r = await createCatchUpPorts(plugin()).shortenScript('A very long script.', 1950);
        expect(r).toEqual({ ok: true, value: 'Short.' });
        expect(summarizeText.mock.calls[0][1]).toContain('at most 1950 words');
    });
});

describe('cleanSpokenScript', () => {
    it('removes markdown stragglers and collapses blank runs', () => {
        expect(cleanSpokenScript('## Title\n\n\n\n**Bold** text\n* item')).toBe('Title\n\nBold text\nitem');
    });
});

describe('previewCost', () => {
    it('prices TTS from the provider registry, scaled by the cap', () => {
        const a = previewCost(plugin(), 15);
        const b = previewCost(plugin(), 20);
        expect(a.ttsUsd).toBeGreaterThan(0);
        expect(b.ttsUsd!).toBeGreaterThan(a.ttsUsd!);
        expect(a.spokenChars).toBe(15 * 130 * 6);
    });

    it('does not guess an Azure price', () => {
        azure.on = true;
        expect(previewCost(plugin(), 15).ttsUsd).toBeNull();
    });
});
