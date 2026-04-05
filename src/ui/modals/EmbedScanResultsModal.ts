/**
 * Embed Scan Results Modal
 * Displays scan results with search/filter, sorting, type filtering, and min-size controls.
 * 
 * UX design (Gestalt principles):
 * - Proximity: Filters grouped together at top; each target's references grouped below it
 * - Similarity: Consistent badges, icons, and spacing across all results
 * - Common Region: Collapsible sections for references and orphans
 * - Progressive Disclosure: Orphans collapsed by default; references expand on click
 * 
 * Accessibility: All interactive elements are keyboard-navigable with ARIA roles.
 */

import { App, Modal, TFile, setIcon, Notice } from 'obsidian';
import type { Translations } from '../../i18n/types';
import {
    EmbedTarget,
    EmbedScanResult,
    EmbedTargetType,
    formatFileSize,
    getEmbedTypeIcon,
    classifyExtension,
} from '../../services/embedScanService';
import { listen } from '../utils/domUtils';

// ─── Sort options ────────────────────────────────────────────────────────────

type SortField = 'size' | 'references' | 'name';
type SortDirection = 'asc' | 'desc';

interface SortOption {
    field: SortField;
    direction: SortDirection;
    label: string;
}

// ─── Filter state ────────────────────────────────────────────────────────────

interface FilterState {
    searchQuery: string;
    activeTypes: Set<EmbedTargetType>;
    sortField: SortField;
    sortDirection: SortDirection;
    minSizeBytes: number;
}

// ─── Type filter definitions ─────────────────────────────────────────────────

const ALL_EMBED_TYPES: EmbedTargetType[] = ['image', 'pdf', 'audio', 'video', 'document', 'other'];

function getTypeLabel(type: EmbedTargetType, t?: Translations): string {
    if (t) {
        switch (type) {
            case 'image': return t.embedScan.typeImage;
            case 'pdf': return t.embedScan.typePdf;
            case 'audio': return t.embedScan.typeAudio;
            case 'video': return t.embedScan.typeVideo;
            case 'document': return t.embedScan.typeDocument;
            case 'other': return t.embedScan.typeOther;
        }
    }
    // Fallback for non-i18n usage
    switch (type) {
        case 'image': return 'Images';
        case 'pdf': return 'PDFs';
        case 'audio': return 'Audio';
        case 'video': return 'Video';
        case 'document': return 'Documents';
        case 'other': return 'Other';
    }
}

// ─── Min-size presets ────────────────────────────────────────────────────────

interface SizePreset {
    label: string;
    bytes: number;
}

const SIZE_PRESETS: SizePreset[] = [
    { label: 'All sizes', bytes: 0 },
    { label: '> 100 KB', bytes: 100 * 1024 },
    { label: '> 500 KB', bytes: 500 * 1024 },
    { label: '> 1 MB', bytes: 1024 * 1024 },
    { label: '> 5 MB', bytes: 5 * 1024 * 1024 },
    { label: '> 10 MB', bytes: 10 * 1024 * 1024 },
];

// ─── Modal ───────────────────────────────────────────────────────────────────

export class EmbedScanResultsModal extends Modal {
    private readonly scanResult: EmbedScanResult;
    private readonly t: Translations;
    private summaryEl!: HTMLElement;
    private resultsContainer!: HTMLElement;
    private orphansContainer!: HTMLElement;
    private statusEl!: HTMLElement;
    private selectionToolbar!: HTMLElement;
    private expandedTargets: Set<string> = new Set();
    /** Paths of selected targets and orphans */
    private selectedPaths: Set<string> = new Set();
    private cleanups: (() => void)[] = [];

    private filters: FilterState = {
        searchQuery: '',
        activeTypes: new Set(ALL_EMBED_TYPES),
        sortField: 'size',
        sortDirection: 'desc',
        minSizeBytes: 0,
    };

    constructor(app: App, t: Translations, scanResult: EmbedScanResult) {
        super(app);
        this.scanResult = scanResult;
        this.t = t;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('ai-organiser-embed-scan-modal');

        const embedScan = this.t.embedScan;

        // ── Title ──
        contentEl.createEl('h2', {
            text: embedScan.resultsTitle,
            cls: 'ai-organiser-embed-scan-title'
        });

        // ── Scan summary ──
        this.summaryEl = contentEl.createDiv({ cls: 'ai-organiser-embed-scan-summary' });
        this.updateSummary();

        // ── Filters row ──
        this.renderFilters(contentEl);

        // ── Selection toolbar (hidden until items selected) ──
        this.selectionToolbar = contentEl.createDiv({ cls: 'ai-organiser-embed-scan-selection-toolbar hidden' });

        // ── Status line (showing filtered count) ──
        this.statusEl = contentEl.createDiv({ cls: 'ai-organiser-embed-scan-status' });

        // ── Results container ──
        this.resultsContainer = contentEl.createDiv({ cls: 'ai-organiser-embed-scan-results' });

        // ── Possibly Orphaned section (vault scope only) ──
        if (this.scanResult.possiblyOrphaned.length > 0) {
            this.orphansContainer = contentEl.createDiv({ cls: 'ai-organiser-embed-scan-orphans' });
        }

        // ── Close button ──
        const buttonRow = contentEl.createDiv({ cls: 'ai-organiser-embed-scan-buttons' });
        const closeBtn = buttonRow.createEl('button', {
            text: embedScan.closeButton,
            cls: 'mod-cta'
        });
        this.cleanups.push(listen(closeBtn, 'click', () => this.close()));

        // Initial render
        this.applyFiltersAndRender();
    }

    // ─── Filter controls ─────────────────────────────────────────────────────

    private renderFilters(container: HTMLElement): void {
        const embedScan = this.t.embedScan;
        const filtersRow = container.createDiv({ cls: 'ai-organiser-embed-scan-filters' });

        // Search input
        const searchWrapper = filtersRow.createDiv({ cls: 'ai-organiser-embed-scan-search' });
        const searchIcon = searchWrapper.createSpan({ cls: 'ai-organiser-embed-scan-search-icon' });
        setIcon(searchIcon, 'search');
        const searchInput = searchWrapper.createEl('input', {
            type: 'text',
            placeholder: embedScan.searchPlaceholder,
            cls: 'ai-organiser-embed-scan-search-input',
        });
        searchInput.setAttribute('aria-label', embedScan.searchPlaceholder);
        this.cleanups.push(listen(searchInput, 'input', () => {
            this.filters.searchQuery = searchInput.value.toLowerCase();
            this.applyFiltersAndRender();
        }));

        // Controls row: type filters + sort + min-size
        const controlsRow = container.createDiv({ cls: 'ai-organiser-embed-scan-controls' });

        // Type filter chips
        const typeChips = controlsRow.createDiv({ cls: 'ai-organiser-embed-scan-type-chips' });
        for (const type of ALL_EMBED_TYPES) {
            const count = this.scanResult.targets.filter(t => t.type === type).length;
            if (count === 0) continue; // Don't show empty types

            const chip = typeChips.createEl('button', {
                cls: `ai-organiser-embed-scan-chip ${this.filters.activeTypes.has(type) ? 'active' : ''}`,
            });
            chip.setAttribute('role', 'checkbox');
            chip.setAttribute('aria-checked', this.filters.activeTypes.has(type) ? 'true' : 'false');
            chip.setAttribute('aria-label', `${getTypeLabel(type, this.t)} (${count})`);
            chip.setAttribute('tabindex', '0');

            const chipIcon = chip.createSpan({ cls: 'ai-organiser-embed-scan-chip-icon' });
            setIcon(chipIcon, getEmbedTypeIcon(type));
            chip.createSpan({ text: `${getTypeLabel(type, this.t)} (${count})` });

            this.cleanups.push(listen(chip, 'click', () => this.toggleTypeFilter(type, chip)));
            this.cleanups.push(listen(chip, 'keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this.toggleTypeFilter(type, chip);
                }
            }));
        }

        // Min-size dropdown
        const sizeWrapper = controlsRow.createDiv({ cls: 'ai-organiser-embed-scan-size-filter' });
        const sizeSelect = sizeWrapper.createEl('select', {
            cls: 'ai-organiser-embed-scan-size-select'
        });
        sizeSelect.setAttribute('aria-label', embedScan.minSizeLabel);
        for (const preset of SIZE_PRESETS) {
            sizeSelect.createEl('option', {
                text: preset.label,
                value: String(preset.bytes),
            });
        }
        this.cleanups.push(listen(sizeSelect, 'change', () => {
            this.filters.minSizeBytes = Number(sizeSelect.value);
            this.applyFiltersAndRender();
        }));

        // Sort dropdown
        const sortWrapper = controlsRow.createDiv({ cls: 'ai-organiser-embed-scan-sort' });
        const sortSelect = sortWrapper.createEl('select', {
            cls: 'ai-organiser-embed-scan-sort-select'
        });
        sortSelect.setAttribute('aria-label', embedScan.sortLabel);
        const sortOptions: SortOption[] = [
            { field: 'size', direction: 'desc', label: embedScan.sortSizeDesc },
            { field: 'size', direction: 'asc', label: embedScan.sortSizeAsc },
            { field: 'references', direction: 'desc', label: embedScan.sortRefsDesc },
            { field: 'references', direction: 'asc', label: embedScan.sortRefsAsc },
            { field: 'name', direction: 'asc', label: embedScan.sortNameAsc },
        ];
        for (const opt of sortOptions) {
            sortSelect.createEl('option', {
                text: opt.label,
                value: `${opt.field}-${opt.direction}`,
            });
        }
        this.cleanups.push(listen(sortSelect, 'change', () => {
            const [field, direction] = sortSelect.value.split('-') as [SortField, SortDirection];
            this.filters.sortField = field;
            this.filters.sortDirection = direction;
            this.applyFiltersAndRender();
        }));
    }

    private toggleTypeFilter(type: EmbedTargetType, chip: HTMLElement): void {
        if (this.filters.activeTypes.has(type)) {
            this.filters.activeTypes.delete(type);
            chip.removeClass('active');
            chip.setAttribute('aria-checked', 'false');
        } else {
            this.filters.activeTypes.add(type);
            chip.addClass('active');
            chip.setAttribute('aria-checked', 'true');
        }
        this.applyFiltersAndRender();
    }

    // ─── Summary ──────────────────────────────────────────────────────────

    private updateSummary(): void {
        this.summaryEl.empty();
        const embedScan = this.t.embedScan;
        this.summaryEl.createSpan({
            text: embedScan.scannedNotes
                .replace('{count}', String(this.scanResult.notesScanned)),
        });
        const totalSize = this.scanResult.targets.reduce((sum, t) => sum + t.sizeBytes, 0);
        this.summaryEl.createSpan({ text: ' · ' });
        this.summaryEl.createSpan({
            text: embedScan.totalFiles
                .replace('{count}', String(this.scanResult.targets.length)),
        });
        this.summaryEl.createSpan({ text: ' · ' });
        this.summaryEl.createSpan({
            text: embedScan.totalSize
                .replace('{size}', formatFileSize(totalSize)),
        });
    }

    // ─── Filter + Sort + Render ──────────────────────────────────────────────

    private applyFiltersAndRender(): void {
        this.updateSummary();
        const filtered = this.getFilteredTargets();
        this.updateStatus(filtered.length);
        this.renderResults(filtered);
        if (this.orphansContainer) {
            this.renderOrphans();
        }
        this.updateSelectionToolbar();
    }

    private getFilteredTargets(): EmbedTarget[] {
        let targets = this.scanResult.targets.filter(t => {
            // Type filter
            if (!this.filters.activeTypes.has(t.type)) return false;
            // Min size filter
            if (t.sizeBytes < this.filters.minSizeBytes) return false;
            // Search query
            if (this.filters.searchQuery) {
                const query = this.filters.searchQuery;
                const matchesPath = t.path.toLowerCase().includes(query);
                const matchesRefSource = t.references.some(r =>
                    r.sourceFile.basename.toLowerCase().includes(query)
                );
                if (!matchesPath && !matchesRefSource) return false;
            }
            return true;
        });

        // Sort
        targets = this.sortTargets(targets);
        return targets;
    }

    private sortTargets(targets: EmbedTarget[]): EmbedTarget[] {
        const { sortField, sortDirection } = this.filters;
        const dir = sortDirection === 'desc' ? -1 : 1;

        return [...targets].sort((a, b) => {
            switch (sortField) {
                case 'size': return (a.sizeBytes - b.sizeBytes) * dir;
                case 'references': return (a.references.length - b.references.length) * dir;
                case 'name': return a.path.localeCompare(b.path) * dir;
                default: return 0;
            }
        });
    }

    private updateStatus(filteredCount: number): void {
        this.statusEl.empty();
        const total = this.scanResult.targets.length;
        const embedScan = this.t.embedScan;

        // Select-all checkbox
        const allVisible = this.getAllSelectablePaths();
        const allSelected = allVisible.length > 0 && allVisible.every(p => this.selectedPaths.has(p));
        const someSelected = allVisible.some(p => this.selectedPaths.has(p));
        const selectAllCb = this.statusEl.createEl('input', {
            type: 'checkbox',
            cls: 'ai-organiser-embed-scan-checkbox',
        });
        selectAllCb.checked = allSelected;
        selectAllCb.indeterminate = someSelected && !allSelected;
        selectAllCb.setAttribute('aria-label', allSelected ? embedScan.deselectAll : embedScan.selectAll);
        this.cleanups.push(listen(selectAllCb, 'change', () => {
            if (selectAllCb.checked) {
                for (const p of allVisible) this.selectedPaths.add(p);
            } else {
                for (const p of allVisible) this.selectedPaths.delete(p);
            }
            this.applyFiltersAndRender();
        }));

        this.statusEl.createSpan({
            text: embedScan.showingResults
                .replace('{count}', String(filteredCount))
                .replace('{total}', String(total)),
        });
    }

    // ─── Result rendering ────────────────────────────────────────────────────

    private renderResults(targets: EmbedTarget[]): void {
        this.resultsContainer.empty();

        if (targets.length === 0) {
            const emptyEl = this.resultsContainer.createDiv({ cls: 'ai-organiser-embed-scan-empty' });
            emptyEl.createSpan({ text: this.t.embedScan.noResults });
            return;
        }

        for (const target of targets) {
            this.renderTargetRow(this.resultsContainer, target);
        }
    }

    private renderTargetRow(container: HTMLElement, target: EmbedTarget): void {
        const key = target.path;
        const isExpanded = this.expandedTargets.has(key);

        const row = container.createDiv({ cls: 'ai-organiser-embed-scan-row' });

        // Main row (clickable to expand)
        const header = row.createDiv({
            cls: `ai-organiser-embed-scan-row-header ${isExpanded ? 'expanded' : ''}`
        });
        header.setAttribute('role', 'button');
        header.setAttribute('tabindex', '0');
        header.setAttribute('aria-expanded', String(isExpanded));

        // Checkbox (only for resolved files)
        if (target.file) {
            this.createCheckbox(header, target.file.path);
        }

        // Chevron
        const chevron = header.createSpan({ cls: 'ai-organiser-embed-scan-chevron' });
        setIcon(chevron, isExpanded ? 'chevron-down' : 'chevron-right');

        // Type icon
        const iconEl = header.createSpan({ cls: 'ai-organiser-embed-scan-type-icon' });
        setIcon(iconEl, getEmbedTypeIcon(target.type));

        // File name
        const fileName = target.file?.name ?? target.path.split('/').pop() ?? target.path;
        header.createSpan({ cls: 'ai-organiser-embed-scan-filename', text: fileName });

        // Badges container
        const badges = header.createDiv({ cls: 'ai-organiser-embed-scan-badges' });

        // Size badge
        if (target.sizeBytes > 0) {
            const sizeBadge = badges.createSpan({ cls: 'ai-organiser-embed-scan-badge size' });
            sizeBadge.textContent = formatFileSize(target.sizeBytes);
        }

        // Reference count badge
        const refBadge = badges.createSpan({ cls: 'ai-organiser-embed-scan-badge refs' });
        const embedScan = this.t.embedScan;
        const refCount = target.references.length;
        refBadge.textContent = `${refCount} ${refCount === 1 ? embedScan.reference : embedScan.references}`;

        // Type badge
        const typeBadge = badges.createSpan({ cls: `ai-organiser-embed-scan-badge type-${target.type}` });
        typeBadge.textContent = getTypeLabel(target.type, this.t);

        // Path subtitle
        if (target.file) {
            const pathEl = header.createDiv({ cls: 'ai-organiser-embed-scan-path' });
            pathEl.textContent = target.file.path;
        }

        // Click / keyboard expand
        const toggleExpand = () => {
            if (this.expandedTargets.has(key)) {
                this.expandedTargets.delete(key);
            } else {
                this.expandedTargets.add(key);
            }
            this.applyFiltersAndRender();
        };
        this.cleanups.push(listen(header, 'click', toggleExpand));
        this.cleanups.push(listen(header, 'keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggleExpand();
            }
        }));

        // Expanded: show references
        if (isExpanded) {
            const refsContainer = row.createDiv({ cls: 'ai-organiser-embed-scan-refs' });
            const refsTitle = refsContainer.createDiv({ cls: 'ai-organiser-embed-scan-refs-title' });
            refsTitle.textContent = embedScan.referencedBy;

            // Group references by source file
            const bySource = new Map<string, { file: TFile; lines: number[]; texts: string[] }>();
            for (const ref of target.references) {
                const existing = bySource.get(ref.sourceFile.path);
                if (existing) {
                    existing.lines.push(ref.lineNumber);
                    existing.texts.push(ref.originalText);
                } else {
                    bySource.set(ref.sourceFile.path, {
                        file: ref.sourceFile,
                        lines: [ref.lineNumber],
                        texts: [ref.originalText]
                    });
                }
            }

            for (const [, data] of bySource) {
                const refRow = refsContainer.createDiv({ cls: 'ai-organiser-embed-scan-ref-row' });
                refRow.setAttribute('role', 'link');
                refRow.setAttribute('tabindex', '0');

                const refIcon = refRow.createSpan({ cls: 'ai-organiser-embed-scan-ref-icon' });
                setIcon(refIcon, 'file-text');

                const refName = refRow.createSpan({ cls: 'ai-organiser-embed-scan-ref-name' });
                refName.textContent = data.file.basename;

                const refLines = refRow.createSpan({ cls: 'ai-organiser-embed-scan-ref-lines' });
                const lineStr = data.lines.length === 1
                    ? `L${data.lines[0]}`
                    : data.lines.map(l => `L${l}`).join(', ');
                refLines.textContent = lineStr;

                // Click to navigate to the referencing note
                const navigateToRef = () => {
                    void this.app.workspace.openLinkText(data.file.path, '', false);
                    this.close();
                };
                this.cleanups.push(listen(refRow, 'click', navigateToRef));
                this.cleanups.push(listen(refRow, 'keydown', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        navigateToRef();
                    }
                }));
            }

            // "Open file" button for the target itself
            if (target.file) {
                const actionsRow = refsContainer.createDiv({ cls: 'ai-organiser-embed-scan-actions' });
                const openBtn = actionsRow.createEl('button', {
                    text: embedScan.openFile,
                    cls: 'ai-organiser-embed-scan-action-btn'
                });
                const openIcon = openBtn.createSpan();
                setIcon(openIcon, 'external-link');
                openBtn.prepend(openIcon);
                this.cleanups.push(listen(openBtn, 'click', (e) => {
                    e.stopPropagation();
                    void this.app.workspace.openLinkText(target.file!.path, '', false);
                    this.close();
                }));

                // Copy path button
                const copyBtn = actionsRow.createEl('button', {
                    text: embedScan.copyPath,
                    cls: 'ai-organiser-embed-scan-action-btn'
                });
                const copyIcon = copyBtn.createSpan();
                setIcon(copyIcon, 'copy');
                copyBtn.prepend(copyIcon);
                this.cleanups.push(listen(copyBtn, 'click', (e) => {
                    e.stopPropagation();
                    void navigator.clipboard.writeText(target.file!.path);
                    new Notice(embedScan.pathCopied);
                }));
            }
        }
    }

    // ─── Orphan rendering ────────────────────────────────────────────────────

    private renderOrphans(): void {
        this.orphansContainer.empty();
        const embedScan = this.t.embedScan;

        const orphans = this.scanResult.possiblyOrphaned;
        // Apply min-size filter to orphans too
        const filteredOrphans = this.filters.minSizeBytes > 0
            ? orphans.filter(f => f.stat.size >= this.filters.minSizeBytes)
            : orphans;

        if (filteredOrphans.length === 0) return;

        // Collapsible section — default collapsed
        const details = this.orphansContainer.createEl('details', {
            cls: 'ai-organiser-embed-scan-orphan-section'
        });
        const summary = details.createEl('summary', {
            cls: 'ai-organiser-embed-scan-orphan-summary'
        });
        summary.setAttribute('tabindex', '0');

        const summaryIcon = summary.createSpan({ cls: 'ai-organiser-embed-scan-orphan-icon' });
        setIcon(summaryIcon, 'alert-triangle');
        summary.createSpan({
            text: `${embedScan.possiblyOrphanedTitle} (${embedScan.orphanCount.replace('{count}', String(filteredOrphans.length))})`,
        });

        const disclaimer = details.createDiv({ cls: 'ai-organiser-embed-scan-orphan-disclaimer' });
        disclaimer.textContent = embedScan.orphanDisclaimer;

        const orphanList = details.createDiv({ cls: 'ai-organiser-embed-scan-orphan-list' });
        for (const file of filteredOrphans) {
            const row = orphanList.createDiv({ cls: 'ai-organiser-embed-scan-orphan-row' });
            row.setAttribute('role', 'link');
            row.setAttribute('tabindex', '0');

            // Checkbox
            this.createCheckbox(row, file.path);

            const icon = row.createSpan({ cls: 'ai-organiser-embed-scan-type-icon' });
            setIcon(icon, getEmbedTypeIcon(
                (['png','jpg','jpeg','gif','webp','bmp','svg','heic','heif','tiff','tif','avif'].includes(file.extension)) ? 'image'
                : file.extension === 'pdf' ? 'pdf'
                : (['mp3','m4a','wav','webm','ogg','mp4','mpeg','mpga','oga'].includes(file.extension)) ? 'audio'
                : (['mp4','mov','avi'].includes(file.extension)) ? 'video'
                : 'document'
            ));

            row.createSpan({ cls: 'ai-organiser-embed-scan-filename', text: file.name });
            const sizeBadge = row.createSpan({ cls: 'ai-organiser-embed-scan-badge size' });
            sizeBadge.textContent = formatFileSize(file.stat.size);

            const pathEl = row.createDiv({ cls: 'ai-organiser-embed-scan-path' });
            pathEl.textContent = file.path;

            const navigateToOrphan = () => {
                void this.app.workspace.openLinkText(file.path, '', false);
                this.close();
            };
            this.cleanups.push(listen(row, 'click', navigateToOrphan));
            this.cleanups.push(listen(row, 'keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    navigateToOrphan();
                }
            }));
        }
    }

    // ─── Selection toolbar ─────────────────────────────────────────────────

    private updateSelectionToolbar(): void {
        this.selectionToolbar.empty();
        const count = this.selectedPaths.size;

        if (count === 0) {
            this.selectionToolbar.addClass('hidden');
            return;
        }

        this.selectionToolbar.removeClass('hidden');
        const embedScan = this.t.embedScan;

        // Selected count
        this.selectionToolbar.createSpan({
            cls: 'ai-organiser-embed-scan-selection-count',
            text: embedScan.selectedCount.replace('{count}', String(count)),
        });

        // Select all / deselect all
        const allVisible = this.getAllSelectablePaths();
        const allSelected = allVisible.every(p => this.selectedPaths.has(p));
        const toggleBtn = this.selectionToolbar.createEl('button', {
            text: allSelected ? embedScan.deselectAll : embedScan.selectAll,
            cls: 'ai-organiser-embed-scan-selection-btn',
        });
        this.cleanups.push(listen(toggleBtn, 'click', () => {
            if (allSelected) {
                for (const p of allVisible) this.selectedPaths.delete(p);
            } else {
                for (const p of allVisible) this.selectedPaths.add(p);
            }
            this.applyFiltersAndRender();
        }));

        // Delete button
        const deleteBtn = this.selectionToolbar.createEl('button', {
            text: embedScan.deleteSelected,
            cls: 'ai-organiser-embed-scan-delete-btn mod-warning',
        });
        const deleteIcon = deleteBtn.createSpan();
        setIcon(deleteIcon, 'trash-2');
        deleteBtn.prepend(deleteIcon);
        this.cleanups.push(listen(deleteBtn, 'click', () => this.showDeleteConfirmation()));
    }

    /** Returns paths of all currently visible (filtered) targets + orphans that have a vault file */
    private getAllSelectablePaths(): string[] {
        const paths: string[] = [];
        const filtered = this.getFilteredTargets();
        for (const t of filtered) {
            if (t.file) paths.push(t.file.path);
        }
        if (this.scanResult.possiblyOrphaned.length > 0) {
            const filteredOrphans = this.filters.minSizeBytes > 0
                ? this.scanResult.possiblyOrphaned.filter(f => f.stat.size >= this.filters.minSizeBytes)
                : this.scanResult.possiblyOrphaned;
            for (const f of filteredOrphans) paths.push(f.path);
        }
        return paths;
    }

    // ─── Delete confirmation & execution ──────────────────────────────────

    private showDeleteConfirmation(): void {
        const filesToDelete = this.getSelectedFiles();
        if (filesToDelete.length === 0) return;

        const totalSize = filesToDelete.reduce((sum, f) => sum + f.stat.size, 0);
        new DeleteConfirmModal(
            this.app,
            this.t,
            filesToDelete,
            totalSize,
            async () => {
                await this.executeDelete(filesToDelete);
            }
        ).open();
    }

    private getSelectedFiles(): TFile[] {
        const files: TFile[] = [];
        for (const path of this.selectedPaths) {
            const file = this.app.vault.getAbstractFileByPath(path);
            if (file instanceof TFile) files.push(file);
        }
        return files;
    }

    private async executeDelete(files: TFile[]): Promise<void> {
        const embedScan = this.t.embedScan;
        let deletedCount = 0;

        for (const file of files) {
            try {
                await this.app.fileManager.trashFile(file);
                deletedCount++;
                // Remove from scan result
                this.removeFromScanResult(file.path);
                this.selectedPaths.delete(file.path);
            } catch {
                new Notice(embedScan.deleteError.replace('{file}', file.name));
            }
        }

        if (deletedCount > 0) {
            new Notice(embedScan.deleteSuccess.replace('{count}', String(deletedCount)));
        }

        // Re-render with updated data
        this.applyFiltersAndRender();
    }

    private removeFromScanResult(path: string): void {
        const targetIdx = this.scanResult.targets.findIndex(t => t.file?.path === path);
        if (targetIdx !== -1) {
            this.scanResult.targets.splice(targetIdx, 1);
        }
        const orphanIdx = this.scanResult.possiblyOrphaned.findIndex(f => f.path === path);
        if (orphanIdx !== -1) {
            this.scanResult.possiblyOrphaned.splice(orphanIdx, 1);
        }
    }

    // ─── Checkbox helper ─────────────────────────────────────────────────

    private createCheckbox(container: HTMLElement, path: string): HTMLElement {
        const checkbox = container.createEl('input', {
            type: 'checkbox',
            cls: 'ai-organiser-embed-scan-checkbox',
        });
        checkbox.checked = this.selectedPaths.has(path);
        checkbox.setAttribute('aria-label', this.t.embedScan.selectFile);
        this.cleanups.push(listen(checkbox, 'click', (e) => {
            e.stopPropagation(); // Don't toggle row expand
        }));
        this.cleanups.push(listen(checkbox, 'keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation(); // Don't trigger row expand/navigate
            }
        }));
        this.cleanups.push(listen(checkbox, 'change', () => {
            if (checkbox.checked) {
                this.selectedPaths.add(path);
            } else {
                this.selectedPaths.delete(path);
            }
            this.updateSelectionToolbar();
        }));
        return checkbox;
    }

    onClose(): void {
        for (const cleanup of this.cleanups) cleanup();
        this.cleanups = [];
        this.contentEl.empty();
    }
}

// ─── Delete confirmation modal ─────────────────────────────────────────────

class DeleteConfirmModal extends Modal {
    private readonly t: Translations;
    private readonly files: TFile[];
    private readonly totalSize: number;
    private readonly onConfirm: () => Promise<void>;

    constructor(app: App, t: Translations, files: TFile[], totalSize: number, onConfirm: () => Promise<void>) {
        super(app);
        this.t = t;
        this.files = files;
        this.totalSize = totalSize;
        this.onConfirm = onConfirm;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('ai-organiser-embed-scan-confirm-modal');
        const embedScan = this.t.embedScan;

        // Title
        contentEl.createEl('h3', {
            text: embedScan.deleteConfirmTitle.replace('{count}', String(this.files.length)),
        });

        // Message
        contentEl.createEl('p', {
            text: embedScan.deleteConfirmMessage.replace('{size}', formatFileSize(this.totalSize)),
            cls: 'ai-organiser-embed-scan-confirm-message',
        });

        // File list
        const list = contentEl.createDiv({ cls: 'ai-organiser-embed-scan-confirm-list' });
        for (const file of this.files) {
            const row = list.createDiv({ cls: 'ai-organiser-embed-scan-confirm-file' });
            const icon = row.createSpan();
            const ext = file.extension ? `.${file.extension}` : '';
            setIcon(icon, getEmbedTypeIcon(classifyExtension(ext)));
            row.createSpan({ text: file.name });
            row.createSpan({
                text: formatFileSize(file.stat.size),
                cls: 'ai-organiser-embed-scan-badge size',
            });
        }

        // Warning
        contentEl.createEl('p', {
            text: embedScan.deleteConfirmWarning,
            cls: 'ai-organiser-embed-scan-confirm-warning',
        });

        // Buttons
        const buttons = contentEl.createDiv({ cls: 'ai-organiser-embed-scan-buttons' });
        const cancelBtn = buttons.createEl('button', { text: embedScan.cancelButton });
        cancelBtn.addEventListener('click', () => this.close());

        const confirmBtn = buttons.createEl('button', {
            text: embedScan.deleteSelected,
            cls: 'mod-warning',
        });
        const confirmIcon = confirmBtn.createSpan();
        setIcon(confirmIcon, 'trash-2');
        confirmBtn.prepend(confirmIcon);
        confirmBtn.addEventListener('click', () => { void (async () => {
            this.close();
            await this.onConfirm();
        })(); });
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
