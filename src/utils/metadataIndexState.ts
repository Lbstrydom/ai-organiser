/**
 * Is Obsidian's link index complete? One answer for every feature that draws a conclusion from
 * `resolvedLinks` ("nothing links to this file") before something destructive.
 *
 * `initialized`, `resolved` and `linkResolverQueue` are undocumented runtime fields that differ by
 * Obsidian version (older builds expose `resolved`, 1.14 exposes `initialized`), and their
 * completion semantics are not guaranteed. They are therefore only HINTS. The lifecycle comes from
 * the documented `changed` and `resolved` metadata-cache events, watched by a tracker the plugin
 * attaches at load (`trackMetadataIndex`).
 *
 *  - `building`  the index is (or may be) incomplete: wait.
 *  - `ready`     the index is complete enough for the policy.
 *  - `unknown`   nothing establishes it either way: callers that can do harm fail closed.
 */

import type { App, EventRef, Plugin } from 'obsidian';

export type MetadataIndexState = 'ready' | 'building' | 'unknown';

/**
 * `strict` (destructive or protection-sensitive decisions) additionally needs observed completion;
 * `lenient` trusts a positive hint and ignores in-flight `changed` events, for a caller that must
 * not be wedged by a `changed` whose `resolved` never arrives.
 */
export type ReadinessPolicy = 'strict' | 'lenient';

/** With no `changed` seen since the tracker attached, this long after attach is taken as "already indexed". */
export const QUIET_MS = 15_000;

interface Tracked {
    /** A file was indexed (`changed`) since the last `resolved`. Only `resolved` clears it. */
    pending: boolean;
    resolvedSeen: boolean;
    changedSeen: boolean;
    attachedAt: number;
}

const tracked = new WeakMap<object, Tracked>();

interface CacheHints {
    initialized?: unknown;
    resolved?: unknown;
    linkResolverQueue?: unknown;
}

/** An array or Set with entries is work in flight; any other shape says nothing. */
function queueBusy(queue: unknown): boolean {
    if (Array.isArray(queue)) return queue.length > 0;
    if (queue instanceof Set) return queue.size > 0;
    return false;
}

/** What the runtime fields say: any boolean `false` or queued work is building; a boolean `true` is ready. */
function hintOf(cache: CacheHints): 'ready' | 'building' | 'none' {
    const flags = [cache.initialized, cache.resolved].filter((v): v is boolean => typeof v === 'boolean');
    if (flags.includes(false) || queueBusy(cache.linkResolverQueue)) return 'building';
    return flags.length > 0 ? 'ready' : 'none';
}

export function getMetadataIndexState(app: App, policy: ReadinessPolicy, now: number = Date.now()): MetadataIndexState {
    const cache = app?.metadataCache;
    if (!cache) return 'unknown';
    const hint = hintOf(cache as unknown as CacheHints);
    if (hint === 'building') return 'building';
    const t = tracked.get(cache);

    if (policy === 'lenient') {
        if (hint === 'ready') return 'ready';
        return t?.resolvedSeen && !t.pending ? 'ready' : 'unknown';
    }

    // Strict: completion must have been observed, whatever the fields claim.
    if (!t) return 'unknown';
    if (t.pending) return 'building';
    if (t.resolvedSeen) return 'ready';
    if (hint === 'none') return 'unknown';
    // A hint-only index: believable only when nothing has been indexing since we started watching.
    return !t.changedSeen && now - t.attachedAt >= QUIET_MS ? 'ready' : 'building';
}

/**
 * Start watching the documented index events. Call once from `onload`; the listeners are removed
 * with the plugin.
 */
export function trackMetadataIndex(plugin: Plugin, now: number = Date.now()): void {
    const cache = plugin.app.metadataCache;
    const observer = observeMetadataIndex(cache, now);
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

export function observeMetadataIndex(cache: object, now: number = Date.now()): IndexObserver {
    const t: Tracked = { pending: false, resolvedSeen: false, changedSeen: false, attachedAt: now };
    tracked.set(cache, t);
    return {
        changed: () => { t.pending = true; t.changedSeen = true; },
        resolved: () => { t.pending = false; t.resolvedSeen = true; },
        detach: () => { if (tracked.get(cache) === t) tracked.delete(cache); },
    };
}

export interface WaitOptions {
    policy: ReadinessPolicy;
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
 * `resolved` (an event with the state still `building` keeps waiting) and on a short poll (the
 * quiet-period rule becomes true with no event); settles exactly once and releases its listener
 * and timers on every exit. Callers write only after `outcome === 'ready'`.
 */
export function waitForMetadataIndex(app: App, opts: WaitOptions): Promise<WaitResult> {
    return new Promise<WaitResult>((resolve) => {
        let settled = false;
        let ref: EventRef | null = null;
        let poll: number | null = null;
        let timer: number | null = null;

        const finish = (outcome: WaitOutcome, state: MetadataIndexState): void => {
            if (settled) return;
            settled = true;
            if (ref) app.metadataCache.offref(ref);
            if (poll !== null) window.clearInterval(poll);
            if (timer !== null) window.clearTimeout(timer);
            opts.signal?.removeEventListener('abort', onAbort);
            resolve({ outcome, state });
        };
        const check = (): void => {
            if (settled) return;
            const state = getMetadataIndexState(app, opts.policy);
            if (opts.signal?.aborted || opts.shouldStop?.()) return finish('aborted', state);
            if (state === 'ready') finish('ready', state);
        };
        const onAbort = (): void => finish('aborted', getMetadataIndexState(app, opts.policy));

        ref = app.metadataCache.on('resolved', check);
        opts.signal?.addEventListener('abort', onAbort);
        check();
        if (settled) return;
        poll = window.setInterval(check, POLL_MS);
        timer = window.setTimeout(() => finish('timeout', getMetadataIndexState(app, opts.policy)), Math.max(0, opts.timeoutMs));
    });
}
