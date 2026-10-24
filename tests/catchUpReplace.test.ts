// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/minutesUtils', () => ({
    ensureFolderExists: vi.fn().mockResolvedValue(undefined),
    sanitizeFileName: (n: string) => n,
}));

import { ok, err } from '../src/core/result';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { __resetChainForTests } from '../src/core/pluginDataStore';
import { runCatchUp, __resetCatchUpLockForTests, type CatchUpPorts } from '../src/services/newsletter/catchUp/catchUpService';
import { ackEpisodes, DRAFT_DATA_KEY, ACKS_DATA_KEY } from '../src/services/newsletter/catchUp/catchUpDraft';
import { buildCatchUpSnapshot } from '../src/services/newsletter/catchUp/catchUpSelection';
import {
    assessReplace,
    lostDaysOf,
    prepareReplace,
    replaceAndRunCatchUp,
    type ReplaceDeps,
    type ReplacePrep,
    type ReplaceRequest,
} from '../src/services/newsletter/catchUp/catchUpReplace';
import { makeCatchUpVault } from './helpers/catchUpVault';

const ROOT = 'AI-Organiser/Newsletter Inbox';
const FOLDER = `${ROOT}/Catch-up`;
const NOW1 = new Date(2026, 9, 23, 12, 0, 0);
const NOW2 = new Date(2026, 9, 24, 12, 0, 0);

const brief = (n: string) => `### Fixtures\n\n- **Story ${n} alpha**: Synthetic summary alpha for fixture ${n}. (Sources: Fixture A)\n- **Story ${n} beta**: Synthetic summary beta for fixture ${n}. (Sources: Fixture B)\n`;
const digest = (d: string) => `# Newsletter Digest — ${d}\n\n<!-- DAILY_BRIEF_START -->\n## Daily Brief\n\n${brief(d.slice(-2))}\n<!-- DAILY_BRIEF_END -->\n\n## Sources\n\n- [[${d}/Fixture 1|Fixture 1]]\n- [[${d}/Fixture 2|Fixture 2]]\n`;

function ledgerData(revisions: Record<string, number>) {
    const buckets: Record<string, unknown> = {};
    for (const [d, rev] of Object.entries(revisions)) {
        buckets[d] = {
            revision: rev, updatedAt: 1, audio: {},
            stories: [{ key: `story ${d} alpha`, title: `Story ${d.slice(-2)} alpha`, gist: 'Gist alpha', firstRevision: 1, contentRevision: 1 }],
        };
    }
    return { 'newsletter-story-ledger': { version: 1, buckets } };
}

function makePlugin(initial: Record<string, unknown>) {
    const state = { stored: structuredClone(initial) as Record<string, unknown>, failLoad: false };
    return {
        state,
        loadData: async () => { if (state.failLoad) throw new Error('disk'); return structuredClone(state.stored); },
        saveData: vi.fn(async (d: Record<string, unknown>) => { state.stored = structuredClone(d); }),
    };
}

const settings = (over: Record<string, unknown> = {}) => ({
    ...DEFAULT_SETTINGS,
    featureFlags: { newsletter: true },
    newsletterAudioPodcast: true,
    newsletterAudioMode: 'on-demand',
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

function ports(now: Date, over: Partial<CatchUpPorts> = {}, s: Record<string, unknown> = {}): CatchUpPorts & { generateScript: ReturnType<typeof vi.fn> } {
    return {
        app: vault.app as never,
        plugin: plugin as never,
        settings: settings(s),
        now: () => now,
        random: nextRandom,
        resolveTts: vi.fn(async () => ({ ok: true as const, tts: { engine: engine as never, providerId: 'fixture', modelId: 'fixture-model' } })),
        generateScript: vi.fn(async () => ok(SCRIPT)),
        shortenScript: vi.fn(async () => ok('A shorter synthetic script.')),
        ...over,
    } as never;
}

const run = { interactive: true };
const episodeNotes = () => [...vault.files.keys()].filter((k) => k.startsWith(`${FOLDER}/Catch-up `) && k.endsWith('.md'));
const episodeAudios = () => [...vault.files.keys()].filter((k) => k.startsWith(`${FOLDER}/catchup-`) && k.endsWith('.mp3'));

/** One unheard episode covering 21-23, made the normal way. Afterwards "now" is the 24th and a new day waits. */
async function seedUnheard(): Promise<void> {
    const made = await runCatchUp(ports(NOW1), run);
    expect(made.ok).toBe(true);
    vault.set(`${ROOT}/Digest — 2026-10-24.md`, digest('2026-10-24'));
    plugin.state.stored = { ...plugin.state.stored, ...ledgerData({ '2026-10-21': 2, '2026-10-22': 3, '2026-10-23': 1, '2026-10-24': 1 }) };
}

const deps = (over: Partial<ReplaceDeps> = {}): ReplaceDeps => ({
    app: vault.app as never, plugin: plugin as never, settings: settings(), now: () => NOW2, ...over,
});

async function ready(): Promise<Extract<ReplacePrep, { kind: 'ready' }>> {
    const prep = await prepareReplace(deps());
    expect(prep.ok).toBe(true);
    const v = (prep as { value: ReplacePrep }).value;
    expect(v.kind).toBe('ready');
    return v as Extract<ReplacePrep, { kind: 'ready' }>;
}

const request = (prep: Extract<ReplacePrep, { kind: 'ready' }>, over: Partial<ReplaceRequest> = {}): ReplaceRequest => ({
    episodeIds: prep.episodeIds, previewHash: prep.preview.plan!.planHash, acceptLostDays: false, purpose: 'manual', run, ...over,
});

beforeEach(() => {
    // Obsidian provides `activeDocument`; the default playback probe needs it to look at any player.
    (globalThis as { activeDocument?: Document }).activeDocument = document;
    counter = 0;
    __resetChainForTests();
    __resetCatchUpLockForTests();
    vault = makeCatchUpVault();
    for (const d of ['2026-10-21', '2026-10-22', '2026-10-23']) vault.set(`${ROOT}/Digest — ${d}.md`, digest(d));
    plugin = makePlugin(ledgerData({ '2026-10-21': 2, '2026-10-22': 3, '2026-10-23': 1 }));
    engine = { providerId: 'fixture', synthesizeChunk: vi.fn(async () => tone()) };
});

describe('prepareReplace (read only: nothing is spent or changed)', () => {
    it('shows the exact plan a replacement would make, covering ALL pending days, and names what would go', async () => {
        await seedUnheard();
        const before = new Map(vault.files);
        const prep = await ready();
        expect(prep.candidates).toHaveLength(1);
        expect(prep.candidates[0]).toMatchObject({ from: '2026-10-21', to: '2026-10-23', dates: ['2026-10-21', '2026-10-22', '2026-10-23'] });
        expect(prep.candidates[0].noteName).toMatch(/^Catch-up 2026-10-21 to 2026-10-23 .+\.md$/);
        expect(prep.candidates[0].audioName).toMatch(/^catchup-.+\.mp3$/);
        expect(prep.preview.plan!.entries.map((e) => e.date)).toEqual(['2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24']);
        expect(prep.lostDays).toEqual([]);
        expect(vault.app.fileManager.trashFile).not.toHaveBeenCalled();
        expect(new Map(vault.files)).toEqual(before);
    });

    it('with nothing unheard there is nothing to replace', async () => {
        const prep = await prepareReplace(deps());
        expect(prep).toEqual({ ok: false, error: 'catchup-nothing-pending' });
    });

    it('is refused outside the catch-up modes', async () => {
        await seedUnheard();
        expect(await prepareReplace(deps({ settings: settings({ newsletterAudioMode: 'daily' }) }))).toEqual({ ok: false, error: 'catchup-wrong-mode' });
        expect(await prepareReplace(deps({ settings: settings({ newsletterAudioPodcast: false }) }))).toEqual({ ok: false, error: 'catchup-wrong-mode' });
    });

    it('is blocked, with the reason, while the episode is playing or the probe cannot tell', async () => {
        await seedUnheard();
        const playing = await prepareReplace(deps({ probePlaying: () => 'playing' }));
        expect(playing).toMatchObject({ ok: true, value: { kind: 'blocked', refused: [{ reason: 'playing-now' }] } });
        const unknown = await prepareReplace(deps({ probePlaying: () => 'unknown' }));
        expect(unknown).toMatchObject({ ok: true, value: { kind: 'blocked', refused: [{ reason: 'playback-unknown' }] } });
    });

    it('days of the old episode that can no longer be made are reported as lost', async () => {
        await seedUnheard();
        vault.remove(`${ROOT}/Digest — 2026-10-21.md`);
        const prep = await ready();
        expect(prep.lostDays).toEqual(['2026-10-21']);
    });
});

describe('assessReplace fails closed on everything unknown', () => {
    async function candidates() {
        await seedUnheard();
        const snap = await buildCatchUpSnapshot({ app: vault.app as never, plugin: plugin as never, settings: settings(), now: NOW2 });
        return snap.unheard;
    }
    const idle = { probePlaying: () => 'idle' as const };

    it('passes a plain unheard episode', async () => {
        const eps = await candidates();
        const a = await assessReplace(deps(idle), eps, 'manual');
        expect(a.refused).toEqual([]);
        expect(a.candidates[0].inboundLinks).toBe(0);
    });

    it.each([
        ['an index that is not ready', { waitForIndex: async () => ({ outcome: 'timeout' as const, state: 'building' as const }) }, 'index-not-ready'],
        ['an index nothing can vouch for', { waitForIndex: async () => ({ outcome: 'timeout' as const, state: 'unknown' as const }) }, 'index-unavailable'],
    ])('refuses on %s', async (_n, extra, reason) => {
        const eps = await candidates();
        const a = await assessReplace(deps({ ...idle, ...extra }), eps, 'manual');
        expect(a.refused).toEqual([{ id: eps[0].id, reason }]);
        expect(a.candidates).toEqual([]);
    });

    it('refuses when the plugin data cannot be read', async () => {
        const eps = await candidates();
        plugin.state.failLoad = true;
        const a = await assessReplace(deps(idle), eps, 'manual');
        expect(a.refused[0].reason).toBe('acks-unreadable');
    });

    it('refuses an episode that was just marked listened', async () => {
        const eps = await candidates();
        await ackEpisodes(plugin as never, [{ id: eps[0].id, to: eps[0].to }], '2026-10-24', 7);
        const a = await assessReplace(deps(idle), eps, 'manual');
        expect(a.refused[0].reason).toBe('acked');
    });

    it('refuses an episode a stored operation record names, and an unreadable record', async () => {
        const eps = await candidates();
        plugin.state.stored = { ...plugin.state.stored, [DRAFT_DATA_KEY]: { version: 99 } };
        expect((await assessReplace(deps(idle), eps, 'manual')).refused[0].reason).toBe('record-unknown');
        plugin.state.stored = { ...plugin.state.stored, [DRAFT_DATA_KEY]: 'garbage' };
        expect((await assessReplace(deps(idle), eps, 'manual')).refused[0].reason).toBe('record-unknown');
    });

    it('refuses protected folders (note and audio separately)', async () => {
        const eps = await candidates();
        const protectedNote = deps({ ...idle, settings: settings({ protectedFolders: [FOLDER] }) });
        expect((await assessReplace(protectedNote, eps, 'manual')).refused[0].reason).toBe('protected');
    });

    it('refuses a note that moved, a missing audio file and an unexpected audio name', async () => {
        const eps = await candidates();
        const moved = { ...eps[0], notePath: `${ROOT}/elsewhere/${eps[0].notePath.split('/').pop()}` };
        expect((await assessReplace(deps(idle), [moved], 'manual')).refused[0].reason).toBe('note-unexpected');
        vault.remove(`${FOLDER}/${eps[0].audio}`);
        expect((await assessReplace(deps(idle), eps, 'manual')).refused[0].reason).toBe('audio-unexpected');
        expect((await assessReplace(deps(idle), [{ ...eps[0], audio: '../x.mp3' }], 'manual')).refused[0].reason).toBe('note-unexpected');
    });

    it('counts other notes that link to the episode files', async () => {
        const eps = await candidates();
        vault.app.metadataCache.resolvedLinks['Somewhere/Journal.md'] = { [`${FOLDER}/${eps[0].audio}`]: 1 };
        vault.app.metadataCache.resolvedLinks[eps[0].notePath] = { [`${FOLDER}/${eps[0].audio}`]: 1 };
        const a = await assessReplace(deps(idle), eps, 'manual');
        expect(a.candidates[0].inboundLinks).toBe(1);
    });
});

describe('assessReplace: automatic replacement has nobody to confirm', () => {
    it('refuses an episode other notes link to, where a manual replace only counts the links', async () => {
        await seedUnheard();
        const snap = await buildCatchUpSnapshot({ app: vault.app as never, plugin: plugin as never, settings: settings(), now: NOW2 });
        const eps = snap.unheard;
        vault.app.metadataCache.resolvedLinks['Somewhere/Journal.md'] = { [eps[0].notePath]: 1 };
        const idle = { probePlaying: () => 'idle' as const };
        expect((await assessReplace(deps(idle), eps, 'manual')).candidates[0].inboundLinks).toBe(1);
        expect((await assessReplace(deps(idle), eps, 'auto')).refused).toEqual([{ id: eps[0].id, reason: 'linked-elsewhere' }]);
    });

    it('takes the covered days from the note as it is NOW, not from the supplied metadata', async () => {
        await seedUnheard();
        const snap = await buildCatchUpSnapshot({ app: vault.app as never, plugin: plugin as never, settings: settings(), now: NOW2 });
        const stale = { ...snap.unheard[0], coverage: { '2026-10-23': { kind: 'whole' as const } } };
        const a = await assessReplace(deps({ probePlaying: () => 'idle' }), [stale], 'manual');
        expect(a.candidates[0].dates).toEqual(['2026-10-21', '2026-10-22', '2026-10-23']);
    });

    it('an unexpected throw while judging is a refusal, never an exception', async () => {
        await seedUnheard();
        const snap = await buildCatchUpSnapshot({ app: vault.app as never, plugin: plugin as never, settings: settings(), now: NOW2 });
        const a = await assessReplace(deps({ probePlaying: () => { throw new Error('boom'); } }), snap.unheard, 'manual');
        expect(a.refused).toEqual([{ id: snap.unheard[0].id, reason: 'unreadable' }]);
    });
});

describe('lostDaysOf', () => {
    const plan = (dates: string[]) => ({ entries: dates.map((date) => ({ date })) }) as never;
    it('only days neither re-planned nor still covered elsewhere are lost', () => {
        const lost = lostDaysOf([{ dates: ['2026-10-20', '2026-10-21', '2026-10-22'] }], {
            plan: plan(['2026-10-21']),
            pending: { entries: [], unresolved: [], noStoredDates: [], coveredDates: ['2026-10-22'], openDates: [] },
        });
        expect(lost).toEqual(['2026-10-20']);
    });
});

describe('replaceAndRunCatchUp', () => {
    it('makes ONE new episode over every pending day, then moves the old note and audio to the trash (note first)', async () => {
        await seedUnheard();
        const oldNote = episodeNotes()[0];
        const oldAudio = episodeAudios()[0];
        const prep = await ready();
        const p = ports(NOW2);
        const res = await replaceAndRunCatchUp(p, request(prep), { probePlaying: () => 'idle' });
        expect(res.ok).toBe(true);
        const outcome = (res as { value: { episode: { from: string; to: string; days: number }; retired: unknown[] } }).value;
        expect(outcome.episode).toMatchObject({ from: '2026-10-21', to: '2026-10-24', days: 4 });
        expect(outcome.retired).toEqual([expect.objectContaining({ note: 'trashed', audio: 'trashed' })]);
        const plan = p.generateScript.mock.calls[0][0];
        expect(plan.entries.map((e: { date: string }) => e.date)).toEqual(['2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24']);

        const trashed = vault.app.fileManager.trashFile.mock.calls.map((c) => (c[0] as { path: string }).path);
        expect(trashed).toEqual([oldNote, oldAudio]);
        expect(episodeNotes()).toHaveLength(1);
        expect(episodeNotes()[0]).not.toBe(oldNote);
        // A trash, never a permanent delete.
        expect((vault.app.vault as unknown as Record<string, unknown>)['delete']).toBeUndefined();
    });

    it('the new episode is NOT marked heard by the replace', async () => {
        await seedUnheard();
        const prep = await ready();
        await replaceAndRunCatchUp(ports(NOW2), request(prep), { probePlaying: () => 'idle' });
        const snap = await buildCatchUpSnapshot({ app: vault.app as never, plugin: plugin as never, settings: settings(), now: NOW2 });
        expect(snap.unheard).toHaveLength(1);
        expect(plugin.state.stored[ACKS_DATA_KEY]).toBeUndefined();
    });

    it('a failed script or voice leaves the old episode exactly as it was', async () => {
        await seedUnheard();
        const prep = await ready();
        const oldFiles = new Set(vault.files.keys());
        const failing = ports(NOW2, { generateScript: vi.fn(async () => err('boom')) as never });
        const res = await replaceAndRunCatchUp(failing, request(prep), { probePlaying: () => 'idle' });
        expect(res.ok).toBe(false);
        expect(vault.app.fileManager.trashFile).not.toHaveBeenCalled();
        expect(new Set(vault.files.keys())).toEqual(oldFiles);

        engine.synthesizeChunk.mockRejectedValue(new Error('voice down'));
        const res2 = await replaceAndRunCatchUp(ports(NOW2), request(prep), { probePlaying: () => 'idle' });
        expect(res2.ok).toBe(false);
        expect(vault.app.fileManager.trashFile).not.toHaveBeenCalled();
    });

    it('a changed blocker set or a changed plan does nothing', async () => {
        await seedUnheard();
        const prep = await ready();
        const stale = await replaceAndRunCatchUp(ports(NOW2), request(prep, { episodeIds: ['20260101-000000-aaaa'] }), { probePlaying: () => 'idle' });
        expect(stale).toEqual({ ok: false, error: 'catchup-changed' });
        const wrongHash = await replaceAndRunCatchUp(ports(NOW2), request(prep, { previewHash: 'deadbeef' }), { probePlaying: () => 'idle' });
        expect(wrongHash).toEqual({ ok: false, error: 'catchup-changed' });
        expect(vault.app.fileManager.trashFile).not.toHaveBeenCalled();
    });

    it('refuses before any spend when the episode is unsafe to replace', async () => {
        await seedUnheard();
        const prep = await ready();
        const p = ports(NOW2);
        const res = await replaceAndRunCatchUp(p, request(prep), { probePlaying: () => 'playing' });
        expect(res).toEqual({ ok: false, error: 'catchup-replace-unsafe' });
        expect(p.generateScript).not.toHaveBeenCalled();
    });

    it('playback that starts DURING generation keeps the old episode and preserves the new one', async () => {
        await seedUnheard();
        const prep = await ready();
        let playing = false;
        const p = ports(NOW2, { generateScript: vi.fn(async () => { playing = true; return ok(SCRIPT); }) as never });
        const res = await replaceAndRunCatchUp(p, request(prep), { probePlaying: () => (playing ? 'playing' : 'idle') });
        expect(res.ok).toBe(true);
        const retired = (res as { value: { retired: Array<{ note: string; audio: string; reason?: string }> } }).value.retired;
        expect(retired).toEqual([expect.objectContaining({ note: 'kept', audio: 'kept', reason: 'playing-now' })]);
        expect(vault.app.fileManager.trashFile).not.toHaveBeenCalled();
        expect(episodeNotes()).toHaveLength(2);
    });

    it('an ack that arrives during generation keeps the old episode', async () => {
        await seedUnheard();
        const prep = await ready();
        const old = prep.candidates[0];
        const p = ports(NOW2, { generateScript: vi.fn(async () => { await ackEpisodes(plugin as never, [{ id: old.id, to: old.to }], '2026-10-24', 7); return ok(SCRIPT); }) as never });
        const res = await replaceAndRunCatchUp(p, request(prep), { probePlaying: () => 'idle' });
        expect(res.ok).toBe(true);
        expect((res as { value: { retired: Array<{ reason?: string }> } }).value.retired[0].reason).toBe('acked');
        expect(vault.app.fileManager.trashFile).not.toHaveBeenCalled();
    });

    it('reports a trash that fails PER FILE: note trashed then audio failed is an orphan, never "kept"', async () => {
        await seedUnheard();
        const prep = await ready();
        const real = vault.app.fileManager.trashFile.getMockImplementation()!;
        vault.app.fileManager.trashFile.mockImplementation(async (f: { path: string }) => {
            if (f.path.endsWith('.mp3') && f.path === prep.candidates[0].audioPath) throw new Error('locked');
            return (real as unknown as (file: unknown) => Promise<void>)(f);
        });
        const res = await replaceAndRunCatchUp(ports(NOW2), request(prep), { probePlaying: () => 'idle' });
        expect(res.ok).toBe(true);
        const retired = (res as { value: { retired: Array<{ note: string; audio: string }> } }).value.retired;
        expect(retired).toEqual([expect.objectContaining({ note: 'trashed', audio: 'failed' })]);
    });

    it('a failed NOTE trash keeps both files', async () => {
        await seedUnheard();
        const prep = await ready();
        vault.app.fileManager.trashFile.mockRejectedValue(new Error('locked'));
        const res = await replaceAndRunCatchUp(ports(NOW2), request(prep), { probePlaying: () => 'idle' });
        const retired = (res as { value: { retired: Array<{ note: string; audio: string }> } }).value.retired;
        expect(retired).toEqual([expect.objectContaining({ note: 'failed', audio: 'kept' })]);
        expect(episodeAudios()).toHaveLength(2);
    });

    it('lost days need the person to have accepted them, and an automatic replace never accepts them', async () => {
        await seedUnheard();
        vault.remove(`${ROOT}/Digest — 2026-10-21.md`);
        const prep = await ready();
        expect(prep.lostDays).toEqual(['2026-10-21']);
        const refused = await replaceAndRunCatchUp(ports(NOW2), request(prep), { probePlaying: () => 'idle' });
        expect(refused).toEqual({ ok: false, error: 'catchup-replace-unsafe' });
        const auto = await replaceAndRunCatchUp(ports(NOW2), request(prep, { acceptLostDays: true, purpose: 'auto' }), { probePlaying: () => 'idle' });
        expect(auto).toEqual({ ok: false, error: 'catchup-replace-unsafe' });
        const accepted = await replaceAndRunCatchUp(ports(NOW2), request(prep, { acceptLostDays: true }), { probePlaying: () => 'idle' });
        expect(accepted.ok).toBe(true);
    });

    it('playback that starts between the note trash and the audio trash keeps the audio', async () => {
        await seedUnheard();
        const prep = await ready();
        let calls = 0;
        // idle for the lock-time assessment, the pre-retirement assessment and the note trash; playing right before the audio.
        const probe = () => (++calls >= 3 ? 'playing' as const : 'idle' as const);
        const res = await replaceAndRunCatchUp(ports(NOW2), request(prep), { probePlaying: probe });
        expect(res.ok).toBe(true);
        const retired = (res as { value: { retired: Array<{ note: string; audio: string; reason?: string }> } }).value.retired;
        expect(retired).toEqual([expect.objectContaining({ note: 'trashed', audio: 'kept', reason: 'playing-now' })]);
        expect(episodeAudios()).toContain(prep.candidates[0].audioPath);
    });

    it('an exception while retiring never turns a committed replacement into a failure', async () => {
        await seedUnheard();
        const prep = await ready();
        let calls = 0;
        const probe = () => { if (++calls >= 3) throw new Error('detached window'); return 'idle' as const; };
        const res = await replaceAndRunCatchUp(ports(NOW2), request(prep), { probePlaying: probe });
        expect(res.ok).toBe(true);
        // The report matches the disk: the note was trashed before the probe threw, so the audio is NOT claimed as kept.
        const retired = (res as { value: { retired: Array<{ note: string; audio: string; reason?: string }> } }).value.retired;
        expect(retired).toEqual([expect.objectContaining({ note: 'trashed', audio: 'failed', reason: 'unreadable' })]);
        expect(episodeAudios()).toContain(prep.candidates[0].audioPath);
    });

    it('holds the single-flight lock: a second run is busy while a replacement is being made', async () => {
        await seedUnheard();
        const prep = await ready();
        let release: () => void = () => undefined;
        const gate = new Promise<void>((r) => { release = r; });
        const slow = ports(NOW2, { generateScript: vi.fn(async () => { await gate; return ok(SCRIPT); }) as never });
        const first = replaceAndRunCatchUp(slow, request(prep), { probePlaying: () => 'idle' });
        await vi.waitFor(() => expect(slow.generateScript).toHaveBeenCalled());
        expect(await runCatchUp(ports(NOW2), run)).toEqual({ ok: false, error: 'catchup-busy' });
        expect(await replaceAndRunCatchUp(ports(NOW2), request(prep), { probePlaying: () => 'idle' })).toEqual({ ok: false, error: 'catchup-busy' });
        release();
        expect((await first).ok).toBe(true);
    });

    it('is refused in Daily mode', async () => {
        await seedUnheard();
        const prep = await ready();
        const res = await replaceAndRunCatchUp(ports(NOW2, {}, { newsletterAudioMode: 'daily' }), request(prep), { probePlaying: () => 'idle' });
        expect(res).toEqual({ ok: false, error: 'catchup-wrong-mode' });
    });
});
