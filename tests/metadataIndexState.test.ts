import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    QUIET_MS,
    getMetadataIndexState,
    observeMetadataIndex,
    trackMetadataIndex,
    waitForMetadataIndex,
} from '../src/utils/metadataIndexState';

type Handler = (...a: unknown[]) => void;

/** A metadata cache with real event plumbing and whatever runtime hints a test sets. */
function makeApp(hints: Record<string, unknown> = {}) {
    const handlers = new Map<object, { name: string; cb: Handler }>();
    const cache = {
        ...hints,
        on: vi.fn((name: string, cb: Handler) => { const ref = {}; handlers.set(ref, { name, cb }); return ref; }),
        offref: vi.fn((ref: object) => { handlers.delete(ref); }),
    };
    const emit = (name: string) => { for (const h of [...handlers.values()]) if (h.name === name) h.cb(); };
    return { app: { metadataCache: cache } as never, cache, emit, handlers: () => handlers.size };
}

const T0 = 1_000_000;

describe('hints alone (lenient policy)', () => {
    it.each([
        ['old shape resolved:true', { resolved: true }, 'ready'],
        ['old shape resolved:false', { resolved: false }, 'building'],
        ['new shape initialized:true', { initialized: true }, 'ready'],
        ['new shape initialized:false', { initialized: false }, 'building'],
        ['both true', { initialized: true, resolved: true }, 'ready'],
        ['one false wins', { initialized: true, resolved: false }, 'building'],
        ['neither flag', {}, 'unknown'],
        ['non-boolean junk is not a flag', { initialized: 'yes', resolved: 1 }, 'unknown'],
        ['queued link work is building', { initialized: true, linkResolverQueue: [{}] }, 'building'],
        ['an empty queue says nothing', { initialized: true, linkResolverQueue: [] }, 'ready'],
        ['a queue of an unknown shape says nothing', { initialized: true, linkResolverQueue: { x: 1 } }, 'ready'],
        // The shape Obsidian 1.15 actually has (read from its app bundle): a null queue until link resolution starts, then an object.
        ['1.15: initialized, queue not started (null)', { initialized: true, inProgressTaskCount: 0, linkResolverQueue: null }, 'ready'],
        ['1.15: idle queue object', { initialized: true, inProgressTaskCount: 0, linkResolverQueue: { items: [], runnable: { isRunning: () => false } } }, 'ready'],
        ['1.15: queue has pending items', { initialized: true, inProgressTaskCount: 0, linkResolverQueue: { items: [{}], runnable: { isRunning: () => false } } }, 'building'],
        ['1.15: queue is running', { initialized: true, inProgressTaskCount: 0, linkResolverQueue: { items: [], runnable: { isRunning: () => true } } }, 'building'],
        ['1.15: files still being indexed', { initialized: true, inProgressTaskCount: 3, linkResolverQueue: null }, 'building'],
        ['a queue whose probe throws says nothing', { initialized: true, linkResolverQueue: { runnable: { isRunning: () => { throw new Error('x'); } } } }, 'ready'],
    ])('%s', (_label, hints, expected) => {
        const { app } = makeApp(hints);
        expect(getMetadataIndexState(app, 'lenient')).toBe(expected);
    });

    it('neither flag but a completed resolution was observed: ready', () => {
        const { app, cache } = makeApp();
        observeMetadataIndex(cache, T0).resolved();
        expect(getMetadataIndexState(app, 'lenient')).toBe('ready');
    });

    it('no metadata cache at all is unknown', () => {
        expect(getMetadataIndexState({} as never, 'strict')).toBe('unknown');
    });
});

describe('strict policy needs observed completion, whatever the flags claim', () => {
    it('no tracker attached: unknown, even with initialized:true', () => {
        const { app } = makeApp({ initialized: true });
        expect(getMetadataIndexState(app, 'strict', T0)).toBe('unknown');
    });

    it('hint-ready and nothing observed: building until QUIET_MS has passed since attach', () => {
        const { app, cache } = makeApp({ initialized: true });
        observeMetadataIndex(cache, T0);
        expect(getMetadataIndexState(app, 'strict', T0 + 5_000)).toBe('building');
        expect(getMetadataIndexState(app, 'strict', T0 + QUIET_MS)).toBe('ready');
    });

    it('a resolved event is ready immediately', () => {
        const { app, cache } = makeApp({ initialized: true });
        observeMetadataIndex(cache, T0).resolved();
        expect(getMetadataIndexState(app, 'strict', T0)).toBe('ready');
    });

    it('changed with no later resolved is building, and quiet time never rescues it', () => {
        const { app, cache } = makeApp({ initialized: true });
        const o = observeMetadataIndex(cache, T0);
        o.changed();
        expect(getMetadataIndexState(app, 'strict', T0 + 60_000)).toBe('building');
        o.resolved();
        expect(getMetadataIndexState(app, 'strict', T0 + 60_000)).toBe('ready');
    });

    it('a previously resolved cache that starts rebuilding is building again', () => {
        const { app, cache } = makeApp({ initialized: true });
        const o = observeMetadataIndex(cache, T0);
        o.resolved();
        expect(getMetadataIndexState(app, 'strict', T0)).toBe('ready');
        o.changed();
        expect(getMetadataIndexState(app, 'strict', T0)).toBe('building');
    });

    it('lenient ignores an in-flight changed that never resolves', () => {
        const { app, cache } = makeApp({ initialized: true });
        observeMetadataIndex(cache, T0).changed();
        expect(getMetadataIndexState(app, 'lenient', T0)).toBe('ready');
    });

    it('flags that say building override an observed resolution', () => {
        const { app, cache } = makeApp({ initialized: false });
        observeMetadataIndex(cache, T0).resolved();
        expect(getMetadataIndexState(app, 'strict', T0)).toBe('building');
    });

    it('neither flag and no resolution observed: unknown (fail closed)', () => {
        const { app, cache } = makeApp();
        observeMetadataIndex(cache, T0);
        expect(getMetadataIndexState(app, 'strict', T0 + 10 * QUIET_MS)).toBe('unknown');
    });

    it('detach removes the tracker', () => {
        const { app, cache } = makeApp({ initialized: true });
        const o = observeMetadataIndex(cache, T0);
        o.resolved();
        o.detach();
        expect(getMetadataIndexState(app, 'strict', T0)).toBe('unknown');
    });
});

describe('trackMetadataIndex wires the documented events through the plugin', () => {
    it('registers changed and resolved via registerEvent, and detaches on unload', () => {
        const { app, cache, emit } = makeApp({ initialized: true });
        const registered: unknown[] = [];
        let unload: (() => void) | undefined;
        trackMetadataIndex({ app, registerEvent: (r: unknown) => { registered.push(r); }, register: (fn: () => void) => { unload = fn; } } as never, T0);
        expect(registered).toHaveLength(2);
        expect(cache.on).toHaveBeenCalledWith('changed', expect.any(Function));
        expect(cache.on).toHaveBeenCalledWith('resolved', expect.any(Function));
        emit('changed');
        expect(getMetadataIndexState(app, 'strict', T0)).toBe('building');
        emit('resolved');
        expect(getMetadataIndexState(app, 'strict', T0)).toBe('ready');
        unload?.();
        expect(getMetadataIndexState(app, 'strict', T0)).toBe('unknown');
    });
});

describe('waitForMetadataIndex', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal('window', globalThis);
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('already ready: resolves ready at once and leaves no listener behind', async () => {
        const { app, cache, handlers } = makeApp({ initialized: true });
        observeMetadataIndex(cache, T0).resolved();
        await expect(waitForMetadataIndex(app, { policy: 'strict', timeoutMs: 5_000 })).resolves.toEqual({ outcome: 'ready', state: 'ready' });
        expect(handlers()).toBe(0);
    });

    it('becomes ready on a resolved event while waiting', async () => {
        const { app, cache, emit, handlers } = makeApp({ initialized: true });
        const o = observeMetadataIndex(cache, T0);
        o.changed();
        const p = waitForMetadataIndex(app, { policy: 'strict', timeoutMs: 5_000 });
        o.resolved();
        emit('resolved');
        await expect(p).resolves.toEqual({ outcome: 'ready', state: 'ready' });
        expect(handlers()).toBe(0);
    });

    it('a resolved event with the state still building keeps waiting, then times out with the final state', async () => {
        const { app, cache, emit, handlers } = makeApp({ initialized: false });
        observeMetadataIndex(cache, T0);
        const p = waitForMetadataIndex(app, { policy: 'strict', timeoutMs: 1_000 });
        emit('resolved');
        await vi.advanceTimersByTimeAsync(1_001);
        await expect(p).resolves.toEqual({ outcome: 'timeout', state: 'building' });
        expect(handlers()).toBe(0);
    });

    it('times out as unknown when nothing can establish readiness', async () => {
        const { app, cache } = makeApp();
        observeMetadataIndex(cache, T0);
        const p = waitForMetadataIndex(app, { policy: 'strict', timeoutMs: 500 });
        await vi.advanceTimersByTimeAsync(600);
        await expect(p).resolves.toEqual({ outcome: 'timeout', state: 'unknown' });
    });

    it('an abort signal ends the wait as aborted and releases the listener', async () => {
        const { app, cache, handlers } = makeApp({ initialized: false });
        observeMetadataIndex(cache, T0);
        const ac = new AbortController();
        const p = waitForMetadataIndex(app, { policy: 'strict', timeoutMs: 60_000, signal: ac.signal });
        ac.abort();
        await expect(p).resolves.toMatchObject({ outcome: 'aborted' });
        expect(handlers()).toBe(0);
    });

    it('shouldStop (plugin unload) ends the wait as aborted', async () => {
        const { app, cache } = makeApp({ initialized: false });
        observeMetadataIndex(cache, T0);
        let stop = false;
        const p = waitForMetadataIndex(app, { policy: 'strict', timeoutMs: 60_000, shouldStop: () => stop });
        stop = true;
        await vi.advanceTimersByTimeAsync(300);
        await expect(p).resolves.toMatchObject({ outcome: 'aborted' });
    });

    it('settles exactly once: a late event after the timeout changes nothing', async () => {
        const { app, cache, emit } = makeApp({ initialized: false });
        observeMetadataIndex(cache, T0);
        const p = waitForMetadataIndex(app, { policy: 'strict', timeoutMs: 100 });
        await vi.advanceTimersByTimeAsync(150);
        const first = await p;
        emit('resolved');
        expect(first.outcome).toBe('timeout');
    });
});
