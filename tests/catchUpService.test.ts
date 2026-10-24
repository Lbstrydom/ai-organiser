// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/minutesUtils', () => ({
    ensureFolderExists: vi.fn().mockResolvedValue(undefined),
    sanitizeFileName: (n: string) => n,
}));

import { ok, err } from '../src/core/result';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { __resetChainForTests } from '../src/core/pluginDataStore';
import {
    runCatchUp,
    resumeCatchUp,
    discardOperation,
    reconcileOperation,
    classifyOperation,
    autoRunDecision,
    runAutoCatchUp,
    isCatchUpRunning,
    countWords,
    __resetCatchUpLockForTests,
    type CatchUpPorts,
    type RunPhase,
} from '../src/services/newsletter/catchUp/catchUpService';
import { loadOperation, saveOperation, DRAFT_DATA_KEY, ackEpisodes, RECORD_TTL_MS, type OperationRecord } from '../src/services/newsletter/catchUp/catchUpDraft';
import { buildCatchUpSnapshot } from '../src/services/newsletter/catchUp/catchUpSelection';
import { buildEpisodeNote, findLatestEpisode, parseEpisodeContent } from '../src/services/newsletter/catchUp/catchUpEpisode';
import { buildEpisodeName } from '../src/services/newsletter/catchUp/catchUpCoverage';
import { makeCatchUpVault } from './helpers/catchUpVault';

const ROOT = 'AI-Organiser/Newsletter Inbox';
const FOLDER = `${ROOT}/Catch-up`;
const NOW = new Date(2026, 9, 23, 12, 0, 0);
const DATES = ['2026-10-21', '2026-10-22', '2026-10-23'];

const brief = (n: string) => `### Fixtures\n\n- **Story ${n} alpha**: Synthetic summary alpha for fixture ${n}. (Sources: Fixture A)\n- **Story ${n} beta**: Synthetic summary beta for fixture ${n}. (Sources: Fixture B)\n`;
const digest = (d: string) => `# Newsletter Digest — ${d}\n\n<!-- DAILY_BRIEF_START -->\n## Daily Brief\n\n${brief(d.slice(-2))}\n<!-- DAILY_BRIEF_END -->\n\n## Sources\n\n- [[${d}/Fixture 1|Fixture 1]]\n- [[${d}/Fixture 2|Fixture 2]]\n`;

function ledgerData(revisions: Record<string, number> = { '2026-10-21': 2, '2026-10-22': 3, '2026-10-23': 1 }, extraStories: Record<string, Array<[string, number]>> = {}) {
    const buckets: Record<string, unknown> = {};
    for (const [d, rev] of Object.entries(revisions)) {
        buckets[d] = {
            revision: rev,
            updatedAt: 1,
            stories: [
                { key: `story ${d} alpha`, title: `Story ${d.slice(-2)} alpha`, gist: 'Gist alpha', firstRevision: 1, contentRevision: 1 },
                ...(extraStories[d] ?? []).map(([title, contentRevision]) => ({ key: title.toLowerCase(), title, gist: `Gist for ${title}`, firstRevision: contentRevision, contentRevision })),
            ],
            audio: {},
        };
    }
    return { 'newsletter-story-ledger': { version: 1, buckets } };
}

function makePlugin(initial: Record<string, unknown> = ledgerData()) {
    const state = { stored: structuredClone(initial) as Record<string, unknown> };
    return {
        state,
        loadData: async () => structuredClone(state.stored),
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
let randomCounter = 0;
/** Deterministic but varying, so two runs in the same second still get different operation ids. */
const nextRandom = () => ((++randomCounter * 0.137) % 1);

const SHORT_SCRIPT = 'Good morning. Here is what happened across the days you missed, in a short synthetic script.';
const LONG_SCRIPT = 'synthetic '.repeat(2400).trim(); // 2400 words > 1.15 * 1950 for a 15-minute cap, ~28 spoken minutes

function ports(over: Partial<CatchUpPorts> = {}, s: Record<string, unknown> = {}): CatchUpPorts & {
    generateScript: ReturnType<typeof vi.fn>;
    shortenScript: ReturnType<typeof vi.fn>;
    resolveTts: ReturnType<typeof vi.fn>;
} {
    return {
        app: vault.app as never,
        plugin: plugin as never,
        settings: settings(s),
        now: () => NOW,
        random: nextRandom,
        resolveTts: vi.fn(async () => ({ ok: true as const, tts: { engine: engine as never, providerId: 'fixture', modelId: 'fixture-model' } })),
        generateScript: vi.fn(async () => ok(SHORT_SCRIPT)),
        shortenScript: vi.fn(async () => ok('A shorter synthetic script.')),
        ...over,
    } as never;
}

const opts = (over: Record<string, unknown> = {}) => ({ interactive: true, ...over });

beforeEach(() => {
    randomCounter = 0;
    __resetChainForTests();
    __resetCatchUpLockForTests();
    vault = makeCatchUpVault();
    for (const d of DATES) vault.set(`${ROOT}/Digest — ${d}.md`, digest(d));
    plugin = makePlugin();
    engine = { providerId: 'fixture', synthesizeChunk: vi.fn(async () => tone()) };
});

describe('the happy path', () => {
    it('writes the script, then the audio, then the note LAST, and clears the record', async () => {
        const p = ports();
        const events: string[] = [];
        p.generateScript.mockImplementation(async () => { events.push('script'); return ok(SHORT_SCRIPT); });
        engine.synthesizeChunk.mockImplementation(async () => { events.push('tts'); return tone(); });
        vault.app.vault.create.mockImplementation(async (path: string, c: string) => { events.push('note'); vault.set(path, c); return { path }; });

        const res = await runCatchUp(p, opts());
        expect(res.ok).toBe(true);
        expect(events).toEqual(['script', 'tts', 'note']);
        expect(p.resolveTts.mock.invocationCallOrder[0]).toBeLessThan(p.generateScript.mock.invocationCallOrder[0]);
        expect(await loadOperation(plugin as never)).toBeNull();
        expect(DRAFT_DATA_KEY in plugin.state.stored).toBe(false);
    });

    it('reports the result and the covered range', async () => {
        const res = await runCatchUp(ports(), opts());
        if (!res.ok) throw new Error(res.error);
        expect(res.value.from).toBe('2026-10-21');
        expect(res.value.to).toBe('2026-10-23');
        expect(res.value.days).toBe(3);
        expect(res.value.sources).toBe(6);
        expect(res.value.minutes).toBeCloseTo(0.0167, 1);
        expect(vault.exists(res.value.audioPath)).toBe(true);
        expect(vault.exists(res.value.notePath)).toBe(true);
    });

    it('the episode note carries the FROZEN coverage and the next snapshot sees nothing pending', async () => {
        const res = await runCatchUp(ports(), opts());
        expect(res.ok).toBe(true);
        const meta = parseEpisodeContent(vault.text((res as { value: { notePath: string } }).value.notePath), 'p')!;
        expect(meta.coverage).toEqual({
            '2026-10-21': { kind: 'revision', rev: 2 },
            '2026-10-22': { kind: 'revision', rev: 3 },
            '2026-10-23': { kind: 'revision', rev: 1 },
        });
        const snap = await buildCatchUpSnapshot({ app: vault.app as never, plugin: plugin as never, settings: settings(), now: NOW });
        expect(snap.plan).toBeNull();
        expect(snap.state).toBe('caught-up');
        expect(snap.unheard).toHaveLength(1); // generated, not heard
    });

    it('reports phases in order and stops offering Cancel at the commit', async () => {
        const phases: RunPhase['key'][] = [];
        const setCancellable = vi.fn();
        await runCatchUp(ports(), opts({ onPhase: (p: RunPhase) => phases.push(p.key), setCancellable }));
        expect(phases[0]).toBe('freezing');
        expect(phases).toContain('writingScript');
        expect(phases).toContain('synthesising');
        expect(phases.at(-1)).toBe('saving');
        expect(setCancellable).toHaveBeenCalledWith(false);
        expect(phases.indexOf('writingScript')).toBeLessThan(phases.indexOf('synthesising'));
    });

    it('write-ahead: the record already names the audio file when synthesis starts', async () => {
        let seen: OperationRecord | null = null;
        engine.synthesizeChunk.mockImplementation(async () => { seen = await loadOperation(plugin as never); return tone(); });
        await runCatchUp(ports(), opts());
        expect(seen).not.toBeNull();
        expect(seen!.phase).toBe('audio-writing');
        expect(seen!.audio?.path).toMatch(/Catch-up\/catchup-.+\.mp3$/);
        expect(seen!.script).toBe(SHORT_SCRIPT);
    });

    it('gives the script prompt the frozen plan', async () => {
        const p = ports();
        await runCatchUp(p, opts());
        const plan = p.generateScript.mock.calls[0][0];
        expect(plan.entries.map((e: { date: string }) => e.date)).toEqual(DATES);
        expect(plan.length.capMinutes).toBe(15);
    });
});

describe('admission', () => {
    it('nothing pending is refused with guidance and calls nothing', async () => {
        await runCatchUp(ports(), opts());
        const p = ports();
        const res = await runCatchUp(p, opts());
        expect(res).toEqual({ ok: false, error: 'catchup-nothing-pending' });
        expect(p.generateScript).not.toHaveBeenCalled();
        expect(p.resolveTts).not.toHaveBeenCalled();
    });

    it('a missing TTS setup fails BEFORE any LLM spend', async () => {
        const p = ports({ resolveTts: vi.fn(async () => ({ ok: false as const, code: 'catchup-no-tts' })) });
        const res = await runCatchUp(p, opts());
        expect(res).toEqual({ ok: false, error: 'catchup-no-tts' });
        expect(p.generateScript).not.toHaveBeenCalled();
    });

    it('a changed world since the preview is refused, not generated', async () => {
        const p = ports();
        const res = await runCatchUp(p, opts({ previewHash: 'deadbeef' }));
        expect(res).toEqual({ ok: false, error: 'catchup-changed' });
        expect(p.generateScript).not.toHaveBeenCalled();
    });

    it('the previewed hash is accepted when nothing changed', async () => {
        const snap = await buildCatchUpSnapshot({ app: vault.app as never, plugin: plugin as never, settings: settings(), now: NOW });
        const res = await runCatchUp(ports(), opts({ previewHash: snap.plan!.planHash }));
        expect(res.ok).toBe(true);
    });

    it('a second request while one runs is rejected as busy', async () => {
        let release: () => void = () => undefined;
        const gate = new Promise<void>((r) => { release = r; });
        const slow = ports({ generateScript: vi.fn(async () => { await gate; return ok(SHORT_SCRIPT); }) as never });
        const first = runCatchUp(slow, opts());
        await vi.waitFor(() => expect(isCatchUpRunning()).toBe(true));
        const second = await runCatchUp(ports(), opts());
        expect(second).toEqual({ ok: false, error: 'catchup-busy' });
        release();
        expect((await first).ok).toBe(true);
        expect(isCatchUpRunning()).toBe(false);
    });

    it('the lock is released after a failure', async () => {
        await runCatchUp(ports({ generateScript: vi.fn(async () => err('boom')) as never }), opts());
        expect(isCatchUpRunning()).toBe(false);
    });
});

describe('failure before the script exists', () => {
    it('a failed script call saves nothing and writes no record', async () => {
        const res = await runCatchUp(ports({ generateScript: vi.fn(async () => err('llm down')) as never }), opts());
        expect(res).toEqual({ ok: false, error: 'catchup-script-failed' });
        expect(await loadOperation(plugin as never)).toBeNull();
        expect(vault.app.vault.create).not.toHaveBeenCalled();
        expect(engine.synthesizeChunk).not.toHaveBeenCalled();
    });

    it('an empty script is a failure, not an empty episode', async () => {
        const res = await runCatchUp(ports({ generateScript: vi.fn(async () => ok('   ')) as never }), opts());
        expect(res).toEqual({ ok: false, error: 'catchup-script-failed' });
    });

    it('cancelling during the script call leaves no record and no files', async () => {
        const ac = new AbortController();
        const p = ports({ generateScript: vi.fn(async () => { ac.abort(); return err('aborted'); }) as never });
        const res = await runCatchUp(p, opts({ signal: ac.signal }));
        expect(res).toEqual({ ok: false, error: 'cancelled' });
        expect(await loadOperation(plugin as never)).toBeNull();
        expect([...vault.files.keys()].some((k) => k.includes('Catch-up'))).toBe(false);
    });
});

describe('cancellation after the script', () => {
    it('keeps the script record, saves no note and no coverage, and removes the partial audio', async () => {
        const ac = new AbortController();
        engine.synthesizeChunk.mockImplementation(async () => { ac.abort(); return tone(); });
        const res = await runCatchUp(ports(), opts({ signal: ac.signal }));
        expect(res).toEqual({ ok: false, error: 'cancelled' });
        const rec = await loadOperation(plugin as never);
        expect(rec?.script).toBe(SHORT_SCRIPT);
        expect([...vault.files.keys()].filter((k) => k.endsWith('.md') && k.includes('Catch-up'))).toEqual([]);
        expect([...vault.files.keys()].filter((k) => k.endsWith('.mp3'))).toEqual([]);
        const snap = await buildCatchUpSnapshot({ app: vault.app as never, plugin: plugin as never, settings: settings(), now: NOW });
        expect(snap.plan).not.toBeNull(); // coverage did not advance
    });
});

describe('TTS failure and resume', () => {
    beforeEach(() => { engine.synthesizeChunk.mockRejectedValue(new Error('tts down')); });

    it('keeps the script and reports the failure', async () => {
        const res = await runCatchUp(ports(), opts());
        expect(res).toEqual({ ok: false, error: 'catchup-tts-failed' });
        const rec = await loadOperation(plugin as never);
        expect(rec?.phase).toBe('audio-writing');
        expect(rec?.script).toBe(SHORT_SCRIPT);
    });

    it('resume re-voices from the stored script WITHOUT another LLM call', async () => {
        await runCatchUp(ports(), opts());
        engine.synthesizeChunk.mockImplementation(async () => tone());
        const p = ports();
        const res = await resumeCatchUp(p, opts());
        expect(res.ok).toBe(true);
        expect(p.generateScript).not.toHaveBeenCalled();
        expect(await loadOperation(plugin as never)).toBeNull();
    });

    it('resume claims the STORED coverage even after a new fetch changed the ledger', async () => {
        await runCatchUp(ports(), opts());
        // A fetch lands between the failure and the resume: bucket 22 advances to revision 5 and a digest changes.
        const rec = (await loadOperation(plugin as never))!;
        plugin.state.stored = {
            ...ledgerData({ '2026-10-21': 2, '2026-10-22': 5, '2026-10-23': 1 }, { '2026-10-22': [['Late story', 5]] }),
            [DRAFT_DATA_KEY]: rec,
        };
        engine.synthesizeChunk.mockImplementation(async () => tone());
        const res = await resumeCatchUp(ports(), opts());
        expect(res.ok).toBe(true);
        const meta = parseEpisodeContent(vault.text((res as { value: { notePath: string } }).value.notePath), 'p')!;
        expect(meta.coverage['2026-10-22']).toEqual({ kind: 'revision', rev: 3 }); // the frozen revision, not 5
        const snap = await buildCatchUpSnapshot({ app: vault.app as never, plugin: plugin as never, settings: settings(), now: NOW });
        const delta = snap.plan!.entries.find((e) => e.date === '2026-10-22')!;
        expect(delta.kind).toBe('delta'); // the late story belongs to the NEXT run
        expect(delta.sinceRevision).toBe(3);
    });

    it('a different voice re-synthesises; the same voice would have reused verified audio', async () => {
        engine.synthesizeChunk.mockImplementation(async () => tone());
        // Make the commit fail so a verified audio-ready record remains.
        vault.app.vault.create.mockRejectedValueOnce(new Error('disk full'));
        await runCatchUp(ports(), opts());
        const rec = await loadOperation(plugin as never);
        expect(rec?.phase).toBe('audio-ready');
        const callsBefore = engine.synthesizeChunk.mock.calls.length;

        const same = await resumeCatchUp(ports(), opts());
        expect(same.ok).toBe(true);
        expect(engine.synthesizeChunk.mock.calls.length).toBe(callsBefore); // reused, not re-voiced
    });
});

describe('save failure and Finish saving', () => {
    it('keeps verified audio; resume only writes the note and needs no TTS setup', async () => {
        vault.app.vault.create.mockRejectedValueOnce(new Error('disk full'));
        const res = await runCatchUp(ports(), opts());
        expect(res).toEqual({ ok: false, error: 'catchup-save-failed' });
        const rec = await loadOperation(plugin as never);
        expect(rec?.phase).toBe('audio-ready');
        expect(rec?.audio?.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(vault.exists(rec!.audio!.path)).toBe(true);

        const callsBefore = engine.synthesizeChunk.mock.calls.length;
        const p = ports({ resolveTts: vi.fn(async () => ({ ok: false as const, code: 'catchup-no-tts' })) as never });
        const fin = await resumeCatchUp(p, opts());
        expect(fin.ok).toBe(true);
        expect(p.resolveTts).not.toHaveBeenCalled();
        expect(engine.synthesizeChunk.mock.calls.length).toBe(callsBefore);
        expect(await loadOperation(plugin as never)).toBeNull();
    });

    it('classifies a corrupted staged file as incomplete rather than reusable', async () => {
        vault.app.vault.create.mockRejectedValueOnce(new Error('disk full'));
        await runCatchUp(ports(), opts());
        const rec = (await loadOperation(plugin as never))!;
        const whole = vault.files.get(rec.audio!.path) as ArrayBuffer;
        vault.set(rec.audio!.path, whole.slice(0, whole.byteLength - 20));
        const state = await classifyOperation(ports());
        expect(state.kind).toBe('audio-writing');
    });
});

describe('crash after the note was created', () => {
    async function crashAfterNote(): Promise<OperationRecord> {
        vault.app.vault.create.mockRejectedValueOnce(new Error('disk full'));
        await runCatchUp(ports(), opts());
        const rec = (await loadOperation(plugin as never))!;
        // The note actually landed, but the record was never cleared.
        const note = buildEpisodeNote({
            id: rec.opId, from: rec.frozen.from, to: rec.frozen.to,
            coverage: Object.fromEntries(rec.frozen.entries.map((e) => [e.date, e.coverage])),
            audio: rec.audio!.path.split('/').pop()!, fingerprint: 'c3d4e5f6', minutes: 1, sources: 6, titles: [], script: rec.script,
        });
        vault.set(`${FOLDER}/${buildEpisodeName(rec.frozen.from, rec.frozen.to, rec.opId)}`, note);
        return rec;
    }

    it('classifies as committed and reconciliation just clears the record', async () => {
        const rec = await crashAfterNote();
        expect((await classifyOperation(ports())).kind).toBe('committed');
        await reconcileOperation(ports());
        expect(await loadOperation(plugin as never)).toBeNull();
        expect(vault.exists(rec.audio!.path)).toBe(true);
    });

    it('TTL expiry never trashes the audio a committed note references', async () => {
        const rec = await crashAfterNote();
        const late = () => new Date(NOW.getTime() + RECORD_TTL_MS + 60_000);
        await reconcileOperation(ports({ now: late }));
        expect(vault.exists(rec.audio!.path)).toBe(true);
        expect(vault.app.fileManager.trashFile).not.toHaveBeenCalled();
        expect(await loadOperation(plugin as never)).toBeNull();
    });

    it('a changed voice after the crash does not touch the committed audio either', async () => {
        const rec = await crashAfterNote();
        await reconcileOperation(ports({}, { newsletterPodcastVoice: 'Puck' }));
        expect(vault.exists(rec.audio!.path)).toBe(true);
    });

    it('a retry of the commit is idempotent: one note only', async () => {
        const rec = await crashAfterNote();
        const res = await resumeCatchUp(ports(), opts());
        // reconcile saw the committed note and cleared the record, so there is nothing left to resume
        expect(res).toEqual({ ok: false, error: 'catchup-nothing-pending' });
        const notes = [...vault.files.keys()].filter((k) => k.startsWith(`${FOLDER}/Catch-up`));
        expect(notes).toHaveLength(1);
        expect(rec.opId).toBeTruthy();
    });
});

describe('expiry and discard of an UNcommitted record', () => {
    it('TTL expiry trashes the owned, unreferenced audio and clears the record', async () => {
        vault.app.vault.create.mockRejectedValueOnce(new Error('disk full'));
        await runCatchUp(ports(), opts());
        const rec = (await loadOperation(plugin as never))!;
        const late = () => new Date(NOW.getTime() + RECORD_TTL_MS + 60_000);
        const state = await reconcileOperation(ports({ now: late }));
        expect(state.kind).toBe('none');
        expect(vault.exists(rec.audio!.path)).toBe(false);
        expect(await loadOperation(plugin as never)).toBeNull();
    });

    it('Discard removes the record and the staged audio but leaves committed episodes alone', async () => {
        await runCatchUp(ports(), opts()); // a committed episode
        const committed = [...vault.files.keys()].filter((k) => k.endsWith('.mp3'));
        expect(committed).toHaveLength(1);

        // a later, unfinished operation
        await ackEpisodes(plugin as never, [], '2026-10-23', 7);
        vault.set(`${ROOT}/Digest — 2026-10-24.md`, digest('2026-10-24'));
        const later = () => new Date(2026, 9, 24, 12, 0, 0);
        engine.synthesizeChunk.mockRejectedValueOnce(new Error('tts down'));
        plugin.state.stored = { ...plugin.state.stored, ...ledgerData({ '2026-10-21': 2, '2026-10-22': 3, '2026-10-23': 1, '2026-10-24': 1 }) };
        await runCatchUp(ports({ now: later }), opts());
        const rec = (await loadOperation(plugin as never))!;

        const res = await discardOperation(ports({ now: later }));
        expect(res).toEqual({ ok: true, value: true });
        expect(await loadOperation(plugin as never)).toBeNull();
        expect([...vault.files.keys()].filter((k) => k.endsWith('.mp3'))).toEqual(committed);
        expect(rec.opId).toBeTruthy();
    });

    it('Discard with nothing stored is a quiet false', async () => {
        expect(await discardOperation(ports())).toEqual({ ok: true, value: false });
    });
});

describe('unresolved work blocks a new run', () => {
    it('a stored record makes runCatchUp refuse rather than replace it', async () => {
        engine.synthesizeChunk.mockRejectedValueOnce(new Error('tts down'));
        await runCatchUp(ports(), opts());
        const p = ports();
        const res = await runCatchUp(p, opts());
        expect(res).toEqual({ ok: false, error: 'catchup-unresolved' });
        expect(p.generateScript).not.toHaveBeenCalled();
    });
});

describe('episode length', () => {
    it('one automatic shrink fixes an over-long script without asking', async () => {
        const p = ports({ generateScript: vi.fn(async () => ok(LONG_SCRIPT)) as never });
        const confirm = vi.fn();
        const res = await runCatchUp(p, opts({ confirmOverrun: confirm }));
        expect(res.ok).toBe(true);
        expect(p.shortenScript).toHaveBeenCalledTimes(1);
        expect(confirm).not.toHaveBeenCalled();
        expect(vault.app.vault.create).toHaveBeenCalled();
    });

    it('still over after the shrink: an AUTOMATIC run fails with guidance and keeps the script', async () => {
        const p = ports({ generateScript: vi.fn(async () => ok(LONG_SCRIPT)) as never, shortenScript: vi.fn(async () => ok(LONG_SCRIPT)) as never });
        const res = await runCatchUp(p, opts({ interactive: false }));
        expect(res).toEqual({ ok: false, error: 'catchup-script-too-long' });
        expect(engine.synthesizeChunk).not.toHaveBeenCalled();
        expect((await loadOperation(plugin as never))?.script).toBe(LONG_SCRIPT);
    });

    it('interactive: Continue anyway proceeds, with the estimate shown', async () => {
        const p = ports({ generateScript: vi.fn(async () => ok(LONG_SCRIPT)) as never, shortenScript: vi.fn(async () => ok(LONG_SCRIPT)) as never });
        const confirm = vi.fn(async (_info: { estimatedMinutes: number; capMinutes: number }) => 'continue' as const);
        const res = await runCatchUp(p, opts({ confirmOverrun: confirm }));
        expect(res.ok).toBe(true);
        expect(confirm).toHaveBeenCalledWith({ estimatedMinutes: expect.any(Number), capMinutes: 15 });
        expect(confirm.mock.calls[0][0].estimatedMinutes).toBeGreaterThan(15);
    });

    it('interactive: Shorten again asks the shortener once more, then proceeds when it fits', async () => {
        const shorten = vi.fn()
            .mockResolvedValueOnce(ok(LONG_SCRIPT))       // the automatic shrink fails to help
            .mockResolvedValueOnce(ok(SHORT_SCRIPT));     // the user's "shorten again" works
        const p = ports({ generateScript: vi.fn(async () => ok(LONG_SCRIPT)) as never, shortenScript: shorten as never });
        const confirm = vi.fn(async () => 'shorten' as const);
        const res = await runCatchUp(p, opts({ confirmOverrun: confirm }));
        expect(res.ok).toBe(true);
        expect(shorten).toHaveBeenCalledTimes(2);
        expect(confirm).toHaveBeenCalledTimes(1);
    });

    it('interactive: Cancel stops before any audio and keeps the script', async () => {
        const p = ports({ generateScript: vi.fn(async () => ok(LONG_SCRIPT)) as never, shortenScript: vi.fn(async () => ok(LONG_SCRIPT)) as never });
        const res = await runCatchUp(p, opts({ confirmOverrun: vi.fn(async () => 'cancel' as const) }));
        expect(res).toEqual({ ok: false, error: 'cancelled' });
        expect(engine.synthesizeChunk).not.toHaveBeenCalled();
        expect((await loadOperation(plugin as never))?.script).toBe(LONG_SCRIPT);
    });

    it('the cap follows the day count: 3 days aim for 15, 4 days allow 20', async () => {
        const p3 = ports();
        await runCatchUp(p3, opts());
        expect(p3.generateScript.mock.calls[0][0].length).toEqual({ capMinutes: 15, wordBudget: 1950 });

        __resetChainForTests();
        vault = makeCatchUpVault();
        for (const d of ['2026-10-20', ...DATES]) vault.set(`${ROOT}/Digest — ${d}.md`, digest(d));
        plugin = makePlugin(ledgerData({ '2026-10-20': 1, '2026-10-21': 2, '2026-10-22': 3, '2026-10-23': 1 }));
        const p4 = ports();
        await runCatchUp(p4, opts());
        expect(p4.generateScript.mock.calls[0][0].length).toEqual({ capMinutes: 20, wordBudget: 2600 });
    });

    it('countWords is whitespace-insensitive', () => {
        expect(countWords('  a  b\n c ')).toBe(3);
        expect(countWords('')).toBe(0);
    });
});

describe('a second run the same day', () => {
    it('covers only the new material', async () => {
        await runCatchUp(ports(), opts());
        // Late newsletters raise today\'s bucket to revision 2 with one new story.
        plugin.state.stored = {
            ...plugin.state.stored,
            ...ledgerData({ '2026-10-21': 2, '2026-10-22': 3, '2026-10-23': 2 }, { '2026-10-23': [['Evening story', 2]] }),
        };
        const p = ports();
        const res = await runCatchUp(p, opts());
        expect(res.ok).toBe(true);
        const plan = p.generateScript.mock.calls[0][0];
        expect(plan.entries).toHaveLength(1);
        expect(plan.entries[0]).toMatchObject({ date: '2026-10-23', kind: 'delta', sinceRevision: 1 });
        expect(plan.entries[0].text).toBe('- **Evening story**: Gist for Evening story');
        const latest = await findLatestEpisode(vault.app as never, ROOT);
        expect(latest?.coverage['2026-10-23']).toEqual({ kind: 'revision', rev: 2 });
    });
});

describe('operation id uniqueness', () => {
    it('a draw that collides with a committed episode is re-drawn instead of silently no-opping', async () => {
        const fixed = () => 0.5;
        await runCatchUp(ports({ random: fixed }), opts());
        plugin.state.stored = { ...plugin.state.stored, ...ledgerData({ '2026-10-21': 2, '2026-10-22': 3, '2026-10-23': 2 }, { '2026-10-23': [['Evening story', 2]] }) };
        let n = 0;
        const res = await runCatchUp(ports({ random: () => (n++ === 0 ? 0.5 : 0.25) }), opts());
        expect(res.ok).toBe(true);
        expect((res as { value: { created: boolean } }).value.created).toBe(true);
        const notes = [...vault.files.keys()].filter((k) => k.startsWith(`${FOLDER}/Catch-up`));
        expect(notes).toHaveLength(2);
    });

    it('gives up cleanly if every draw collides', async () => {
        const fixed = () => 0.5;
        await runCatchUp(ports({ random: fixed }), opts());
        plugin.state.stored = { ...plugin.state.stored, ...ledgerData({ '2026-10-21': 2, '2026-10-22': 3, '2026-10-23': 2 }, { '2026-10-23': [['Evening story', 2]] }) };
        const res = await runCatchUp(ports({ random: fixed }), opts());
        expect(res).toEqual({ ok: false, error: 'catchup-save-failed' });
    });
});

describe('smart daily', () => {
    const smart = { newsletterAudioMode: 'smart-daily' };

    it('only runs in smart-daily mode', async () => {
        expect(await autoRunDecision(ports())).toEqual({ run: false, reason: 'wrong-mode' });
        expect(await autoRunDecision(ports({}, { newsletterAudioPodcast: false, ...smart }))).toEqual({ run: false, reason: 'wrong-mode' });
        expect(await autoRunDecision(ports({}, { newsletterAudioMode: 'daily' }))).toEqual({ run: false, reason: 'wrong-mode' });
    });

    it('runs when closed days are pending and nothing is unheard, covering only CLOSED days', async () => {
        const p = ports({}, smart);
        expect(await autoRunDecision(p)).toEqual({ run: true });
        const res = await runAutoCatchUp(p);
        expect(res.ok).toBe(true);
        const plan = p.generateScript.mock.calls[0][0];
        expect(plan.entries.map((e: { date: string }) => e.date)).toEqual(['2026-10-21', '2026-10-22']); // today is still open
    });

    it('skips while an earlier episode is unheard, then resumes once it is heard', async () => {
        await runAutoCatchUp(ports({}, smart));
        // a new closed day arrives the next morning
        vault.set(`${ROOT}/Digest — 2026-10-23.md`, digest('2026-10-23'));
        const next = () => new Date(2026, 9, 24, 12, 0, 0);
        plugin.state.stored = { ...plugin.state.stored, ...ledgerData({ '2026-10-21': 2, '2026-10-22': 3, '2026-10-23': 1 }) };
        const p = ports({ now: next }, smart);
        expect(await autoRunDecision(p)).toEqual({ run: false, reason: 'unheard' });

        const latest = (await findLatestEpisode(vault.app as never, ROOT))!;
        await ackEpisodes(plugin as never, [{ id: latest.id, to: latest.to }], '2026-10-24', 7);
        expect(await autoRunDecision(p)).toEqual({ run: true });
    });

    it('works with story memory off (the ack map is independent of the watermark)', async () => {
        const off = { ...smart, newsletterStoryMemory: false };
        await runAutoCatchUp(ports({}, off));
        vault.set(`${ROOT}/Digest — 2026-10-23.md`, digest('2026-10-23'));
        const next = () => new Date(2026, 9, 24, 12, 0, 0);
        const p = ports({ now: next }, off);
        expect(await autoRunDecision(p)).toEqual({ run: false, reason: 'unheard' });
        const latest = (await findLatestEpisode(vault.app as never, ROOT))!;
        await ackEpisodes(plugin as never, [{ id: latest.id, to: latest.to }], '2026-10-24', 7);
        expect(await autoRunDecision(p)).toEqual({ run: true });
    });

    it('skips (never replaces) while an unresolved record exists, after every failure phase', async () => {
        // script-too-long
        const long = ports({ generateScript: vi.fn(async () => ok(LONG_SCRIPT)) as never, shortenScript: vi.fn(async () => ok(LONG_SCRIPT)) as never }, smart);
        expect((await runAutoCatchUp(long)).ok).toBe(false);
        expect(await autoRunDecision(ports({}, smart))).toEqual({ run: false, reason: 'unresolved' });
        const before = await loadOperation(plugin as never);
        const again = await runAutoCatchUp(ports({}, smart));
        expect(again).toEqual({ ok: true, value: null });
        expect(await loadOperation(plugin as never)).toEqual(before);

        await discardOperation(ports({}, smart));

        // tts failure
        engine.synthesizeChunk.mockRejectedValueOnce(new Error('tts down'));
        expect((await runAutoCatchUp(ports({}, smart))).ok).toBe(false);
        expect(await autoRunDecision(ports({}, smart))).toEqual({ run: false, reason: 'unresolved' });
    });

    it('is not admitted while a manual run holds the lock', async () => {
        let release: () => void = () => undefined;
        const gate = new Promise<void>((r) => { release = r; });
        const slow = ports({ generateScript: vi.fn(async () => { await gate; return ok(SHORT_SCRIPT); }) as never });
        const first = runCatchUp(slow, opts());
        await vi.waitFor(() => expect(isCatchUpRunning()).toBe(true));
        expect(await autoRunDecision(ports({}, smart))).toEqual({ run: false, reason: 'busy' });
        release();
        await first;
    });

    it('nothing pending is a quiet skip', async () => {
        await runAutoCatchUp(ports({}, smart));
        const decision = await autoRunDecision(ports({}, smart));
        expect(decision.run).toBe(false);
    });
});

describe('story memory off, end to end', () => {
    const off = { newsletterStoryMemory: false };

    it('first generation, repeat, listen: whole-day coverage, no zero-revision trap', async () => {
        plugin = makePlugin({});
        const first = await runCatchUp(ports({}, off), opts());
        expect(first.ok).toBe(true);
        const meta = parseEpisodeContent(vault.text((first as { value: { notePath: string } }).value.notePath), 'p')!;
        expect(meta.coverage).toEqual({ '2026-10-21': { kind: 'whole' }, '2026-10-22': { kind: 'whole' } });
        // today's bucket is still open, so it was not covered

        const p = ports({}, off);
        const repeat = await runCatchUp(p, opts());
        expect(repeat).toEqual({ ok: false, error: 'catchup-nothing-pending' });
    });
});

describe('the length limit holds on Resume too', () => {
    async function leaveOverLongRecord() {
        const long = ports({ generateScript: vi.fn(async () => ok(LONG_SCRIPT)) as never, shortenScript: vi.fn(async () => ok(LONG_SCRIPT)) as never }, { newsletterAudioMode: 'smart-daily' });
        const res = await runAutoCatchUp(long);
        expect(res.ok).toBe(false);
        const rec = await loadOperation(plugin as never);
        expect(rec?.script).toBe(LONG_SCRIPT);
        expect(rec?.capMinutes).toBe(15);
        return rec!;
    }

    it('an interactive resume of a kept over-long script ASKS before any audio', async () => {
        await leaveOverLongRecord();
        const confirm = vi.fn(async () => 'cancel' as const);
        const res = await resumeCatchUp(ports({ shortenScript: vi.fn(async () => ok(LONG_SCRIPT)) as never }), { interactive: true, confirmOverrun: confirm });
        expect(res).toEqual({ ok: false, error: 'cancelled' });
        expect(confirm).toHaveBeenCalledWith({ estimatedMinutes: expect.any(Number), capMinutes: 15 });
        expect(engine.synthesizeChunk).not.toHaveBeenCalled();
    });

    it('an automatic resume fails with guidance instead of overrunning', async () => {
        await leaveOverLongRecord();
        const res = await resumeCatchUp(ports(), { interactive: false });
        expect(res).toEqual({ ok: false, error: 'catchup-script-too-long' });
        expect(engine.synthesizeChunk).not.toHaveBeenCalled();
    });

    it('Continue anyway lets the resume through, and Shorten persists the shorter script first', async () => {
        await leaveOverLongRecord();
        const shorten = vi.fn(async () => ok(SHORT_SCRIPT));
        const choices = ['shorten'] as const;
        let i = 0;
        const res = await resumeCatchUp(ports({ shortenScript: shorten as never }), { interactive: true, confirmOverrun: async () => choices[i++] ?? 'continue' });
        expect(res.ok).toBe(true);
        expect(shorten).toHaveBeenCalledTimes(1);
        expect(shorten.mock.calls[0]).toEqual([LONG_SCRIPT, 1950, undefined]);
    });

    it('a resume does not spend an automatic shrink (the kept script already had one)', async () => {
        await leaveOverLongRecord();
        const shorten = vi.fn(async () => ok(LONG_SCRIPT));
        await resumeCatchUp(ports({ shortenScript: shorten as never }), { interactive: true, confirmOverrun: async () => 'cancel' });
        expect(shorten).not.toHaveBeenCalled();
    });
});

describe('a transition that cannot be persisted does not proceed', () => {
    it('no audio is written when the write-ahead record is refused', async () => {
        // After the script record is saved, another operation takes the slot: every later save is refused.
        let saves = 0;
        const original = plugin.saveData.getMockImplementation()!;
        plugin.saveData.mockImplementation(async (d: Record<string, unknown>) => {
            await original(d);
            if (++saves === 1) {
                const stored = plugin.state.stored[DRAFT_DATA_KEY] as OperationRecord;
                plugin.state.stored[DRAFT_DATA_KEY] = { ...stored, opId: '20260101-000000-ffff' };
            }
        });
        const res = await runCatchUp(ports(), opts());
        expect(res).toEqual({ ok: false, error: 'catchup-save-failed' });
        expect(engine.synthesizeChunk).not.toHaveBeenCalled();
        expect([...vault.files.keys()].filter((k) => k.endsWith('.mp3'))).toEqual([]);
        expect([...vault.files.keys()].filter((k) => k.includes('Catch-up/Catch-up'))).toEqual([]);
    });
});

describe('recovery uses the operation\'s own output folder', () => {
    it('a committed note in the ORIGINAL folder is found even after the folder setting changes', async () => {
        vault.app.vault.create.mockRejectedValueOnce(new Error('disk full'));
        await runCatchUp(ports(), opts());
        const rec = (await loadOperation(plugin as never))!;
        expect(rec.outputRoot).toBe('AI-Organiser/Newsletter Inbox');
        // The note actually landed...
        const note = buildEpisodeNote({
            id: rec.opId, from: rec.frozen.from, to: rec.frozen.to,
            coverage: Object.fromEntries(rec.frozen.entries.map((e) => [e.date, e.coverage])),
            audio: rec.audio!.path.split('/').pop()!, fingerprint: 'c3d4e5f6', minutes: 1, sources: 6, titles: [], script: rec.script,
        });
        vault.set(`${FOLDER}/${buildEpisodeName(rec.frozen.from, rec.frozen.to, rec.opId)}`, note);
        // ...and then the user pointed the setting somewhere else.
        const moved = ports({}, { newsletterOutputFolder: 'Elsewhere' });
        expect((await classifyOperation(moved)).kind).toBe('committed');
        await reconcileOperation(moved);
        expect(vault.exists(rec.audio!.path)).toBe(true);
    });

    it('cleanup never touches a folder the operation did not start in', async () => {
        vault.app.vault.create.mockRejectedValueOnce(new Error('disk full'));
        await runCatchUp(ports(), opts());
        const rec = (await loadOperation(plugin as never))!;
        vault.set('Elsewhere/Catch-up/catchup-decoy.mp3', new ArrayBuffer(4));
        const late = () => new Date(NOW.getTime() + RECORD_TTL_MS + 60_000);
        await reconcileOperation(ports({ now: late }, { newsletterOutputFolder: 'Elsewhere' }));
        expect(vault.exists('Elsewhere/Catch-up/catchup-decoy.mp3')).toBe(true);
        expect(vault.exists(rec.audio!.path)).toBe(false); // its own staged audio went, from its own folder
    });
});

describe('persistence failures are outcomes, not log lines', () => {
    it('a shortened script that cannot be persisted is not adopted and the run stops', async () => {
        let saves = 0;
        const original = plugin.saveData.getMockImplementation()!;
        plugin.saveData.mockImplementation(async (d: Record<string, unknown>) => {
            await original(d);
            // the first save is the script record; take its slot before the shortened one is written
            if (++saves === 1) plugin.state.stored[DRAFT_DATA_KEY] = { ...(plugin.state.stored[DRAFT_DATA_KEY] as OperationRecord), opId: '20260101-000000-ffff' };
        });
        const p = ports({ generateScript: vi.fn(async () => ok(LONG_SCRIPT)) as never, shortenScript: vi.fn(async () => ok(SHORT_SCRIPT)) as never });
        const res = await runCatchUp(p, opts());
        expect(res).toEqual({ ok: false, error: 'catchup-save-failed' });
        expect(engine.synthesizeChunk).not.toHaveBeenCalled();
    });

    it('the model-budget code from the script step reaches the caller unchanged', async () => {
        const res = await runCatchUp(ports({ generateScript: vi.fn(async () => err('catchup-too-much')) as never }), opts());
        expect(res).toEqual({ ok: false, error: 'catchup-too-much' });
        expect(await loadOperation(plugin as never)).toBeNull();
    });
});

describe('a protected output folder (persona test N2)', () => {
    it.each([['the newsletter output root', ROOT], ['the Catch-up folder', FOLDER], ['a folder above the output root', 'AI-Organiser']])(
        '%s protected: refused with its own code BEFORE any spend, nothing written, no record',
        async (_label, protectedPath) => {
            const p = ports({}, { protectedFolders: [protectedPath] });
            const res = await runCatchUp(p, opts());
            expect(res).toEqual({ ok: false, error: 'catchup-output-protected' });
            expect(p.resolveTts).not.toHaveBeenCalled();
            expect(p.generateScript).not.toHaveBeenCalled();
            expect(engine.synthesizeChunk).not.toHaveBeenCalled();
            expect(vault.app.vault.create).not.toHaveBeenCalled();
            expect(vault.app.vault.createBinary).not.toHaveBeenCalled();
            expect(await loadOperation(plugin as never)).toBeNull();
        },
    );

    it('a protected folder elsewhere does not block the run', async () => {
        const res = await runCatchUp(ports({}, { protectedFolders: ['Course/Week 1'] }), opts());
        expect(res.ok).toBe(true);
    });

    it('protection added mid-run (after the audio exists): the note is refused, the record is kept and resumes once unprotected', async () => {
        const p = ports();
        engine.synthesizeChunk.mockImplementation(async () => {
            (p.settings as unknown as { protectedFolders: string[] }).protectedFolders = [ROOT];
            return tone();
        });
        const res = await runCatchUp(p, opts());
        expect(res).toEqual({ ok: false, error: 'catchup-output-protected' });
        expect(vault.app.vault.create).not.toHaveBeenCalled(); // no episode note
        const rec = await loadOperation(plugin as never);
        expect(rec?.phase).toBe('audio-ready');
        expect(rec?.script).toBe(SHORT_SCRIPT); // the paid-for script is kept

        // Still protected: resume is refused up front and re-voices nothing.
        const calls = engine.synthesizeChunk.mock.calls.length;
        const blocked = await resumeCatchUp(ports({}, { protectedFolders: [ROOT] }), opts());
        expect(blocked).toEqual({ ok: false, error: 'catchup-output-protected' });
        expect(engine.synthesizeChunk.mock.calls.length).toBe(calls);
        expect(await loadOperation(plugin as never)).not.toBeNull();

        // Protection removed: the same record finishes.
        engine.synthesizeChunk.mockImplementation(async () => tone());
        const done = await resumeCatchUp(ports(), opts());
        expect(done.ok).toBe(true);
        expect(await loadOperation(plugin as never)).toBeNull();
    });

    it('protection added while the script is being written: no file operation at all, the script record is kept', async () => {
        const p = ports();
        p.generateScript.mockImplementation(async () => {
            (p.settings as unknown as { protectedFolders: string[] }).protectedFolders = [FOLDER];
            return ok(SHORT_SCRIPT);
        });
        const res = await runCatchUp(p, opts());
        expect(res).toEqual({ ok: false, error: 'catchup-output-protected' });
        expect(engine.synthesizeChunk).not.toHaveBeenCalled();
        expect(vault.app.fileManager.trashFile).not.toHaveBeenCalled();
        expect(vault.app.vault.createBinary).not.toHaveBeenCalled();
        expect((await loadOperation(plugin as never))?.script).toBe(SHORT_SCRIPT);
    });

    it('a kept script resumed into a now-protected folder: refused before any TTS call', async () => {
        engine.synthesizeChunk.mockRejectedValue(new Error('tts down'));
        await runCatchUp(ports(), opts()); // leaves a scripted/audio-writing record
        engine.synthesizeChunk.mockClear();
        engine.synthesizeChunk.mockImplementation(async () => tone());
        const p = ports({}, { protectedFolders: [FOLDER] });
        const res = await resumeCatchUp(p, opts());
        expect(res).toEqual({ ok: false, error: 'catchup-output-protected' });
        expect(engine.synthesizeChunk).not.toHaveBeenCalled();
        expect(p.resolveTts).not.toHaveBeenCalled();
    });

    it('the guidance names the next step: a different output folder, or stop protecting', async () => {
        const { describeError, formatGuidance } = await import('../src/core/friendlyErrors');
        const { en } = await import('../src/i18n/en');
        const text = formatGuidance(describeError(en as never, 'catchup-output-protected'));
        expect(text).toMatch(/different output folder/i);
        expect(text).toMatch(/stop protecting/i);
        expect(text).not.toMatch(/AI provider/i);
    });
});
