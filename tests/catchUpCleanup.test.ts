import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/minutesUtils', () => ({
    ensureFolderExists: vi.fn().mockResolvedValue(undefined),
    sanitizeFileName: (n: string) => n,
}));

import { DEFAULT_SETTINGS } from '../src/core/settings';
import { __resetChainForTests } from '../src/core/pluginDataStore';
import { ok, err, type Result } from '../src/core/result';
import {
    runCatchUpAudioCleanup,
    audioNamesIn,
    MAX_AUDIO_NAME_LENGTH,
    decideEpisode,
    normaliseCleanupDays,
    type CleanupDeps,
    type CleanupOutcome,
} from '../src/services/newsletter/catchUp/catchUpCleanup';
import { buildEpisodeNote, loadEpisodes, markAudioRemovedText, type EpisodeNoteInput } from '../src/services/newsletter/catchUp/catchUpEpisode';
import { buildEpisodeName } from '../src/services/newsletter/catchUp/catchUpCoverage';
import { ACKS_DATA_KEY, DRAFT_DATA_KEY, RECORD_SCHEMA_VERSION } from '../src/services/newsletter/catchUp/catchUpDraft';
import { runExclusive, __resetCatchUpLockForTests } from '../src/services/newsletter/catchUp/catchUpService';
import { makeCatchUpVault } from './helpers/catchUpVault';

const ROOT = 'AI-Organiser/Newsletter Inbox';
const FOLDER = `${ROOT}/Catch-up`;
const DAY1 = new Date(2026, 10, 30, 12, 0, 0); // 2026-11-30
const DAY2 = new Date(2026, 11, 1, 12, 0, 0);  // 2026-12-01

const ID = '20261022-081500-a1b2';
const AUDIO = 'catchup-20261022-081500-a1b2-c3d4e5f6.mp3';

function episode(over: Partial<EpisodeNoteInput> = {}): EpisodeNoteInput {
    return {
        id: ID,
        from: '2026-10-20',
        to: '2026-10-21',
        coverage: { '2026-10-20': { kind: 'revision', rev: 2 }, '2026-10-21': { kind: 'revision', rev: 2 } },
        audio: AUDIO,
        fingerprint: 'c3d4e5f6',
        minutes: 12,
        sources: 4,
        titles: ['Fictional port strike ends'],
        script: 'Good morning. Here is what happened.',
        ...over,
    };
}
const notePath = (i: EpisodeNoteInput) => `${FOLDER}/${buildEpisodeName(i.from, i.to, i.id)}`;

function makePlugin(stored: Record<string, unknown> = {}) {
    const state = { stored: structuredClone(stored) };
    return {
        state,
        loadData: vi.fn(async () => structuredClone(state.stored)),
        saveData: vi.fn(async (d: Record<string, unknown>) => { state.stored = structuredClone(d); }),
    };
}

const acksFor = (...ids: string[]) => ({ version: RECORD_SCHEMA_VERSION, acks: Object.fromEntries(ids.map((id) => [id, { ackedAt: 1, to: '2026-10-21' }])) });

const settings = (over: Record<string, unknown> = {}) => ({
    ...DEFAULT_SETTINGS,
    featureFlags: { newsletter: true },
    newsletterAudioPodcast: true,
    newsletterAudioMode: 'on-demand',
    ...over,
}) as never;

let vault: ReturnType<typeof makeCatchUpVault>;
let plugin: ReturnType<typeof makePlugin>;
let writes: Array<{ path: string; baseline: string; next: string }>;
let writeNote: CleanupDeps['writeNote'];

function addEpisode(i: EpisodeNoteInput = episode(), withAudio = true): void {
    vault.set(notePath(i), buildEpisodeNote(i));
    if (withAudio) vault.set(`${FOLDER}/${i.audio}`, new ArrayBuffer(8));
}

function deps(over: Partial<CleanupDeps> = {}): CleanupDeps {
    return {
        app: vault.app as never,
        plugin: plugin as never,
        settings: settings(),
        days: 14,
        protectedSource: [],
        writeNote,
        removedLine: (d) => `Audio removed on ${d}`,
        now: () => DAY1,
        ...over,
    };
}

async function sweep(over: Partial<CleanupDeps> = {}): Promise<CleanupOutcome> {
    const r = await runCatchUpAudioCleanup(deps(over));
    if (!r.ok) throw new Error(r.error);
    return r.value;
}
function completed(o: CleanupOutcome) {
    if (o.kind !== 'completed') throw new Error(`expected completed, got skipped: ${o.reason}`);
    return o.report;
}

beforeEach(() => {
    __resetChainForTests();
    __resetCatchUpLockForTests();
    vault = makeCatchUpVault();
    plugin = makePlugin({ [ACKS_DATA_KEY]: acksFor(ID) });
    writes = [];
    writeNote = async (path, baseline, next) => {
        writes.push({ path, baseline, next });
        if (vault.text(path) !== baseline) return err('baseline-mismatch');
        vault.set(path, next);
        return ok(undefined);
    };
});

describe('setting', () => {
    it.each([
        [undefined, 0], [null, 0], ['x', 0], [NaN, 0], [-3, 0], [0, 0], [0.9, 0],
        [1, 1], [14, 14], [14.9, 14], [28, 28], [29, 28], [1000, 28], ['21', 0], [true, 0], [[14], 0],
    ])('normaliseCleanupDays(%j) = %j', (raw, expected) => {
        expect(normaliseCleanupDays(raw)).toBe(expected);
    });
});

describe('off is byte-identical: no reads, no writes, no listeners', () => {
    function expectUntouched(): void {
        expect(plugin.loadData).not.toHaveBeenCalled();
        expect(plugin.saveData).not.toHaveBeenCalled();
        expect(vault.app.vault.cachedRead).not.toHaveBeenCalled();
        expect(vault.app.vault.read).not.toHaveBeenCalled();
        expect(vault.app.vault.modify).not.toHaveBeenCalled();
        expect(vault.app.vault.on).not.toHaveBeenCalled();
        expect(vault.app.metadataCache.getFileCache).not.toHaveBeenCalled();
        expect(vault.app.metadataCache.on).not.toHaveBeenCalled();
        expect(vault.app.fileManager.trashFile).not.toHaveBeenCalled();
        expect(writes).toEqual([]);
    }

    it.each([[0], [-1], [Number.NaN]])('days = %j', async (days) => {
        addEpisode();
        const before = new Map(vault.files);
        expect(await sweep({ days })).toEqual({ kind: 'skipped', reason: 'off' });
        expectUntouched();
        expect(vault.files).toEqual(before);
    });

    it('catch-up disabled (daily mode, or audio off)', async () => {
        addEpisode();
        expect(await sweep({ settings: settings({ newsletterAudioMode: 'daily' }) })).toEqual({ kind: 'skipped', reason: 'off' });
        expect(await sweep({ settings: settings({ newsletterAudioPodcast: false }) })).toEqual({ kind: 'skipped', reason: 'off' });
        expectUntouched();
    });
});

describe('audioNamesIn: names that run together never hide each other', () => {
    it('finds each name in a run, in either order, with suffixes and prefixes', () => {
        const a = 'catchup-20261022-081500-a1b2-c3d4e5f6.mp3';
        const b = 'catchup-20261023-081500-c3d4-44444444.mp3';
        const joined = audioNamesIn(`${a}.${b}`);
        expect(joined.has(a) && joined.has(b)).toBe(true); // plus the over-long run, which is harmless
        expect(audioNamesIn(`see [[${a}]] and ![[${b}|Listen]]`)).toEqual(new Set([a, b]));
        expect(audioNamesIn(`${a}.bak`)).toEqual(new Set([a]));
        expect(audioNamesIn(`xx${a}`.toUpperCase())).toEqual(new Set([a]));
        expect(audioNamesIn('no names here, catchup- alone or catchup-x.wav').size).toBe(0);
    });

    it('a crafted run of thousands of joined names costs linear work, not quadratic', () => {
        const run = Array.from({ length: 10000 }, (_, n) => `catchup-${n}-aaaaaaaa.mp3`).join('.');
        const started = Date.now();
        const names = audioNamesIn(run);
        expect(Date.now() - started).toBeLessThan(1000);
        expect(names.size).toBeLessThanOrEqual(10000 * 3);
        expect(names.has('catchup-0-aaaaaaaa.mp3')).toBe(true);
        expect(names.has('catchup-9999-aaaaaaaa.mp3')).toBe(true);
    });

    it.each([
        ['many starts and no ending', 'catchup-'.repeat(60000) + 'a'],
        ['many starts and one ending', 'catchup-'.repeat(60000) + 'a.mp3'],
        ['many endings and one start', 'catchup-a' + '.mp3'.repeat(60000)],
    ])('stays linear with %s', (_label, text) => {
        const started = Date.now();
        const names = audioNamesIn(text);
        expect(Date.now() - started).toBeLessThan(1500);
        expect(names.size).toBeLessThan(200000);
    });

    it('names longer than the bound are not materialised, and an over-long episode audio name is never cleaned up', () => {
        expect(audioNamesIn('catchup-' + 'a'.repeat(200) + '.mp3').size).toBe(0);
        const long = 'catchup-' + 'b'.repeat(120) + '.mp3';
        const base = { acks: { [ID]: { ackedAt: 1, to: '2026-10-21' } }, today: '2026-11-30', cutoff: '2026-11-16', audioExists: true, inflight: null };
        const meta = { id: ID, from: '2026-10-20', to: '2026-10-21', coverage: { '2026-10-21': { kind: 'whole' as const } }, audio: long, fingerprint: 'f', minutes: 1, sources: 1, notePath: 'p.md' };
        expect(decideEpisode({ ...base, meta })).toEqual({ skip: 'audio-name-too-long' });
        expect(MAX_AUDIO_NAME_LENGTH).toBeGreaterThan(AUDIO.length);
    });

    it('a name inside a longer valid-alphabet name is also registered (conservative)', () => {
        expect(audioNamesIn('catchup-x.mp3.mp3')).toEqual(new Set(['catchup-x.mp3', 'catchup-x.mp3.mp3']));
    });

    it('a note that mentions two names back to back keeps BOTH files referenced', async () => {
        addEpisode();
        const other = 'catchup-20261023-081500-c3d4-44444444.mp3';
        vault.set(`${FOLDER}/Keep.md`, `${other}.${AUDIO}`);
        const report = completed(await sweep());
        expect(report.skipped).toEqual({ 'audio-referenced-elsewhere': 1 });
        expect(writes).toEqual([]);
    });
});

describe('decideEpisode (pure)', () => {
    const base = () => ({
        meta: { id: ID, from: '2026-10-20', to: '2026-10-21', coverage: { '2026-10-21': { kind: 'whole' as const } }, audio: AUDIO, fingerprint: 'f', minutes: 1, sources: 1, notePath: 'p.md' },
        acks: { [ID]: { ackedAt: 1, to: '2026-10-21' } },
        today: '2026-11-30',
        cutoff: '2026-11-16',
        audioExists: true,
        inflight: null,
    });

    it('marks a heard, old episode with its audio', () => {
        expect(decideEpisode(base())).toEqual({ stage: 'mark' });
    });

    it('age boundary: newest equal to the cutoff is not old enough, one day earlier is', () => {
        const b = base();
        expect(decideEpisode({ ...b, meta: { ...b.meta, to: '2026-11-16', coverage: { '2026-11-16': { kind: 'whole' } } } })).toEqual({ skip: 'too-recent' });
        expect(decideEpisode({ ...b, meta: { ...b.meta, to: '2026-11-15', coverage: { '2026-11-15': { kind: 'whole' } } } })).toEqual({ stage: 'mark' });
    });

    it('the newest covered day counts, not just `to`', () => {
        const b = base();
        expect(decideEpisode({ ...b, meta: { ...b.meta, coverage: { '2026-10-21': { kind: 'whole' }, '2026-11-20': { kind: 'whole' } } } })).toEqual({ skip: 'too-recent' });
    });

    it('never an unheard episode, and never one without audio', () => {
        expect(decideEpisode({ ...base(), acks: {} })).toEqual({ skip: 'not-heard' });
        expect(decideEpisode({ ...base(), audioExists: false })).toEqual({ skip: 'audio-missing' });
    });

    it('an episode named by the stored operation record is left alone', () => {
        expect(decideEpisode({ ...base(), inflight: { opId: ID, audioName: 'x.mp3' } })).toEqual({ skip: 'operation-in-flight' });
        expect(decideEpisode({ ...base(), inflight: { opId: 'other', audioName: AUDIO } })).toEqual({ skip: 'operation-in-flight' });
        expect(decideEpisode({ ...base(), inflight: { opId: 'other', audioName: 'y.mp3' } })).toEqual({ stage: 'mark' });
    });

    it('marked: trash only on a later day than the marker, and only with the ack', () => {
        const b = base();
        const marked = { ...b, meta: { ...b.meta, audioRemoved: '2026-11-30' } };
        expect(decideEpisode(marked)).toEqual({ skip: 'waiting-for-next-day', pending: true });
        expect(decideEpisode({ ...marked, today: '2026-12-01' })).toEqual({ stage: 'trash' });
        expect(decideEpisode({ ...marked, today: '2026-12-01', acks: {} })).toEqual({ skip: 'marker-without-ack' });
        expect(decideEpisode({ ...marked, audioExists: false })).toEqual({ done: true });
    });
});

describe('stage 1: mark', () => {
    it('marks a heard, old episode: note rewritten, audio untouched, coverage preserved', async () => {
        addEpisode();
        const report = completed(await sweep());
        expect(report).toMatchObject({ marked: 1, removed: 0, markedPending: 1, retryPending: 0 });
        const text = vault.text(notePath(episode()));
        expect(text).toContain("catchup_audio_removed: '2026-11-30'");
        expect(text).toContain('🎧 **Listen:** Audio removed on 2026-11-30');
        expect(text).not.toContain('![[');
        expect(vault.exists(`${FOLDER}/${AUDIO}`)).toBe(true);
        expect(vault.app.fileManager.trashFile).not.toHaveBeenCalled();
        expect(writes).toHaveLength(1);
        expect(writes[0].baseline).toBe(buildEpisodeNote(episode()));
    });

    it('a second sweep the same day does nothing destructive and keeps the episode pending', async () => {
        addEpisode();
        await sweep();
        const report = completed(await sweep());
        expect(report).toMatchObject({ marked: 0, removed: 0, markedPending: 1, retryPending: 0 });
        expect(vault.exists(`${FOLDER}/${AUDIO}`)).toBe(true);
        expect(writes).toHaveLength(1);
    });

    it('does not touch an unheard episode, a recent one, or a note it cannot parse; recent notes cost no read', async () => {
        const unheard = episode({ id: '20261022-090000-aaaa', audio: 'catchup-20261022-090000-aaaa-11111111.mp3' });
        const recent = episode({ id: '20261128-090000-bbbb', from: '2026-11-27', to: '2026-11-28', audio: 'catchup-20261128-090000-bbbb-22222222.mp3', coverage: { '2026-11-27': { kind: 'whole' }, '2026-11-28': { kind: 'whole' } } });
        addEpisode(unheard);
        addEpisode(recent);
        plugin.state.stored[ACKS_DATA_KEY] = acksFor(recent.id);
        vault.set(`${FOLDER}/Catch-up 2026-10-01 zzzz.md`, 'not an episode');
        const report = completed(await sweep());
        expect(report.marked).toBe(0);
        expect(report.skipped).toMatchObject({ 'not-heard': 1, 'note-invalid': 1 });
        expect(writes).toEqual([]);
        expect(vault.app.fileManager.trashFile).not.toHaveBeenCalled();
    });

    it('a protected folder is skipped, never written', async () => {
        addEpisode();
        const report = completed(await sweep({ protectedSource: [FOLDER] }));
        expect(report.skipped).toEqual({ 'protected-folder': 1 });
        expect(writes).toEqual([]);
        expect(vault.exists(`${FOLDER}/${AUDIO}`)).toBe(true);
    });

    it.each([
        ['returns an error', async () => err('baseline-mismatch'), 'baseline-mismatch'],
        ['throws', async () => { throw new Error('disk full'); }, 'disk full'],
    ])('a writer that %s leaves note and audio as they were, is reported, and ends the sweep', async (_label, failing, message) => {
        addEpisode();
        const second = episode({ id: '20261023-081500-c3d4', from: '2026-10-22', to: '2026-10-22', audio: 'catchup-20261023-081500-c3d4-44444444.mp3', coverage: { '2026-10-22': { kind: 'whole' } } });
        addEpisode(second);
        plugin.state.stored[ACKS_DATA_KEY] = acksFor(ID, second.id);
        const out = await sweep({ writeNote: failing as CleanupDeps['writeNote'] });
        // An ambiguous write invalidates the snapshot: nothing further is attempted this sweep.
        expect(out).toMatchObject({ kind: 'skipped', reason: 'changed-during-sweep' });
        if (out.kind !== 'skipped' || !out.report) throw new Error('expected a partial report');
        expect(out.report.marked).toBe(0);
        expect(out.report.items.errors).toHaveLength(1);
        expect(out.report.items.errors[0].error).toBe(message);
        expect(vault.text(notePath(episode()))).toBe(buildEpisodeNote(episode()));
        expect(vault.app.fileManager.trashFile).not.toHaveBeenCalled();
        expect(vault.listeners()).toBe(0);
    });

    it('a note that cannot be classified safely (reference in the transcript) is skipped', async () => {
        addEpisode(episode({ script: `listen again: ![[${AUDIO}]]` }));
        const report = completed(await sweep());
        expect(report.skipped).toEqual({ 'unclassified-reference': 1 });
        expect(writes).toEqual([]);
    });
});

describe('stage 2: trash on a later day', () => {
    it('removes the audio the next day, keeps the note, and a third sweep is a no-op', async () => {
        addEpisode();
        await sweep();
        const report = completed(await sweep({ now: () => DAY2 }));
        expect(report).toMatchObject({ marked: 0, removed: 1, markedPending: 0 });
        expect(vault.app.fileManager.trashFile).toHaveBeenCalledTimes(1);
        expect(vault.app.fileManager.trashFile.mock.calls[0][0].path).toBe(`${FOLDER}/${AUDIO}`);
        expect(vault.exists(`${FOLDER}/${AUDIO}`)).toBe(false);
        expect(vault.exists(notePath(episode()))).toBe(true);

        const again = completed(await sweep({ now: () => DAY2 }));
        expect(again).toMatchObject({ marked: 0, removed: 0, markedPending: 0 });
        expect(vault.app.fileManager.trashFile).toHaveBeenCalledTimes(1);
        expect(writes).toHaveLength(1);
    });

    it('the episode keeps covering its days after the audio is gone', async () => {
        addEpisode();
        await sweep();
        await sweep({ now: () => DAY2 });
        const { episodes, missingAudio } = await loadEpisodes(vault.app as never, ROOT, '2026-10-17');
        expect(episodes.map((e) => e.id)).toEqual([ID]);
        expect(missingAudio).toEqual([]);
    });

    it('a hand-added marker on an UNHEARD episode (old or recent) deletes nothing', async () => {
        const marked = buildEpisodeNote(episode()).replace('catchup_sources: 4', "catchup_sources: 4\ncatchup_audio_removed: '2026-11-01'");
        vault.set(notePath(episode()), marked);
        vault.set(`${FOLDER}/${AUDIO}`, new ArrayBuffer(8));
        plugin.state.stored[ACKS_DATA_KEY] = acksFor();
        const report = completed(await sweep({ now: () => DAY2 }));
        expect(report).toMatchObject({ removed: 0, markedPending: 0 });
        expect(report.skipped).toEqual({ 'marker-without-ack': 1 });
        expect(vault.exists(`${FOLDER}/${AUDIO}`)).toBe(true);
    });

    it('an ack pruned between the stages retains the audio (fail closed)', async () => {
        addEpisode();
        await sweep();
        plugin.state.stored[ACKS_DATA_KEY] = acksFor();
        const report = completed(await sweep({ now: () => DAY2 }));
        expect(report.removed).toBe(0);
        expect(report.skipped).toEqual({ 'marker-without-ack': 1 });
        expect(vault.exists(`${FOLDER}/${AUDIO}`)).toBe(true);
    });

    it('a trash failure keeps the episode marked and pending, then the next sweep finishes', async () => {
        addEpisode();
        await sweep();
        vault.app.fileManager.trashFile.mockRejectedValueOnce(new Error('disk busy'));
        const first = completed(await sweep({ now: () => DAY2 }));
        expect(first).toMatchObject({ removed: 0, markedPending: 1, retryPending: 1 });
        expect(first.items.errors).toHaveLength(1);
        expect(vault.exists(`${FOLDER}/${AUDIO}`)).toBe(true);
        const second = completed(await sweep({ now: () => DAY2 }));
        expect(second.removed).toBe(1);
    });

    it('a link added to the note between the stages (a new frontmatter field) retains the audio', async () => {
        addEpisode();
        await sweep();
        const p = notePath(episode());
        vault.set(p, vault.text(p).replace("catchup_audio_removed:", `related: "[[${AUDIO}]]"\ncatchup_audio_removed:`));
        const report = completed(await sweep({ now: () => DAY2 }));
        expect(report.removed).toBe(0);
        expect(vault.exists(`${FOLDER}/${AUDIO}`)).toBe(true);
    });

    it('raising the threshold later still finishes an already-marked recent episode (found via the metadata cache)', async () => {
        const recent = episode({ id: '20261120-090000-cccc', from: '2026-11-19', to: '2026-11-20', audio: 'catchup-20261120-090000-cccc-33333333.mp3', coverage: { '2026-11-19': { kind: 'whole' }, '2026-11-20': { kind: 'whole' } } });
        const marked = markAudioRemovedText(buildEpisodeNote(recent), recent.audio, '2026-11-25', 'Audio removed on 2026-11-25');
        if (!marked.ok) throw new Error(marked.error);
        vault.set(notePath(recent), marked.value);
        vault.set(`${FOLDER}/${recent.audio}`, new ArrayBuffer(8));
        plugin.state.stored[ACKS_DATA_KEY] = acksFor(recent.id);
        const report = completed(await sweep({ days: 28 }));
        expect(report.removed).toBe(1);
    });
});

describe('safety gates', () => {
    it('an episode named by a valid operation record is left alone', async () => {
        addEpisode();
        plugin.state.stored[DRAFT_DATA_KEY] = {
            version: RECORD_SCHEMA_VERSION, opId: ID, phase: 'audio-writing',
            frozen: { entries: [{ date: '2026-10-21', kind: 'full', coverage: { kind: 'whole' } }], from: '2026-10-21', to: '2026-10-21', sources: 1, titles: [] },
            script: 's', scriptIdentity: 'x', outputRoot: ROOT, capMinutes: 15, audio: { path: `${FOLDER}/${AUDIO}` }, createdAt: Date.now(),
        };
        const report = completed(await sweep());
        expect(report.skipped).toEqual({ 'operation-in-flight': 1 });
        expect(writes).toEqual([]);
    });

    it.each([['a newer plugin version', { version: 99, opId: 'x' }], ['a corrupt record', 'garbage'], ['an invalid record', { version: 1, opId: '' }]])('%s makes the sweep skip without reading the folder', async (_label, record) => {
        addEpisode();
        plugin.state.stored[DRAFT_DATA_KEY] = record;
        expect(await sweep()).toEqual({ kind: 'skipped', reason: 'record-unknown' });
        expect(vault.app.vault.cachedRead).not.toHaveBeenCalled();
        expect(writes).toEqual([]);
    });

    it('index not ready: nothing is read', async () => {
        addEpisode();
        vault.app.metadataCache.resolved = false;
        expect(await sweep()).toEqual({ kind: 'skipped', reason: 'index-not-ready' });
        expect(plugin.loadData).not.toHaveBeenCalled();
        expect(vault.app.vault.cachedRead).not.toHaveBeenCalled();
        delete (vault.app.metadataCache as { resolved?: boolean }).resolved;
        expect(await sweep()).toEqual({ kind: 'skipped', reason: 'index-not-ready' });
    });

    it('another episode-folder note that mentions the file keeps the audio', async () => {
        addEpisode();
        vault.set(`${FOLDER}/My notes.md`, `remember to keep ${AUDIO} around`);
        const report = completed(await sweep());
        expect(report.skipped).toEqual({ 'audio-referenced-elsewhere': 1 });
        expect(writes).toEqual([]);
    });

    it('a note elsewhere in the vault that links the file keeps the audio', async () => {
        addEpisode();
        vault.app.metadataCache.resolvedLinks = { 'Projects/Plan.md': { [`${FOLDER}/${AUDIO}`]: 1 } };
        const report = completed(await sweep());
        expect(report.skipped).toEqual({ 'audio-referenced-elsewhere': 1 });
    });

    it('a folder note that cannot be read makes the answer unknown, which blocks the removal', async () => {
        addEpisode();
        vault.set(`${FOLDER}/Unreadable.md`, 'x');
        vault.app.vault.cachedRead.mockImplementation(async (f: { path: string }) => {
            if (f.path.endsWith('Unreadable.md')) throw new Error('locked');
            return vault.text(f.path);
        });
        const report = completed(await sweep());
        expect(report.skipped).toEqual({ 'audio-reference-unknown': 1 });
        expect(writes).toEqual([]);
    });

    it('the note changing under us (fresh content no longer matches) is skipped', async () => {
        addEpisode();
        vault.app.vault.read.mockImplementationOnce(async () => buildEpisodeNote(episode({ id: '20261022-999999-ffff' })));
        const report = completed(await sweep());
        expect(report.skipped).toEqual({ 'note-changed': 1 });
        expect(writes).toEqual([]);
    });
});

describe('vault changes during the sweep', () => {
    const second = episode({ id: '20261023-081500-c3d4', from: '2026-10-22', to: '2026-10-22', audio: 'catchup-20261023-081500-c3d4-44444444.mp3', coverage: { '2026-10-22': { kind: 'whole' } } });

    it('its own writes do not count as someone else changing the vault; listeners are removed', async () => {
        addEpisode();
        addEpisode(second);
        plugin.state.stored[ACKS_DATA_KEY] = acksFor(ID, second.id);
        const emitting: CleanupDeps['writeNote'] = async (path, baseline, next) => {
            const r = await writeNote(path, baseline, next);
            vault.emit('vault', 'modify', { path });
            vault.emit('cache', 'changed', { path });
            return r;
        };
        const report = completed(await sweep({ writeNote: emitting }));
        expect(report.marked).toBe(2);
        expect(vault.listeners()).toBe(0);
    });

    it('another note changing mid-sweep stops further destructive work and reports it', async () => {
        addEpisode();
        addEpisode(second);
        plugin.state.stored[ACKS_DATA_KEY] = acksFor(ID, second.id);
        const interfering: CleanupDeps['writeNote'] = async (path, baseline, next) => {
            const r = await writeNote(path, baseline, next);
            vault.emit('vault', 'modify', { path: 'Projects/Plan.md' });
            return r;
        };
        const out = await sweep({ writeNote: interfering });
        expect(out.kind).toBe('skipped');
        if (out.kind !== 'skipped') return;
        expect(out.reason).toBe('changed-during-sweep');
        expect(out.report?.marked).toBe(1);
        expect(writes).toHaveLength(1);
        expect(vault.listeners()).toBe(0);
    });

    it('a rename or a metadata change of another note also stops it', async () => {
        for (const fire of [
            () => vault.emit('vault', 'rename', { path: 'Projects/New.md' }, 'Projects/Old.md'),
            () => vault.emit('cache', 'changed', { path: 'Projects/Plan.md' }),
            () => vault.emit('vault', 'create', { path: 'Projects/Fresh.md' }),
            () => vault.emit('vault', 'delete', { path: 'Projects/Gone.md' }),
        ]) {
            vault = makeCatchUpVault();
            addEpisode();
            addEpisode(second);
            plugin = makePlugin({ [ACKS_DATA_KEY]: acksFor(ID, second.id) });
            writeNote = async (path, baseline, next) => { vault.set(path, next); fire(); return ok(undefined); };
            const out = await sweep();
            expect(out).toMatchObject({ kind: 'skipped', reason: 'changed-during-sweep' });
        }
    });

    it('a non-markdown change is not a reference change', async () => {
        addEpisode();
        addEpisode(second);
        plugin.state.stored[ACKS_DATA_KEY] = acksFor(ID, second.id);
        const w: CleanupDeps['writeNote'] = async (path, baseline, next) => {
            const r = await writeNote(path, baseline, next);
            vault.emit('vault', 'modify', { path: 'Attachments/photo.png' });
            return r;
        };
        expect(completed(await sweep({ writeNote: w })).marked).toBe(2);
    });
});

describe('the snapshot stays valid from before discovery to the destructive step', () => {
    const second = episode({ id: '20261023-081500-c3d4', from: '2026-10-22', to: '2026-10-22', audio: 'catchup-20261023-081500-c3d4-44444444.mp3', coverage: { '2026-10-22': { kind: 'whole' } } });

    it('a change while the reference index is being built stops the sweep before any write', async () => {
        addEpisode();
        const real = vault.app.vault.cachedRead.getMockImplementation() as (f: { path: string }) => Promise<string>;
        vault.app.vault.cachedRead.mockImplementation(async (f: { path: string }) => {
            vault.emit('vault', 'create', { path: 'Projects/NewNote.md' });
            return real(f);
        });
        expect(await sweep()).toMatchObject({ kind: 'skipped', reason: 'changed-during-sweep' });
        expect(writes).toEqual([]);
        expect(vault.listeners()).toBe(0);
    });

    it('a change that lands while the candidate note is being read stops it before the write', async () => {
        addEpisode();
        const real = vault.app.vault.read.getMockImplementation() as (f: { path: string }) => Promise<string>;
        vault.app.vault.read.mockImplementation(async (f: { path: string }) => {
            const text = await real(f);
            vault.emit('vault', 'modify', { path: 'Projects/Plan.md' });
            return text;
        });
        expect(await sweep()).toMatchObject({ kind: 'skipped', reason: 'changed-during-sweep' });
        expect(writes).toEqual([]);
    });

    it('the sweep\'s own write is recognised once: a SECOND event for the same note is an outside edit', async () => {
        addEpisode();
        addEpisode(second);
        plugin.state.stored[ACKS_DATA_KEY] = acksFor(ID, second.id);
        const twice: CleanupDeps['writeNote'] = async (path, baseline, next) => {
            const r = await writeNote(path, baseline, next);
            vault.emit('vault', 'modify', { path });
            vault.emit('vault', 'modify', { path });
            return r;
        };
        const out = await sweep({ writeNote: twice });
        expect(out).toMatchObject({ kind: 'skipped', reason: 'changed-during-sweep' });
        expect(writes).toHaveLength(1);
    });

    it('an absent reverse-link table is unknown, not "no links"', async () => {
        addEpisode();
        delete (vault.app.metadataCache as { resolvedLinks?: unknown }).resolvedLinks;
        expect(await sweep()).toEqual({ kind: 'skipped', reason: 'index-not-ready' });
        expect(writes).toEqual([]);
        expect(vault.app.vault.cachedRead).not.toHaveBeenCalled();
    });
});

describe('markedPending keeps transient stage-2 trouble', () => {
    async function markedState(): Promise<void> {
        addEpisode();
        await sweep();
    }

    it('a failed fresh read of a marked note stays pending', async () => {
        await markedState();
        vault.app.vault.read.mockRejectedValueOnce(new Error('locked'));
        const report = completed(await sweep({ now: () => DAY2 }));
        expect(report).toMatchObject({ removed: 0, markedPending: 1, retryPending: 1 });
        expect(report.items.errors).toHaveLength(1);
    });

    it('an unreadable note in the folder (reference unknown) leaves the marked episode pending, not blocked', async () => {
        await markedState();
        vault.set(`${FOLDER}/Unreadable.md`, 'x');
        const real = vault.app.vault.cachedRead.getMockImplementation() as (f: { path: string }) => Promise<string>;
        vault.app.vault.cachedRead.mockImplementation(async (f: { path: string }) => {
            if (f.path.endsWith('Unreadable.md')) throw new Error('locked');
            return real(f);
        });
        const report = completed(await sweep({ now: () => DAY2 }));
        expect(report).toMatchObject({ removed: 0, markedPending: 1, retryPending: 1 });
        expect(report.skipped).toEqual({ 'audio-reference-unknown': 1 });
    });

    it('a confirmed reference elsewhere is a permanent block, not pending', async () => {
        await markedState();
        vault.app.metadataCache.resolvedLinks = { 'Projects/Plan.md': { [`${FOLDER}/${AUDIO}`]: 1 } };
        const report = completed(await sweep({ now: () => DAY2 }));
        expect(report).toMatchObject({ removed: 0, markedPending: 0 });
    });
});

describe('cancellation on unload', () => {
    it('a sweep told to stop does so before its first destructive step', async () => {
        addEpisode();
        const out = await sweep({ shouldStop: () => true });
        expect(out).toMatchObject({ kind: 'skipped', reason: 'cancelled' });
        expect(writes).toEqual([]);
        expect(vault.app.fileManager.trashFile).not.toHaveBeenCalled();
        expect(vault.listeners()).toBe(0);
    });

    it('stopping between two candidates keeps the first and leaves the second untouched', async () => {
        addEpisode();
        const second = episode({ id: '20261023-081500-c3d4', from: '2026-10-22', to: '2026-10-22', audio: 'catchup-20261023-081500-c3d4-44444444.mp3', coverage: { '2026-10-22': { kind: 'whole' } } });
        addEpisode(second);
        plugin.state.stored[ACKS_DATA_KEY] = acksFor(ID, second.id);
        const out = await sweep({ shouldStop: () => writes.length >= 1 });
        expect(out).toMatchObject({ kind: 'skipped', reason: 'cancelled' });
        if (out.kind !== 'skipped') return;
        expect(out.report?.marked).toBe(1);
        expect(writes).toHaveLength(1);
    });
});

describe('single flight and cost', () => {
    it('busy while an episode is being made: skipped with no reads', async () => {
        addEpisode();
        let release!: () => void;
        const held = runExclusive(() => new Promise<Result<undefined>>((resolve) => { release = () => resolve(ok(undefined)); }));
        expect(await sweep()).toEqual({ kind: 'skipped', reason: 'busy' });
        expect(plugin.loadData).not.toHaveBeenCalled();
        expect(vault.app.vault.cachedRead).not.toHaveBeenCalled();
        release();
        await held;
        expect(completed(await sweep()).marked).toBe(1);
    });

    it('work is linear: notes are read for the index once, links are walked once, however many candidates', async () => {
        const ids: string[] = [];
        for (let n = 0; n < 6; n++) {
            const id = `2026102${n}-081500-a1b${n}`;
            ids.push(id);
            addEpisode(episode({ id, from: `2026-10-0${n + 1}`, to: `2026-10-0${n + 1}`, audio: `catchup-${id}-5555555${n}.mp3`, coverage: { [`2026-10-0${n + 1}`]: { kind: 'whole' } } }));
        }
        plugin.state.stored[ACKS_DATA_KEY] = acksFor(...ids);
        let linkWalks = 0;
        vault.app.metadataCache.resolvedLinks = new Proxy({} as Record<string, Record<string, number>>, { ownKeys: () => { linkWalks++; return []; } });
        const report = completed(await sweep());
        expect(report.marked).toBe(6);
        expect(vault.app.vault.cachedRead).toHaveBeenCalledTimes(6);
        expect(linkWalks).toBe(1);
        expect(vault.app.vault.read).toHaveBeenCalledTimes(6);
    });

    it('with nothing eligible the reference index is never built', async () => {
        addEpisode();
        plugin.state.stored[ACKS_DATA_KEY] = acksFor();
        completed(await sweep());
        expect(vault.app.vault.cachedRead).not.toHaveBeenCalled();
        expect(vault.listeners()).toBe(0); // watching is always torn down
    });
});
