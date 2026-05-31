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

import { App, Modal, prepareFuzzySearch, setIcon, TFile, type SearchResult } from 'obsidian';
import { listen } from '../utils/domUtils';
import type { DocumentItem } from '../controllers/DocumentHandlingController';
import type { Translations } from '../../i18n/types';
import { SectionRegistryController } from '../../services/minutes/sectionRegistryController';
import { renderSectionAssignmentSelect } from '../components/SectionAssignmentSelect';
import { renderScopedFilePickerHeader } from '../components/ScopedFilePickerHeader';
import { getScopedFiles, pickDefaultScope, type VaultFileScope } from '../utils/vaultFileScope';

export interface DocumentMultiPickerOptions {
    items: DocumentItem[];
    /** Pre-selected items — typically empty for the "Pick which…" flow. */
    initialSelection?: ReadonlySet<string>;
    t: Translations;
    /**
     * Optional — when provided, every row shows a SectionAssignmentSelect
     * with topic-creation entry (D2/D3/D11). When absent, behaves as today.
     */
    sectionRegistry?: SectionRegistryController;
    /**
     * Optional — when provided alongside `app`, renders ScopedFilePickerHeader
     * defaulting to "Files in this note" (D9). When absent, picker shows
     * the full `items` list.
     */
    sourceFile?: TFile;
    app?: App;
    /**
     * When true, the picker behaves as single-select: rows render as radio
     * inputs, the "Select all" button is hidden, and picking one row clears
     * the others. Used by agenda / style-reference flows that previously
     * routed through the flat DocumentPickerModal but still want the scoped
     * header. Default: false (multi-select).
     */
    singleSelect?: boolean;
    /** Optional title override (defaults to docMultiPickerTitle). */
    title?: string;
    /** Optional description override. */
    description?: string;
    /** Optional confirm-button label override. */
    confirmLabel?: string;
    onConfirm: (selected: Array<{ item: DocumentItem; sectionId: string }>) => void;
}

export class DocumentMultiPickerModal extends Modal {
    private readonly options: DocumentMultiPickerOptions;
    private readonly selected: Set<string>;
    /** Per-row section assignments (item.id → sectionId). Default: 'general' */
    private readonly rowSection = new Map<string, string>();
    /** Current scope filter for the scoped-files header (D9). */
    private currentScope: VaultFileScope = 'all-vault';
    /** Files in the active note matching role (computed once at open). */
    private inNoteFilePaths = new Set<string>();
    private inNoteCount = 0;
    private vaultCount = 0;
    private searchQuery = '';
    private listContainerEl: HTMLElement | null = null;
    private bulkToggleBtn: HTMLButtonElement | null = null;
    private cleanups: Array<() => void> = [];
    private confirmed = false;

    constructor(app: App, options: DocumentMultiPickerOptions) {
        super(app);
        this.options = options;
        this.selected = new Set(options.initialSelection ?? []);
        for (const item of options.items) {
            this.rowSection.set(item.id, SectionRegistryController.GENERAL_ID);
        }
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('ai-organiser-doc-multi-picker');
        const tMin = this.options.t.minutes;

        // Header
        const header = contentEl.createEl('h2', {
            text: this.options.title || tMin.docMultiPickerTitle || 'Pick documents to attach',
        });
        header.addClass('ai-organiser-doc-multi-picker-title');

        // Description
        const desc = contentEl.createEl('p', {
            text: this.options.description
                || tMin.docMultiPickerDescription
                || 'Select the documents you want to attach as meeting context.',
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

        // Scoped picker header (D9) — only when sourceFile + app provided
        if (this.options.sourceFile && this.options.app) {
            // H9 fix: getScopedFiles falls back to all-vault when the active
            // note has zero matching files. We MUST capture only files
            // actually referenced by the source note — request scope and
            // verify the result is 'active-note', else use an empty set.
            const scoped = getScopedFiles(
                this.options.app,
                this.options.sourceFile,
                'active-note',
                () => true,
            );
            this.inNoteFilePaths = scoped.scope === 'active-note'
                ? new Set(scoped.files.map((f) => f.path))
                : new Set();
            this.inNoteCount = this.options.items.filter((it) =>
                it.path ? this.inNoteFilePaths.has(it.path) : false,
            ).length;
            this.vaultCount = this.options.items.length;
            this.currentScope = pickDefaultScope(this.inNoteCount);
            const headerEl = contentEl.createDiv();
            renderScopedFilePickerHeader({
                container: headerEl,
                initialScope: this.currentScope,
                activeNoteCount: this.inNoteCount,
                vaultCount: this.vaultCount,
                inNoteLabel: 'Files in this note',
                allVaultLabel: 'All vault files',
                onScopeChange: (scope) => {
                    this.currentScope = scope;
                    this.renderList();
                },
                cleanups: this.cleanups,
            });
        }

        // Select-all / deselect-all toggle (toggles based on currently-visible
        // filtered+scoped subset). Hidden in single-select mode since picking
        // multiple is not allowed.
        if (!this.options.singleSelect) {
            const bulkRow = contentEl.createDiv({ cls: 'ai-organiser-doc-multi-picker-bulk' });
            this.bulkToggleBtn = bulkRow.createEl('button', {
                cls: 'ai-organiser-doc-multi-picker-bulk-btn',
                text: 'Select all',
                attr: { 'data-testid': 'doc-multi-picker-bulk-toggle' },
            });
            this.cleanups.push(listen(this.bulkToggleBtn, 'click', () => this.toggleBulkSelection()));
        }

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
            text: this.options.confirmLabel
                || tMin.docMultiPickerConfirmButton
                || 'Attach selected',
            cls: 'ai-organiser-doc-multi-picker-confirm mod-cta',
            attr: { 'data-testid': 'doc-multi-picker-confirm' },
        });
        this.cleanups.push(
            listen(confirmBtn, 'click', () => {
                this.confirmed = true;
                const selectedPayload = this.options.items
                    .filter((it) => this.selected.has(it.id))
                    .map((it) => ({
                        item: it,
                        sectionId: this.rowSection.get(it.id) ?? SectionRegistryController.GENERAL_ID,
                    }));
                this.options.onConfirm(selectedPayload);
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

    /** Render the checkbox list, applying scope + search filters. */
    private renderList(): void {
        if (!this.listContainerEl) return;
        const container = this.listContainerEl;
        container.empty();

        // Apply scope filter first (D9), then search.
        const scopeFiltered = this.applyScopeFilter(this.options.items);
        const filtered = this.applyFilter(scopeFiltered, this.searchQuery);
        this.refreshBulkToggleLabel(filtered);
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

            const inputType = this.options.singleSelect ? 'radio' : 'checkbox';
            const checkbox = row.createEl('input', {
                cls: 'ai-organiser-doc-multi-picker-checkbox',
                attr: {
                    type: inputType,
                    id: `doc-pick-${this.slugifyId(item.id)}`,
                    ...(this.options.singleSelect ? { name: 'doc-multi-picker-single' } : {}),
                },
            });
            checkbox.checked = this.selected.has(item.id);
            this.cleanups.push(
                listen(checkbox, 'change', () => {
                    if (this.options.singleSelect) {
                        // Radio behavior: clear all others, set this one.
                        if (checkbox.checked) {
                            this.selected.clear();
                            this.selected.add(item.id);
                        }
                    } else {
                        if (checkbox.checked) this.selected.add(item.id);
                        else this.selected.delete(item.id);
                    }
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

            // D3 — per-row section assignment when registry provided
            if (this.options.sectionRegistry) {
                const selectHost = row.createDiv({ cls: 'ai-organiser-doc-multi-picker-section-select-host' });
                renderSectionAssignmentSelect({
                    host: selectHost,
                    sectionRegistry: this.options.sectionRegistry,
                    currentSectionId: this.rowSection.get(item.id) ?? SectionRegistryController.GENERAL_ID,
                    ariaLabel: `Section assignment for ${item.name}`,
                    labels: {
                        generalOption: 'General',
                        newTopicOption: '+ New topic…',
                        topicNamePrompt: 'Topic name',
                        topicNameTooLong: `Topic name must be ${SectionRegistryController.MAX_NAME_LENGTH} characters or fewer`,
                        topicCreated: 'Created topic',
                        topicPrefix: 'Topic: ',
                    },
                    onChange: (sectionId) => {
                        this.rowSection.set(item.id, sectionId);
                    },
                    onTopicCreated: () => {
                        // Re-render so other rows pick up the new topic
                        this.renderList();
                    },
                    cleanups: this.cleanups,
                });
            }
        }
    }

    /** D9 — filter by current scope. When no sourceFile, all items pass. */
    private applyScopeFilter(items: DocumentItem[]): DocumentItem[] {
        if (!this.options.sourceFile || this.currentScope === 'all-vault') return items;
        return items.filter((it) => (it.path ? this.inNoteFilePaths.has(it.path) : false));
    }

    /**
     * Toggle selection across all CURRENTLY VISIBLE rows (scope + search
     * filtered). If every visible row is selected, deselects them; otherwise
     * selects every visible row. Re-renders so checkboxes reflect the new
     * state and the bulk-toggle label flips between "Select all" /
     * "Deselect all".
     */
    private toggleBulkSelection(): void {
        const scopeFiltered = this.applyScopeFilter(this.options.items);
        const visible = this.applyFilter(scopeFiltered, this.searchQuery);
        if (visible.length === 0) return;
        const allSelected = visible.every((it) => this.selected.has(it.id));
        if (allSelected) {
            for (const it of visible) this.selected.delete(it.id);
        } else {
            for (const it of visible) this.selected.add(it.id);
        }
        this.renderList();
    }

    /** Flip the bulk-toggle button label based on the visible-row selection state. */
    private refreshBulkToggleLabel(visible: DocumentItem[]): void {
        if (!this.bulkToggleBtn) return;
        const allSelected = visible.length > 0 && visible.every((it) => this.selected.has(it.id));
        this.bulkToggleBtn.textContent = allSelected ? 'Deselect all' : 'Select all';
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
