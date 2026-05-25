// @vitest-environment happy-dom
/**
 * Unit tests for DocumentMultiPickerModal (plan F4, Gemini-r2 G5).
 *
 * Coverage:
 *   - Renders one row per item; each row has checkbox + label
 *   - Search input filters via prepareFuzzySearch
 *   - Checkbox toggle updates internal selection
 *   - Confirm fires onConfirm with selected items only
 *   - Cancel / Escape closes without onConfirm
 *   - Empty list shows the empty-state message
 */

vi.mock('obsidian', async () => {
    const mod = await import('./mocks/obsidian');
    return {
        ...mod,
        // FuzzySearch helper — return-match shape compatible with the real Obsidian API.
        // Our test queries deliberately use prefix matches so we can keep this simple.
        prepareFuzzySearch: (q: string) => (text: string) => {
            const idx = text.toLowerCase().indexOf(q.toLowerCase());
            return idx >= 0 ? { score: -idx, matches: [[idx, idx + q.length]] } : null;
        },
    };
});

import { App } from 'obsidian';
import { DocumentMultiPickerModal } from '../src/ui/modals/DocumentMultiPickerModal';
import type { DocumentItem } from '../src/ui/controllers/DocumentHandlingController';
import type { Translations } from '../src/i18n/types';

const t: Translations = {
    modals: { cancelButton: 'Cancel' },
    minutes: {
        docMultiPickerTitle: 'Pick documents',
        docMultiPickerDescription: 'Select…',
        docMultiPickerSearchPlaceholder: 'Filter…',
        docMultiPickerConfirmButton: 'Attach selected',
        docMultiPickerEmpty: 'No matches.',
    },
} as unknown as Translations;

function makeItem(id: string, name: string, path?: string): DocumentItem {
    return {
        id,
        name,
        path,
        isExternal: false,
        truncationChoice: 'truncate',
        charCount: 0,
        isProcessing: false,
    };
}

function polyfill(el: HTMLElement): HTMLElement {
    const e = el as unknown as Record<string, unknown>;
    e.empty = (): void => { while (el.firstChild) el.removeChild(el.firstChild); };
    e.addClass = (c: string): void => el.classList.add(c);
    e.removeClass = (c: string): void => el.classList.remove(c);
    e.toggleClass = (c: string, on?: boolean): void => {
        if (on === undefined) el.classList.toggle(c);
        else if (on) el.classList.add(c);
        else el.classList.remove(c);
    };
    e.setText = (txt: string): void => { el.textContent = txt; };
    e.createEl = (tag: string, opts?: { cls?: string; text?: string; attr?: Record<string, string> }): HTMLElement => {
        const child = document.createElement(tag);
        if (opts?.cls) child.className = opts.cls;
        if (opts?.text) child.textContent = opts.text;
        if (opts?.attr) for (const [k, v] of Object.entries(opts.attr)) child.setAttribute(k, v);
        el.appendChild(child);
        polyfill(child);
        return child;
    };
    e.createDiv = (opts?: { cls?: string; text?: string; attr?: Record<string, string> }): HTMLElement => {
        const child = document.createElement('div');
        if (opts?.cls) child.className = opts.cls;
        if (opts?.text) child.textContent = opts.text;
        if (opts?.attr) for (const [k, v] of Object.entries(opts.attr)) child.setAttribute(k, v);
        el.appendChild(child);
        polyfill(child);
        return child;
    };
    e.createSpan = (opts?: { cls?: string; text?: string; attr?: Record<string, string> }): HTMLElement => {
        const child = document.createElement('span');
        if (opts?.cls) child.className = opts.cls;
        if (opts?.text) child.textContent = opts.text;
        if (opts?.attr) for (const [k, v] of Object.entries(opts.attr)) child.setAttribute(k, v);
        el.appendChild(child);
        polyfill(child);
        return child;
    };
    return el;
}

function makeModal(
    items: DocumentItem[],
    onConfirm: (sel: Array<{ item: DocumentItem; sectionId: string }>) => void,
): DocumentMultiPickerModal {
    // Construct the modal but bypass the real `super(app)` constructor by
    // injecting a polyfilled contentEl directly. The mock Modal in tests/mocks/
    // gives us a no-op base class that we can extend.
    const app = {} as unknown as App;
    const modal = new DocumentMultiPickerModal(app, { items, t, onConfirm });
    // Patch contentEl so the polyfilled DOM helpers exist when onOpen runs.
    (modal as unknown as { contentEl: HTMLElement }).contentEl = polyfill(document.createElement('div'));
    return modal;
}

function rowsIn(modal: DocumentMultiPickerModal): HTMLElement[] {
    const c = (modal as unknown as { contentEl: HTMLElement }).contentEl;
    return Array.from(c.querySelectorAll('[data-testid="doc-multi-picker-row"]')) as HTMLElement[];
}

function getButton(modal: DocumentMultiPickerModal, text: string): HTMLButtonElement | null {
    const c = (modal as unknown as { contentEl: HTMLElement }).contentEl;
    return Array.from(c.querySelectorAll('button')).find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined ?? null;
}

describe('DocumentMultiPickerModal', () => {
    it('renders one row per item with a checkbox and label', () => {
        const modal = makeModal(
            [makeItem('a', 'Alpha.pdf'), makeItem('b', 'Beta.docx')],
            vi.fn()
        );
        modal.onOpen();
        const rows = rowsIn(modal);
        expect(rows.length).toBe(2);
        for (const row of rows) {
            expect(row.querySelector('input[type="checkbox"]')).not.toBeNull();
            expect(row.querySelector('label')).not.toBeNull();
        }
    });

    it('filters the list when the user types in the search box', () => {
        const modal = makeModal(
            [makeItem('a', 'Q3 budget.pdf'), makeItem('b', 'Team standup notes.docx'), makeItem('c', 'budget rollup.xlsx')],
            vi.fn()
        );
        modal.onOpen();

        const search = (modal as unknown as { contentEl: HTMLElement }).contentEl
            .querySelector<HTMLInputElement>('[data-testid="doc-multi-picker-search"]')!;
        search.value = 'budget';
        search.dispatchEvent(new Event('input'));

        const rows = rowsIn(modal);
        expect(rows.length).toBe(2);
        const names = rows.map((r) => r.querySelector('.ai-organiser-doc-multi-picker-name')?.textContent);
        expect(names).toEqual(expect.arrayContaining(['Q3 budget.pdf', 'budget rollup.xlsx']));
    });

    it('Confirm fires onConfirm with only checked items', () => {
        const onConfirm = vi.fn();
        const items = [makeItem('a', 'Alpha'), makeItem('b', 'Beta'), makeItem('c', 'Charlie')];
        const modal = makeModal(items, onConfirm);
        modal.onOpen();

        const checkboxes = (modal as unknown as { contentEl: HTMLElement }).contentEl
            .querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
        // Check Alpha + Charlie, leave Beta unchecked.
        checkboxes[0].checked = true;
        checkboxes[0].dispatchEvent(new Event('change'));
        checkboxes[2].checked = true;
        checkboxes[2].dispatchEvent(new Event('change'));

        getButton(modal, 'Attach selected')!.click();

        expect(onConfirm).toHaveBeenCalledOnce();
        const selected = onConfirm.mock.calls[0][0] as Array<{ item: DocumentItem; sectionId: string }>;
        expect(selected.map((s) => s.item.id)).toEqual(['a', 'c']);
        // Default section is 'general' when no registry is supplied.
        expect(selected.every((s) => s.sectionId === 'general')).toBe(true);
    });

    it('Cancel does NOT fire onConfirm', () => {
        const onConfirm = vi.fn();
        const modal = makeModal([makeItem('a', 'Alpha')], onConfirm);
        modal.onOpen();

        getButton(modal, 'Cancel')!.click();
        // Cancel calls modal.close() which is a no-op in the mock; onClose
        // gets invoked by the real Obsidian framework, not here. The key
        // assertion is that the Confirm callback was NOT fired.
        expect(onConfirm).not.toHaveBeenCalled();
    });

    it('shows the empty-state message when no items match the search', () => {
        const modal = makeModal([makeItem('a', 'Alpha')], vi.fn());
        modal.onOpen();

        const search = (modal as unknown as { contentEl: HTMLElement }).contentEl
            .querySelector<HTMLInputElement>('[data-testid="doc-multi-picker-search"]')!;
        search.value = 'nonsense';
        search.dispatchEvent(new Event('input'));

        const list = (modal as unknown as { contentEl: HTMLElement }).contentEl
            .querySelector('[data-testid="doc-multi-picker-list"]')!;
        expect(list.textContent).toContain('No matches');
    });
});
