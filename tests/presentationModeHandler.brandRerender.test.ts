/**
 * F7 — live On-brand re-render scheduler (presentation-demo-fixes).
 *
 * Drives the private `requestBrandRerender` / `executeBrandRerender` /
 * `flushPendingBrandRerender` seams with mocked collaborators to lock the
 * monotonic last-write-wins + queue-while-locked + typed-outcome contract.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/services/chat/presentationHtmlService', async (orig) => {
    const actual = await (orig() as Promise<Record<string, unknown>>);
    const { ok } = await import('../src/core/result');
    return { ...actual, buildHtmlFromDeckIr: vi.fn(() => ok('<branded-html>')) };
});
vi.mock('../src/services/chat/brandThemeService', async (orig) => {
    const actual = await (orig() as Promise<Record<string, unknown>>);
    return { ...actual, resolveTheme: vi.fn(async () => ({ css: 'brand-css', auditChecklist: [], promptRules: '' })) };
});
vi.mock('../src/services/prompts/presentationChatPrompts', async (orig) => {
    const actual = await (orig() as Promise<Record<string, unknown>>);
    return { ...actual, countSlides: vi.fn(() => 5) };
});

import { PresentationModeHandler } from '../src/ui/chat/PresentationModeHandler';
import { buildHtmlFromDeckIr } from '../src/services/chat/presentationHtmlService';
import { App, mockNotices, clearMockNotices } from './mocks/obsidian';
import { coffeeDeckIr } from './fixtures/coffeeDeckIr';
import { en } from '../src/i18n/en';
import { ok, err } from '../src/core/result';

const buildHtmlMock = buildHtmlFromDeckIr as unknown as ReturnType<typeof vi.fn>;

function makeCtx() {
    const settings = { summaryLanguage: 'en', pluginFolder: 'AI-Organiser', configFolderPath: 'Config' };
    const plugin = { t: en, settings };
    return { app: new App(), plugin, fullPlugin: { t: en, settings }, options: {} } as never;
}

type HandlerProbe = {
    deck: { deckIr: unknown; html: string; activeSlideIndex: number; deckEpoch: number };
    themeResolver: { resolve: (...a: unknown[]) => Promise<unknown> };
    lastRenderedBrandEnabled: boolean;
    brandCheckboxEl: { checked: boolean } | null;
    brandEnabled: boolean;
    lastCtx: unknown;
    pendingBrand: unknown;
    requestBrandRerender: (ctx: never, b: boolean) => Promise<string>;
    executeBrandRerender: (ctx: never, b: boolean) => Promise<void>;
    flushPendingBrandRerender: () => void;
};

function makeHandler(deckIr: unknown = coffeeDeckIr, activeSlideIndex = 0): { h: PresentationModeHandler; p: HandlerProbe } {
    const h = new PresentationModeHandler();
    const p = h as unknown as HandlerProbe;
    Object.assign(p.deck, { deckIr, html: '<base-html>', activeSlideIndex, deckEpoch: 1 });
    vi.spyOn(p.themeResolver, 'resolve').mockResolvedValue({});
    return { h, p };
}

beforeEach(() => {
    buildHtmlMock.mockReset();
    buildHtmlMock.mockReturnValue(ok('<branded-html>'));
    clearMockNotices();
});

describe('F7 brand re-render scheduler', () => {
    it('applied: re-renders the live deck and preserves the active slide', async () => {
        const { p } = makeHandler(coffeeDeckIr, 2);
        const epochBefore = p.deck.deckEpoch;
        const outcome = await p.requestBrandRerender(makeCtx(), true);
        expect(outcome).toBe('applied');
        expect(p.deck.html).toBe('<branded-html>');
        expect(p.deck.deckEpoch).toBe(epochBefore + 1);   // re-theme bumps epoch (no version push)
        expect(p.deck.activeSlideIndex).toBe(2);           // clamp(2, 5) preserved
        expect(p.lastRenderedBrandEnabled).toBe(true);
    });

    it('skipped-no-deck: no deck → no render, html untouched', async () => {
        const { p } = makeHandler(null);
        const outcome = await p.requestBrandRerender(makeCtx(), true);
        expect(outcome).toBe('skipped-no-deck');
        expect(buildHtmlMock).not.toHaveBeenCalled();
        expect(p.deck.html).toBe('<base-html>');
    });

    it('queued while a mutating op holds the lock; flushes on release', async () => {
        const { h, p } = makeHandler();
        const ctx = makeCtx();
        p.lastCtx = ctx;
        const run = (h as unknown as { run: { lock: () => void; end: () => void; isLocked: () => boolean; onRelease: (fn: () => void) => void } }).run;
        run.onRelease(() => p.flushPendingBrandRerender());
        run.lock();
        const outcome = await p.requestBrandRerender(ctx, true);
        expect(outcome).toBe('queued');
        expect(p.pendingBrand).not.toBeNull();
        expect(buildHtmlMock).not.toHaveBeenCalled();
        // Release the lock — onRelease → flush → render drains.
        run.end();
        await new Promise((r) => setTimeout(r, 0));
        expect(buildHtmlMock).toHaveBeenCalledTimes(1);
        expect(p.deck.html).toBe('<branded-html>');
        expect(p.pendingBrand).toBeNull();
    });

    it('last-write-wins: a render superseded mid-resolve does not commit; the latest drains', async () => {
        const { p } = makeHandler();
        const ctx = makeCtx();
        // First resolve hangs so a second request can supersede it.
        let releaseFirst!: () => void;
        (p.themeResolver.resolve as ReturnType<typeof vi.fn>)
            .mockImplementationOnce(() => new Promise((res) => { releaseFirst = () => res({}); }))
            .mockResolvedValue({});
        const first = p.requestBrandRerender(ctx, true);   // reqId 1, hangs on resolve
        const second = await p.requestBrandRerender(ctx, false); // reqId 2 → queued (brandRendering)
        expect(second).toBe('queued');
        releaseFirst();
        const firstOutcome = await first;
        expect(firstOutcome).toBe('queued');               // superseded → did not commit
        await new Promise((r) => setTimeout(r, 0));         // let the drain run
        expect(p.lastRenderedBrandEnabled).toBe(false);     // only the latest (false) committed
    });

    it('error: failure policy notifies + reconciles the checkbox to the last rendered state', async () => {
        const { p } = makeHandler();
        p.lastRenderedBrandEnabled = false;
        p.brandCheckboxEl = { checked: true };
        p.brandEnabled = true;
        buildHtmlMock.mockReturnValue(err('render boom'));
        await p.executeBrandRerender(makeCtx(), true);
        expect(mockNotices.some((m) => m === en.modals.unifiedChat.brandRerenderFailed)).toBe(true);
        expect(p.brandEnabled).toBe(false);
        expect(p.brandCheckboxEl.checked).toBe(false);
    });
});
