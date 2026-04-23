/**
 * withProgress / withProgressResult wrapper contract tests — verifies the
 * Result<T> promotion, cancel sentinel routing, error normalization, and
 * toast ownership (reporter fires them, not caller).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { withProgress, withProgressResult } from '../src/services/progress/withProgress';
import { __resetStatusBarBroker } from '../src/services/progress/statusBarBroker';
import { ok, err } from '../src/core/result';
import type { ProgressReporterOptions } from '../src/services/progress/types';
import { mockNotices, clearMockNotices } from './mocks/obsidian';

if (typeof (globalThis as any).DOMException === 'undefined') {
    (globalThis as any).DOMException = class DOMException extends Error {
        constructor(message: string, name: string) {
            super(message);
            this.name = name;
        }
    };
}
if (typeof (globalThis as any).MutationObserver === 'undefined') {
    (globalThis as any).MutationObserver = class MutationObserver {
        constructor(_cb: any) {}
        observe() {}
        disconnect() {}
    };
}

type Phase = 'working';

function makePlugin(): any {
    return {
        busyStatusBarEl: { setText: vi.fn(), addClass: vi.fn(), removeClass: vi.fn() },
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

function opts(plugin: any): ProgressReporterOptions<Phase> {
    return {
        plugin,
        initialPhase: { key: 'working' },
        resolvePhase: () => 'Working…',
    };
}

beforeEach(() => { clearMockNotices(); __resetStatusBarBroker(); });
afterEach(() => { __resetStatusBarBroker(); });

describe('withProgress (raw T contract)', () => {
    it('returns { ok: true, value: T } on success', async () => {
        const plugin = makePlugin();
        const r = await withProgress(opts(plugin), async () => 42);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toBe(42);
    });

    it('does not fire a success toast', async () => {
        const plugin = makePlugin();
        clearMockNotices();
        await withProgress(opts(plugin), async () => 'done');
        // Only the initial persistent Notice from the reporter mount — no success toast
        const successToasts = mockNotices.filter(m => m.toLowerCase().includes('success') || m.toLowerCase().includes('complete'));
        expect(successToasts.length).toBe(0);
    });

    it('returns { ok: false, error: "cancelled" } on AbortError', async () => {
        const plugin = makePlugin();
        const r = await withProgress(opts(plugin), async () => {
            throw new DOMException('cancelled', 'AbortError');
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe('cancelled');
    });

    it('fires "Cancelled" toast on AbortError', async () => {
        const plugin = makePlugin();
        clearMockNotices();
        await withProgress(opts(plugin), async () => {
            throw new DOMException('cancelled', 'AbortError');
        });
        expect(mockNotices).toContain('Cancelled');
    });

    it('returns { ok: false, error: <msg> } on thrown Error', async () => {
        const plugin = makePlugin();
        const r = await withProgress(opts(plugin), async () => {
            throw new Error('network fail');
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe('network fail');
    });

    it('fires "Failed: ..." toast on thrown Error', async () => {
        const plugin = makePlugin();
        clearMockNotices();
        await withProgress(opts(plugin), async () => {
            throw new Error('boom');
        });
        expect(mockNotices).toContain('Failed: boom');
    });

    it('normalizes non-Error throws', async () => {
        const plugin = makePlugin();
        const r = await withProgress(opts(plugin), async () => {
            throw 'string literal'; // eslint-disable-line @typescript-eslint/only-throw-error
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe('string literal');
    });

    it('uses i18n fallback for empty/unstringifiable throws', async () => {
        const plugin = makePlugin();
        const r = await withProgress(opts(plugin), async () => {
            throw null; // eslint-disable-line @typescript-eslint/only-throw-error
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe('Unknown error');
    });
});

describe('withProgressResult (Result<T>-returning contract)', () => {
    it('passes through { ok: true, value } without wrapping', async () => {
        const plugin = makePlugin();
        const r = await withProgressResult(opts(plugin), async () => ok('hello'));
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toBe('hello');
    });

    it('passes through { ok: false, error } without double-wrapping', async () => {
        const plugin = makePlugin();
        const r = await withProgressResult(opts(plugin), async () => err<string>('api down'));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe('api down');
    });

    it('routes inner "cancelled" to reporter.cancel() (not fail)', async () => {
        const plugin = makePlugin();
        clearMockNotices();
        await withProgressResult(opts(plugin), async () => err<string>('cancelled'));
        // Should see neutral "Cancelled", not "Failed: cancelled"
        expect(mockNotices).toContain('Cancelled');
        expect(mockNotices.filter(m => m.toLowerCase().startsWith('failed'))).toHaveLength(0);
    });

    it('routes inner non-cancel error through reporter.fail()', async () => {
        const plugin = makePlugin();
        clearMockNotices();
        await withProgressResult(opts(plugin), async () => err<string>('bad key'));
        expect(mockNotices).toContain('Failed: bad key');
    });

    it('handles throws identically to withProgress', async () => {
        const plugin = makePlugin();
        const r = await withProgressResult(opts(plugin), async () => {
            throw new DOMException('cancelled', 'AbortError');
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe('cancelled');
    });

    it('respects AbortController signal forwarded to operation', async () => {
        const plugin = makePlugin();
        const ac = new AbortController();
        ac.abort(); // pre-aborted
        const r = await withProgressResult({ ...opts(plugin), abortController: ac }, async (reporter) => {
            if (reporter.signal.aborted) throw new DOMException('cancelled', 'AbortError');
            return ok('unreachable');
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe('cancelled');
    });
});

describe('Cancel sentinel detection', () => {
    it('matches exact "cancelled"', async () => {
        const plugin = makePlugin();
        clearMockNotices();
        await withProgressResult(opts(plugin), async () => err<string>('cancelled'));
        expect(mockNotices).toContain('Cancelled');
    });
    it('matches case-insensitive variants', async () => {
        const plugin = makePlugin();
        clearMockNotices();
        await withProgressResult(opts(plugin), async () => err<string>('Cancelled'));
        expect(mockNotices).toContain('Cancelled');
    });
    it('does NOT match substrings (e.g. "Request was cancelled due to X")', async () => {
        const plugin = makePlugin();
        clearMockNotices();
        await withProgressResult(opts(plugin), async () => err<string>('Request was cancelled due to timeout'));
        // Should be treated as failure, not cancel
        expect(mockNotices.filter(m => m.startsWith('Failed:'))).toHaveLength(1);
    });
});
