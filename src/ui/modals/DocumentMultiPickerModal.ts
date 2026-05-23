/**
 * DocumentMultiPickerModal (plan F4, Gemini-r2 G5).
 *
 * Multi-select picker for choosing a subset of detected documents to attach
 * as Minutes context. Extends Obsidian's base `Modal` (NOT `FuzzySuggestModal`)
 * because the latter auto-closes on click — fundamentally incompatible with
 * a multi-select checkbox flow. Built from a plain Modal + search input +
 * checkbox list, using Obsidian's `prepareFuzzySearch` for filtering.
 *
 * Contract:
 *  - Constructor takes the available items + onConfirm callback.
 *  - User toggles checkboxes; clicks Confirm → onConfirm(selectedItems).
 *  - Cancel / Escape closes without calling onConfirm.
 */

import { App, Modal, prepareFuzzySearch, setIcon, type SearchResult } from 'obsidian';
import { listen } from '../utils/domUtils';
import type { DocumentItem } from '../controllers/DocumentHandlingController';
import type { Translations } from '../../i18n/types';

export interface DocumentMultiPickerOptions {
    items: DocumentItem[];
    /** Pre-selected items — typically empty for the "Pick which…" flow. */
    initialSelection?: ReadonlySet<string>;
    t: Translations;
    onConfirm: (selected: DocumentItem[]) => void;
}

export class DocumentMultiPickerModal extends Modal {
    private readonly options: DocumentMultiPickerOptions;
    private readonly selected: Set<string>;
    private searchQuery = '';
    private listContainerEl: HTMLElement | null = null;
    private cleanups: Array<() => void> = [];
    private confirmed = false;

    constructor(app: App, options: DocumentMultiPickerOptions) {
        super(app);
        this.options = options;
        this.selected = new Set(options.initialSelection ?? []);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('ai-organiser-doc-multi-picker');
        const tMin = this.options.t.minutes;

        // Header
        const header = contentEl.createEl('h2', {
            text: tMin.docMultiPickerTitle || 'Pick documents to attach',
        });
        header.addClass('ai-organiser-doc-multi-picker-title');

        // Description
        const desc = contentEl.createEl('p', {
            text: tMin.docMultiPickerDescription || 'Select the documents you want to attach as meeting context.',
            cls: 'ai-organiser-doc-multi-picker-desc',
        });
        desc.addClass('ai-organiser-text-muted');

        // Search input
        const searchInput = contentEl.createEl('input', {
            cls: 'ai-organiser-doc-multi-picker-search',
            attr: {
                type: 'text',
                placeholder: tMin.docMultiPickerSearchPlaceholder || 'Filter documents…',
                'data-testid': 'doc-multi-picker-search',
            },
        });
        this.cleanups.push(
            listen(searchInput, 'input', () => {
                this.searchQuery = searchInput.value;
                this.renderList();
            })
        );

        // List container
        this.listContainerEl = contentEl.createDiv({
            cls: 'ai-organiser-doc-multi-picker-list',
            attr: { 'data-testid': 'doc-multi-picker-list' },
        });
        this.renderList();

        // Actions
        const actions = contentEl.createDiv({ cls: 'ai-organiser-doc-multi-picker-actions' });
        const cancelBtn = actions.createEl('button', {
            text: this.options.t.modals?.cancelButton || 'Cancel',
            cls: 'ai-organiser-doc-multi-picker-cancel',
        });
        this.cleanups.push(listen(cancelBtn, 'click', () => this.close()));

        const confirmBtn = actions.createEl('button', {
            text: tMin.docMultiPickerConfirmButton || 'Attach selected',
            cls: 'ai-organiser-doc-multi-picker-confirm mod-cta',
            attr: { 'data-testid': 'doc-multi-picker-confirm' },
        });
        this.cleanups.push(
            listen(confirmBtn, 'click', () => {
                this.confirmed = true;
                const selectedItems = this.options.items.filter((it) => this.selected.has(it.id));
                this.options.onConfirm(selectedItems);
                this.close();
            })
        );
    }

    onClose(): void {
        for (const cleanup of this.cleanups) cleanup();
        this.cleanups = [];
        this.listContainerEl = null;
        this.contentEl.empty();
        // If the user closed without clicking Confirm (Escape, X), do nothing —
        // the parent gets no callback and assumes "no change".
        if (!this.confirmed) {
            // Reset so a future reopen with the same options starts fresh.
            this.selected.clear();
        }
    }

    /** Render the checkbox list, applying the current search filter. */
    private renderList(): void {
        if (!this.listContainerEl) return;
        const container = this.listContainerEl;
        container.empty();

        const filtered = this.applyFilter(this.options.items, this.searchQuery);
        if (filtered.length === 0) {
            const empty = container.createDiv({
                cls: 'ai-organiser-doc-multi-picker-empty',
                text: this.options.t.minutes.docMultiPickerEmpty || 'No documents match your search.',
            });
            empty.addClass('ai-organiser-text-muted');
            return;
        }

        for (const item of filtered) {
            const row = container.createDiv({
                cls: 'ai-organiser-doc-multi-picker-row',
                attr: { 'data-testid': 'doc-multi-picker-row', 'data-doc-id': item.id },
            });

            const checkbox = row.createEl('input', {
                cls: 'ai-organiser-doc-multi-picker-checkbox',
                attr: { type: 'checkbox', id: `doc-pick-${this.slugifyId(item.id)}` },
            });
            checkbox.checked = this.selected.has(item.id);
            this.cleanups.push(
                listen(checkbox, 'change', () => {
                    if (checkbox.checked) this.selected.add(item.id);
                    else this.selected.delete(item.id);
                })
            );

            const label = row.createEl('label', {
                cls: 'ai-organiser-doc-multi-picker-label',
                attr: { for: `doc-pick-${this.slugifyId(item.id)}` },
            });
            const iconEl = label.createSpan({ cls: 'ai-organiser-doc-multi-picker-icon' });
            setIcon(iconEl, 'file-text');
            label.createSpan({ cls: 'ai-organiser-doc-multi-picker-name', text: item.name });
            if (item.path) {
                label.createSpan({
                    cls: 'ai-organiser-doc-multi-picker-path',
                    text: ` — ${item.path}`,
                });
            }
        }
    }

    /**
     * Filter items by query. Uses Obsidian's prepareFuzzySearch so users get
     * the same matching behaviour they see in the command picker.
     */
    private applyFilter(items: DocumentItem[], query: string): DocumentItem[] {
        const trimmed = query.trim();
        if (!trimmed) return items;
        const matcher = prepareFuzzySearch(trimmed);
        // Score by name + path; keep anything that matches one OR the other.
        const scored: Array<{ item: DocumentItem; score: number }> = [];
        for (const item of items) {
            const nameMatch: SearchResult | null = matcher(item.name);
            const pathMatch: SearchResult | null = item.path ? matcher(item.path) : null;
            const score = Math.max(nameMatch?.score ?? -Infinity, pathMatch?.score ?? -Infinity);
            if (score > -Infinity) scored.push({ item, score });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.map((s) => s.item);
    }

    private slugifyId(id: string): string {
        return id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    }
}
