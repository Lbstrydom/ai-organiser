/**
 * PdfHandlePool (CA1) — ref-counted, TTL'd handle sharing: concurrent leases parse once
 * (C9/G4 single-flight), destroy fires only at refs=0 + TTL, a new lease revives a
 * pending-destroy entry, disposeAll tears everything down.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PdfHandlePool } from '../src/services/pdf/pdfHandlePool';
import { __resetPdfJsCacheForTests, type PdfRendererDeps } from '../src/services/pdf/pdfPageRenderer';
import { createTFile } from './mocks/obsidian';

function fakeLib(getDocumentSpy: () => void, destroySpy: () => void) {
    return {
        OPS: {},
        getDocument: (..._args: unknown[]) => {
            getDocumentSpy();
            return {
                promise: Promise.resolve({
                    numPages: 2,
                    getPage: async () => ({
                        getTextContent: async () => ({ items: [] }),
                        getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
                        getViewport: () => ({ width: 100, height: 100 }),
                        render: () => ({ promise: Promise.resolve() }),
                        cleanup: () => {},
                    }),
                    destroy: destroySpy,
                }),
            };
        },
    };
}

interface Timers {
    scheduled: Array<{ fn: () => void; ms: number }>;
    schedule: (fn: () => void, ms: number) => number;
    cancel: (h: number) => void;
    fire: () => void;
}

function makeTimers(): Timers {
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    return {
        scheduled,
        schedule: (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length as never; },
        cancel: (h) => { scheduled[h - 1] = { fn: () => {}, ms: 0 }; },
        fire: () => { const t = scheduled.shift(); t?.fn(); },
    };
}

function makePool(getDoc = vi.fn(), destroy = vi.fn()) {
    const deps: PdfRendererDeps = {
        loadPdfJs: async () => fakeLib(getDoc, destroy),
        readBinary: async () => new ArrayBuffer(4),
    };
    const timers = makeTimers();
    const pool = new PdfHandlePool(deps, 8000, { schedule: timers.schedule, cancel: timers.cancel });
    return { pool, timers, getDoc, destroy };
}

beforeEach(() => { __resetPdfJsCacheForTests(); });

describe('PdfHandlePool (CA1)', () => {
    it('two concurrent leases for one PDF parse it ONCE (single-flight, G4)', async () => {
        const { pool, getDoc } = makePool();
        const file = createTFile('deck.pdf');
        const [a, b] = await Promise.all([pool.lease(file), pool.lease(file)]);
        expect(a.ok && b.ok).toBe(true);
        expect(getDoc).toHaveBeenCalledTimes(1);
        if (a.ok && b.ok) expect(a.value.handle).toBe(b.value.handle);
    });

    it('destroy fires only when refs hit 0 AND the TTL expires', async () => {
        const { pool, timers, destroy } = makePool();
        const file = createTFile('deck.pdf');
        const a = await pool.lease(file);
        const b = await pool.lease(file);
        expect(a.ok && b.ok).toBe(true);
        if (!a.ok || !b.ok) return;

        a.value.release();
        expect(timers.scheduled.length).toBe(0); // still one ref — no destroy scheduled
        b.value.release();
        expect(timers.scheduled.length).toBe(1); // last ref — TTL destroy scheduled
        expect(destroy).not.toHaveBeenCalled();
        timers.fire();
        expect(destroy).toHaveBeenCalledTimes(1);
        expect(pool.size).toBe(0);
    });

    it('a new lease before the TTL fires REVIVES the entry (no destroy, no re-parse)', async () => {
        const { pool, timers, getDoc, destroy } = makePool();
        const file = createTFile('deck.pdf');
        const a = await pool.lease(file);
        if (!a.ok) throw new Error('lease failed');
        a.value.release();
        expect(timers.scheduled.length).toBe(1);

        const b = await pool.lease(file); // revive — cancels the pending destroy
        expect(b.ok).toBe(true);
        timers.fire(); // the cancelled slot is a no-op
        expect(destroy).not.toHaveBeenCalled();
        expect(getDoc).toHaveBeenCalledTimes(1); // amortized — no re-parse
    });

    it('a re-saved PDF (mtime change) gets a FRESH parse, never the stale handle', async () => {
        const { pool, getDoc } = makePool();
        const file = createTFile('deck.pdf');
        file.stat.mtime = 1000;
        const a = await pool.lease(file);
        file.stat.mtime = 2000;
        const b = await pool.lease(file);
        expect(a.ok && b.ok).toBe(true);
        expect(getDoc).toHaveBeenCalledTimes(2);
        if (a.ok && b.ok) expect(a.value.handle).not.toBe(b.value.handle);
    });

    it('release is idempotent', async () => {
        const { pool, timers } = makePool();
        const file = createTFile('deck.pdf');
        const a = await pool.lease(file);
        const b = await pool.lease(file);
        if (!a.ok || !b.ok) throw new Error('lease failed');
        a.value.release();
        a.value.release(); // double release must NOT steal b's ref
        expect(timers.scheduled.length).toBe(0);
        b.value.release();
        expect(timers.scheduled.length).toBe(1);
    });

    it('a failed load is NOT cached — the next lease re-attempts', async () => {
        __resetPdfJsCacheForTests();
        let fail = true;
        const getDoc = vi.fn();
        const deps: PdfRendererDeps = {
            loadPdfJs: async () => fakeLib(getDoc, vi.fn()),
            readBinary: async () => {
                if (fail) throw new Error('io');
                return new ArrayBuffer(4);
            },
        };
        const timers = makeTimers();
        const pool = new PdfHandlePool(deps, 8000, { schedule: timers.schedule, cancel: timers.cancel });
        const file = createTFile('deck.pdf');
        const first = await pool.lease(file);
        expect(first.ok).toBe(false);
        fail = false;
        const second = await pool.lease(file);
        expect(second.ok).toBe(true);
    });

    it('disposeAll destroys everything immediately and blocks new leases', async () => {
        const { pool, destroy } = makePool();
        const file = createTFile('deck.pdf');
        const a = await pool.lease(file);
        expect(a.ok).toBe(true);
        pool.disposeAll();
        expect(destroy).toHaveBeenCalledTimes(1);
        const after = await pool.lease(file);
        expect(after.ok).toBe(false);
        if (!after.ok) expect(after.error).toBe('pool-disposed');
    });
});
