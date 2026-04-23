/**
 * ProgressReporter unit tests — covers the state machine, surface coordination,
 * terminal transitions, and lifecycle cleanup per docs/plans/progress-reporter.md §8.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ProgressReporter, normalizeError } from '../src/services/progress/progressReporter';
import { __resetStatusBarBroker } from '../src/services/progress/statusBarBroker';
import type { ProgressHost, ProgressReporterOptions } from '../src/services/progress/types';
import { mockNotices, clearMockNotices } from './mocks/obsidian';

// Minimal DOMException mock for node env
if (typeof (globalThis as any).DOMException === 'undefined') {
    (globalThis as any).DOMException = class DOMException extends Error {
        constructor(message: string, name: string) {
            super(message);
            this.name = name;
        }
    };
}

// Minimal MutationObserver mock
if (typeof (globalThis as any).MutationObserver === 'undefined') {
    (globalThis as any).MutationObserver = class MutationObserver {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        constructor(_cb: any) {}
        observe() { /* noop */ }
        disconnect() { /* noop */ }
    };
}

type Phase = 'preparing' | 'working' | 'finalizing';

function makePlugin(): any {
    const statusBarEl: any = {
        setText: vi.fn(),
        addClass: vi.fn(),
        removeClass: vi.fn(),
    };
    return {
        busyStatusBarEl: statusBarEl,
        t: {
            messages: { aiProcessing: 'AI processing…' },
            progress: {
                cancelButton: 'Cancel',
                cancelled: 'Cancelled',
                cancelPrompt: 'Cancel?',
                failedPrefix: 'Failed',
                timedOut: 'Timed out after {duration}',
                stillWorking: 'Still working…',
                unknownError: 'Unknown error',
            },
        },
    };
}

function makeHost(container?: any): ProgressHost {
    const el = container || makeEl();
    const detachCallbacks: Array<() => void> = [];
    return {
        getProgressContainer: () => el,
        onHostDetach: (cb: () => void) => {
            detachCallbacks.push(cb);
            return () => {
                const idx = detachCallbacks.indexOf(cb);
                if (idx >= 0) detachCallbacks.splice(idx, 1);
            };
        },
        // Expose for tests to fire
        _fireDetach: () => detachCallbacks.forEach(cb => cb()),
    } as any;
}

function makeEl(): any {
    const children: any[] = [];
    const listeners = new Map<string, Function[]>();
    const el: any = {
        children,
        isConnected: true,
        parentElement: null,
        classList: { add: vi.fn(), remove: vi.fn(), contains: () => false, toggle: vi.fn() },
        _cssProps: {} as Record<string, string>,
        _attrs: {} as Record<string, string>,
        textContent: '',
        addClass: vi.fn(),
        removeClass: vi.fn(),
        empty: vi.fn(() => { children.length = 0; }),
        setText: vi.fn(function (this: any, t: string) { this.textContent = t; return this; }),
        setAttr: vi.fn(function (this: any, k: string, v: string) { this._attrs[k] = v; return this; }),
        setAttribute: vi.fn(function (this: any, k: string, v: string) { this._attrs[k] = v; return this; }),
        removeAttribute: vi.fn(function (this: any, k: string) { delete this._attrs[k]; return this; }),
        setCssProps: vi.fn(function (this: any, props: Record<string, string>) { Object.assign(this._cssProps, props); }),
        remove: vi.fn(function (this: any) { this.isConnected = false; }),
        createSpan: vi.fn(function (this: any, opts?: { cls?: string; text?: string }) {
            const child = makeEl();
            if (opts?.cls) child.classList = { ...child.classList, add: vi.fn(), contains: (c: string) => c === opts.cls };
            if (opts?.text) child.textContent = opts.text;
            children.push(child);
            return child;
        }),
        createDiv: vi.fn(function (this: any, opts?: { cls?: string }) {
            const child = makeEl();
            if (opts?.cls) child.classList = { ...child.classList, add: vi.fn(), contains: (c: string) => c === opts.cls };
            children.push(child);
            return child;
        }),
        createEl: vi.fn(function (this: any, _tag: string, opts?: { cls?: string; text?: string }) {
            const child = makeEl();
            if (opts?.cls) child.classList = { ...child.classList, add: vi.fn(), contains: (c: string) => c === opts.cls };
            if (opts?.text) child.textContent = opts.text;
            children.push(child);
            return child;
        }),
        querySelector: vi.fn(function (this: any, _selector: string) {
            return children[0] ?? null;
        }),
        addEventListener: (ev: string, h: Function) => {
            const list = listeners.get(ev) ?? [];
            list.push(h);
            listeners.set(ev, list);
        },
        removeEventListener: (ev: string, h: Function) => {
            const list = listeners.get(ev);
            if (list) {
                const idx = list.indexOf(h);
                if (idx >= 0) list.splice(idx, 1);
            }
        },
        _listeners: listeners,
    };
    return el;
}

function baseOptions(plugin: any, overrides: Partial<ProgressReporterOptions<Phase>> = {}): ProgressReporterOptions<Phase> {
    return {
        plugin,
        initialPhase: { key: 'preparing' },
        resolvePhase: (p) => `Phase: ${p.key}`,
        ...overrides,
    };
}

beforeEach(() => {
    clearMockNotices();
    __resetStatusBarBroker();
});

afterEach(() => {
    __resetStatusBarBroker();
});

describe('ProgressReporter — construction', () => {
    it('creates a Notice on construction when no host supplied', () => {
        const plugin = makePlugin();
        const reporter = new ProgressReporter<Phase>(baseOptions(plugin));
        expect(mockNotices.length).toBeGreaterThanOrEqual(1);
        reporter.dispose();
    });

    it('acquires status bar ticket when busyStatusBarEl present', () => {
        const plugin = makePlugin();
        const reporter = new ProgressReporter<Phase>(baseOptions(plugin));
        expect(plugin.busyStatusBarEl.addClass).toHaveBeenCalledWith('ai-organiser-busy-active');
        reporter.dispose();
    });

    it('skips status bar when busyStatusBarEl is null (mobile guard)', () => {
        const plugin = makePlugin();
        plugin.busyStatusBarEl = null;
        const reporter = new ProgressReporter<Phase>(baseOptions(plugin));
        expect(mockNotices.length).toBeGreaterThanOrEqual(1);
        reporter.dispose();
    });

    it('uses host inline when host.getProgressContainer().isConnected is true', () => {
        const plugin = makePlugin();
        const host = makeHost();
        const reporter = new ProgressReporter<Phase>(baseOptions(plugin, { host }));
        // Inline mode suppresses the Notice
        expect(mockNotices.length).toBe(0);
        reporter.dispose();
    });

    it('exposes signal (non-aborted) even when no abortController supplied', () => {
        const plugin = makePlugin();
        const reporter = new ProgressReporter<Phase>(baseOptions(plugin));
        expect(reporter.signal).toBeDefined();
        expect(reporter.signal.aborted).toBe(false);
        reporter.dispose();
    });

    it('exposes signal that reflects abortController state', () => {
        const plugin = makePlugin();
        const ac = new AbortController();
        const reporter = new ProgressReporter<Phase>(baseOptions(plugin, { abortController: ac }));
        expect(reporter.signal).toBe(ac.signal);
        reporter.dispose();
    });
});

describe('ProgressReporter — terminal transitions', () => {
    it('succeed() releases surfaces without firing a toast', () => {
        const plugin = makePlugin();
        const reporter = new ProgressReporter<Phase>(baseOptions(plugin));
        clearMockNotices();
        reporter.succeed();
        expect(mockNotices.length).toBe(0); // No success toast — caller owns that
    });

    it('fail() fires one error toast with failedPrefix', () => {
        const plugin = makePlugin();
        const reporter = new ProgressReporter<Phase>(baseOptions(plugin));
        clearMockNotices();
        reporter.fail('API key invalid');
        expect(mockNotices.length).toBe(1);
        expect(mockNotices[0]).toBe('Failed: API key invalid');
    });

    it('cancel() fires one "Cancelled" toast', () => {
        const plugin = makePlugin();
        const reporter = new ProgressReporter<Phase>(baseOptions(plugin));
        clearMockNotices();
        reporter.cancel();
        expect(mockNotices.length).toBe(1);
        expect(mockNotices[0]).toBe('Cancelled');
    });

    it('timedOut() fires error toast with duration', () => {
        const plugin = makePlugin();
        const reporter = new ProgressReporter<Phase>(baseOptions(plugin));
        clearMockNotices();
        reporter.timedOut(125000); // 2:05
        expect(mockNotices.length).toBe(1);
        expect(mockNotices[0]).toContain('2:05');
    });

    it('terminal states are idempotent', () => {
        const plugin = makePlugin();
        const reporter = new ProgressReporter<Phase>(baseOptions(plugin));
        clearMockNotices();
        reporter.fail('once');
        reporter.fail('twice'); // no-op
        reporter.cancel();       // no-op
        expect(mockNotices.length).toBe(1);
    });

    it('setPhase is ignored after terminal state', () => {
        const plugin = makePlugin();
        const reporter = new ProgressReporter<Phase>(baseOptions(plugin));
        reporter.succeed();
        reporter.setPhase({ key: 'working' }); // no-op
        // No assertion beyond no throw; state contract doesn't expose phase post-terminal
        expect(true).toBe(true);
    });

    it('dispose() is idempotent', () => {
        const plugin = makePlugin();
        const reporter = new ProgressReporter<Phase>(baseOptions(plugin));
        reporter.dispose();
        reporter.dispose(); // no throw
        expect(true).toBe(true);
    });
});

describe('ProgressReporter — abort signal', () => {
    it('external abort transitions to cancelled', () => {
        const plugin = makePlugin();
        const ac = new AbortController();
        const reporter = new ProgressReporter<Phase>(baseOptions(plugin, { abortController: ac }));
        clearMockNotices();
        ac.abort();
        expect(mockNotices.length).toBe(1);
        expect(mockNotices[0]).toBe('Cancelled');
        void reporter;
    });
});

describe('normalizeError', () => {
    it('uses Error.message', () => {
        expect(normalizeError(new Error('boom'), 'fallback')).toBe('boom');
    });
    it('uses non-empty string directly', () => {
        expect(normalizeError('literal', 'fallback')).toBe('literal');
    });
    it('falls back for empty Error.message', () => {
        expect(normalizeError(new Error(''), 'fallback')).toBe('fallback');
    });
    it('falls back for null', () => {
        expect(normalizeError(null, 'fallback')).toBe('fallback');
    });
    it('falls back for undefined', () => {
        expect(normalizeError(undefined, 'fallback')).toBe('fallback');
    });
    it('falls back for empty string', () => {
        expect(normalizeError('', 'fallback')).toBe('fallback');
    });
    it('stringifies bare objects', () => {
        const r = normalizeError({ custom: 'oops' }, 'fallback');
        // Should produce either the object's toString or the fallback — both OK
        expect(r.length).toBeGreaterThan(0);
    });
});
