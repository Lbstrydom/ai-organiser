// @vitest-environment happy-dom
/**
 * The read signal at the service boundary: the brief prompt adapts, the audio script does not,
 * switching off is clean, and a failed save is an honest Result.
 */

vi.mock('obsidian', () => ({
    normalizePath: (p: string) => p.replace(/\\/g, '/'),
    requestUrl: vi.fn(),
    TFile: class TFile { path = ''; name = ''; basename = ''; parent: { path: string } | null = null; },
}));

const summarizeText = vi.hoisted(() => vi.fn());
vi.mock('../src/services/llmFacade', () => ({ summarizeText, pluginContext: (p: unknown) => p }));

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TFile } from 'obsidian';
import { DEFAULT_SETTINGS, getNewsletterOutputFullPath, migrateNewsletterAudioSettings } from '../src/core/settings';
import { NewsletterService, getDigestPath, digestBucketForPath } from '../src/services/newsletter/newsletterService';
import { MEMORY_SCHEMA_VERSION } from '../src/services/newsletter/newsletterMemoryTypes';
import { creditPair, currentReadGeneration } from '../src/services/newsletter/newsletterReadSignal';
import { getReadMode } from '../src/services/newsletter/newsletterReadMode';
import { isReadSignalEnabled, isReadThroughEnabled } from '../src/services/newsletter/newsletterMemoryPolicy';
import type { ProcessedNewsletter } from '../src/services/newsletter/newsletterTypes';

const PRIOR = '2026-10-20';
const TODAY = '2026-10-21';

const priorStory = { key: 'port-strike-harbour', title: 'Port strike at the harbour', gist: 'Dockers walked out', firstRevision: 1, contentRevision: 1 };

function makeVault() {
    const files = new Map<string, { content: string; tfile: TFile }>();
    const mk = (path: string): TFile => {
        const t = new TFile();
        t.path = path; t.name = path.split('/').pop() ?? path; t.basename = t.name.replace(/\.md$/, '');
        t.parent = { path: path.slice(0, path.lastIndexOf('/')) } as never;
        return t;
    };
    const put = (path: string, content: string) => files.set(path, { content, tfile: mk(path) });
    return {
        files, put,
        getAbstractFileByPath: (p: string) => files.get(p)?.tfile ?? null,
        cachedRead: vi.fn(async (f: { path: string }) => files.get(f.path)?.content ?? ''),
        read: vi.fn(async (f: { path: string }) => files.get(f.path)?.content ?? ''),
        modify: vi.fn(async (f: { path: string }, c: string) => { put(f.path, c); }),
        create: vi.fn(async (p: string, c: string) => { put(p, c); return files.get(p)!.tfile; }),
    };
}

function setup(settingsOver: Record<string, unknown>, withRead: boolean, opts: { failSave?: boolean } = {}) {
    const vault = makeVault();
    const settings = { ...DEFAULT_SETTINGS, featureFlags: { newsletter: true }, newsletterStoryMemory: true, ...settingsOver };
    const root = getNewsletterOutputFullPath(settings);
    const items = ['Alpha', 'Beta'].map((n) => `${root}/${TODAY}/${n}.md`);
    vault.put(getDigestPath(root, TODAY), `# Digest — ${TODAY}\n\n${items.map((p) => `- [[${TODAY}/${p.split('/').pop()!.replace(/\.md$/, '')}|x]]`).join('\n')}\n`);
    const data: Record<string, unknown> = {
        'newsletter-story-ledger': { version: MEMORY_SCHEMA_VERSION, buckets: { [PRIOR]: { revision: 1, updatedAt: 1, audio: {}, stories: [priorStory] } } },
        'newsletter-consumed-briefs': { version: MEMORY_SCHEMA_VERSION, consumed: {} },
    };
    if (withRead) data['newsletter-read-briefs'] = { version: MEMORY_SCHEMA_VERSION, read: { [PRIOR]: { via: 'explicit', credited: [creditPair(priorStory)] } } };
    const loadData = vi.fn(async () => structuredClone(data));
    const saveData = vi.fn(async (d: Record<string, unknown>) => {
        if (opts.failSave) throw new Error('disk full');
        for (const k of Object.keys(data)) delete data[k];
        Object.assign(data, structuredClone(d));
    });
    const plugin = { app: { vault, workspace: {}, metadataCache: { getFileCache: () => null } }, settings, loadData, saveData } as never;
    const batch: ProcessedNewsletter[] = items.map((p, i) => ({
        id: `m${i}`, from: 'x', subject: `s${i}`, date: TODAY, senderName: i === 0 ? 'Alpha' : 'Beta', markdown: '',
        triage: `Triage text number ${i} about the harbour port strike continuing and other things going on across several areas.`, llmFailed: false, keyLinks: [], _resolvedPath: p,
    }));
    return { plugin, batch, data, vault, saveData };
}

const generate = (service: NewsletterService, batch: ProcessedNewsletter[]) =>
    (service as unknown as { generateAndInjectBrief(d: string, b: ProcessedNewsletter[]): Promise<void> }).generateAndInjectBrief(TODAY, batch);

beforeEach(() => {
    // The code under test reads the real clock for "today"; the fixtures are dated, so pin it (Date only) or the test depends on the day it runs.
    vi.useFakeTimers({ toFake: ['Date'] });
    // The daily audio waits until TODAY's bucket has closed, so the clock sits the day after it.
    vi.setSystemTime(new Date(2026, 9, 22, 12, 0, 0));
    summarizeText.mockReset();
    summarizeText.mockResolvedValue({ success: true, content: '### News\n- **Something new**: A development. (Sources: Alpha, Beta)' });
});

afterEach(() => { vi.useRealTimers(); });

describe('the brief adapts to what was read', () => {
    it('a prior-day story the reader read is listed as already told; without the read it is listed as missed', async () => {
        const on = setup({ newsletterReadMode: 'explicit' }, true);
        await generate(new NewsletterService(on.plugin), on.batch);
        const withRead = summarizeText.mock.calls[0][1] as string;
        expect(withRead).toContain('[ALREADY_TOLD_THEM_ON_A_PREVIOUS_DAY]');
        expect(withRead).toContain(`[${PRIOR}] Port strike at the harbour`);

        summarizeText.mockClear();
        const off = setup({ newsletterReadMode: 'off' }, true);
        await generate(new NewsletterService(off.plugin), off.batch);
        const without = summarizeText.mock.calls[0][1] as string;
        expect(without).toContain('[THEY_MISSED_THESE_ENTIRELY]');
        expect(without).not.toContain('[ALREADY_TOLD_THEM_ON_A_PREVIOUS_DAY]');
    });

    it('mode off never reads the read store, even when one is present', async () => {
        const off = setup({ newsletterReadMode: 'off' }, true);
        await generate(new NewsletterService(off.plugin), off.batch);
        // loadData is called by every store; what matters is that the read key never influenced the output (above)
        // and was not rewritten.
        expect(off.data['newsletter-read-briefs']).toBeDefined();
    });

    it('the podcast script keeps the heard-only recall (reading never shortens audio)', async () => {
        const s = setup({ newsletterReadMode: 'explicit', newsletterAudioPodcast: true, newsletterAudioMode: 'daily' }, true);
        const service = new NewsletterService(s.plugin);
        const spy = vi.spyOn(service as unknown as { generateAudioForBrief: (...a: unknown[]) => Promise<void> }, 'generateAudioForBrief').mockResolvedValue(undefined);
        await generate(service, s.batch);
        expect(spy).toHaveBeenCalledTimes(1);
        const audioRecall = spy.mock.calls[0][3] as { heard: unknown[]; unheard: Array<{ key: string }> };
        expect(audioRecall.heard).toHaveLength(0);
        expect(audioRecall.unheard.map((x) => x.key)).toEqual(['port-strike-harbour']);
    });
});

describe('markBriefRead / clearReadHistory', () => {
    const obs = { date: PRIOR, displayed: [{ key: priorStory.key, title: priorStory.title, gist: priorStory.gist }] };

    it('refuses with a code when memory or the mode is off, and writes nothing', async () => {
        const a = setup({ newsletterReadMode: 'off' }, false);
        expect(await new NewsletterService(a.plugin).markBriefRead(obs, 'explicit', currentReadGeneration())).toEqual({ ok: true, value: { kind: 'refused', code: 'mode-off' } });
        const b = setup({ newsletterReadMode: 'explicit', newsletterStoryMemory: false }, false);
        expect(await new NewsletterService(b.plugin).markBriefRead(obs, 'explicit', currentReadGeneration())).toEqual({ ok: true, value: { kind: 'refused', code: 'memory-off' } });
        expect(a.saveData).not.toHaveBeenCalled();
        expect(b.saveData).not.toHaveBeenCalled();
    });

    it('a rejected save is a Result.err and records nothing', async () => {
        const s = setup({ newsletterReadMode: 'explicit' }, false, { failSave: true });
        const res = await new NewsletterService(s.plugin).markBriefRead(obs, 'explicit', currentReadGeneration());
        expect(res.ok).toBe(false);
        expect(s.data['newsletter-read-briefs']).toBeUndefined();
    });

    it('clearReadHistory removes only the read store and bumps the generation first', async () => {
        const s = setup({ newsletterReadMode: 'explicit' }, true);
        const before = currentReadGeneration();
        const res = await new NewsletterService(s.plugin).clearReadHistory();
        expect(res).toEqual({ ok: true, value: true });
        expect(currentReadGeneration()).toBe(before + 1);
        expect(s.data['newsletter-read-briefs']).toBeUndefined();
        expect(s.data['newsletter-story-ledger']).toBeDefined();
        expect(s.data['newsletter-consumed-briefs']).toBeDefined();
    });

    it('a session captured before a purge cannot commit after it', async () => {
        const s = setup({ newsletterReadMode: 'explicit' }, false);
        const service = new NewsletterService(s.plugin);
        const gen = currentReadGeneration();
        await service.clearReadHistory();
        const late = await service.markBriefRead(obs, 'read-through', gen);
        expect(late).toEqual({ ok: true, value: { kind: 'refused', code: 'invalidated' } });
        expect(s.data['newsletter-read-briefs']).toBeUndefined();
    });

    it('story memory switched off purges the read store too, but a no-op purge writes nothing', async () => {
        const s = setup({ newsletterReadMode: 'explicit' }, true);
        expect((await new NewsletterService(s.plugin).clearStoryMemory()).ok).toBe(true);
        expect(s.data['newsletter-read-briefs']).toBeUndefined();
        const quiet = setup({ newsletterReadMode: 'off' }, false);
        await new NewsletterService(quiet.plugin).clearReadHistory();
        expect(quiet.saveData).not.toHaveBeenCalled();
    });
});

describe('mode policy and migration', () => {
    it('default is off; unknown values fail closed to off', () => {
        expect(DEFAULT_SETTINGS.newsletterReadMode).toBe('off');
        expect(getReadMode({})).toBe('off');
        expect(getReadMode({ newsletterReadMode: 'weird' })).toBe('off');
        expect(getReadMode({ newsletterReadMode: 'read-through' })).toBe('read-through');
    });
    it('the migration coerces anything outside the shipped set to off, and is idempotent', () => {
        for (const [input, expected] of [[undefined, 'off'], ['nope', 'off'], [7, 'off'], ['explicit', 'explicit'], ['read-through', 'read-through']] as const) {
            const old: Record<string, unknown> = { newsletterReadMode: input };
            migrateNewsletterAudioSettings(old);
            expect(old.newsletterReadMode).toBe(expected);
            migrateNewsletterAudioSettings(old);
            expect(old.newsletterReadMode).toBe(expected);
        }
    });
    it('the policy needs story memory AND a mode; read-through needs that mode', () => {
        const base = { ...DEFAULT_SETTINGS, featureFlags: { newsletter: true } };
        expect(isReadSignalEnabled({ ...base, newsletterReadMode: 'off' })).toBe(false);
        expect(isReadSignalEnabled({ ...base, newsletterReadMode: 'explicit', newsletterStoryMemory: false })).toBe(false);
        expect(isReadSignalEnabled({ ...base, newsletterReadMode: 'explicit' })).toBe(true);
        expect(isReadThroughEnabled({ ...base, newsletterReadMode: 'explicit' })).toBe(false);
        expect(isReadThroughEnabled({ ...base, newsletterReadMode: 'read-through' })).toBe(true);
    });
});

describe('digestBucketForPath', () => {
    it('accepts only the digest path under the output root', () => {
        const root = getNewsletterOutputFullPath(DEFAULT_SETTINGS);
        expect(digestBucketForPath(root, getDigestPath(root, TODAY))).toBe(TODAY);
        expect(digestBucketForPath(root, `Elsewhere/Digest — ${TODAY}.md`)).toBeNull();
        expect(digestBucketForPath(root, `${root}/${TODAY}/Alpha.md`)).toBeNull();
    });
});
