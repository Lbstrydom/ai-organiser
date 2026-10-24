/**
 * Catch-up playback: is a catch-up episode playing, or was it played lately?
 *
 * Two instruments, kept apart on purpose:
 *
 *  - a LIVE probe of the audio elements Obsidian is rendering, with no callback and no stored state,
 *    so it holds in every mode and under the default settings (Replace uses it to never remove a
 *    recording that is playing). An answer it cannot give is `unknown`, and `unknown` blocks;
 *  - a small DURABLE memory of when each episode was last played on this device, used only by the
 *    automatic replacement (opt-in, default off) so it never trashes an episode that was heard lately.
 *    Missing history is UNKNOWN, never "safe": see `recentPlayVerdict`.
 */

import type { App, Plugin } from 'obsidian';
import { updatePluginData } from '../../../core/pluginDataStore';
import { logger } from '../../../utils/logger';
import { isFeatureEnabled } from '../../featureService';
import { getAudioMode } from '../newsletterAudioMode';
import { resolveCatchUpAudio } from './catchUpListen';
import { normaliseWhenBehind } from './catchUpTypes';

export type PlaybackProbe = 'playing' | 'idle' | 'unknown';

function safeDecode(value: string): string {
    try { return decodeURIComponent(value); } catch { return value; }
}

/** The lower-cased file name an `<audio>` source points at (query and fragment stripped), or ''. */
function basenameOf(src: string): string {
    const path = safeDecode(src.replace(/[?#].*$/, '')).replaceAll('\\', '/');
    return (path.split('/').pop() ?? '').toLowerCase();
}

/** Every document that can hold a player: the main window and each popout that hosts a leaf. */
function documentsOf(app: App): Document[] {
    const docs = new Set<Document>();
    // The window the person is in; `activeDocument` is Obsidian's popout-aware global (absent outside the app).
    if (typeof activeDocument !== 'undefined') docs.add(activeDocument);
    const workspace = app.workspace as { iterateAllLeaves?: (cb: (leaf: { containerEl?: HTMLElement }) => void) => void } | undefined;
    workspace?.iterateAllLeaves?.((leaf) => {
        const doc = leaf.containerEl?.ownerDocument;
        if (doc) docs.add(doc);
    });
    return [...docs];
}

/**
 * `playing` when any player in any window is actively playing a source whose file name is
 * `audioName`; `idle` when none is; `unknown` when the probe cannot look at all.
 */
export function probeEpisodePlaying(app: App, audioName: string): PlaybackProbe {
    try {
        const docs = documentsOf(app);
        if (docs.length === 0) return 'unknown';
        const wanted = audioName.toLowerCase();
        let unidentified = false;
        for (const doc of docs) {
            for (const player of Array.from(doc.querySelectorAll('audio'))) {
                if (player.paused || player.ended) continue;
                const src = player.currentSrc || player.src || '';
                const name = basenameOf(src);
                if (name === wanted) return 'playing';
                // Something is playing that this probe cannot name (a blob or stream, no file name): it might be this episode.
                if (name === '' || /^(blob|data|mediastream):/i.test(src)) unidentified = true;
            }
        }
        return unidentified ? 'unknown' : 'idle';
    } catch {
        return 'unknown';
    }
}

// ── The durable memory (automatic replacement only) ──────────────────────────

export const PLAYBACK_DATA_KEY = 'newsletter-catchup-playback';
export const PLAYBACK_SCHEMA_VERSION = 1;
/** An episode played inside this window is never replaced automatically. */
export const RECENT_PLAY_MS = 24 * 60 * 60 * 1000;
/** Observation must have run this long before "no recorded play" means anything. */
export const OBSERVE_MS = RECENT_PLAY_MS;
/** A heartbeat younger than this means the episode is playing now (a lost pause cannot pin it forever). */
export const ACTIVE_BEAT_MS = 90_000;
/** The durable record of a play is refreshed at most this often while it continues. */
export const WRITE_THROTTLE_MS = 60_000;
/** Plays older than this are dropped (the safety window is 24 hours). */
export const KEEP_MS = 48 * 60 * 60 * 1000;
/** More entries than this is not normal; the store then reports overflow and automatic replacement stops. */
export const MAX_ENTRIES = 500;

/** One device's observation state. The vault's plugin data can be synced, so this is kept PER DEVICE. */
export interface Observer {
    /** When uninterrupted observation of playback on that device began, or null. */
    observingSince: number | null;
    /** False from the moment observation starts until that device shuts down cleanly. */
    cleanShutdown: boolean;
}

export interface PlaybackStore {
    version: number;
    /** The store outgrew MAX_ENTRIES: evidence may be missing. */
    overflow: boolean;
    /** Episode id -> when it was last played on ANY device (ms). Facts are never erased by a reset. */
    plays: Record<string, number>;
    /** Device id -> its observation state. */
    observers: Record<string, Observer>;
}

const emptyStore = (): PlaybackStore => ({ version: PLAYBACK_SCHEMA_VERSION, overflow: false, plays: {}, observers: {} });

/** The stored value as a store; an absent key is a fresh empty store, anything malformed is UNKNOWN. */
export function coercePlaybackStore(raw: unknown): PlaybackStore | 'unknown' {
    if (raw === undefined || raw === null) return emptyStore();
    if (typeof raw !== 'object' || Array.isArray(raw)) return 'unknown';
    const o = raw as Record<string, unknown>;
    if (o.version !== PLAYBACK_SCHEMA_VERSION || typeof o.overflow !== 'boolean') return 'unknown';
    for (const field of [o.plays, o.observers]) if (!field || typeof field !== 'object' || Array.isArray(field)) return 'unknown';
    const plays: Record<string, number> = {};
    for (const [id, at] of Object.entries(o.plays as Record<string, unknown>)) {
        if (typeof at !== 'number' || !Number.isFinite(at)) return 'unknown';
        plays[id] = at;
    }
    const observers: Record<string, Observer> = {};
    for (const [device, value] of Object.entries(o.observers as Record<string, unknown>)) {
        const v = value as Record<string, unknown> | null;
        if (!v || typeof v !== 'object' || typeof v.cleanShutdown !== 'boolean') return 'unknown';
        if (!(v.observingSince === null || (typeof v.observingSince === 'number' && Number.isFinite(v.observingSince)))) return 'unknown';
        observers[device] = { observingSince: v.observingSince, cleanShutdown: v.cleanShutdown };
    }
    return { version: PLAYBACK_SCHEMA_VERSION, overflow: o.overflow, plays, observers };
}

/** The one capability predicate: playback memory is kept only while automatic replacement is possible. */
export function playbackTrackingWanted(settings: Parameters<typeof isFeatureEnabled>[0] & { newsletterAudioPodcast?: boolean; newsletterAudioMode?: unknown; newsletterCatchUpWhenBehind?: unknown }): boolean {
    return isFeatureEnabled(settings, 'newsletter')
        && settings.newsletterAudioPodcast === true
        && getAudioMode(settings) === 'smart-daily'
        && normaliseWhenBehind(settings.newsletterCatchUpWhenBehind) === 'replace';
}

export type RecentPlay = 'clear' | 'recent' | 'unknown';

/**
 * May an episode be treated as NOT played lately? Only when every doubt is excluded: the store is
 * readable and not over capacity, this session never failed to persist, THIS device has observed for a
 * full safety window, nothing is playing now, and the episode has no play (on any device) inside the window.
 */
export function recentPlayVerdict(input: {
    store: PlaybackStore | 'unknown';
    deviceId: string;
    degraded: boolean;
    activeNow: boolean;
    /** A play this session that may not be persisted yet. */
    localPlayAt?: number;
    episodeId: string;
    now: number;
}): RecentPlay {
    const { store, now } = input;
    if (input.activeNow) return 'recent';
    if (input.localPlayAt !== undefined && now - input.localPlayAt < RECENT_PLAY_MS) return 'recent';
    if (store === 'unknown' || input.degraded || store.overflow) return 'unknown';
    const last = store.plays[input.episodeId];
    if (typeof last === 'number' && now - last < RECENT_PLAY_MS) return 'recent';
    // No recorded play only means something once a full window has been observed here without a gap.
    const me = store.observers[input.deviceId];
    if (!me || me.observingSince === null || now - me.observingSince < OBSERVE_MS) return 'unknown';
    return 'clear';
}

export interface TrackerPorts {
    plugin: Plugin;
    settings: () => Parameters<typeof playbackTrackingWanted>[0];
    now?: () => number;
    /** The output root, for recognising an episode's audio. */
    outputRoot: () => string;
    /** A stable id for THIS device (kept in local storage, never synced). A new id each start is merely stricter. */
    deviceId: () => string;
}

/**
 * Records when catch-up episodes are played, for the automatic replacement's safety check. Every entry
 * point returns before touching the store unless `playbackTrackingWanted`, so the default configuration
 * reads and writes nothing.
 *
 * Observation is continuous or it is reset, per device: `observingSince` is cleared whenever it may have
 * been interrupted (tracking turned off, the plugin enabled mid-session, a failed write, an unclean exit).
 */
export class CatchUpPlaybackTracker {
    private degraded = false;
    private active = new Map<string, number>();
    private lastWrite = new Map<string, number>();
    /** Plays seen this session, visible to safety checks before they are persisted. */
    private localPlays = new Map<string, number>();
    private pending = new Set<Promise<unknown>>();
    private started = false;
    /** Tracking is (or is being) on: used to detect the transitions in settings. */
    private wasWanted = false;
    /** Observation has actually begun (its marker is down): events before this are dropped, and nothing is judged safe. */
    private ready = false;
    private closing = false;
    /** The activation in progress, so a shutdown can wait for it instead of racing it. */
    private activation: Promise<void> | null = null;
    /** When each play was last written to storage, so shutdown can flush the newest unwritten one. */
    private persisted = new Map<string, number>();

    constructor(private readonly ports: TrackerPorts) {}

    private now(): number { return this.ports.now ? this.ports.now() : Date.now(); }
    private wanted(): boolean { return playbackTrackingWanted(this.ports.settings()); }

    private write(mutate: (store: PlaybackStore) => void): Promise<boolean> {
        const run = (async (): Promise<boolean> => {
            try {
                await updatePluginData(this.ports.plugin, (data) => {
                    const current = coercePlaybackStore(data[PLAYBACK_DATA_KEY]);
                    const store = current === 'unknown' ? emptyStore() : current;
                    mutate(store);
                    const cutoff = this.now() - KEEP_MS;
                    for (const [id, at] of Object.entries(store.plays)) if (at < cutoff) delete store.plays[id];
                    if (Object.keys(store.plays).length > MAX_ENTRIES) store.overflow = true;
                    data[PLAYBACK_DATA_KEY] = store;
                    return { changed: true };
                });
                return true;
            } catch (e) {
                logger.warn('Newsletter', 'Could not persist catch-up playback memory', e);
                this.degraded = true;
                return false;
            }
        })();
        this.pending.add(run);
        void run.finally(() => this.pending.delete(run));
        return run;
    }

    /** Plugin load. `midSession`: the workspace was already running, so playback in the gap went unseen. */
    async start(midSession: boolean): Promise<void> {
        this.started = true;
        if (!this.wanted()) return;
        await this.activate(midSession);
    }

    private activate(forceReset: boolean): Promise<void> {
        const run = this.activateNow(forceReset);
        this.activation = run;
        void run.finally(() => { if (this.activation === run) this.activation = null; });
        return run;
    }

    private async activateNow(forceReset: boolean): Promise<void> {
        this.wasWanted = true;
        this.ready = false;
        this.closing = false;
        this.degraded = false;
        const device = this.ports.deviceId();
        let reset = forceReset;
        try {
            const data = (await this.ports.plugin.loadData()) as Record<string, unknown> | null;
            const stored = coercePlaybackStore(data?.[PLAYBACK_DATA_KEY]);
            const mine = stored === 'unknown' ? undefined : stored.observers[device];
            // An unreadable store, a first run here, or an exit that was not clean proves nothing about the past.
            if (!mine || mine.observingSince === null || !mine.cleanShutdown) reset = true;
        } catch {
            reset = true;
        }
        const t = this.now();
        // The marker goes down BEFORE observation counts; if that write fails, tracking stays degraded.
        await this.write((s) => {
            const mine = s.observers[device];
            s.observers[device] = { observingSince: reset || !mine || mine.observingSince === null ? t : mine.observingSince, cleanShutdown: false };
            if (reset) s.overflow = false;
        });
        // Only now does observation count; a failed write above has already marked the session degraded.
        this.ready = true;
    }

    /** Settings changed: a transition to wanted starts a fresh observation, away from it ends this device's. */
    async onSettingsChanged(): Promise<void> {
        if (!this.started) return;
        const wanted = this.wanted();
        const device = this.ports.deviceId();
        if (wanted && !this.wasWanted) await this.activate(true);
        else if (!wanted && this.wasWanted) {
            this.wasWanted = false;
            this.ready = false;
            this.active.clear();
            this.localPlays.clear();
            this.persisted.clear();
            await this.write((s) => { s.observers[device] = { observingSince: null, cleanShutdown: false }; });
        }
    }

    /** A player event for an audio source. Cheap and synchronous unless a durable write is due. */
    record(input: { sourcePath: string; audioSrc: string }, state: 'playing' | 'paused' | 'ended'): void {
        if (!this.wanted() || !this.ready || this.closing) return;
        const resolved = resolveCatchUpAudio({ ...input, outputRoot: this.ports.outputRoot() });
        if (!resolved) return;
        const id = resolved.episodeId;
        const t = this.now();
        if (state === 'playing') { this.active.set(id, t); this.localPlays.set(id, t); } else this.active.delete(id);
        const last = this.lastWrite.get(id) ?? 0;
        if (state === 'playing' && t - last < WRITE_THROTTLE_MS) return;
        this.lastWrite.set(id, t);
        // Monotonic: a slower earlier write can never put an older time over a newer one.
        void this.write((s) => { s.plays[id] = Math.max(s.plays[id] ?? 0, t); }).then((done) => { if (done) this.persisted.set(id, t); });
    }

    /** Plugin unload or app quit: mark a clean end, unless this session could not keep its promises. */
    async shutdown(): Promise<void> {
        if (!this.started || !this.wasWanted) return;
        // An activation still putting its marker down finishes first; shutting down is not allowed to race it.
        if (this.activation) await this.activation.catch(() => undefined);
        if (!this.ready) return;
        // No new events are accepted from here on, so what is flushed below is everything there will be.
        this.closing = true;
        // Let every write already started settle first: a pending failure must be seen before claiming a clean end.
        await Promise.allSettled([...this.pending]);
        if (this.degraded) return;
        const device = this.ports.deviceId();
        // Plays the throttle held back are written now, so the next start sees the newest one.
        const unwritten = [...this.localPlays].filter(([id, at]) => at > (this.persisted.get(id) ?? 0));
        await this.write((s) => {
            for (const [id, at] of unwritten) s.plays[id] = Math.max(s.plays[id] ?? 0, at);
            const mine = s.observers[device];
            if (mine && !this.degraded) mine.cleanShutdown = true;
        });
    }

    /** Is this episode playing, or played lately? `unknown` blocks. */
    async recentPlay(episodeId: string): Promise<RecentPlay> {
        if (!this.wanted() || !this.ready) return 'unknown';
        const beat = this.active.get(episodeId);
        const activeNow = beat !== undefined && this.now() - beat < ACTIVE_BEAT_MS;
        let store: PlaybackStore | 'unknown';
        try {
            const data = (await this.ports.plugin.loadData()) as Record<string, unknown> | null;
            store = coercePlaybackStore(data?.[PLAYBACK_DATA_KEY]);
        } catch {
            store = 'unknown';
        }
        return recentPlayVerdict({ store, deviceId: this.ports.deviceId(), degraded: this.degraded, activeNow, localPlayAt: this.localPlays.get(episodeId), episodeId, now: this.now() });
    }
}
