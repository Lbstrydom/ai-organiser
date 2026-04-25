/**
 * Edit Accessories — Selection pill + Mode pills + Flags row
 *
 * Renders the chat-input accessory area for the slide-authoring-editing
 * EDIT flow. Stateless; all mutations delegate to callbacks owned by
 * PresentationModeHandler. Idempotent — safe to call repeatedly to
 * re-render in place when state changes.
 *
 * Plan: docs/completed/slide-authoring-editing.md §"Edit accessories"
 */

import type { SelectionScope, EditMode, EditFlags } from '../../../services/chat/presentationTypes';
import type { Translations } from '../../../i18n/types';

/** Subset of translations the accessory consumes. Caller passes
 *  `plugin.t.modals.unifiedChat`. Templates use `{n}`/`{end}`/`{kind}` slots. */
export type EditAccessoriesT = Pick<
    Translations['modals']['unifiedChat'],
    | 'slideSelectionLabelSlide' | 'slideSelectionLabelRange' | 'slideSelectionLabelElement'
    | 'slideSelectionClearAria' | 'slideSelectionClearTitle'
    | 'slideEditModeLabel' | 'slideEditModeContent' | 'slideEditModeDesign'
    | 'slideEditFlagWebSearch'
>;

export interface EditAccessoriesOptions {
    selection: SelectionScope | null;
    editMode: EditMode;
    editFlags: EditFlags;
    /** UI gates: pills disable themselves while an apply is running. */
    operation: 'idle' | 'applying' | 'error';
    /** i18n strings — required for production. Tests pass a stub object. */
    t: EditAccessoriesT;
    onClearSelection: () => void;
    onSetMode: (mode: EditMode) => void;
    onSetWebSearch: (on: boolean) => void;
}

/** Top-level entry. Empties the container and rebuilds — caller is
 *  responsible for keeping the same container element across re-renders
 *  so focus / scroll position stay reasonable. */
export function renderEditAccessories(
    container: HTMLElement,
    opts: EditAccessoriesOptions,
): void {
    container.empty();
    container.addClass('ai-organiser-pres-edit-accessories');

    // Live region — fires when the selected scope changes, so screen-
    // reader users hear "Selected: Slide 3 → list-item" without having
    // to navigate to the pill. Plan §"Accessibility" requirement that
    // the v1 ship missed; restored after persona walkthrough.
    // The .sr-only class is a vault-wide convention used by the slide
    // preview live region too — visible to AT only.
    const liveRegion = container.createDiv({
        cls: 'sr-only',
        attr: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
    });
    if (opts.selection) {
        liveRegion.textContent = `Selected: ${describeScope(opts.selection, opts.t)}`;
    }

    if (opts.selection) {
        renderSelectionPill(container, opts);
    }
    // Mode pills hidden when no selection — Polish whole-deck is mode-agnostic.
    if (opts.selection) {
        renderModePills(container, opts);
    }
    if (opts.selection && opts.editMode === 'content') {
        renderEditFlags(container, opts);
    }
}

// ── Selection pill ──────────────────────────────────────────────────────────

function renderSelectionPill(parent: HTMLElement, opts: EditAccessoriesOptions): void {
    if (!opts.selection) return;
    // Pill itself is a focusable button so keyboard users can Tab to it
    // and press Esc to clear (Audit R1 MEDIUM-2 fix). The inner × button
    // remains for mouse users.
    const pill = parent.createEl('button', {
        cls: 'ai-organiser-pres-selection-pill',
        attr: {
            type: 'button',
            'aria-label': opts.t.slideSelectionClearAria.replace('{label}', describeScope(opts.selection, opts.t)),
        },
    });
    if (opts.operation === 'applying') pill.addClass('is-disabled');

    const label = describeScope(opts.selection, opts.t);
    pill.createSpan({ cls: 'ai-organiser-pres-selection-label', text: label });

    pill.createEl('span', {
        cls: 'ai-organiser-pres-selection-clear',
        text: '×',
        attr: { 'aria-hidden': 'true' },
    });
    if (opts.operation === 'applying') {
        pill.disabled = true;
        return;
    }
    pill.addEventListener('click', () => opts.onClearSelection());
    pill.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' || e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            opts.onClearSelection();
        }
    });
}

function describeScope(scope: SelectionScope, t: EditAccessoriesT): string {
    if (scope.kind === 'range') {
        const end = scope.slideEndIndex ?? scope.slideIndex;
        return t.slideSelectionLabelRange
            .replace('{n}', String(scope.slideIndex + 1))
            .replace('{end}', String(end + 1));
    }
    if (scope.kind === 'slide') {
        return t.slideSelectionLabelSlide.replace('{n}', String(scope.slideIndex + 1));
    }
    const kind = scope.elementKind ?? 'element';
    return t.slideSelectionLabelElement
        .replace('{n}', String(scope.slideIndex + 1))
        .replace('{kind}', kind);
}

// ── Mode pills ──────────────────────────────────────────────────────────────

function renderModePills(parent: HTMLElement, opts: EditAccessoriesOptions): void {
    const row = parent.createDiv({
        cls: 'ai-organiser-pres-edit-mode-row',
        attr: { role: 'radiogroup', 'aria-label': opts.t.slideEditModeLabel },
    });
    row.createSpan({ cls: 'ai-organiser-pres-edit-mode-label', text: opts.t.slideEditModeLabel });

    addModePill(row, opts, 'content', opts.t.slideEditModeContent);
    addModePill(row, opts, 'design', opts.t.slideEditModeDesign);
}

/** Track whether the previous render had a mode pill focused; if so, the
 *  next render should auto-focus the new active pill so arrow-key
 *  navigation actually moves keyboard focus (Audit R1 MEDIUM-1 fix). The
 *  flag is reset on every renderEditAccessories call. */
let modePillsHadFocus = false;

function addModePill(
    row: HTMLElement,
    opts: EditAccessoriesOptions,
    mode: EditMode,
    label: string,
): void {
    const isActive = opts.editMode === mode;
    const pill = row.createEl('button', {
        cls: `ai-organiser-pres-edit-mode-pill${isActive ? ' is-active' : ''}`,
        text: label,
        attr: {
            type: 'button',
            role: 'radio',
            'aria-checked': isActive ? 'true' : 'false',
            tabindex: isActive ? '0' : '-1',
        },
    });
    if (opts.operation === 'applying') {
        pill.disabled = true;
        pill.addClass('is-disabled');
        return;
    }
    pill.addEventListener('click', () => opts.onSetMode(mode));
    pill.addEventListener('keydown', (e) => handleModeKeydown(e, opts, mode));
    pill.addEventListener('focus', () => { modePillsHadFocus = true; });
    pill.addEventListener('blur', () => {
        // Defer the unset so the next-render focus check still sees `true`
        // when arrow-key navigation triggered the rebuild.
        setTimeout(() => {
            const active = document.activeElement;
            if (!active?.classList.contains('ai-organiser-pres-edit-mode-pill')) {
                modePillsHadFocus = false;
            }
        }, 0);
    });
    // Auto-focus the active pill when the previous render had focus —
    // this makes ArrowRight on Content actually move focus to Design.
    if (isActive && modePillsHadFocus) {
        // Defer to after the parent appendChild completes.
        setTimeout(() => pill.focus(), 0);
    }
}

function handleModeKeydown(e: KeyboardEvent, opts: EditAccessoriesOptions, current: EditMode): void {
    // Arrow-key navigation across the radio group; Space activates.
    if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        opts.onSetMode(current);
        return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        opts.onSetMode(current === 'content' ? 'design' : 'content');
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        opts.onSetMode(current === 'design' ? 'content' : 'design');
    }
}

// ── Edit flags (Content mode only) ──────────────────────────────────────────

function renderEditFlags(parent: HTMLElement, opts: EditAccessoriesOptions): void {
    const row = parent.createDiv({ cls: 'ai-organiser-pres-edit-flags' });

    const webLabel = row.createEl('label', { cls: 'ai-organiser-pres-edit-flag' });
    const webBox = webLabel.createEl('input', {
        attr: { type: 'checkbox', 'aria-label': opts.t.slideEditFlagWebSearch },
    });
    webBox.checked = opts.editFlags.webSearch;
    if (opts.operation === 'applying') webBox.disabled = true;
    webBox.addEventListener('change', () => opts.onSetWebSearch(webBox.checked));
    webLabel.createSpan({ text: opts.t.slideEditFlagWebSearch });

    // References UI deferred to a follow-up pass; v1 ships web-search only
    // because that's the most-asked content-grounding affordance. Adding
    // reference-note picker is a small follow-on (vault file picker modal).
}
