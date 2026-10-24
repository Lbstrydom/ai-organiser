/**
 * Is Obsidian's link index complete? One answer for every feature that draws a conclusion from
 * `resolvedLinks` ("nothing links to this file") before something destructive or protective.
 *
 * Readiness must be PROVEN, never assumed from a flag's presence or from silence:
 *
 *  - `initialized` (1.14+) and the older `resolved` flag are undocumented and differ by version.
 *    Read from the 1.15 app bundle, `initialized` becomes true once link resolution has been QUEUED,
 *    not finished, so it can say "not yet" but never "done".
 *  - Obsidian's own definition of "done" is `isCacheClean()`: no indexing task in progress, an empty
 *    link-resolver queue that is not running. That method, or the fields it reads, is a positive
 *    proof when present.
 *  - The documented `resolved` event (fired when the link-resolver queue stops) is a proof the plugin
 *    can always observe: `trackMetadataIndex` watches it, and `changed`, from load.
 *
 * Strict result: `ready` only with a proof and nothing saying "building"; `building` when something
 * says so (a false flag, queued work, a `changed` not yet followed by `resolved`) or a flag is
 * positive but no proof exists yet; `unknown` when nothing at all can be established. Callers that
 * could do harm treat both `building` and `unknown` as "do not proceed".
 */

import type { App, EventRef, Plugin } from 'obsidian';

export type MetadataIndexState = 'ready' | 'building' | 'unknown';

interface Tracked {
    /** A file was indexed (`changed`) since the last `resolved`. Only `resolved` clears it. */
    pending: boolean;
    resolvedSeen: boolean;
}

const tracked = new WeakMap<object, Tracked>();

interface CacheFields {
    initialized?: unknown;
    resolved?: unknown;
    linkResolverQueue?: unknown;
    inProgressTaskCount?: unknown;
    isCacheClean?: unknown;
}

type Probe = 'clean' | 'busy' | 'none';

interface QueueShape {
    items?: unknown;
    runnable?: { isRunning?: () => unknown };
}

/** Obsidian's own queue object: pending `items` plus a `runnable`. Anything else is not that shape. */
function asQueueObject(queue: unknown): (QueueShape & { items: unknown[]; runnable: { isRunning: () => unknown } }) | null {
    if (typeof queue !== 'object' || queue === null) return null;
    const q = queue as QueueShape;
    return Array.isArray(q.items) && typeof q.runnable?.isRunning === 'function'
        ? (q as QueueShape & { items: unknown[]; runnable: { isRunning: () => unknown } })
        : null;
}

/** Work in flight, from any shape the queue has. An error or an unknown shape says nothing. */
function queueBusy(queue: unknown): boolean {
    try {
        if (Array.isArray(queue)) return queue.length > 0;
        if (queue instanceof Set) return queue.size > 0;
        const q = asQueueObject(queue);
        return q !== null && (q.items.length > 0 || q.runnable.isRunning() === true);
    } catch {
        return false;
    }
}

/** Obsidian's own cleanliness check, via its method when present, else the fields it reads. */
function probeOf(cache: CacheFields): Probe {
    try {
        if (typeof cache.isCacheClean === 'function') return (cache.isCacheClean as () => unknown).call(cache) === true ? 'clean' : 'busy';
    } catch {
        // fall through to the fields
    }
    const tasks = typeof cache.inProgressTaskCount === 'number' ? cache.inProgressTaskCount : null;
    if ((tasks !== null && tasks > 0) || queueBusy(cache.linkResolverQueue)) return 'busy';
    try {
        return tasks === 0 && asQueueObject(cache.linkResolverQueue) !== null ? 'clean' : 'none';
    } catch {
        return 'none';
    }
}

/** The state of the link index. Needs `trackMetadataIndex` to have run (otherwise `unknown`). */
export function getMetadataIndexState(app: App): MetadataIndexState {
    const cache = app?.metadataCache;
    if (!cache) return 'unknown';
    const t = tracked.get(cache);
    if (!t) return 'unknown';
    const fields = cache as unknown as CacheFields;

    const flags = [fields.initialized, fields.resolved].filter((v): v is boolean => typeof v === 'boolean');
    const probe = probeOf(fields);
    if (flags.includes(false) || probe === 'busy' || t.pending) return 'building';

    // A proof: Obsidian's own cleanliness check, the old `resolved` flag (set when resolution
    // finishes), or a completed resolution this plugin has seen.
    if (probe === 'clean' || fields.resolved === true || t.resolvedSeen) return 'ready';
    // `initialized` alone only says resolution was queued: wait for a proof.
    return flags.length > 0 ? 'building' : 'unknown';
}

/**
 * Start watching the documented index events. Call once from `onload`; the listeners are removed
 * with the plugin.
 */
export function trackMetadataIndex(plugin: Plugin): void {
    const cache = plugin.app.metadataCache;
    const observer = observeMetadataIndex(cache);
    plugin.registerEvent(cache.on('changed', () => observer.changed()));
    plugin.registerEvent(cache.on('resolved', () => observer.resolved()));
    plugin.register(() => observer.detach());
}

/** The state machine behind the tracker, separate from event wiring so it can be driven directly. */
export interface IndexObserver {
    changed(): void;
    resolved(): void;
    detach(): void;
}

export function observeMetadataIndex(cache: object): IndexObserver {
    const t: Tracked = { pending: false, resolvedSeen: false };
    tracked.set(cache, t);
    return {
        changed: () => { t.pending = true; },
        resolved: () => { t.pending = false; t.resolvedSeen = true; },
        detach: () => { if (tracked.get(cache) === t) tracked.delete(cache); },
    };
}

export interface WaitOptions {
    timeoutMs: number;
    signal?: AbortSignal;
    /** Polled while waiting: true ends the wait as `aborted` (the plugin was unloaded). */
    shouldStop?: () => boolean;
}

export type WaitOutcome = 'ready' | 'timeout' | 'aborted';

export interface WaitResult {
    outcome: WaitOutcome;
    /** The state when the wait ended, so a caller can tell `building` from `unknown` after a timeout. */
    state: MetadataIndexState;
}

const POLL_MS = 250;

/**
 * Wait until the index is ready, the timeout passes, or the caller cancels. Never rejects.
 * Subscribes BEFORE the first check so a transition cannot be missed; re-evaluates on every
 * `resolved` (an event with the state still `building` keeps waiting) and on a short poll (queue
 * fields change with no event); settles exactly once and releases its listener and timers on every
 * exit. Cancellation outranks readiness on every path, the timeout included. Callers write only
 * after `outcome === 'ready'`.
 */
export function waitForMetadataIndex(app: App, opts: WaitOptions): Promise<WaitResult> {
    return new Promise<WaitResult>((resolve) => {
        let settled = false;
        let ref: EventRef | null = null;
        let poll: number | null = null;
        let timer: number | null = null;

        const cancelled = (): boolean => opts.signal?.aborted === true || opts.shouldStop?.() === true;
        const finish = (outcome: WaitOutcome): void => {
            if (settled) return;
            settled = true;
            if (ref) app.metadataCache.offref(ref);
            if (poll !== null) window.clearInterval(poll);
            if (timer !== null) window.clearTimeout(timer);
            opts.signal?.removeEventListener('abort', onAbort);
            resolve({ outcome, state: getMetadataIndexState(app) });
        };
        /** Cancellation first, then readiness; `final` also ends the wait when it is neither. */
        const settle = (final: boolean): void => {
            if (settled) return;
            if (cancelled()) return finish('aborted');
            if (getMetadataIndexState(app) === 'ready') return finish('ready');
            if (final) finish('timeout');
        };
        const onAbort = (): void => finish('aborted');

        ref = app.metadataCache.on('resolved', () => settle(false));
        opts.signal?.addEventListener('abort', onAbort);
        settle(false);
        if (settled) return;
        poll = window.setInterval(() => settle(false), POLL_MS);
        timer = window.setTimeout(() => settle(true), Math.max(0, opts.timeoutMs));
    });
}
