import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    getMetadataIndexState,
    observeMetadataIndex,
    trackMetadataIndex,
    waitForMetadataIndex,
} from '../src/utils/metadataIndexState';

type Handler = (...a: unknown[]) => void;

/** A metadata cache with real event plumbing and whatever runtime fields a test sets. */
function makeApp(fields: Record<string, unknown> = {}) {
    const handlers = new Map<object, { name: string; cb: Handler }>();
    const cache = {
        ...fields,
        on: vi.fn((name: string, cb: Handler) => { const ref = {}; handlers.set(ref, { name, cb }); return ref; }),
        offref: vi.fn((ref: object) => { handlers.delete(ref); }),
    };
    const emit = (name: string) => { for (const h of [...handlers.values()]) if (h.name === name) h.cb(); };
    return { app: { metadataCache: cache } as never, cache, emit, handlers: () => handlers.size };
}

const idleQueue = () => ({ items: [], runnable: { isRunning: () => false } });

/** The state with a tracker attached that has seen nothing yet (the plugin loaded after indexing finished). */
function fresh(fields: Record<string, unknown>) {
    const a = makeApp(fields);
    const observer = observeMetadataIndex(a.cache);
    return { ...a, observer };
}

describe('without a tracker nothing can be proven', () => {
    it('no tracker attached: unknown, whatever the fields claim', () => {
        const { app } = makeApp({ initialized: true, inProgressTaskCount: 0, linkResolverQueue: idleQueue() });
        expect(getMetadataIndexState(app)).toBe('unknown');
    });

    it('no metadata cache at all is unknown', () => {
        expect(getMetadataIndexState({} as never)).toBe('unknown');
    });

    it('detach removes the tracker', () => {
        const { app, observer } = fresh({ initialized: true });
        observer.resolved();
        expect(getMetadataIndexState(app)).toBe('ready');
        observer.detach();
        expect(getMetadataIndexState(app)).toBe('unknown');
    });
});

describe('a flag alone is never a proof', () => {
    it.each([
        ['new shape initialized:true', { initialized: true }, 'building'],
        ['new shape initialized:false', { initialized: false }, 'building'],
        ['old shape resolved:false', { resolved: false }, 'building'],
        ['one false wins', { initialized: true, resolved: false }, 'building'],
        ['neither flag', {}, 'unknown'],
        ['non-boolean junk is not a flag', { initialized: 'yes', resolved: 1 }, 'unknown'],
    ])('%s', (_label, fields, expected) => {
        const { app } = fresh(fields);
        expect(getMetadataIndexState(app)).toBe(expected);
    });

    it('initialized:true with no proof stays building however long it has been quiet', () => {
        const { app } = fresh({ initialized: true });
        vi.useFakeTimers();
        vi.advanceTimersByTime(10 * 60_000);
        expect(getMetadataIndexState(app)).toBe('building');
        vi.useRealTimers();
    });
});

describe('proofs of completion', () => {
    it('a resolved event is a proof (initialized:true, 1.14 shape)', () => {
        const { app, observer } = fresh({ initialized: true });
        observer.resolved();
        expect(getMetadataIndexState(app)).toBe('ready');
    });

    it('neither flag but a resolved event was observed: ready', () => {
        const { app, observer } = fresh({});
        observer.resolved();
        expect(getMetadataIndexState(app)).toBe('ready');
    });

    it('the old resolved:true flag is a proof (it is set when resolution finishes)', () => {
        const { app } = fresh({ resolved: true });
        expect(getMetadataIndexState(app)).toBe('ready');
    });

    it('Obsidian 1.15 shape: initialized, no tasks, idle queue object => ready without any event', () => {
        const { app } = fresh({ initialized: true, inProgressTaskCount: 0, linkResolverQueue: idleQueue() });
        expect(getMetadataIndexState(app)).toBe('ready');
    });

    it('Obsidian own isCacheClean() is used when it exists, both ways', () => {
        const clean = fresh({ initialized: true, isCacheClean: () => true });
        expect(getMetadataIndexState(clean.app)).toBe('ready');
        const busy = fresh({ initialized: true, isCacheClean: () => false });
        busy.observer.resolved();
        expect(getMetadataIndexState(busy.app)).toBe('building');
    });

    it('a throwing isCacheClean falls back to the fields', () => {
        const { app } = fresh({ initialized: true, isCacheClean: () => { throw new Error('x'); }, inProgressTaskCount: 0, linkResolverQueue: idleQueue() });
        expect(getMetadataIndexState(app)).toBe('ready');
    });
});

describe('work in flight is building, even after a proof', () => {
    it.each([
        ['queue has pending items', { initialized: true, inProgressTaskCount: 0, linkResolverQueue: { items: [{}], runnable: { isRunning: () => false } } }],
        ['queue is running', { initialized: true, inProgressTaskCount: 0, linkResolverQueue: { items: [], runnable: { isRunning: () => true } } }],
        ['files still being indexed', { initialized: true, inProgressTaskCount: 3, linkResolverQueue: null }],
        ['an array queue with entries', { initialized: true, linkResolverQueue: [{}] }],
        ['a Set queue with entries', { initialized: true, linkResolverQueue: new Set([1]) }],
    ])('%s', (_label, fields) => {
        const { app, observer } = fresh(fields);
        observer.resolved();
        expect(getMetadataIndexState(app)).toBe('building');
    });

    it('a changed with no later resolved is building, and only resolved clears it', () => {
        const { app, observer } = fresh({ initialized: true });
        observer.resolved();
        observer.changed();
        expect(getMetadataIndexState(app)).toBe('building');
        observer.resolved();
        expect(getMetadataIndexState(app)).toBe('ready');
    });

    it('a previously resolved cache that starts rebuilding is building again', () => {
        const { app, cache, observer } = fresh({ initialized: true });
        observer.resolved();
        expect(getMetadataIndexState(app)).toBe('ready');
        (cache as unknown as { initialized: boolean }).initialized = false;
        expect(getMetadataIndexState(app)).toBe('building');
    });

    it('a queue whose probe throws or answers oddly is NOT clean: it proves nothing', () => {
        const throwing = { items: [], runnable: { isRunning: () => { throw new Error('x'); } } };
        const odd = { items: [], runnable: { isRunning: () => 'no' } };
        for (const linkResolverQueue of [throwing, odd]) {
            const { app } = fresh({ initialized: true, inProgressTaskCount: 0, linkResolverQueue });
            expect(getMetadataIndexState(app)).toBe('building'); // initialized alone is not a proof
        }
    });

    it('an unreadable queue does not block a real proof (an observed resolved event)', () => {
        const { app, observer } = fresh({ initialized: true, linkResolverQueue: { items: [], runnable: { isRunning: () => { throw new Error('x'); } } } });
        observer.resolved();
        expect(getMetadataIndexState(app)).toBe('ready');
    });

    it('an empty array or Set queue is not evidence of idleness either', () => {
        for (const linkResolverQueue of [[], new Set()]) {
            const { app } = fresh({ initialized: true, inProgressTaskCount: 0, linkResolverQueue });
            expect(getMetadataIndexState(app)).toBe('building');
        }
    });
});

describe('trackMetadataIndex wires the documented events through the plugin', () => {
    it('registers changed and resolved via registerEvent, and detaches on unload', () => {
        const { app, cache, emit } = makeApp({ initialized: true });
        const registered: unknown[] = [];
        let unload: (() => void) | undefined;
        trackMetadataIndex({ app, registerEvent: (r: unknown) => { registered.push(r); }, register: (fn: () => void) => { unload = fn; } } as never);
        expect(registered).toHaveLength(2);
        expect(cache.on).toHaveBeenCalledWith('changed', expect.any(Function));
        expect(cache.on).toHaveBeenCalledWith('resolved', expect.any(Function));
        emit('changed');
        expect(getMetadataIndexState(app)).toBe('building');
        emit('resolved');
        expect(getMetadataIndexState(app)).toBe('ready');
        unload?.();
        expect(getMetadataIndexState(app)).toBe('unknown');
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
        const { app, observer, handlers } = fresh({ initialized: true });
        observer.resolved();
        await expect(waitForMetadataIndex(app, { timeoutMs: 5_000 })).resolves.toEqual({ outcome: 'ready', state: 'ready' });
        expect(handlers()).toBe(0);
    });

    it('becomes ready on a resolved event while waiting', async () => {
        const { app, observer, emit, handlers } = fresh({ initialized: true });
        observer.changed();
        const p = waitForMetadataIndex(app, { timeoutMs: 5_000 });
        observer.resolved();
        emit('resolved');
        await expect(p).resolves.toEqual({ outcome: 'ready', state: 'ready' });
        expect(handlers()).toBe(0);
    });

    it('becomes ready on the poll when a queue drains with no event', async () => {
        const queue = { items: [{}], runnable: { isRunning: () => false } };
        const { app } = fresh({ initialized: true, inProgressTaskCount: 0, linkResolverQueue: queue });
        const p = waitForMetadataIndex(app, { timeoutMs: 5_000 });
        queue.items.length = 0;
        await vi.advanceTimersByTimeAsync(300);
        await expect(p).resolves.toEqual({ outcome: 'ready', state: 'ready' });
    });

    it('a resolved event with the state still building keeps waiting, then times out with the final state', async () => {
        const { app, emit, handlers } = fresh({ initialized: false });
        const p = waitForMetadataIndex(app, { timeoutMs: 1_000 });
        emit('resolved');
        await vi.advanceTimersByTimeAsync(1_001);
        await expect(p).resolves.toEqual({ outcome: 'timeout', state: 'building' });
        expect(handlers()).toBe(0);
    });

    it('times out as unknown when nothing can establish readiness', async () => {
        const { app } = fresh({});
        const p = waitForMetadataIndex(app, { timeoutMs: 500 });
        await vi.advanceTimersByTimeAsync(600);
        await expect(p).resolves.toEqual({ outcome: 'timeout', state: 'unknown' });
    });

    it('an abort signal ends the wait as aborted and releases the listener', async () => {
        const { app, handlers } = fresh({ initialized: false });
        const ac = new AbortController();
        const p = waitForMetadataIndex(app, { timeoutMs: 60_000, signal: ac.signal });
        ac.abort();
        await expect(p).resolves.toMatchObject({ outcome: 'aborted' });
        expect(handlers()).toBe(0);
    });

    it('shouldStop (plugin unload) ends the wait as aborted', async () => {
        const { app } = fresh({ initialized: false });
        let stop = false;
        const p = waitForMetadataIndex(app, { timeoutMs: 60_000, shouldStop: () => stop });
        stop = true;
        await vi.advanceTimersByTimeAsync(300);
        await expect(p).resolves.toMatchObject({ outcome: 'aborted' });
    });

    it('cancellation outranks readiness, including at the timeout', async () => {
        const { app, observer } = fresh({ initialized: true });
        observer.resolved();
        await expect(waitForMetadataIndex(app, { timeoutMs: 1_000, shouldStop: () => true })).resolves.toMatchObject({ outcome: 'aborted' });
        const building = fresh({ initialized: false });
        let stop = false;
        const p = waitForMetadataIndex(building.app, { timeoutMs: 400, shouldStop: () => stop });
        stop = true;
        await vi.advanceTimersByTimeAsync(500);
        await expect(p).resolves.toMatchObject({ outcome: 'aborted' });
    });

    it('a resolved callback that fires during registration still releases its listener', async () => {
        const { app, cache, observer } = fresh({ initialized: true });
        observer.resolved();
        const offref = vi.fn();
        (cache as unknown as { on: unknown }).on = vi.fn((_name: string, cb: Handler) => { cb(); return {}; });
        (cache as unknown as { offref: unknown }).offref = offref;
        await expect(waitForMetadataIndex(app, { timeoutMs: 1_000 })).resolves.toMatchObject({ outcome: 'ready' });
        expect(offref).toHaveBeenCalledTimes(1);
    });

    it('settles exactly once: a late event after the timeout changes nothing', async () => {
        const { app, emit } = fresh({ initialized: false });
        const p = waitForMetadataIndex(app, { timeoutMs: 100 });
        await vi.advanceTimersByTimeAsync(150);
        const first = await p;
        emit('resolved');
        expect(first.outcome).toBe('timeout');
    });
});
