// @vitest-environment happy-dom
/**
 * Unit tests for PresentationLayoutController + presentationLayoutConstants
 * (plan: docs/plans/slides-side-rail-workspace.md, Phase 1).
 *
 * Coverage:
 *  - clampRailWidth: min/max/fraction/zero-width (audit L1 clamp math)
 *  - enter: marker class + rail wrapper + reparent + data-testid hooks
 *  - non-presentation / no-deck: stacked (no marker, elements direct children)
 *  - capture-once + exact restore on leave (audit Gemini-G1 regression)
 *  - resync while active does NOT re-capture original parent
 *  - collapse: class + inert + aria-hidden + aria-expanded; focus moves out of rail (M1)
 *  - keyboard resize: ArrowLeft widens, Home/End clamp, persists
 *  - persist debounce coalescing (single write) (audit M3)
 *  - dispose flushes pending persist + restores DOM
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    PresentationLayoutController,
    type PresLayoutState,
} from '../src/ui/controllers/PresentationLayoutController';
import {
    clampRailWidth,
    PRES_RAIL_MIN_PX,
    PRES_RAIL_MAX_PX,
    PRES_RESIZE_STEP_PX,
} from '../src/ui/controllers/presentationLayoutConstants';

// ── Obsidian DOM helper polyfill (createDiv/createEl) over happy-dom ──────────
function polyfill(el: HTMLElement): HTMLElement {
    const e = el as unknown as Record<string, unknown>;
    e.empty = (): void => { while (el.firstChild) el.removeChild(el.firstChild); };
    e.createEl = (tag: string, opts?: { cls?: string; text?: string; attr?: Record<string, string> }): HTMLElement => {
        const child = document.createElement(tag);
        if (opts?.cls) child.className = opts.cls;
        if (opts?.text) child.textContent = opts.text;
        if (opts?.attr) for (const [k, v] of Object.entries(opts.attr)) child.setAttribute(k, v);
        el.appendChild(child);
        polyfill(child);
        return child;
    };
    e.createDiv = (opts?: { cls?: string; text?: string }): HTMLElement =>
        (e.createEl as (t: string, o?: unknown) => HTMLElement)('div', opts);
    e.setCssProps = (props: Record<string, string>): void => {
        for (const [k, v] of Object.entries(props)) el.style.setProperty(k, v);
    };
    return el;
}

interface Harness {
    contentEl: HTMLElement;
    contextEl: HTMLElement;
    chatAreaEl: HTMLElement;
    inputRowEl: HTMLElement;
    actionsEl: HTMLElement;
    layout: PresLayoutState;
    persist: ReturnType<typeof vi.fn>;
    controller: PresentationLayoutController;
    setWidth: (px: number) => void;
}

function makeHarness(initial?: Partial<PresLayoutState>): Harness {
    const contentEl = polyfill(document.createElement('div'));
    // Mimic renderShell child order: mode-bar, context, chat-area, input-row, actions.
    contentEl.createEl('div', { cls: 'ai-organiser-chat-mode-bar' });
    const contextEl = contentEl.createEl('div', { cls: 'ai-organiser-chat-context' });
    const chatAreaEl = contentEl.createEl('div', { cls: 'ai-organiser-chat-area' });
    const inputRowEl = contentEl.createEl('div', { cls: 'ai-organiser-chat-input-row' });
    const actionsEl = contentEl.createEl('div', { cls: 'ai-organiser-chat-actions' });

    // Attach to the document so focus()/activeElement work in happy-dom.
    document.body.appendChild(contentEl);
    // Give contentEl a MUTABLE measurable width (happy-dom clientWidth is 0) so
    // tests can simulate crossing the narrow breakpoint.
    const widthRef = { value: 1600 };
    Object.defineProperty(contentEl, 'clientWidth', { get: () => widthRef.value, configurable: true });
    const setWidth = (px: number): void => { widthRef.value = px; };

    const layout: PresLayoutState = {
        railCollapsed: false,
        railWidthPx: 360,
        filmstripCollapsed: false,
        ...initial,
    };
    const persist = vi.fn(async (next: PresLayoutState) => { Object.assign(layout, next); });

    const controller: PresentationLayoutController = new PresentationLayoutController({
        contentEl,
        chatAreaEl,
        inputRowEl,
        getLayout: () => layout,
        persistLayout: persist,
        labels: () => ({
            collapseChatPanel: 'Collapse chat panel',
            expandChatPanel: 'Expand chat panel',
            resizeChatPanel: 'Resize chat panel',
            openChatPanel: 'Open chat',
        }),
    });

    const harness = { contentEl, contextEl, chatAreaEl, inputRowEl, actionsEl, layout, persist, controller, setWidth };
    created.push(harness);
    return harness;
}

// Track every harness created in a test so afterEach disposes ALL of them —
// not just the last `h` (some tests reassign `h = makeHarness(...)`) (audit L6).
const created: Harness[] = [];

const PRESENT = { mode: 'presentation', hasDeck: true, deckVersion: 1 };
const NOTE = { mode: 'note', hasDeck: false, deckVersion: 0 };

// ── clampRailWidth ────────────────────────────────────────────────────────────

describe('clampRailWidth', () => {
    it('clamps below MIN up to MIN', () => {
        expect(clampRailWidth(100, 1600)).toBe(PRES_RAIL_MIN_PX);
    });
    it('clamps above MAX down to MAX', () => {
        expect(clampRailWidth(9999, 1600)).toBe(PRES_RAIL_MAX_PX);
    });
    it('caps at 40% of modal width', () => {
        // 40% of 1000 = 400 → desired 500 clamps to 400
        expect(clampRailWidth(500, 1000)).toBe(400);
    });
    it('skips the fraction cap when modal width is unknown (0)', () => {
        expect(clampRailWidth(420, 0)).toBe(420);
    });
    it('keeps a valid value within range', () => {
        expect(clampRailWidth(360, 1600)).toBe(360);
    });
});

// ── Controller ────────────────────────────────────────────────────────────────

describe('PresentationLayoutController', () => {
    let h: Harness;
    beforeEach(() => { created.length = 0; h = makeHarness(); });
    afterEach(() => {
        for (const c of created) c.controller.dispose();
        created.length = 0;
        document.body.innerHTML = '';
        vi.useRealTimers();
    });

    it('non-presentation mode leaves the stacked layout (no marker, direct children)', () => {
        h.controller.sync(NOTE);
        expect(h.contentEl.classList.contains('ai-organiser-pres-workspace')).toBe(false);
        expect(h.chatAreaEl.parentElement).toBe(h.contentEl);
        expect(h.contentEl.querySelector('.ai-organiser-pres-rail')).toBeNull();
    });

    it('presentation mode with NO deck stays stacked (create-panel) — no grid (audit M15)', () => {
        h.controller.sync({ mode: 'presentation', hasDeck: false, deckVersion: 0 });
        expect(h.contentEl.classList.contains('ai-organiser-pres-workspace')).toBe(false);
        expect(h.contentEl.querySelector('.ai-organiser-pres-rail')).toBeNull();
        expect(h.chatAreaEl.parentElement).toBe(h.contentEl);
    });

    it('marks the create state (presentation + no deck) so CSS collapses the empty transcript', () => {
        h.controller.sync({ mode: 'presentation', hasDeck: false, deckVersion: 0 });
        expect(h.contentEl.classList.contains('ai-organiser-pres-create')).toBe(true);
        // Generating a deck clears the create marker (side-rail takes over).
        h.controller.sync(PRESENT);
        expect(h.contentEl.classList.contains('ai-organiser-pres-create')).toBe(false);
        // Leaving presentation also clears it.
        h.controller.sync({ mode: 'presentation', hasDeck: false, deckVersion: 0 });
        h.controller.sync(NOTE);
        expect(h.contentEl.classList.contains('ai-organiser-pres-create')).toBe(false);
    });

    it('transitions cleanly from no-deck → deck → no-deck (deck generated then discarded)', () => {
        h.controller.sync({ mode: 'presentation', hasDeck: false, deckVersion: 0 }); // create panel
        h.controller.sync({ mode: 'presentation', hasDeck: true, deckVersion: 1 });  // generated
        expect(h.contentEl.classList.contains('ai-organiser-pres-workspace')).toBe(true);
        h.controller.sync({ mode: 'presentation', hasDeck: false, deckVersion: 1 }); // discarded
        expect(h.contentEl.classList.contains('ai-organiser-pres-workspace')).toBe(false);
        expect(h.chatAreaEl.parentElement).toBe(h.contentEl);
        expect(h.chatAreaEl.nextElementSibling).toBe(h.inputRowEl);
    });

    it('entering the workspace adds the marker, reparents into the rail, tags testids', () => {
        h.controller.sync(PRESENT);
        expect(h.contentEl.classList.contains('ai-organiser-pres-workspace')).toBe(true);
        const rail = h.contentEl.querySelector('.ai-organiser-pres-rail');
        expect(rail).not.toBeNull();
        expect(rail?.getAttribute('data-testid')).toBe('pres-rail');
        expect(h.chatAreaEl.parentElement).toBe(rail);
        expect(h.inputRowEl.parentElement).toBe(rail);
        expect(h.contextEl.getAttribute('data-testid')).toBe('pres-canvas');
        // resizer + toggle present
        expect(h.contentEl.querySelector('.ai-organiser-pres-resizer')?.getAttribute('role')).toBe('separator');
        expect(h.contentEl.querySelector('.ai-organiser-pres-rail-toggle')).not.toBeNull();
    });

    it('restores transcript + composer to EXACT original positions on leave', () => {
        h.controller.sync(PRESENT);
        expect(h.chatAreaEl.parentElement).toBe(h.contentEl.querySelector('.ai-organiser-pres-rail'));

        h.controller.sync(NOTE);
        // Back under contentEl, original order: chat-area immediately before input-row,
        // input-row immediately before actions.
        expect(h.chatAreaEl.parentElement).toBe(h.contentEl);
        expect(h.inputRowEl.parentElement).toBe(h.contentEl);
        expect(h.chatAreaEl.nextElementSibling).toBe(h.inputRowEl);
        expect(h.inputRowEl.nextElementSibling).toBe(h.actionsEl);
        expect(h.contentEl.classList.contains('ai-organiser-pres-workspace')).toBe(false);
        expect(h.contentEl.querySelector('.ai-organiser-pres-rail')).toBeNull();
    });

    it('resync while active does NOT re-capture the original parent (Gemini-G1)', () => {
        h.controller.sync(PRESENT);
        // Several resyncs (e.g. deck mutations) while already in the workspace.
        h.controller.sync({ ...PRESENT, deckVersion: 2 });
        h.controller.sync({ ...PRESENT, deckVersion: 3 });
        const rail = h.contentEl.querySelector('.ai-organiser-pres-rail');
        expect(h.chatAreaEl.parentElement).toBe(rail); // still in rail, not double-moved

        // Leaving must still restore to contentEl — proving origin wasn't overwritten with the rail.
        h.controller.sync(NOTE);
        expect(h.chatAreaEl.parentElement).toBe(h.contentEl);
        expect(h.chatAreaEl.nextElementSibling).toBe(h.inputRowEl);
    });

    it('collapse sets the class, inert + aria-hidden on the rail, and aria-expanded on the toggle', () => {
        h.controller.sync(PRESENT);
        const toggle = h.contentEl.querySelector('.ai-organiser-pres-rail-toggle') as HTMLElement;
        const rail = h.contentEl.querySelector('.ai-organiser-pres-rail') as HTMLElement;
        expect(toggle.getAttribute('aria-expanded')).toBe('true');

        toggle.dispatchEvent(new Event('click'));
        expect(h.contentEl.classList.contains('ai-organiser-pres-rail-collapsed')).toBe(true);
        expect(rail.getAttribute('aria-hidden')).toBe('true');
        expect(rail.hasAttribute('inert')).toBe(true);
        expect(toggle.getAttribute('aria-expanded')).toBe('false');

        toggle.dispatchEvent(new Event('click'));
        expect(h.contentEl.classList.contains('ai-organiser-pres-rail-collapsed')).toBe(false);
        expect(rail.hasAttribute('inert')).toBe(false);
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
    });

    it('moves focus to the toggle when collapsing with focus inside the rail (audit M1)', () => {
        h.controller.sync(PRESENT);
        const toggle = h.contentEl.querySelector('.ai-organiser-pres-rail-toggle') as HTMLElement;
        // Put a focusable element inside the rail and focus it.
        const input = document.createElement('input');
        h.chatAreaEl.appendChild(input);
        input.focus();
        expect(h.chatAreaEl.contains(document.activeElement)).toBe(true);

        toggle.dispatchEvent(new Event('click'));
        expect(document.activeElement).toBe(toggle);
    });

    it('keyboard resize: ArrowLeft widens by the step; Home/End clamp to max/min', () => {
        h = makeHarness({ railWidthPx: 360 });
        h.controller.sync(PRESENT);
        const resizer = h.contentEl.querySelector('.ai-organiser-pres-resizer') as HTMLElement;

        resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
        expect(h.contentEl.getAttribute('data-rail-width')).toBe(String(360 + PRES_RESIZE_STEP_PX));

        resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'End' }));
        expect(h.contentEl.getAttribute('data-rail-width')).toBe(String(PRES_RAIL_MIN_PX));

        // Home → max, but capped at 40% of 1600 = 640 → MAX(560) wins since 640>560.
        resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }));
        expect(h.contentEl.getAttribute('data-rail-width')).toBe(String(PRES_RAIL_MAX_PX));
    });

    it('coalesces rapid persists into a single debounced write (audit M3)', async () => {
        vi.useFakeTimers();
        h = makeHarness();
        h.controller.sync(PRESENT);
        const resizer = h.contentEl.querySelector('.ai-organiser-pres-resizer') as HTMLElement;

        resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
        resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
        resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
        expect(h.persist).not.toHaveBeenCalled(); // still debouncing

        await vi.runAllTimersAsync();
        expect(h.persist).toHaveBeenCalledTimes(1);
        expect(h.persist.mock.calls[0][0].railWidthPx).toBe(360 + PRES_RESIZE_STEP_PX * 3);
    });

    it('dispose flushes a pending persist and restores the DOM', async () => {
        vi.useFakeTimers();
        h = makeHarness();
        h.controller.sync(PRESENT);
        const resizer = h.contentEl.querySelector('.ai-organiser-pres-resizer') as HTMLElement;
        resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));

        h.controller.dispose(); // before the debounce fires
        await vi.runAllTimersAsync();

        expect(h.persist).toHaveBeenCalledTimes(1);
        // DOM restored
        expect(h.chatAreaEl.parentElement).toBe(h.contentEl);
        expect(h.contentEl.querySelector('.ai-organiser-pres-rail')).toBeNull();
    });

    // ── Phase 3 — narrow bottom-sheet ────────────────────────────────────────

    it('on a narrow modal, marks narrow + mounts the bottom-sheet FAB', () => {
        h = makeHarness();
        h.setWidth(800); // below PRES_NARROW_BREAKPOINT_PX (900)
        h.controller.sync(PRESENT);
        expect(h.contentEl.classList.contains('ai-organiser-pres-narrow')).toBe(true);
        expect(h.contentEl.querySelector('.ai-organiser-pres-sheet-fab')).not.toBeNull();
    });

    it('FAB opens the sheet (class + aria-expanded + focus into rail); Escape closes + returns focus', () => {
        h = makeHarness();
        h.setWidth(800);
        h.controller.sync(PRESENT);
        const fab = h.contentEl.querySelector('.ai-organiser-pres-sheet-fab') as HTMLElement;
        // a focusable inside the rail so focus has somewhere to land
        const input = document.createElement('button');
        h.chatAreaEl.appendChild(input);

        fab.dispatchEvent(new Event('click'));
        expect(h.contentEl.classList.contains('ai-organiser-pres-sheet-open')).toBe(true);
        expect(fab.getAttribute('aria-expanded')).toBe('true');

        h.contentEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(h.contentEl.classList.contains('ai-organiser-pres-sheet-open')).toBe(false);
        expect(fab.getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(fab); // focus returned to the FAB
    });

    it('backdrop tap closes the sheet', () => {
        h = makeHarness();
        h.setWidth(800);
        h.controller.sync(PRESENT);
        (h.contentEl.querySelector('.ai-organiser-pres-sheet-fab') as HTMLElement).dispatchEvent(new Event('click'));
        (h.contentEl.querySelector('.ai-organiser-pres-sheet-backdrop') as HTMLElement).dispatchEvent(new Event('click'));
        expect(h.contentEl.classList.contains('ai-organiser-pres-sheet-open')).toBe(false);
    });

    it('crossing back to wide mid-session closes the sheet (clean breakpoint transition)', () => {
        h = makeHarness();
        h.setWidth(800);
        h.controller.sync(PRESENT);
        (h.contentEl.querySelector('.ai-organiser-pres-sheet-fab') as HTMLElement).dispatchEvent(new Event('click'));
        expect(h.contentEl.classList.contains('ai-organiser-pres-sheet-open')).toBe(true);
        // widen + resync → narrow drops, sheet must close
        h.setWidth(1600);
        h.controller.sync({ ...PRESENT, deckVersion: 2 });
        expect(h.contentEl.classList.contains('ai-organiser-pres-narrow')).toBe(false);
        expect(h.contentEl.classList.contains('ai-organiser-pres-sheet-open')).toBe(false);
    });

    it('seeds collapsed state from persisted settings on enter', () => {
        h = makeHarness({ railCollapsed: true });
        h.controller.sync(PRESENT);
        expect(h.contentEl.classList.contains('ai-organiser-pres-rail-collapsed')).toBe(true);
        const rail = h.contentEl.querySelector('.ai-organiser-pres-rail') as HTMLElement;
        expect(rail.hasAttribute('inert')).toBe(true);
    });
});
