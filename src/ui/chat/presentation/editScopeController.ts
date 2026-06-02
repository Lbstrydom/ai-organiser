/**
 * Edit-scope controller (TD-SSR-02 Phase 6).
 *
 * Owns the scoped-editing state extracted from PresentationModeHandler:
 *   - selection (null = whole-deck edit; else the iframe-clicked / pill-clicked scope),
 *   - editMode ('content' edits text/data; 'design' edits layout),
 *   - editFlags (web search + reference notes — content mode only),
 *   - the chat-input accessory area (selection pill + mode pills + flags) and its
 *     idempotent re-render.
 *
 * Presentational/state only — no LLM, no deck, no lifecycle. It reads two things
 * it doesn't own via injected callbacks: the current operation (derived from the
 * handler's phase, drives whether pills are interactive) and the mutation lock
 * (element clicks are ignored mid-apply). It tells the handler when an element
 * click changes the active slide via onActiveSlide.
 */

import type { Translations } from '../../../i18n/types';
import type {
    SelectionScope, EditMode, EditFlags, ElementKind,
} from '../../../services/chat/presentationTypes';
import type { IframeSelectionEvent } from '../../components/SlideIframePreview';
import { renderEditAccessories } from './EditAccessories';

type Operation = 'idle' | 'applying' | 'error';
type UnifiedChatT = Translations['modals']['unifiedChat'];

export interface EditScopeDeps {
    /** Current operation derived from the handler's phase — drives pill enablement. */
    getOperation: () => Operation;
    /** Mutation lock — element clicks are ignored while an apply is in flight. */
    isLocked: () => boolean;
    /** An element/slide click sets the active slide (a canvas concern the handler owns). */
    onActiveSlide: (slideIndex: number) => void;
}

const KNOWN_ELEMENT_KINDS: ReadonlySet<string> = new Set([
    'heading', 'subheading', 'list', 'list-item',
    'image', 'figure', 'table', 'callout',
    'col-container', 'col', 'stats-grid',
    'quote', 'code', 'speaker-notes',
]);

export class EditScopeController {
    private selection: SelectionScope | null = null;
    private editMode: EditMode = 'content';
    private editFlags: EditFlags = { webSearch: false, references: [] };
    private container: HTMLElement | null = null;
    private t: UnifiedChatT | null = null;

    constructor(private readonly deps: EditScopeDeps) {}

    // ── Reads (consumed by the generation pipeline) ─────────────────────────
    getSelection(): SelectionScope | null { return this.selection; }
    getEditMode(): EditMode { return this.editMode; }
    getEditFlags(): EditFlags { return this.editFlags; }

    // ── Accessory binding (renderContextPanel) ──────────────────────────────
    /** Bind the (freshly created) accessory host + translations and render once. */
    bind(container: HTMLElement, t: UnifiedChatT): void {
        this.container = container;
        this.t = t;
        this.render();
    }

    /** Drop the container ref before the host's container.empty() so render()
     *  can't fire against detached DOM during a re-render transition window. */
    unbind(): void {
        this.container = null;
    }

    // ── Selection mutations ─────────────────────────────────────────────────
    /** Iframe element/slide click → update selection + active slide + re-render.
     *  Ignored while a mutation is in flight (matches the old in-handler guard). */
    selectFromEvent(event: IframeSelectionEvent): void {
        if (this.deps.isLocked()) return;
        if (event.kind === 'slide') {
            this.selection = { kind: 'slide', slideIndex: event.slideIndex };
        } else {
            // Coerce the runtime-derived elementKind to the typed union; unknown
            // kinds drop through as undefined so the prompt builder treats them
            // as generic elements.
            const elementKind = KNOWN_ELEMENT_KINDS.has(event.elementKind)
                ? (event.elementKind as ElementKind)
                : undefined;
            this.selection = {
                kind: 'element',
                slideIndex: event.slideIndex,
                elementPath: event.elementPath,
                elementKind,
            };
        }
        this.deps.onActiveSlide(event.slideIndex);
        this.render();
    }

    /** Set selection from outside (slide-picker command) + re-render. */
    setSelection(scope: SelectionScope | null): void {
        this.selection = scope;
        this.render();
    }

    /** Test seam — set selection without re-rendering. */
    setSelectionForTesting(scope: SelectionScope | null): void {
        this.selection = scope;
    }

    /** Clear the active selection (× pill, Esc, post-apply) + re-render. */
    clear(): void {
        this.selection = null;
        this.render();
    }

    /** Reset all scoped-editing state for a fresh deck (onClear). No render —
     *  the accessory host is rebuilt on the next renderContextPanel. */
    reset(): void {
        this.selection = null;
        this.editMode = 'content';
        this.editFlags = { webSearch: false, references: [] };
    }

    dispose(): void {
        this.container = null;
        this.t = null;
        this.selection = null;
    }

    // ── Internal ────────────────────────────────────────────────────────────
    private setEditMode(mode: EditMode): void {
        this.editMode = mode;
        this.render();
    }

    private setWebSearchFlag(on: boolean): void {
        this.editFlags = { ...this.editFlags, webSearch: on };
        this.render();
    }

    /** Idempotent re-render of the accessory area. No-op until bound. */
    render(): void {
        if (!this.container || !this.t) return;
        renderEditAccessories(this.container, {
            selection: this.selection,
            editMode: this.editMode,
            editFlags: this.editFlags,
            operation: this.deps.getOperation(),
            t: this.t,
            onClearSelection: () => this.clear(),
            onSetMode: (m) => this.setEditMode(m),
            onSetWebSearch: (on) => this.setWebSearchFlag(on),
        });
    }
}
