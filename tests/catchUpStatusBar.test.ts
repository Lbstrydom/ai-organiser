// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const platform = vi.hoisted(() => ({ isMobile: false }));
vi.mock('obsidian', () => ({
    Platform: platform,
    setIcon: vi.fn(),
    TFile: class { path = ''; },
    normalizePath: (p: string) => p,
}));

const snap = vi.hoisted(() => ({ value: null as unknown, calls: 0 }));
vi.mock('../src/services/newsletter/catchUp/catchUpSelection', () => ({
    buildCatchUpSnapshot: vi.fn(async () => { snap.calls++; return snap.value; }),
}));

import { CatchUpStatusBar, statusBarWanted } from '../src/ui/components/CatchUpStatusBar';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { getTranslations } from '../src/i18n';

const t = getTranslations('en');

function el() {
    const e: Record<string, unknown> & { hidden: boolean; text: string; attrs: Record<string, string>; handlers: Record<string, (ev?: unknown) => void>; removed: boolean } = {
        hidden: true, text: '', attrs: {}, handlers: {}, removed: false,
        addClass: vi.fn(), hide() { e.hidden = true; }, show() { e.hidden = false; },
        setAttribute(k: string, v: string) { e.attrs[k] = v; },
        addEventListener(ev: string, h: (x?: unknown) => void) { e.handlers[ev] = h; },
        empty() { e.text = ''; },
        createSpan(o?: { text?: string }) { e.text += o?.text ?? ''; return { } as never; },
        remove() { e.removed = true; },
    };
    return e;
}

function plugin(over: Record<string, unknown> = {}) {
    const item = el();
    return {
        item,
        p: {
            app: {}, t,
            addStatusBarItem: () => item,
            openCatchUpWindow: vi.fn(),
            settings: {
                ...DEFAULT_SETTINGS, featureFlags: { newsletter: true }, newsletterAudioPodcast: true,
                newsletterAudioMode: 'on-demand', newsletterCatchUpStatusBar: true, ...over,
            },
        } as never,
    };
}

const snapshot = (days: number, unheard = 0) => ({
    plan: days === 0 ? null : { entries: Array.from({ length: days }, (_, i) => ({ date: `2026-10-2${i}`, newsletters: 2 })) },
    unheard: Array.from({ length: unheard }, (_, i) => ({ id: `e${i}` })),
});

beforeEach(() => {
    vi.useFakeTimers();
    platform.isMobile = false;
    snap.calls = 0;
    snap.value = snapshot(3);
});
afterEach(() => { vi.useRealTimers(); });

async function settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(1100);
    await vi.advanceTimersByTimeAsync(0);
}

describe('statusBarWanted (every hiding rule)', () => {
    const base = { ...DEFAULT_SETTINGS, featureFlags: { newsletter: true }, newsletterAudioPodcast: true, newsletterAudioMode: 'on-demand' as const, newsletterCatchUpStatusBar: true };
    it('shows for on-demand and smart-daily', () => {
        expect(statusBarWanted(base)).toBe(true);
        expect(statusBarWanted({ ...base, newsletterAudioMode: 'smart-daily' })).toBe(true);
    });
    it.each([
        ['daily mode', { newsletterAudioMode: 'daily' }],
        ['audio off', { newsletterAudioPodcast: false }],
        ['feature off', { featureFlags: { newsletter: false } }],
        ['user opt-out', { newsletterCatchUpStatusBar: false }],
    ])('is hidden for %s', (_n, over) => {
        expect(statusBarWanted({ ...base, ...over } as never)).toBe(false);
    });
});

describe('CatchUpStatusBar', () => {
    it('shows the pending summary as a button with an accessible name', async () => {
        const { p, item } = plugin();
        const bar = new CatchUpStatusBar(p);
        bar.mount();
        expect(item.attrs.role).toBe('button');
        expect(item.attrs.tabindex).toBe('0');
        bar.refresh();
        await settle();
        expect(item.hidden).toBe(false);
        expect(item.attrs['aria-label']).toBe('Newsletter audio: 3 days · 6 newsletters pending');
        expect(item.text).toContain('3 days · 6 newsletters pending');
        bar.dispose();
    });

    it('coalesces a burst of refreshes into ONE read pass', async () => {
        const { p } = plugin();
        const bar = new CatchUpStatusBar(p);
        bar.mount();
        for (let i = 0; i < 20; i++) bar.refresh();
        await settle();
        expect(snap.calls).toBe(1);
        bar.dispose();
    });

    it('hides when there is nothing pending and nothing unheard', async () => {
        snap.value = snapshot(0, 0);
        const { p, item } = plugin();
        const bar = new CatchUpStatusBar(p);
        bar.mount();
        bar.refresh();
        await settle();
        expect(item.hidden).toBe(true);
        bar.dispose();
    });

    it('shows an unheard episode even with nothing pending', async () => {
        snap.value = snapshot(0, 2);
        const { p, item } = plugin();
        const bar = new CatchUpStatusBar(p);
        bar.mount();
        bar.refresh();
        await settle();
        expect(item.hidden).toBe(false);
        expect(item.attrs['aria-label']).toBe('2 not listened');
        bar.dispose();
    });

    it('adds the unheard count beside the pending summary', async () => {
        snap.value = snapshot(2, 1);
        const { p, item } = plugin();
        const bar = new CatchUpStatusBar(p);
        bar.mount();
        bar.refresh();
        await settle();
        expect(item.attrs['aria-label']).toContain('2 days · 4 newsletters pending');
        expect(item.attrs['aria-label']).toContain('1 not listened');
        bar.dispose();
    });

    it.each([
        ['daily mode', { newsletterAudioMode: 'daily' }],
        ['opted out', { newsletterCatchUpStatusBar: false }],
    ])('does not even read the vault when %s', async (_n, over) => {
        const { p, item } = plugin(over);
        const bar = new CatchUpStatusBar(p);
        bar.mount();
        bar.refresh();
        await settle();
        expect(snap.calls).toBe(0);
        expect(item.hidden).toBe(true);
        bar.dispose();
    });

    it('a settings change that turns it off hides a visible item', async () => {
        const { p, item } = plugin();
        const bar = new CatchUpStatusBar(p);
        bar.mount();
        bar.refresh();
        await settle();
        expect(item.hidden).toBe(false);
        (p as never as { settings: { newsletterAudioMode: string } }).settings.newsletterAudioMode = 'daily';
        bar.refresh();
        await settle();
        expect(item.hidden).toBe(true);
        bar.dispose();
    });

    it('opens the window on click and on Enter / Space', () => {
        const { p, item } = plugin();
        const bar = new CatchUpStatusBar(p);
        bar.mount();
        item.handlers.click();
        item.handlers.keydown({ key: 'Enter', preventDefault: vi.fn() });
        item.handlers.keydown({ key: ' ', preventDefault: vi.fn() });
        item.handlers.keydown({ key: 'a', preventDefault: vi.fn() });
        expect((p as never as { openCatchUpWindow: ReturnType<typeof vi.fn> }).openCatchUpWindow).toHaveBeenCalledTimes(3);
        bar.dispose();
    });

    it('is absent on mobile: nothing is created and refresh is a no-op', async () => {
        platform.isMobile = true;
        const { p } = plugin();
        const add = vi.spyOn(p as never as { addStatusBarItem: () => unknown }, 'addStatusBarItem');
        const bar = new CatchUpStatusBar(p);
        bar.mount();
        bar.refresh();
        await settle();
        expect(add).not.toHaveBeenCalled();
        expect(snap.calls).toBe(0);
    });

    it('a failing read hides the item instead of throwing', async () => {
        const mod = await import('../src/services/newsletter/catchUp/catchUpSelection');
        (mod.buildCatchUpSnapshot as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('vault unreadable'));
        const { p, item } = plugin();
        const bar = new CatchUpStatusBar(p);
        bar.mount();
        bar.refresh();
        await settle();
        expect(item.hidden).toBe(true);
        bar.dispose();
    });

    it('dispose removes the item and cancels a pending refresh', async () => {
        const { p, item } = plugin();
        const bar = new CatchUpStatusBar(p);
        bar.mount();
        bar.refresh();
        bar.dispose();
        await settle();
        expect(item.removed).toBe(true);
        expect(snap.calls).toBe(0);
    });
});

describe('the status bar re-checks after its read', () => {
    it('stays hidden if settings turned it off while the snapshot was loading', async () => {
        const { p, item } = plugin();
        const bar = new CatchUpStatusBar(p);
        bar.mount();
        const mod = await import('../src/services/newsletter/catchUp/catchUpSelection');
        (mod.buildCatchUpSnapshot as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
            (p as never as { settings: { newsletterCatchUpStatusBar: boolean } }).settings.newsletterCatchUpStatusBar = false;
            return snap.value;
        });
        bar.refresh();
        await settle();
        expect(item.hidden).toBe(true);
        bar.dispose();
    });
});
