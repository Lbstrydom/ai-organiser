// @vitest-environment happy-dom
/**
 * "When I am behind": the default (wait) is byte-identical to 1.1.0, and replace acts only when every
 * safety condition is clear.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/minutesUtils', () => ({
    ensureFolderExists: vi.fn().mockResolvedValue(undefined),
    sanitizeFileName: (n: string) => n,
}));

import { ok } from '../src/core/result';
import { DEFAULT_SETTINGS, migrateOldSettings } from '../src/core/settings';
import { __resetChainForTests } from '../src/core/pluginDataStore';
import { autoRunDecision, runAutoCatchUp, runCatchUp, __resetCatchUpLockForTests, type CatchUpPorts } from '../src/services/newsletter/catchUp/catchUpService';
import { ackEpisodes } from '../src/services/newsletter/catchUp/catchUpDraft';
import { __resetAutoReplaceMemoryForTests, AUTO_MIN_AGE_MS, episodeCreatedAt } from '../src/services/newsletter/catchUp/catchUpReplace';
import { normaliseWhenBehind } from '../src/services/newsletter/catchUp/catchUpTypes';
import { makeCatchUpVault } from './helpers/catchUpVault';

const ROOT = 'AI-Organiser/Newsletter Inbox';
const FOLDER = `${ROOT}/Catch-up`;
const NOW1 = new Date(2026, 9, 23, 12, 0, 0);   // the first episode is made now
const NOW3 = new Date(2026, 9, 25, 12, 0, 0);   // two days later: the 24th has closed and is pending

const brief = (n: string) => `### Fixtures\n\n- **Story ${n} alpha**: Synthetic summary alpha for fixture ${n}. (Sources: Fixture A)\n`;
const digest = (d: string) => `# Newsletter Digest — ${d}\n\n<!-- DAILY_BRIEF_START -->\n## Daily Brief\n\n${brief(d.slice(-2))}\n<!-- DAILY_BRIEF_END -->\n\n## Sources\n\n- [[${d}/Fixture 1|Fixture 1]]\n`;
const ledger = (revs: Record<string, number>) => ({
    'newsletter-story-ledger': {
        version: 1,
        buckets: Object.fromEntries(Object.entries(revs).map(([d, revision]) => [d, { revision, updatedAt: 1, audio: {}, stories: [{ key: `s ${d}`, title: `Story ${d.slice(-2)} alpha`, gist: 'g', firstRevision: 1, contentRevision: 1 }] }])),
    },
});

function makePlugin(initial: Record<string, unknown>) {
    const state = { stored: structuredClone(initial) as Record<string, unknown> };
    return { state, loadData: async () => structuredClone(state.stored), saveData: vi.fn(async (d: Record<string, unknown>) => { state.stored = structuredClone(d); }) };
}

const settings = (over: Record<string, unknown> = {}) => ({
    ...DEFAULT_SETTINGS,
    featureFlags: { newsletter: true },
    newsletterAudioPodcast: true,
    newsletterAudioMode: 'smart-daily',
    newsletterStoryMemory: true,
    newsletterCatchUpLookbackDays: 7,
    newsletterRetentionDays: 30,
    newsletterPodcastVoice: 'Charon',
    ...over,
}) as never;

function tone(): Int16Array {
    const out = new Int16Array(24000);
    for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 24000) * 8000);
    return out;
}

let vault: ReturnType<typeof makeCatchUpVault>;
let plugin: ReturnType<typeof makePlugin>;
let engine: { providerId: string; synthesizeChunk: ReturnType<typeof vi.fn> };
let counter = 0;
const nextRandom = () => ((++counter * 0.137) % 1);
const SCRIPT = 'Good morning. Here is what happened across the days you missed, in a short synthetic script.';
let recentPlay: ReturnType<typeof vi.fn>;

function ports(now: Date, s: Record<string, unknown> = {}, over: Partial<CatchUpPorts> = {}): CatchUpPorts & { generateScript: ReturnType<typeof vi.fn> } {
    return {
        app: vault.app as never, plugin: plugin as never, settings: settings(s), now: () => now, random: nextRandom,
        resolveTts: vi.fn(async () => ({ ok: true as const, tts: { engine: engine as never, providerId: 'fixture', modelId: 'fixture-model' } })),
        generateScript: vi.fn(async () => ok(SCRIPT)),
        shortenScript: vi.fn(async () => ok('A shorter synthetic script.')),
        recentPlay,
        ...over,
    } as never;
}

const notes = () => [...vault.files.keys()].filter((k) => k.startsWith(`${FOLDER}/Catch-up `) && k.endsWith('.md'));
const trashed = () => vault.app.fileManager.trashFile.mock.calls.map((c) => (c[0] as { path: string }).path);

/** An unheard episode made on the 23rd, then two newer days (24th closed by the 25th) waiting. */
async function behind(): Promise<void> {
    const made = await runCatchUp(ports(NOW1, { newsletterAudioMode: 'on-demand' }), { interactive: true });
    expect(made.ok).toBe(true);
    vault.set(`${ROOT}/Digest — 2026-10-24.md`, digest('2026-10-24'));
    plugin.state.stored = { ...plugin.state.stored, ...ledger({ '2026-10-21': 2, '2026-10-22': 3, '2026-10-23': 1, '2026-10-24': 1 }) };
}

beforeEach(() => {
    (globalThis as { activeDocument?: Document }).activeDocument = document;
    counter = 0;
    __resetChainForTests();
    __resetCatchUpLockForTests();
    __resetAutoReplaceMemoryForTests();
    vault = makeCatchUpVault();
    for (const d of ['2026-10-21', '2026-10-22', '2026-10-23']) vault.set(`${ROOT}/Digest — ${d}.md`, digest(d));
    plugin = makePlugin(ledger({ '2026-10-21': 2, '2026-10-22': 3, '2026-10-23': 1 }));
    engine = { providerId: 'fixture', synthesizeChunk: vi.fn(async () => tone()) };
    recentPlay = vi.fn(async () => 'clear');
});

describe('the setting', () => {
    it('defaults to wait, and only the exact value replace means replace', () => {
        expect(DEFAULT_SETTINGS.newsletterCatchUpWhenBehind).toBe('wait');
        for (const junk of [undefined, null, '', 'Replace', 'REPLACE', 'wait', 'yes', true, 1, {}, []]) expect(normaliseWhenBehind(junk)).toBe('wait');
        expect(normaliseWhenBehind('replace')).toBe('replace');
    });

    it('migration coerces junk to wait and keeps a deliberate replace', () => {
        const migrated = (v: unknown) => (migrateOldSettings({ newsletterCatchUpWhenBehind: v }) as unknown as { newsletterCatchUpWhenBehind: string }).newsletterCatchUpWhenBehind;
        expect(migrated('replace')).toBe('replace');
        for (const junk of [undefined, 'REPLACE', 'sometimes', 5, null]) expect(migrated(junk)).toBe('wait');
        expect(migrated('wait')).toBe('wait');
    });
});

describe('wait (the default) is byte-identical to 1.1.0', () => {
    it('the whole decision table is unchanged and the new machinery is never consulted', async () => {
        await behind();
        for (const s of [{}, { newsletterCatchUpWhenBehind: 'wait' }, { newsletterCatchUpWhenBehind: 'garbage' }, { newsletterCatchUpWhenBehind: undefined }]) {
            expect(await autoRunDecision(ports(NOW3, s))).toEqual({ run: false, reason: 'unheard' });
        }
        expect(recentPlay).not.toHaveBeenCalled();
        expect(vault.app.fileManager.trashFile).not.toHaveBeenCalled();
        // Other reasons are untouched too.
        expect(await autoRunDecision(ports(NOW3, { newsletterAudioMode: 'on-demand' }))).toEqual({ run: false, reason: 'wrong-mode' });
        expect(await runAutoCatchUp(ports(NOW3))).toEqual({ ok: true, value: null });
        expect(notes()).toHaveLength(1);
    });

    it('with nothing unheard the run is exactly the same under either setting', async () => {
        const a = await autoRunDecision(ports(NOW1, { newsletterCatchUpWhenBehind: 'wait' }));
        const b = await autoRunDecision(ports(NOW1, { newsletterCatchUpWhenBehind: 'replace' }));
        expect(a).toEqual({ run: true });
        expect(b).toEqual(a);
    });
});

describe('replace', () => {
    const replace = { newsletterCatchUpWhenBehind: 'replace' };

    it('acts only when every condition is clear, and replaces the episode with one over everything', async () => {
        await behind();
        const decision = await autoRunDecision(ports(NOW3, replace));
        expect(decision).toMatchObject({ run: true, replace: { episodeIds: [expect.any(String)], previewHash: expect.any(String) } });

        const oldNote = notes()[0];
        const p = ports(NOW3, replace);
        const res = await runAutoCatchUp(p);
        expect(res.ok).toBe(true);
        const plan = p.generateScript.mock.calls[0][0];
        expect(plan.entries.map((e: { date: string }) => e.date)).toEqual(['2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24']);
        expect(trashed()[0]).toBe(oldNote);
        expect(trashed()).toHaveLength(2);
        expect(notes()).toHaveLength(1);
        expect(notes()[0]).not.toBe(oldNote);
        // The probe above decided once; the run decides, checks again under the lock, and once more right before retiring.
        expect(recentPlay).toHaveBeenCalledTimes(4);
    });

    it('holds back when nothing new is waiting (replacing an episode with itself is pointless)', async () => {
        await behind();
        // Today is still the 24th: the new day is open, so an automatic run has nothing to add.
        expect(await autoRunDecision(ports(new Date(2026, 9, 24, 12, 0, 0), replace))).toEqual({ run: false, reason: 'unheard' });
    });

    it.each([
        ['played in the last day', async () => 'recent' as const],
        ['playback history unknown', async () => 'unknown' as const],
    ])('never replaces an episode with %s', async (_n, verdict) => {
        await behind();
        recentPlay.mockImplementation(verdict);
        expect(await autoRunDecision(ports(NOW3, replace))).toEqual({ run: false, reason: 'unheard' });
        expect(trashed()).toEqual([]);
    });

    it('without any tracker (tracking off) it is unknown, which blocks', async () => {
        await behind();
        expect(await autoRunDecision(ports(NOW3, replace, { recentPlay: undefined }))).toEqual({ run: false, reason: 'unheard' });
    });

    it('never replaces an episode younger than half a day, nor one whose age cannot be read', async () => {
        await behind();
        const young = new Date(2026, 9, 23, 12, 0, 0).getTime() + AUTO_MIN_AGE_MS - 1;
        expect(await autoRunDecision(ports(new Date(young), replace))).toEqual({ run: false, reason: 'unheard' });
        expect(episodeCreatedAt('20261023-120000-aaaa')).toBe(new Date(2026, 9, 23, 12, 0, 0).getTime());
        expect(episodeCreatedAt('garbage')).toBeNull();
        expect(episodeCreatedAt('20261323-120000-aaaa')).not.toBeNull(); // JS normalises month 13: still a finite time, the id check is the pattern
    });

    // Two clocks, the more recent wins: the id (local wall clock) and the file's creation time (reset by a sync).
    // The test vault stamps files with a fixed old time, so this decides by the clock the test injects, never by the day it runs.
    it('the file creation time can only make an episode look YOUNGER, never older than its id says', async () => {
        await behind();
        const file = vault.app.vault.getAbstractFileByPath(notes()[0]) as { stat: { ctime: number } };
        expect(file.stat.ctime).toBeLessThan(NOW1.getTime());
        // A sync reset the file an hour before "now": too young, whatever the id says.
        file.stat.ctime = NOW3.getTime() - 60 * 60 * 1000;
        expect(await autoRunDecision(ports(NOW3, replace))).toEqual({ run: false, reason: 'unheard' });
        // A creation time in the FUTURE of the injected clock is also young (never negative age treated as old).
        file.stat.ctime = NOW3.getTime() + 60 * 60 * 1000;
        expect(await autoRunDecision(ports(NOW3, replace))).toEqual({ run: false, reason: 'unheard' });
        // Old enough on both clocks: it acts.
        file.stat.ctime = NOW3.getTime() - AUTO_MIN_AGE_MS - 1;
        expect(await autoRunDecision(ports(NOW3, replace))).toMatchObject({ run: true });
    });

    it('never replaces an episode that other notes link to', async () => {
        await behind();
        const note = notes()[0];
        vault.app.metadataCache.resolvedLinks['Journal/Today.md'] = { [note]: 1 };
        expect(await autoRunDecision(ports(NOW3, replace))).toEqual({ run: false, reason: 'unheard' });
    });

    it('holds back when the listening history cannot be read', async () => {
        await behind();
        const spy = vi.spyOn(await import('../src/services/newsletter/newsletterConsumption'), 'loadConsumption').mockRejectedValueOnce(new Error('disk'));
        expect(await autoRunDecision(ports(NOW3, replace))).toEqual({ run: false, reason: 'evidence-unreadable' });
        spy.mockRestore();
    });

    it('never replaces an episode whose days could not be made again', async () => {
        await behind();
        vault.remove(`${ROOT}/Digest — 2026-10-21.md`);
        expect(await autoRunDecision(ports(NOW3, replace))).toEqual({ run: false, reason: 'unheard' });
    });

    it('does not act while another episode is unfinished, or when the mode is not smart daily', async () => {
        await behind();
        expect(await autoRunDecision(ports(NOW3, { ...replace, newsletterAudioMode: 'on-demand' }))).toEqual({ run: false, reason: 'wrong-mode' });
        expect(await autoRunDecision(ports(NOW3, { ...replace, newsletterAudioPodcast: false }))).toEqual({ run: false, reason: 'wrong-mode' });
    });

    it('an ack that arrives between deciding and retiring keeps the old episode', async () => {
        await behind();
        const eps = notes();
        const p = ports(NOW3, replace, {
            generateScript: vi.fn(async () => {
                const id = /Catch-up .+ (\d{8}-\d{6}-[0-9a-f]{4})\.md$/.exec(eps[0])![1];
                await ackEpisodes(plugin as never, [{ id, to: '2026-10-23' }], '2026-10-25', 7);
                return ok(SCRIPT);
            }) as never,
        });
        const res = await runAutoCatchUp(p);
        expect(res.ok).toBe(true);
        expect(trashed()).toEqual([]);
        expect(notes()).toHaveLength(2);
    });

    it('the same episode is not retried the same day', async () => {
        await behind();
        recentPlay.mockResolvedValueOnce('clear').mockResolvedValueOnce('clear').mockResolvedValueOnce('recent'); // decide ok, lock ok, then it was played just before retiring: kept
        const first = await runAutoCatchUp(ports(NOW3, replace));
        expect(first.ok).toBe(true);
        expect(trashed()).toEqual([]);
        recentPlay.mockResolvedValue('clear');
        expect(await autoRunDecision(ports(NOW3, replace))).toEqual({ run: false, reason: 'unheard' });
    });
});
