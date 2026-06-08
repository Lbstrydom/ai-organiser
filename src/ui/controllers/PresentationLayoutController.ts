/**
 * PresentationLayoutController — owns the Slides side-rail workspace layout.
 *
 * Plan: docs/plans/slides-side-rail-workspace.md (Phase 1).
 *
 * Responsibilities (and ONLY these — it receives element refs + a settings
 * get/persist pair, never the whole modal, audit M4):
 *  - Toggle the `.ai-organiser-pres-workspace` marker class that activates the
 *    CSS grid (never keyed off the preview's internal class — audit H3).
 *  - Reparent `chat-area` + `input-row` into a `.ai-organiser-pres-rail` wrapper
 *    so they read as one collapsible/resizable region, and restore them EXACTLY
 *    on mode-leave. Capture-once on the entry edge (audit Gemini-G1).
 *  - Mount a resizer (role=separator, keyboard-operable) + a collapse/expand
 *    toggle that lives OUTSIDE the inert rail (audit R3-H2 + Gemini-G4).
 *  - Toggle `.ai-organiser-pres-narrow` from the MEASURED modal width, not a
 *    viewport media query (audit Gemini-G2).
 *  - Persist the user's RAW chosen width; clamp only at apply time (audit G5).
 *
 * Never throws into an event handler; persistence is fire-and-forget with an
 * internal catch (audit M3 — no floating promises).
 */

import { logger } from '../../utils/logger';
import { listen } from '../utils/domUtils';
import {
    PRES_RAIL_DEFAULT_PX,
    PRES_RESIZE_STEP_PX,
    PRES_NARROW_BREAKPOINT_PX,
    PRES_RAIL_MIN_PX,
    PRES_RAIL_MAX_PX,
    clampRailWidth,
} from './presentationLayoutConstants';

export interface PresLayoutState {
    railCollapsed: boolean;
    railWidthPx: number;
    filmstripCollapsed: boolean;
}

export interface PresLayoutLabels {
    collapseChatPanel: string;
    expandChatPanel: string;
    resizeChatPanel: string;
    openChatPanel: string;
}

export interface PresLayoutControllerDeps {
    /** The modal's contentEl — carries the grid + marker classes. */
    contentEl: HTMLElement;
    /** The transcript region (`.ai-organiser-chat-area`). */
    chatAreaEl: HTMLElement;
    /** The composer row (`.ai-organiser-chat-input-row`). */
    inputRowEl: HTMLElement;
    /** Read the persisted layout slice. */
    getLayout: () => PresLayoutState;
    /** Persist the layout slice (awaited internally, never floated). */
    persistLayout: (next: PresLayoutState) => Promise<void>;
    /** i18n accessor (lazy so language changes are picked up). */
    labels: () => PresLayoutLabels;
}

const PERSIST_DEBOUNCE_MS = 250;

const CLS_WORKSPACE = 'ai-organiser-pres-workspace';
const CLS_COLLAPSED = 'ai-organiser-pres-rail-collapsed';
const CLS_NARROW = 'ai-organiser-pres-narrow';
const CLS_CREATE = 'ai-organiser-pres-create';
const CLS_REVIEWING = 'ai-organiser-pres-reviewing';
const CLS_SHEET_OPEN = 'ai-organiser-pres-sheet-open';
const SHEET_FOCUSABLE = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Set a CSS custom property via Obsidian's API (no inline `style.*` — keeps
 *  the review-bot `no-static-styles-assignment` rule happy). Tests polyfill
 *  `setCssProps` on their fixture elements. */
function setCssVar(el: HTMLElement, name: string, value: string): void {
    el.setCssProps({ [name]: value });
}

export class PresentationLayoutController {
    private readonly deps: PresLayoutControllerDeps;

    private inWorkspace = false;
    private railEl: HTMLElement | null = null;
    private toggleBtn: HTMLButtonElement | null = null;
    private resizerEl: HTMLElement | null = null;

    /** Captured ONCE on the entry edge so restore is exact (Gemini-G1). */
    private originalChatParent: HTMLElement | null = null;
    private originalChatNext: Node | null = null;
    private originalInputParent: HTMLElement | null = null;
    private originalInputNext: Node | null = null;

    private cleanups: Array<() => void> = [];
    private resizeObserver: ResizeObserver | null = null;

    // Narrow-width bottom-sheet (Phase 3).
    private fabBtn: HTMLButtonElement | null = null;
    private backdropEl: HTMLElement | null = null;
    private sheetOpen = false;
    private sheetKeyOff: (() => void) | null = null;

    // Persist debounce + in-flight coalescing.
    private persistTimer: ReturnType<typeof setTimeout> | null = null;
    private pendingPersist = false;
    private inFlight: Promise<void> = Promise.resolve();

    // Live session state — authoritative once in the workspace (settings are
    // read only on enter; persistence is debounced for the NEXT open). This
    // prevents a resync from reverting an optimistic collapse/resize before its
    // debounced write lands.
    private dragging = false;
    private currentWidthPx = PRES_RAIL_DEFAULT_PX;
    private currentCollapsed = false;
    private rafId: number | null = null;

    constructor(deps: PresLayoutControllerDeps) {
        this.deps = deps;
    }

    /**
     * Idempotent. Called after every renderAll/switchMode/deck-mutation.
     * `active = mode === 'presentation' && hasDeck`. `deckVersion` is accepted
     * for symmetry/future use but does not trigger re-capture (capture is
     * edge-only).
     */
    sync(opts: { mode: string; hasDeck: boolean; deckVersion?: number; reviewingStoryline?: boolean }): void {
        const active = opts.mode === 'presentation' && opts.hasDeck;
        // Presentation mode with NO deck yet = the "create" panel. Mark it so CSS
        // can collapse the empty transcript void (the create form + composer are
        // the whole interaction pre-generation). Cleared once a deck exists or on
        // any other mode.
        this.deps.contentEl.classList.toggle(CLS_CREATE, opts.mode === 'presentation' && !opts.hasDeck);
        // …EXCEPT while a storyline is in review (no deck): the transcript now holds
        // the posted storyline the user must read + iterate on, so the collapse rule
        // is overridden (CSS gives the transcript room when both markers are set).
        this.deps.contentEl.classList.toggle(CLS_REVIEWING, opts.mode === 'presentation' && !opts.hasDeck && !!opts.reviewingStoryline);
        if (active && !this.inWorkspace) {
            this.enterWorkspace();
        } else if (!active && this.inWorkspace) {
            this.leaveWorkspace();
        } else if (active && this.inWorkspace) {
            // Resync while already active: self-correct if a re-render moved the
            // elements out of the rail, and re-apply the LIVE width/collapse
            // (not persisted settings — avoids reverting an un-flushed change).
            this.ensureReparented();
            this.applyWidth(this.currentWidthPx);
            this.applyCollapsed(this.currentCollapsed, /*persist*/ false, /*moveFocus*/ false);
            this.updateNarrowClass();
        }
    }

    dispose(): void {
        if (this.inWorkspace) this.leaveWorkspace();
        this.deps.contentEl.classList.remove(CLS_CREATE);
        if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null; }
        if (this.pendingPersist) this.flushPersist();
    }

    // ── Enter / leave ────────────────────────────────────────────────────────

    private enterWorkspace(): void {
        const { contentEl, chatAreaEl, inputRowEl } = this.deps;

        // Capture original positions ONCE (Gemini-G1) before the first reparent.
        this.originalChatParent = chatAreaEl.parentElement;
        this.originalChatNext = chatAreaEl.nextSibling;
        this.originalInputParent = inputRowEl.parentElement;
        this.originalInputNext = inputRowEl.nextSibling;

        // Build the rail wrapper and move the transcript + composer inside.
        const rail = contentEl.createDiv({ cls: 'ai-organiser-pres-rail' });
        rail.setAttribute('data-testid', 'pres-rail');
        rail.appendChild(chatAreaEl);
        rail.appendChild(inputRowEl);
        this.railEl = rail;

        // Resizer lives INSIDE the rail at its left edge (hidden when collapsed).
        this.mountResizer(rail);

        // Toggle lives OUTSIDE the rail (out of grid flow) so it stays reachable
        // when the rail is inert/collapsed (R3-H2 + Gemini-G4).
        this.mountToggle(contentEl);

        // Narrow-width bottom-sheet controls (Phase 3) — CSS shows them only when
        // `.ai-organiser-pres-narrow` is active.
        this.mountSheetControls(contentEl);

        // Tag the canvas (context panel) for tests + ensure marker class.
        this.deps.contentEl.querySelector('.ai-organiser-chat-context')
            ?.setAttribute('data-testid', 'pres-canvas');
        contentEl.classList.add(CLS_WORKSPACE);

        // Narrow detection on the MEASURED modal width.
        this.startResizeObserver(contentEl);

        // Seed live state from persisted settings (read ONCE on enter).
        const layout = this.deps.getLayout();
        this.currentWidthPx = layout.railWidthPx || PRES_RAIL_DEFAULT_PX;
        this.currentCollapsed = layout.railCollapsed;

        this.inWorkspace = true;
        this.applyWidth(this.currentWidthPx);
        this.applyCollapsed(this.currentCollapsed, /*persist*/ false, /*moveFocus*/ false);
        this.updateNarrowClass();
    }

    private leaveWorkspace(): void {
        // Restore in REVERSE sibling order: input-row first (its original next
        // sibling — actions — never moved), then chat-area (whose original next
        // sibling is input-row, now back in place). Restoring chat-area first
        // would fail its `next.parentNode === parent` guard because input-row is
        // still inside the rail at that moment.
        this.restoreNode(this.deps.inputRowEl, this.originalInputParent, this.originalInputNext);
        this.restoreNode(this.deps.chatAreaEl, this.originalChatParent, this.originalChatNext);

        // Tear down the bottom-sheet (close trap listener + remove FAB/backdrop).
        this.sheetKeyOff?.();
        this.sheetKeyOff = null;
        this.sheetOpen = false;
        this.fabBtn?.remove();
        this.fabBtn = null;
        this.backdropEl?.remove();
        this.backdropEl = null;

        this.railEl?.remove();
        this.railEl = null;
        this.toggleBtn?.remove();
        this.toggleBtn = null;
        this.resizerEl = null;

        this.deps.contentEl.classList.remove(CLS_WORKSPACE, CLS_COLLAPSED, CLS_NARROW, CLS_SHEET_OPEN);

        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        for (const off of this.cleanups) off();
        this.cleanups = [];

        this.originalChatParent = this.originalChatNext = null;
        this.originalInputParent = this.originalInputNext = null;
        this.inWorkspace = false;
    }

    private ensureReparented(): void {
        if (!this.railEl) return;
        const chatOut = this.deps.chatAreaEl.parentElement !== this.railEl;
        const inputOut = this.deps.inputRowEl.parentElement !== this.railEl;
        // If EITHER drifted out, re-append BOTH in the canonical order so a
        // partial drift can't leave chat-area after input-row (audit M14).
        if (chatOut || inputOut) {
            this.railEl.appendChild(this.deps.chatAreaEl);
            this.railEl.appendChild(this.deps.inputRowEl);
        }
    }

    private restoreNode(node: HTMLElement, parent: HTMLElement | null, next: Node | null): void {
        if (!parent) return;
        if (next && next.parentNode === parent) parent.insertBefore(node, next);
        else parent.appendChild(node);
    }

    // ── Controls ──────────────────────────────────────────────────────────────

    private mountResizer(rail: HTMLElement): void {
        const resizer = rail.createDiv({ cls: 'ai-organiser-pres-resizer' });
        resizer.setAttribute('data-testid', 'pres-resizer');
        resizer.setAttribute('role', 'separator');
        resizer.setAttribute('aria-orientation', 'vertical');
        resizer.tabIndex = 0;
        this.resizerEl = resizer;

        this.cleanups.push(listen(resizer, 'pointerdown', (e) => this.onResizeStart(e)));
        this.cleanups.push(listen(resizer, 'keydown', (e) => this.onResizeKey(e)));
    }

    private mountToggle(contentEl: HTMLElement): void {
        const btn = contentEl.createEl('button', { cls: 'ai-organiser-pres-rail-toggle', attr: { type: 'button' } });
        this.toggleBtn = btn;
        this.cleanups.push(listen(btn, 'click', () => this.toggleCollapsed()));
    }

    // ── Layout application ──────────────────────────────────────────────────────

    private startResizeObserver(contentEl: HTMLElement): void {
        if (typeof ResizeObserver !== 'function') return;
        this.resizeObserver = new ResizeObserver(() => {
            if (!this.inWorkspace) return;
            this.updateNarrowClass();
            // Re-clamp the applied width against the new modal size (display only —
            // the persisted raw value is untouched; audit Gemini-G5).
            if (!this.dragging) this.applyWidth(this.currentWidthPx);
        });
        this.resizeObserver.observe(contentEl);
    }

    private applyWidth(rawPx: number): void {
        const modalWidth = this.deps.contentEl.clientWidth || 0;
        const px = clampRailWidth(rawPx, modalWidth);
        setCssVar(this.deps.contentEl, '--pres-rail-width', `${px}px`);
        this.deps.contentEl.setAttribute('data-rail-width', String(px));
        if (this.resizerEl) {
            this.resizerEl.setAttribute('aria-valuenow', String(px));
            this.resizerEl.setAttribute('aria-valuemin', String(PRES_RAIL_MIN_PX));
            this.resizerEl.setAttribute('aria-valuemax', String(PRES_RAIL_MAX_PX));
            this.resizerEl.setAttribute('aria-label', this.deps.labels().resizeChatPanel);
        }
    }

    private applyCollapsed(collapsed: boolean, persist: boolean, moveFocus: boolean): void {
        this.deps.contentEl.classList.toggle(CLS_COLLAPSED, collapsed);

        if (this.railEl) {
            // Keep the collapsed rail out of the tab order + AT tree (audit M1).
            if (collapsed) {
                this.railEl.setAttribute('aria-hidden', 'true');
                this.railEl.setAttribute('inert', '');
                if (moveFocus && this.railEl.contains(document.activeElement)) {
                    this.toggleBtn?.focus();
                }
            } else {
                this.railEl.removeAttribute('aria-hidden');
                this.railEl.removeAttribute('inert');
            }
        }

        if (this.toggleBtn) {
            const l = this.deps.labels();
            // aria-expanded reflects whether the rail (the controlled region) is open.
            this.toggleBtn.setAttribute('aria-expanded', String(!collapsed));
            const label = collapsed ? l.expandChatPanel : l.collapseChatPanel;
            this.toggleBtn.setAttribute('aria-label', label);
            this.toggleBtn.setAttribute('title', label);
        }

        if (persist) this.schedulePersist({ railCollapsed: collapsed });
    }

    private toggleCollapsed(): void {
        this.currentCollapsed = !this.currentCollapsed;
        this.applyCollapsed(this.currentCollapsed, /*persist*/ true, /*moveFocus*/ true);
    }

    private updateNarrowClass(): void {
        const narrow = (this.deps.contentEl.clientWidth || Infinity) <= PRES_NARROW_BREAKPOINT_PX;
        this.deps.contentEl.classList.toggle(CLS_NARROW, narrow);
        // Crossing back to wide mid-session: the rail returns to the side grid,
        // so close the bottom-sheet + drop its trap (no orphaned state/listener).
        if (!narrow && this.sheetOpen) this.closeSheet();
    }

    // ── Bottom-sheet (narrow widths, Phase 3) ───────────────────────────────────

    private mountSheetControls(contentEl: HTMLElement): void {
        const backdrop = contentEl.createDiv({ cls: 'ai-organiser-pres-sheet-backdrop' });
        this.backdropEl = backdrop;
        this.cleanups.push(listen(backdrop, 'click', () => this.closeSheet()));

        const fab = contentEl.createEl('button', {
            cls: 'ai-organiser-pres-sheet-fab',
            attr: { type: 'button', 'aria-label': this.deps.labels().openChatPanel, 'aria-expanded': 'false' },
        });
        this.fabBtn = fab;
        this.cleanups.push(listen(fab, 'click', () => this.openSheet()));
    }

    private openSheet(): void {
        if (this.sheetOpen || !this.railEl) return;
        this.sheetOpen = true;
        this.deps.contentEl.classList.add(CLS_SHEET_OPEN);
        // A bottom-sheet rail must be reachable: clear any collapsed inert/hidden.
        this.railEl.removeAttribute('aria-hidden');
        this.railEl.removeAttribute('inert');
        this.fabBtn?.setAttribute('aria-expanded', 'true');
        // Move focus into the sheet (composer first) + trap Tab within it.
        const focusables = this.railEl.querySelectorAll<HTMLElement>(SHEET_FOCUSABLE);
        (focusables[0] ?? this.railEl).focus();
        this.sheetKeyOff?.();
        this.sheetKeyOff = listen(this.deps.contentEl, 'keydown', (e) => this.onSheetKey(e));
    }

    private closeSheet(): void {
        if (!this.sheetOpen) return;
        this.sheetOpen = false;
        this.deps.contentEl.classList.remove(CLS_SHEET_OPEN);
        this.fabBtn?.setAttribute('aria-expanded', 'false');
        this.sheetKeyOff?.();
        this.sheetKeyOff = null;
        // Restore focus to the FAB that opened it (focus-return contract).
        this.fabBtn?.focus();
    }

    private onSheetKey(e: KeyboardEvent): void {
        if (!this.sheetOpen || !this.railEl) return;
        if (e.key === 'Escape') { e.preventDefault(); this.closeSheet(); return; }
        if (e.key !== 'Tab') return;
        const f = Array.from(this.railEl.querySelectorAll<HTMLElement>(SHEET_FOCUSABLE));
        if (f.length === 0) return;
        const first = f[0];
        const last = f[f.length - 1];
        const active = (this.deps.contentEl.ownerDocument ?? document).activeElement;
        if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
        else if (!this.railEl.contains(active)) { e.preventDefault(); first.focus(); }
    }

    // ── Resize interaction ──────────────────────────────────────────────────────

    private onResizeStart(e: PointerEvent): void {
        if (!this.railEl) return;
        e.preventDefault();
        this.dragging = true;
        const startX = e.clientX;
        const startWidth = this.currentWidthPx;
        try { this.resizerEl?.setPointerCapture(e.pointerId); } catch { /* jsdom */ }

        const offMove = listen(this.resizerEl ?? this.deps.contentEl, 'pointermove', (ev) => {
            if (!this.dragging) return;
            // Rail is on the RIGHT; dragging left (negative dx) widens it.
            const desired = startWidth + (startX - ev.clientX);
            this.queueWidth(desired);
        });
        const finish = (ev: PointerEvent) => {
            if (!this.dragging) return;
            this.dragging = false;
            offMove();
            offUp();
            offCancel();
            try { this.resizerEl?.releasePointerCapture(ev.pointerId); } catch { /* jsdom */ }
            this.schedulePersist({ railWidthPx: this.currentWidthPx });
        };
        const offUp = listen(this.resizerEl ?? this.deps.contentEl, 'pointerup', finish);
        // pointercancel discards the pending change back to the last persisted value.
        const offCancel = listen(this.resizerEl ?? this.deps.contentEl, 'pointercancel', () => {
            if (!this.dragging) return;
            this.dragging = false;
            offMove();
            offUp();
            offCancel();
            this.applyWidth(this.deps.getLayout().railWidthPx || PRES_RAIL_DEFAULT_PX);
        });
    }

    /** rAF-throttled live width update during drag (audit Tech #38). */
    private queueWidth(desiredPx: number): void {
        const modalWidth = this.deps.contentEl.clientWidth || desiredPx;
        this.currentWidthPx = clampRailWidth(desiredPx, modalWidth);
        if (this.rafId != null) return;
        const raf = typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame
            : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number;
        this.rafId = raf(() => {
            this.rafId = null;
            this.applyWidth(this.currentWidthPx);
        });
    }

    private onResizeKey(e: KeyboardEvent): void {
        let next: number | null = null;
        if (e.key === 'ArrowLeft') next = this.currentWidthPx + PRES_RESIZE_STEP_PX;   // widen
        else if (e.key === 'ArrowRight') next = this.currentWidthPx - PRES_RESIZE_STEP_PX; // narrow
        else if (e.key === 'Home') next = PRES_RAIL_MAX_PX;
        else if (e.key === 'End') next = PRES_RAIL_MIN_PX;
        if (next == null) return;
        e.preventDefault();
        const modalWidth = this.deps.contentEl.clientWidth || next;
        this.currentWidthPx = clampRailWidth(next, modalWidth);
        this.applyWidth(this.currentWidthPx);
        this.schedulePersist({ railWidthPx: this.currentWidthPx });
    }

    // ── Persistence (raw value persisted; clamp on read — Gemini-G5) ──────────────

    private schedulePersist(patch: Partial<PresLayoutState>): void {
        const merged: PresLayoutState = { ...this.deps.getLayout(), ...patch };
        this.pendingPersistState = merged;
        this.pendingPersist = true;
        if (this.persistTimer) clearTimeout(this.persistTimer);
        this.persistTimer = setTimeout(() => {
            this.persistTimer = null;
            this.flushPersist();
        }, PERSIST_DEBOUNCE_MS);
    }

    private pendingPersistState: PresLayoutState | null = null;

    private flushPersist(): void {
        if (!this.pendingPersist || !this.pendingPersistState) return;
        const next = this.pendingPersistState;
        this.pendingPersist = false;
        this.pendingPersistState = null;
        // Coalesce: chain after any in-flight write so they never overlap, and
        // never float the promise (audit M3).
        this.inFlight = this.inFlight
            .catch(() => undefined)
            .then(() => this.deps.persistLayout(next))
            .catch((err) => logger.error('Presentation', `layout persist failed: ${String(err)}`));
    }
}
