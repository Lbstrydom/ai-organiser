import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { __resetChainForTests } from '../src/core/pluginDataStore';
import {
    ACTIVE_BEAT_MS,
    CatchUpPlaybackTracker,
    KEEP_MS,
    MAX_ENTRIES,
    OBSERVE_MS,
    PLAYBACK_DATA_KEY,
    RECENT_PLAY_MS,
    WRITE_THROTTLE_MS,
    coercePlaybackStore,
    playbackTrackingWanted,
    recentPlayVerdict,
    type Observer,
    type PlaybackStore,
} from '../src/services/newsletter/catchUp/catchUpPlayback';

const ROOT = 'AI-Organiser/Newsletter Inbox';
const EP = '20261023-120000-aaaa';
const NAME = `catchup-${EP}-c3d4e5f6.mp3`;
const NOTE = `${ROOT}/Catch-up/Catch-up 2026-10-21 to 2026-10-23 ${EP}.md`;
const HOUR = 3_600_000;
const ME = 'device-me';

const store = (over: Partial<PlaybackStore> = {}, me: Observer | null = { observingSince: 0, cleanShutdown: true }): PlaybackStore => ({
    version: 1, overflow: false, plays: {}, observers: me ? { [ME]: me } : {}, ...over,
});

const smartReplace = { featureFlags: { newsletter: true }, newsletterAudioPodcast: true, newsletterAudioMode: 'smart-daily', newsletterCatchUpWhenBehind: 'replace' };

describe('playbackTrackingWanted: the one capability predicate', () => {
    it('only smart daily + audio on + the replace setting + the newsletter feature', () => {
        expect(playbackTrackingWanted(smartReplace as never)).toBe(true);
        for (const off of [
            { newsletterCatchUpWhenBehind: 'wait' },
            { newsletterCatchUpWhenBehind: 'REPLACE' },
            { newsletterCatchUpWhenBehind: undefined },
            { newsletterAudioMode: 'on-demand' },
            { newsletterAudioMode: 'daily' },
            { newsletterAudioMode: 'garbage' },
            { newsletterAudioPodcast: false },
            { featureFlags: { newsletter: false } },
        ]) expect(playbackTrackingWanted({ ...smartReplace, ...off } as never)).toBe(false);
    });
});

describe('coercePlaybackStore', () => {
    it('absent is a fresh store; a well-formed store round-trips', () => {
        expect(coercePlaybackStore(undefined)).toEqual({ version: 1, overflow: false, plays: {}, observers: {} });
        expect(coercePlaybackStore(null)).toMatchObject({ plays: {} });
        const s = store({ plays: { a: 1, b: 2 } }, { observingSince: 5, cleanShutdown: false });
        expect(coercePlaybackStore(structuredClone(s))).toEqual(s);
    });

    it.each([
        ['wrong version', { ...store(), version: 2 }],
        ['a string', 'x'],
        ['an array', []],
        ['bad overflow', { ...store(), overflow: 'no' }],
        ['bad plays', { ...store(), plays: [] }],
        ['non-numeric play', { ...store(), plays: { a: 'x' } }],
        ['bad observers', { ...store(), observers: [] }],
        ['an observer with a bad flag', { ...store(), observers: { d: { observingSince: 1, cleanShutdown: 'yes' } } }],
        ['an observer with a bad start', { ...store(), observers: { d: { observingSince: 'now', cleanShutdown: true } } }],
        ['a null observer', { ...store(), observers: { d: null } }],
    ])('anything malformed (%s) is UNKNOWN, never empty', (_n, raw) => {
        expect(coercePlaybackStore(raw)).toBe('unknown');
    });
});

describe('recentPlayVerdict: missing history is unknown, not safe', () => {
    const base = { degraded: false, activeNow: false, episodeId: EP, deviceId: ME, now: 100 * HOUR };
    it('clear only when every doubt is excluded', () => {
        expect(recentPlayVerdict({ ...base, store: store() })).toBe('clear');
    });

    it('a play inside the window is recent, outside it is clear', () => {
        expect(recentPlayVerdict({ ...base, store: store({ plays: { [EP]: base.now - RECENT_PLAY_MS + 1 } }) })).toBe('recent');
        expect(recentPlayVerdict({ ...base, store: store({ plays: { [EP]: base.now - RECENT_PLAY_MS - 1 } }) })).toBe('clear');
    });

    it('a play on ANOTHER device counts (plays are shared facts)', () => {
        const s = store({ plays: { [EP]: base.now - HOUR } }, { observingSince: 0, cleanShutdown: true });
        expect(recentPlayVerdict({ ...base, store: s })).toBe('recent');
    });

    it('playing now, or a play this session that is not persisted yet, is recent whatever else is wrong', () => {
        expect(recentPlayVerdict({ ...base, activeNow: true, store: 'unknown' })).toBe('recent');
        expect(recentPlayVerdict({ ...base, localPlayAt: base.now - 1000, store: store() })).toBe('recent');
        expect(recentPlayVerdict({ ...base, localPlayAt: base.now - 1000, store: 'unknown' })).toBe('recent');
    });

    it('cold activation, or another device observing but not this one => unknown', () => {
        expect(recentPlayVerdict({ ...base, store: store({}, { observingSince: base.now - OBSERVE_MS + 1, cleanShutdown: true }) })).toBe('unknown');
        expect(recentPlayVerdict({ ...base, store: store({}, { observingSince: null, cleanShutdown: false }) })).toBe('unknown');
        expect(recentPlayVerdict({ ...base, store: store({}, null) })).toBe('unknown');
        expect(recentPlayVerdict({ ...base, deviceId: 'device-other', store: store() })).toBe('unknown');
    });

    it('an unreadable store, a failed write or overflow => unknown', () => {
        expect(recentPlayVerdict({ ...base, store: 'unknown' })).toBe('unknown');
        expect(recentPlayVerdict({ ...base, degraded: true, store: store() })).toBe('unknown');
        expect(recentPlayVerdict({ ...base, store: store({ overflow: true }) })).toBe('unknown');
    });
});

describe('CatchUpPlaybackTracker', () => {
    let state: { stored: Record<string, unknown>; failSave: boolean; saves: number; loads: number; slowSave: Promise<void> | null };
    let plugin: { loadData: () => Promise<Record<string, unknown>>; saveData: (d: Record<string, unknown>) => Promise<void> };
    let clock: number;
    let settings: Record<string, unknown>;
    let device: string;

    const tracker = (): CatchUpPlaybackTracker => new CatchUpPlaybackTracker({ plugin: plugin as never, settings: () => settings as never, now: () => clock, outputRoot: () => ROOT, deviceId: () => device });
    const stored = (): PlaybackStore => state.stored[PLAYBACK_DATA_KEY] as PlaybackStore;
    const mine = (): Observer => stored().observers[device];
    const played = (t: CatchUpPlaybackTracker, kind: 'playing' | 'paused' | 'ended' = 'playing') =>
        t.record({ sourcePath: NOTE, audioSrc: `app://x/AI-Organiser/Newsletter%20Inbox/Catch-up/${NAME}?1` }, kind);
    const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };

    beforeEach(() => {
        __resetChainForTests();
        state = { stored: {}, failSave: false, saves: 0, loads: 0, slowSave: null };
        plugin = {
            loadData: async () => { state.loads++; return structuredClone(state.stored); },
            saveData: async (d) => { if (state.slowSave) await state.slowSave; if (state.failSave) throw new Error('disk'); state.saves++; state.stored = structuredClone(d); },
        };
        clock = 1_000 * HOUR;
        device = ME;
        settings = { ...DEFAULT_SETTINGS, ...smartReplace };
    });

    it('with the default setting it never reads or writes storage, whatever happens in the player', async () => {
        settings = { ...DEFAULT_SETTINGS, featureFlags: { newsletter: true }, newsletterAudioPodcast: true, newsletterAudioMode: 'smart-daily' };
        const t = tracker();
        await t.start(false);
        played(t); played(t, 'paused'); played(t, 'ended');
        await t.onSettingsChanged();
        await t.shutdown();
        expect(await t.recentPlay(EP)).toBe('unknown');
        expect(state.loads).toBe(0);
        expect(state.saves).toBe(0);
    });

    it('cold start: stamps observation, writes the unclean marker BEFORE observing, and blocks for a full window', async () => {
        const t = tracker();
        await t.start(false);
        expect(mine()).toEqual({ observingSince: clock, cleanShutdown: false });
        clock += OBSERVE_MS - 1;
        expect(await t.recentPlay(EP)).toBe('unknown');
        clock += 2;
        expect(await t.recentPlay(EP)).toBe('clear');
    });

    it('records plays throttled, treats a heartbeat as playing, and a lost pause cannot pin it forever', async () => {
        const t = tracker();
        await t.start(false);
        const writes = state.saves;
        played(t); await settle();
        expect(stored().plays[EP]).toBe(clock);
        expect(state.saves).toBe(writes + 1);
        clock += 1_000; played(t); await settle();
        expect(state.saves).toBe(writes + 1); // throttled
        clock += WRITE_THROTTLE_MS; played(t); await settle();
        expect(state.saves).toBe(writes + 2);
        expect(await t.recentPlay(EP)).toBe('recent');
        played(t, 'paused');
        clock += ACTIVE_BEAT_MS + 1;
        expect(await t.recentPlay(EP)).toBe('recent');
        clock += RECENT_PLAY_MS;
        expect(await t.recentPlay(EP)).toBe('clear');
    });

    it('a play is visible to the safety check IMMEDIATELY, before its write completes', async () => {
        const t = tracker();
        await t.start(false);
        clock += 2 * OBSERVE_MS;
        let release: () => void = () => undefined;
        state.slowSave = new Promise<void>((r) => { release = r; });
        played(t);
        played(t, 'paused');
        expect(await t.recentPlay(EP)).toBe('recent');
        release();
        state.slowSave = null;
        await settle();
    });

    it('a play of something that is not a catch-up episode is ignored', async () => {
        const t = tracker();
        await t.start(false);
        const writes = state.saves;
        t.record({ sourcePath: `${ROOT}/Digest — 2026-10-21.md`, audioSrc: 'app://x/brief-2026-10-21-abcd1234.mp3' }, 'playing');
        t.record({ sourcePath: NOTE, audioSrc: 'app://x/other/podcast.mp3' }, 'playing');
        await settle();
        expect(state.saves).toBe(writes);
    });

    it('ordinary restart keeps the observation; an unclean exit resets it', async () => {
        const first = tracker();
        await first.start(false);
        const since = mine().observingSince;
        await first.shutdown();
        expect(mine().cleanShutdown).toBe(true);
        clock += 3 * HOUR;
        const second = tracker();
        await second.start(false);
        expect(mine().observingSince).toBe(since);

        // second never shut down cleanly: a third start must not trust the old observation.
        clock += 3 * HOUR;
        const third = tracker();
        await third.start(false);
        expect(mine().observingSince).toBe(clock);
    });

    it('shutdown waits for writes already started and claims no clean end if one failed', async () => {
        const t = tracker();
        await t.start(false);
        state.failSave = true;
        played(t); // starts a write that will fail
        await t.shutdown(); // must see that failure before deciding
        state.failSave = false;
        expect(mine().cleanShutdown).toBe(false);
        expect(await t.recentPlay('20261001-000000-bbbb')).toBe('unknown');
        expect(await t.recentPlay(EP)).toBe('recent');
    });

    it('a mid-session enable (the workspace was already running) resets the observation', async () => {
        const first = tracker();
        await first.start(false);
        await first.shutdown();
        clock += 5 * HOUR;
        const second = tracker();
        await second.start(true);
        expect(mine().observingSince).toBe(clock);
    });

    it('observation is per device: another device resetting never erases this one, nor any recorded play', async () => {
        const a = tracker();
        await a.start(false);
        played(a); await settle();
        await a.shutdown();
        clock += 2 * HOUR;
        // A second device syncs the same data.json and starts mid-session (a reset on ITS side).
        device = 'device-other';
        const b = tracker();
        await b.start(true);
        expect(stored().observers[ME]).toMatchObject({ cleanShutdown: true });
        expect(stored().observers['device-other'].observingSince).toBe(clock);
        expect(Object.keys(stored().plays)).toEqual([EP]);
        // The other device has not observed for a full window yet, whatever device A saw.
        expect(await b.recentPlay(EP)).toBe('recent');
        expect(await b.recentPlay('20261001-000000-bbbb')).toBe('unknown');
    });

    it('switching to wait ends this device observation and keeps the facts, and switching back starts a FRESH window', async () => {
        const t = tracker();
        await t.start(false);
        played(t); await settle();
        clock += 2 * OBSERVE_MS;
        expect(await t.recentPlay('20261001-000000-bbbb')).toBe('clear');
        settings = { ...settings, newsletterCatchUpWhenBehind: 'wait' };
        await t.onSettingsChanged();
        expect(mine()).toEqual({ observingSince: null, cleanShutdown: false });
        expect(stored().plays[EP]).toBeDefined();
        expect(await t.recentPlay(EP)).toBe('unknown');
        clock += HOUR;
        settings = { ...settings, newsletterCatchUpWhenBehind: 'replace' };
        await t.onSettingsChanged();
        expect(mine().observingSince).toBe(clock);
        expect(await t.recentPlay('20261001-000000-bbbb')).toBe('unknown');
    });

    it('a failed write degrades the session: automatic replacement is blocked and no clean end is claimed', async () => {
        const t = tracker();
        await t.start(false);
        state.failSave = true;
        played(t); await settle();
        clock += 2 * OBSERVE_MS;
        state.failSave = false;
        expect(await t.recentPlay('20261001-000000-bbbb')).toBe('unknown');
        const before = mine().cleanShutdown;
        await t.shutdown();
        expect(mine().cleanShutdown).toBe(before);
    });

    it('a failed marker write at start leaves tracking degraded', async () => {
        state.failSave = true;
        const t = tracker();
        await t.start(false);
        state.failSave = false;
        clock += 2 * OBSERVE_MS;
        expect(await t.recentPlay(EP)).toBe('unknown');
    });

    it('an unreadable stored value is treated as unknown and reset, never as empty', async () => {
        state.stored[PLAYBACK_DATA_KEY] = { version: 99 };
        const t = tracker();
        await t.start(false);
        expect(mine().observingSince).toBe(clock);
        expect(stored().plays).toEqual({});
    });

    it('prunes plays older than 48 hours but keeps a 25 hour old one, and flags overflow past the cap', async () => {
        const t = tracker();
        await t.start(false);
        state.stored[PLAYBACK_DATA_KEY] = store({ plays: { old: clock - KEEP_MS - 1, mid: clock - 25 * HOUR } }, { observingSince: clock - 10 * KEEP_MS, cleanShutdown: false });
        played(t); await settle();
        expect(Object.keys(stored().plays).sort()).toEqual([EP, 'mid'].sort());

        const big: Record<string, number> = {};
        for (let i = 0; i <= MAX_ENTRIES; i++) big[`e${i}`] = clock;
        state.stored[PLAYBACK_DATA_KEY] = store({ plays: big }, { observingSince: clock - 10 * KEEP_MS, cleanShutdown: false });
        clock += WRITE_THROTTLE_MS + 1;
        played(t); await settle();
        expect(stored().overflow).toBe(true);
        clock += 2 * OBSERVE_MS;
        expect(await t.recentPlay('20261001-000000-bbbb')).toBe('unknown');
    });

    it('a store read that throws is unknown', async () => {
        const t = tracker();
        await t.start(false);
        plugin.loadData = async () => { throw new Error('read'); };
        expect(await t.recentPlay('20261001-000000-bbbb')).toBe('unknown');
    });
});

describe('CatchUpPlaybackTracker: lifecycle edges', () => {
    let stored: Record<string, unknown>;
    let clock: number;
    const plugin = {
        loadData: async () => structuredClone(stored),
        saveData: async (d: Record<string, unknown>) => { stored = structuredClone(d); },
    };
    const make = (): CatchUpPlaybackTracker => new CatchUpPlaybackTracker({ plugin: plugin as never, settings: () => ({ ...DEFAULT_SETTINGS, ...smartReplace }) as never, now: () => clock, outputRoot: () => ROOT, deviceId: () => ME });
    const play = (t: CatchUpPlaybackTracker, kind: 'playing' | 'paused' | 'ended' = 'playing') =>
        t.record({ sourcePath: NOTE, audioSrc: `app://x/AI-Organiser/Newsletter%20Inbox/Catch-up/${NAME}` }, kind);
    const tick = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };

    beforeEach(() => { __resetChainForTests(); stored = {}; clock = 1_000 * HOUR; });

    it('nothing is judged safe, and no event counts, until the observation marker is down', async () => {
        const t = make();
        const starting = t.start(false);
        play(t); // before the marker: dropped
        expect(await t.recentPlay(EP)).toBe('unknown');
        await starting;
        expect((stored[PLAYBACK_DATA_KEY] as PlaybackStore).plays).toEqual({});
    });

    it('a write can never move a recorded play backwards in time', async () => {
        const t = make();
        await t.start(false);
        const newer = clock + 5 * HOUR;
        (stored[PLAYBACK_DATA_KEY] as PlaybackStore).plays[EP] = newer; // e.g. written meanwhile by another device
        play(t); await tick();
        expect((stored[PLAYBACK_DATA_KEY] as PlaybackStore).plays[EP]).toBe(newer);
    });

    it('a shutdown that arrives while the observation marker is still being written waits for it', async () => {
        const t = make();
        const starting = t.start(false);
        const closing = t.shutdown();
        await Promise.all([starting, closing]);
        const mineNow = (stored[PLAYBACK_DATA_KEY] as PlaybackStore).observers[ME];
        expect(mineNow).toMatchObject({ cleanShutdown: true });
        expect(mineNow.observingSince).not.toBeNull();
    });

    it('shutdown flushes a play the throttle held back, then ignores any later event', async () => {
        const t = make();
        await t.start(false);
        play(t); await tick();
        const first = clock;
        clock += 10_000;
        play(t); // throttled: remembered in memory only
        await tick();
        expect((stored[PLAYBACK_DATA_KEY] as PlaybackStore).plays[EP]).toBe(first);
        await t.shutdown();
        expect((stored[PLAYBACK_DATA_KEY] as PlaybackStore).plays[EP]).toBe(clock);
        expect((stored[PLAYBACK_DATA_KEY] as PlaybackStore).observers[ME].cleanShutdown).toBe(true);
        clock += 10_000;
        play(t);
        await tick();
        expect((stored[PLAYBACK_DATA_KEY] as PlaybackStore).plays[EP]).toBe(clock - 10_000);
    });
});
