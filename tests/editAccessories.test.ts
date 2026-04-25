/**
 * @vitest-environment happy-dom
 *
 * EditAccessories component tests.
 * Plan: docs/plans/slide-authoring-editing.md §"Edit accessories"
 *
 * Polyfills the small subset of Obsidian's HTMLElement augmentations the
 * component uses (`empty`, `addClass`, `createDiv`, `createEl`, `createSpan`).
 * Prefer this over refactoring the component to plain DOM — every other
 * piece of the chat UI uses these helpers and we don't want to fork
 * conventions for one component.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

beforeAll(() => {
    type ElOpts = {
        cls?: string;
        text?: string;
        attr?: Record<string, string>;
        type?: string;
    };
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const proto = HTMLElement.prototype as any;
    if (!proto.empty) proto.empty = function () { while (this.firstChild) this.firstChild.remove(); };
    if (!proto.addClass) proto.addClass = function (c: string) { this.classList.add(c); };
    if (!proto.createEl) proto.createEl = function (tag: string, opts: ElOpts = {}) {
        const el = document.createElement(tag);
        if (opts.cls) el.className = opts.cls;
        if (opts.text !== undefined) el.textContent = opts.text;
        if (opts.attr) for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, v);
        if (opts.type) (el as HTMLInputElement).type = opts.type;
        this.appendChild(el);
        return el;
    };
    if (!proto.createDiv) proto.createDiv = function (opts: ElOpts = {}) {
        return (this as HTMLElement & { createEl: (t: string, o: ElOpts) => HTMLElement }).createEl('div', opts);
    };
    if (!proto.createSpan) proto.createSpan = function (opts: ElOpts = {}) {
        return (this as HTMLElement & { createEl: (t: string, o: ElOpts) => HTMLElement }).createEl('span', opts);
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */
});

import { renderEditAccessories } from '../src/ui/chat/presentation/EditAccessories';
import type { SelectionScope, EditMode } from '../src/services/chat/presentationTypes';

const SLIDE_SCOPE: SelectionScope = { kind: 'slide', slideIndex: 2 };
const ELEMENT_SCOPE: SelectionScope = {
    kind: 'element', slideIndex: 1,
    elementPath: 'slide-1.list-0.item-2', elementKind: 'list-item',
};
const RANGE_SCOPE: SelectionScope = { kind: 'range', slideIndex: 0, slideEndIndex: 2 };

const T_STUB = {
    slideSelectionLabelSlide: 'Slide {n}',
    slideSelectionLabelRange: 'Slides {n}–{end}',
    slideSelectionLabelElement: 'Slide {n} → {kind}',
    slideSelectionClearAria: 'Clear selection: {label}',
    slideSelectionClearTitle: 'Clear selection',
    slideEditModeLabel: 'Edit mode:',
    slideEditModeContent: 'Content',
    slideEditModeDesign: 'Design',
    slideEditFlagWebSearch: 'Web search',
};

function makeOpts(overrides: Partial<Parameters<typeof renderEditAccessories>[1]> = {}) {
    return {
        selection: null,
        editMode: 'content' as EditMode,
        editFlags: { webSearch: false, references: [] },
        operation: 'idle' as const,
        t: T_STUB,
        onClearSelection: vi.fn(),
        onSetMode: vi.fn(),
        onSetWebSearch: vi.fn(),
        ...overrides,
    };
}

describe('renderEditAccessories — empty selection', () => {
    let host: HTMLDivElement;
    beforeEach(() => { host = document.createElement('div'); });

    it('renders nothing visible when no selection set', () => {
        renderEditAccessories(host, makeOpts());
        // Mode pills should NOT show when no selection — Polish whole-deck
        // is mode-agnostic per the plan.
        expect(host.querySelector('.ai-organiser-pres-selection-pill')).toBeNull();
        expect(host.querySelector('.ai-organiser-pres-edit-mode-row')).toBeNull();
        expect(host.querySelector('.ai-organiser-pres-edit-flags')).toBeNull();
    });

    it('renders an empty live region when no selection (a11y persona walkthrough fix)', () => {
        renderEditAccessories(host, makeOpts());
        const live = host.querySelector('[role="status"][aria-live="polite"]');
        expect(live).not.toBeNull();
        expect(live?.textContent).toBe('');
    });
});

describe('renderEditAccessories — live region (a11y)', () => {
    it('updates the live region with the scope label when selection is set', () => {
        const host = document.createElement('div');
        renderEditAccessories(host, makeOpts({ selection: SLIDE_SCOPE }));
        const live = host.querySelector('[role="status"][aria-live="polite"]');
        expect(live).not.toBeNull();
        expect(live?.textContent).toBe('Selected: Slide 3');
    });

    it('rewrites the live region across re-renders so AT hears the change', () => {
        const host = document.createElement('div');
        renderEditAccessories(host, makeOpts({ selection: SLIDE_SCOPE }));
        renderEditAccessories(host, makeOpts({ selection: ELEMENT_SCOPE }));
        const live = host.querySelector('[role="status"][aria-live="polite"]');
        expect(live?.textContent).toBe('Selected: Slide 2 → list-item');
    });
});

describe('renderEditAccessories — with selection', () => {
    let host: HTMLDivElement;
    beforeEach(() => { host = document.createElement('div'); });

    it('renders selection pill with 1-based slide label for slide scope', () => {
        renderEditAccessories(host, makeOpts({ selection: SLIDE_SCOPE }));
        const label = host.querySelector('.ai-organiser-pres-selection-label');
        expect(label?.textContent).toBe('Slide 3');
    });

    it('renders element pill with kind for element scope', () => {
        renderEditAccessories(host, makeOpts({ selection: ELEMENT_SCOPE }));
        const label = host.querySelector('.ai-organiser-pres-selection-label');
        expect(label?.textContent).toBe('Slide 2 → list-item');
    });

    it('renders range label for range scope', () => {
        renderEditAccessories(host, makeOpts({ selection: RANGE_SCOPE }));
        const label = host.querySelector('.ai-organiser-pres-selection-label');
        expect(label?.textContent).toBe('Slides 1–3');
    });

    it('clicking the pill calls onClearSelection', () => {
        const onClearSelection = vi.fn();
        renderEditAccessories(host, makeOpts({ selection: SLIDE_SCOPE, onClearSelection }));
        // After R1 MEDIUM-2 fix: the pill itself is a focusable button
        // (not just the inner ×). Clicking anywhere on the pill clears.
        const pill = host.querySelector<HTMLButtonElement>('.ai-organiser-pres-selection-pill');
        pill?.click();
        expect(onClearSelection).toHaveBeenCalledTimes(1);
    });

    it('Escape key on the focused pill clears selection (MEDIUM-2 fix)', () => {
        const onClearSelection = vi.fn();
        renderEditAccessories(host, makeOpts({ selection: SLIDE_SCOPE, onClearSelection }));
        const pill = host.querySelector<HTMLButtonElement>('.ai-organiser-pres-selection-pill');
        if (!pill) throw new Error('expected pill');
        pill.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(onClearSelection).toHaveBeenCalledTimes(1);
    });

    it('renders both mode pills with Content active by default', () => {
        renderEditAccessories(host, makeOpts({ selection: SLIDE_SCOPE }));
        const pills = host.querySelectorAll('.ai-organiser-pres-edit-mode-pill');
        expect(pills).toHaveLength(2);
        expect(pills[0].textContent).toBe('Content');
        expect(pills[0].classList.contains('is-active')).toBe(true);
        expect(pills[1].textContent).toBe('Design');
        expect(pills[1].classList.contains('is-active')).toBe(false);
    });

    it('mode pill click calls onSetMode', () => {
        const onSetMode = vi.fn();
        renderEditAccessories(host, makeOpts({ selection: SLIDE_SCOPE, onSetMode }));
        const designPill = host.querySelectorAll<HTMLButtonElement>('.ai-organiser-pres-edit-mode-pill')[1];
        designPill.click();
        expect(onSetMode).toHaveBeenCalledWith('design');
    });

    it('shows web search flag in Content mode only', () => {
        renderEditAccessories(host, makeOpts({ selection: SLIDE_SCOPE, editMode: 'content' }));
        expect(host.querySelector('.ai-organiser-pres-edit-flags')).not.toBeNull();

        host.innerHTML = '';
        renderEditAccessories(host, makeOpts({ selection: SLIDE_SCOPE, editMode: 'design' }));
        expect(host.querySelector('.ai-organiser-pres-edit-flags')).toBeNull();
    });

    it('web search checkbox calls onSetWebSearch', () => {
        const onSetWebSearch = vi.fn();
        renderEditAccessories(host, makeOpts({ selection: SLIDE_SCOPE, onSetWebSearch }));
        const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]');
        if (!checkbox) throw new Error('expected checkbox');
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change'));
        expect(onSetWebSearch).toHaveBeenCalledWith(true);
    });

    it('disables interactive controls during applying state', () => {
        renderEditAccessories(host, makeOpts({ selection: SLIDE_SCOPE, operation: 'applying' }));
        const pill = host.querySelector<HTMLButtonElement>('.ai-organiser-pres-selection-pill');
        const modePills = host.querySelectorAll<HTMLButtonElement>('.ai-organiser-pres-edit-mode-pill');
        const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]');
        expect(pill?.disabled).toBe(true);
        expect(modePills[0].disabled).toBe(true);
        expect(checkbox?.disabled).toBe(true);
    });

    it('mode pills have ARIA radio role and arrow-key navigation', () => {
        const onSetMode = vi.fn();
        renderEditAccessories(host, makeOpts({ selection: SLIDE_SCOPE, onSetMode }));
        const row = host.querySelector('.ai-organiser-pres-edit-mode-row');
        expect(row?.getAttribute('role')).toBe('radiogroup');
        const pills = host.querySelectorAll<HTMLButtonElement>('.ai-organiser-pres-edit-mode-pill');
        expect(pills[0].getAttribute('role')).toBe('radio');
        expect(pills[0].getAttribute('aria-checked')).toBe('true');
        expect(pills[1].getAttribute('aria-checked')).toBe('false');

        // ArrowRight on Content pill → switch to Design
        const event = new KeyboardEvent('keydown', { key: 'ArrowRight' });
        pills[0].dispatchEvent(event);
        expect(onSetMode).toHaveBeenCalledWith('design');
    });
});

describe('renderEditAccessories — idempotent re-render', () => {
    it('clears prior content on re-render with new selection', () => {
        const host = document.createElement('div');
        renderEditAccessories(host, makeOpts({ selection: SLIDE_SCOPE }));
        const firstPills = host.querySelectorAll('.ai-organiser-pres-edit-mode-pill').length;
        renderEditAccessories(host, makeOpts({ selection: ELEMENT_SCOPE }));
        const secondPills = host.querySelectorAll('.ai-organiser-pres-edit-mode-pill').length;
        // Same number of mode pills, not doubled — empty() ran first.
        expect(firstPills).toBe(secondPills);
    });
});
