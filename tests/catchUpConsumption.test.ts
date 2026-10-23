import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/minutesUtils', () => ({
    ensureFolderExists: vi.fn().mockResolvedValue(undefined),
    sanitizeFileName: (n: string) => n,
}));

import { DEFAULT_SETTINGS } from '../src/core/settings';
import { __resetChainForTests } from '../src/core/pluginDataStore';
import {
    coerceConsumption,
    markBucketsConsumed,
    markBucketConsumed,
    CONSUMED_DATA_KEY,
} from '../src/services/newsletter/newsletterConsumption';
import {
    resolveCatchUpAudio,
    markEpisodeListened,
    markCatchUpAudioPlayed,
    ackAllInWindowEpisodes,
} from '../src/services/newsletter/catchUp/catchUpListen';
import { loadAcks } from '../src/services/newsletter/catchUp/catchUpDraft';
import { buildEpisodeNote, type EpisodeNoteInput } from '../src/services/newsletter/catchUp/catchUpEpisode';
import { buildEpisodeName } from '../src/services/newsletter/catchUp/catchUpCoverage';
import { makeCatchUpVault } from './helpers/catchUpVault';

const ROOT = 'AI-Organiser/Newsletter Inbox';
const FOLDER = `${ROOT}/Catch-up`;
const NOW = new Date(2026, 9, 23, 12, 0, 0);

function makePlugin(initial: Record<string, unknown> = {}) {
    const state = { stored: structuredClone(initial) as Record<string, unknown> };
    return {
        state,
        loadData: async () => structuredClone(state.stored),
        saveData: async (d: Record<string, unknown>) => { state.stored = structuredClone(d); },
    };
}

const settings = (over: Record<string, unknown> = {}) => ({
    ...DEFAULT_SETTINGS,
    featureFlags: { newsletter: true },
    newsletterStoryMemory: true,
    ...over,
}) as never;

function episode(over: Partial<EpisodeNoteInput> = {}): EpisodeNoteInput {
    return {
        id: '20261022-081500-a1b2',
        from: '2026-10-20',
        to: '2026-10-22',
        coverage: { '2026-10-20': { kind: 'revision', rev: 2 }, '2026-10-21': { kind: 'whole' }, '2026-10-22': { kind: 'revision', rev: 3 } },
        audio: 'catchup-20261022-081500-a1b2-c3d4e5f6.mp3',
        fingerprint: 'c3d4e5f6',
        minutes: 12,
        sources: 4,
        titles: [],
        script: 's',
        ...over,
    };
}

const notePath = (i: EpisodeNoteInput) => `${FOLDER}/${buildEpisodeName(i.from, i.to, i.id)}`;

beforeEach(() => { __resetChainForTests(); });

describe('consumption signal vocabulary', () => {
    it('round-trips the catchup signal instead of coercing it to manual', () => {
        const state = coerceConsumption({
            version: 1,
            consumed: { '2026-10-20': { firstAt: 1, lastAt: 2, firstVia: 'catchup', lastVia: 'catchup', revision: 2 } },
        });
        expect(state.consumed['2026-10-20'].firstVia).toBe('catchup');
        expect(state.consumed['2026-10-20'].lastVia).toBe('catchup');
    });

    it('still coerces an unknown signal to manual', () => {
        const state = coerceConsumption({
            version: 1,
            consumed: { '2026-10-20': { firstAt: 1, lastAt: 2, firstVia: 'telepathy', lastVia: 'telepathy', revision: 2 } },
        });
        expect(state.consumed['2026-10-20'].lastVia).toBe('manual');
    });
});

describe('markBucketsConsumed', () => {
    it('advances several buckets in ONE write at the frozen revisions', async () => {
        const p = makePlugin();
        const save = vi.spyOn(p, 'saveData');
        const n = await markBucketsConsumed(p as never, [{ date: '2026-10-20', revision: 2 }, { date: '2026-10-22', revision: 3 }], 'catchup', '2026-10-23');
        expect(n).toBe(2);
        expect(save).toHaveBeenCalledTimes(1);
        const consumed = (p.state.stored[CONSUMED_DATA_KEY] as { consumed: Record<string, { revision: number; lastVia: string }> }).consumed;
        expect(consumed['2026-10-20'].revision).toBe(2);
        expect(consumed['2026-10-22'].lastVia).toBe('catchup');
    });

    it('only advances on a strictly higher revision, per bucket', async () => {
        const p = makePlugin();
        await markBucketConsumed(p as never, '2026-10-20', 'audio', 5, '2026-10-23');
        const n = await markBucketsConsumed(p as never, [{ date: '2026-10-20', revision: 3 }, { date: '2026-10-21', revision: 1 }], 'catchup', '2026-10-23');
        expect(n).toBe(1);
        const consumed = (p.state.stored[CONSUMED_DATA_KEY] as { consumed: Record<string, { revision: number }> }).consumed;
        expect(consumed['2026-10-20'].revision).toBe(5);
        expect(consumed['2026-10-21'].revision).toBe(1);
    });

    it('replaying writes nothing', async () => {
        const p = makePlugin();
        await markBucketsConsumed(p as never, [{ date: '2026-10-20', revision: 2 }], 'catchup', '2026-10-23');
        const save = vi.spyOn(p, 'saveData');
        expect(await markBucketsConsumed(p as never, [{ date: '2026-10-20', revision: 2 }], 'catchup', '2026-10-23')).toBe(0);
        expect(save).not.toHaveBeenCalled();
    });

    it('rejects zero, negative, fractional revisions and malformed dates', async () => {
        const p = makePlugin();
        const n = await markBucketsConsumed(p as never, [
            { date: '2026-10-20', revision: 0 }, { date: '2026-10-21', revision: -1 },
            { date: '2026-10-22', revision: 1.5 }, { date: 'soon', revision: 2 },
        ], 'catchup', '2026-10-23');
        expect(n).toBe(0);
        expect(p.state.stored[CONSUMED_DATA_KEY]).toBeUndefined();
    });
});

describe('resolveCatchUpAudio (pure)', () => {
    const src = notePath(episode());
    const audio = `${FOLDER}/${episode().audio}`;

    it('resolves a played catch-up embed inside its episode note', () => {
        expect(resolveCatchUpAudio({ sourcePath: src, audioSrc: audio, outputRoot: ROOT }))
            .toEqual({ episodeId: '20261022-081500-a1b2', audioBasename: episode().audio });
    });

    it('handles url-encoded and query-suffixed sources', () => {
        const enc = `app://local/${encodeURIComponent(audio)}?123`;
        expect(resolveCatchUpAudio({ sourcePath: src, audioSrc: enc, outputRoot: ROOT })?.audioBasename).toBe(episode().audio);
    });

    it('rejects daily brief audio, narration and arbitrary mp3s', () => {
        for (const a of ['brief-2026-10-22-abcd1234.mp3', 'narration.mp3', 'catchup.wav', 'catchup-x.txt']) {
            expect(resolveCatchUpAudio({ sourcePath: src, audioSrc: `${FOLDER}/${a}`, outputRoot: ROOT })).toBeNull();
        }
    });

    it('rejects a catch-up named file played from a note outside the Catch-up folder', () => {
        expect(resolveCatchUpAudio({ sourcePath: `${ROOT}/Digest — 2026-10-22.md`, audioSrc: audio, outputRoot: ROOT })).toBeNull();
        expect(resolveCatchUpAudio({ sourcePath: 'Elsewhere/Catch-up 2026-10-22 x.md', audioSrc: audio, outputRoot: ROOT })).toBeNull();
        expect(resolveCatchUpAudio({ sourcePath: `${FOLDER}/sub/${buildEpisodeName('2026-10-20', '2026-10-22', 'x1')}`, audioSrc: audio, outputRoot: ROOT })).toBeNull();
    });

    it('rejects a note in the folder that is not named like an episode', () => {
        expect(resolveCatchUpAudio({ sourcePath: `${FOLDER}/scratch.md`, audioSrc: audio, outputRoot: ROOT })).toBeNull();
    });

    it('never throws on malformed input', () => {
        expect(resolveCatchUpAudio({ sourcePath: '', audioSrc: audio, outputRoot: ROOT })).toBeNull();
        expect(resolveCatchUpAudio({ sourcePath: src, audioSrc: '%zz', outputRoot: ROOT })).toBeNull();
        expect(resolveCatchUpAudio({ sourcePath: undefined as never, audioSrc: undefined as never, outputRoot: ROOT })).toBeNull();
    });
});

describe('markEpisodeListened', () => {
    const ep = { id: '20261022-081500-a1b2', to: '2026-10-22', coverage: episode().coverage };

    it('writes the durable ack AND the watermark at the frozen revisions when memory is on', async () => {
        const p = makePlugin();
        const res = await markEpisodeListened({ app: {} as never, plugin: p as never, settings: settings(), now: NOW }, ep);
        expect(res).toEqual({ ok: true, value: { acked: true, buckets: 2 } });
        expect(Object.keys(await loadAcks(p as never))).toEqual(['20261022-081500-a1b2']);
        const consumed = (p.state.stored[CONSUMED_DATA_KEY] as { consumed: Record<string, { revision: number }> }).consumed;
        // `whole` has no revision to consume; revision coverage is consumed exactly as frozen.
        expect(Object.keys(consumed).sort()).toEqual(['2026-10-20', '2026-10-22']);
        expect(consumed['2026-10-20'].revision).toBe(2);
        expect(consumed['2026-10-22'].revision).toBe(3);
    });

    it('with story memory OFF writes the ack and nothing else', async () => {
        const p = makePlugin();
        const res = await markEpisodeListened({ app: {} as never, plugin: p as never, settings: settings({ newsletterStoryMemory: false }), now: NOW }, ep);
        expect(res).toEqual({ ok: true, value: { acked: true, buckets: 0 } });
        expect(p.state.stored[CONSUMED_DATA_KEY]).toBeUndefined();
        expect(Object.keys(await loadAcks(p as never))).toHaveLength(1);
    });

    it('is idempotent', async () => {
        const p = makePlugin();
        await markEpisodeListened({ app: {} as never, plugin: p as never, settings: settings(), now: NOW }, ep);
        const again = await markEpisodeListened({ app: {} as never, plugin: p as never, settings: settings(), now: NOW }, ep);
        expect(again).toEqual({ ok: true, value: { acked: false, buckets: 0 } });
    });

    it('a generated-but-unplayed episode registers nothing (nothing calls this)', async () => {
        const p = makePlugin();
        expect(p.state.stored).toEqual({});
        expect(await loadAcks(p as never)).toEqual({});
    });
});

describe('markCatchUpAudioPlayed (host signal)', () => {
    let vault: ReturnType<typeof makeCatchUpVault>;
    beforeEach(() => {
        vault = makeCatchUpVault();
        const i = episode();
        vault.set(notePath(i), buildEpisodeNote(i));
        vault.set(`${FOLDER}/${i.audio}`, new ArrayBuffer(4));
    });
    const deps = (p: ReturnType<typeof makePlugin>, s = settings()) => ({ app: vault.app as never, plugin: p as never, settings: s, now: NOW });

    it('marks the episode heard when the embed in its own note is played', async () => {
        const p = makePlugin();
        const r = await markCatchUpAudioPlayed(deps(p), { sourcePath: notePath(episode()), audioSrc: `${FOLDER}/${episode().audio}` });
        expect(r).toEqual({ ok: true, value: true });
        expect(Object.keys(await loadAcks(p as never))).toEqual(['20261022-081500-a1b2']);
    });

    it('works with story memory off (ack only)', async () => {
        const p = makePlugin();
        const r = await markCatchUpAudioPlayed(deps(p, settings({ newsletterStoryMemory: false })), { sourcePath: notePath(episode()), audioSrc: `${FOLDER}/${episode().audio}` });
        expect(r).toEqual({ ok: true, value: true });
        expect(p.state.stored[CONSUMED_DATA_KEY]).toBeUndefined();
    });

    it('ignores audio that is not a catch-up episode', async () => {
        const p = makePlugin();
        const r = await markCatchUpAudioPlayed(deps(p), { sourcePath: `${ROOT}/Digest — 2026-10-22.md`, audioSrc: 'brief-2026-10-22-abcd1234.mp3' });
        expect(r).toEqual({ ok: true, value: false });
        expect(p.state.stored).toEqual({});
    });

    it('refuses an audio file the note does not name (a copied-in recording)', async () => {
        const p = makePlugin();
        const r = await markCatchUpAudioPlayed(deps(p), { sourcePath: notePath(episode()), audioSrc: `${FOLDER}/catchup-other-12345678.mp3` });
        expect(r).toEqual({ ok: true, value: false });
        expect(await loadAcks(p as never)).toEqual({});
    });

    it('a note that no longer exists marks nothing', async () => {
        const p = makePlugin();
        vault.remove(notePath(episode()));
        const r = await markCatchUpAudioPlayed(deps(p), { sourcePath: notePath(episode()), audioSrc: `${FOLDER}/${episode().audio}` });
        expect(r).toEqual({ ok: true, value: false });
    });
});

describe('ackAllInWindowEpisodes (Mark caught up)', () => {
    it('acks every in-window episode and leaves old ones alone', async () => {
        const vault = makeCatchUpVault();
        const recent = episode();
        const old = episode({ id: '20260101-000000-0001', from: '2026-01-01', to: '2026-01-02', audio: 'catchup-old.mp3', coverage: { '2026-01-02': { kind: 'whole' } } });
        for (const i of [recent, old]) { vault.set(notePath(i), buildEpisodeNote(i)); vault.set(`${FOLDER}/${i.audio}`, new ArrayBuffer(4)); }
        const p = makePlugin();
        const n = await ackAllInWindowEpisodes({ app: vault.app as never, plugin: p as never, settings: settings(), now: NOW });
        expect(n).toBe(1);
        expect(Object.keys(await loadAcks(p as never))).toEqual([recent.id]);
    });
});

describe('resolveCatchUpAudio: the file played must be the episode folder\'s file', () => {
    const src = notePath(episode());
    const base = episode().audio;

    it('accepts a source whose path ends in the Catch-up folder', () => {
        expect(resolveCatchUpAudio({ sourcePath: src, audioSrc: `app://local/C:/Vault/${FOLDER}/${base}?1700`, outputRoot: ROOT })?.audioBasename).toBe(base);
        expect(resolveCatchUpAudio({ sourcePath: src, audioSrc: base, outputRoot: ROOT })?.audioBasename).toBe(base);
    });

    it('rejects a same-named file from anywhere else', () => {
        for (const where of ['Elsewhere', 'AI-Organiser/Newsletter Inbox/2026-10-22', `${ROOT}/Archive`, 'C:/Downloads']) {
            expect(resolveCatchUpAudio({ sourcePath: src, audioSrc: `app://local/${where}/${base}`, outputRoot: ROOT }), where).toBeNull();
        }
    });
});

describe('markBucketsConsumed: the retention window applies to incoming entries', () => {
    it('drops entries older than the window instead of re-introducing them', async () => {
        const p = makePlugin();
        const n = await markBucketsConsumed(p as never, [
            { date: '2026-10-22', revision: 2 },
            { date: '2026-09-01', revision: 5 },
        ], 'catchup', '2026-10-23');
        expect(n).toBe(1);
        const consumed = (p.state.stored[CONSUMED_DATA_KEY] as { consumed: Record<string, unknown> }).consumed;
        expect(Object.keys(consumed)).toEqual(['2026-10-22']);
    });

    it('the boundary day is kept and the day before it is not', async () => {
        const p = makePlugin();
        await markBucketsConsumed(p as never, [{ date: '2026-10-16', revision: 1 }, { date: '2026-10-15', revision: 1 }], 'catchup', '2026-10-23');
        const consumed = (p.state.stored[CONSUMED_DATA_KEY] as { consumed: Record<string, unknown> }).consumed;
        expect(Object.keys(consumed)).toEqual(['2026-10-16']);
    });

    it('only out-of-window entries means no write at all', async () => {
        const p = makePlugin();
        const save = vi.spyOn(p, 'saveData');
        expect(await markBucketsConsumed(p as never, [{ date: '2026-01-01', revision: 3 }], 'catchup', '2026-10-23')).toBe(0);
        expect(save).not.toHaveBeenCalled();
    });
});
