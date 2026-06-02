/**
 * PresentationRunController (TD-SSR-02 Phase 2) — the single-flight run
 * lifecycle: lock, abort, thinking sink, i18n, cancel hook.
 */
import { describe, it, expect, vi } from 'vitest';
import { PresentationRunController } from '../src/ui/chat/presentation/presentationRunController';

const T = { phaseGenerating: 'gen' } as never;

describe('PresentationRunController', () => {
    it('starts idle: not locked, no signal, no translations', () => {
        const r = new PresentationRunController();
        expect(r.isLocked()).toBe(false);
        expect(r.signal).toBeNull();
        expect(r.translations).toBeNull();
    });

    it('begin() locks, mints a signal, wires thinking + i18n', () => {
        const r = new PresentationRunController();
        const think = vi.fn();
        const abort = r.begin(think, T);
        expect(r.isLocked()).toBe(true);
        expect(r.signal).toBe(abort.signal);
        expect(r.translations).toBe(T);
        r.setThinking('hi');
        expect(think).toHaveBeenCalledWith('hi');
    });

    it('end() releases the lock + clears handles', () => {
        const r = new PresentationRunController();
        r.begin(vi.fn(), T);
        r.end();
        expect(r.isLocked()).toBe(false);
        expect(r.signal).toBeNull();
        expect(r.translations).toBeNull();
    });

    it('setThinking is a no-op when idle', () => {
        const r = new PresentationRunController();
        expect(() => r.setThinking('x')).not.toThrow();
    });

    it('abort() aborts the active signal + clears it (idempotent)', () => {
        const r = new PresentationRunController();
        const abort = r.begin(vi.fn(), T);
        r.abort();
        expect(abort.signal.aborted).toBe(true);
        expect(r.signal).toBeNull();
        expect(() => r.abort()).not.toThrow();   // idempotent
    });

    it('lock()/unlock() gate without touching abort/thinking (non-streaming paths)', () => {
        const r = new PresentationRunController();
        r.lock();
        expect(r.isLocked()).toBe(true);
        expect(r.signal).toBeNull();   // no abort controller for the light lock
        r.unlock();
        expect(r.isLocked()).toBe(false);
    });

    it('cancel hook: register → consume fires once and clears', () => {
        const r = new PresentationRunController();
        const hook = vi.fn();
        r.registerCancelHook(hook);
        r.consumeCancelHook();
        expect(hook).toHaveBeenCalledTimes(1);
        r.consumeCancelHook();   // already consumed
        expect(hook).toHaveBeenCalledTimes(1);
    });

    it('consumeCancelHook swallows a throwing hook', () => {
        const r = new PresentationRunController();
        r.registerCancelHook(() => { throw new Error('boom'); });
        expect(() => r.consumeCancelHook()).not.toThrow();
    });
});
