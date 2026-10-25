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

import { App, Modal, TFile, setIcon, Notice, type EventRef } from 'obsidian';
import type { Translations } from '../../i18n/types';
import type AIOrganiserPlugin from '../../main';
import { assertWritable, isProtectedPath } from '../../core/protectedPaths';
import { openOffloadForFile } from '../../commands/offloadCommands';
import { isOffloadAvailable } from '../../services/offload/offloadRuntime';
import { describeError, formatGuidance } from '../../core/friendlyErrors';
import {
    ChangeLog,
    createAppVaultPort,
    eligibilityFromScan,
    revalidate,
    type Eligibility,
    type FileIdentity,
} from '../../services/attachmentEligibility';
import { analyseDuplicates, type DuplicateResult } from '../../services/attachmentDuplicateService';
import {
    HOME_QUERY_CHARS,
    createHomeContext,
    linkToNote,
    suggestHomes,
    type HomeSuggestion,
} from '../../services/attachmentHomeService';
import {
    EmbedTarget,
    EmbedScanResult,
    EmbedTargetType,
    formatFileSize,
    getEmbedTypeIcon,
    classifyExtension,
} from '../../services/embedScanService';
import { listen } from '../utils/domUtils';
import { plural } from '../../utils/plural';
import { describeKept, type KeptCard, type KeptContext } from '../../services/attachmentKeptModel';
import {
    isLinkRemovalEnabled,
    planLinkRemoval,
    removeLinks,
    type NotePlan,
    type UnlinkOutcome,
} from '../../services/attachmentUnlinkService';
import type { BatchResult, Result } from '../../core/result';
import { isFeatureEnabled } from '../../services/featureService';
import { renderKeptPanel } from './EmbedScanKeptPanel';
import { RemoveLinkPreviewModal } from './RemoveLinkPreviewModal';

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
    /** The types the user picked with the chips; empty means no filter (everything is shown). */
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

// ─── Context & session state ─────────────────────────────────────────────────

/** What the results modal needs from the plugin. Absent = read-only browsing (no helper actions). */
export interface EmbedScanModalContext {
    plugin: AIOrganiserPlugin;
    /** Run the scan again (used by the out-of-date banner) */
    onRescan?: () => void;
}

/** The user's answer to "send text to the embedding provider?", remembered per provider for the session. */
const sessionEgressChoice = new Map<string, boolean>();

/** Open state of the collapsed groups, remembered for the session. `null` = no choice yet (the default rule applies). */
let sessionInUseOpen: boolean | null = null;
let sessionMissingOpen = false;

/** Forget the session answers and group choices (called when the plugin loads). */
export function resetEgressChoice(): void {
    sessionEgressChoice.clear();
    sessionInUseOpen = null;
    sessionMissingOpen = false;
}

/** The outcome of re-checking the selected files against the live vault. */
type SafetyCheck =
    | { status: 'ok'; safe: TFile[]; kept: Array<{ file: TFile; eligibility: Eligibility; linksRemovable?: boolean }> }
    /** Obsidian is still indexing links: nothing could be proven, nothing was decided */
    | { status: 'not-ready' }
    /** Could not check (already reported to the user) */
    | { status: 'failed' };

type SuggestState =
    | { status: 'loading' }
    | { status: 'error' }
    | { status: 'done'; suggestion: HomeSuggestion };

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
    private readonly ctx?: EmbedScanModalContext;
    private readonly changeLog = new ChangeLog();
    private vaultRefs: EventRef[] = [];
    /** Files as they were when scanned (TFile.stat is live, so copy it now) */
    private readonly scanIdentity = new Map<string, FileIdentity>();
    private bannerEl!: HTMLElement;
    private toolsEl!: HTMLElement;
    private couldNotReadEl!: HTMLElement;
    private stale = false;
    private largeOnly = false;
    private duplicates: DuplicateResult | null = null;
    private duplicateProgress: { done: number; total: number } | null = null;
    private duplicateAbort: AbortController | null = null;
    private duplicateOf = new Map<string, string[]>();
    /** Files the last re-check kept, with the evidence, until they are fixed, deleted or the window closes. */
    private keptCards = new Map<string, { card: KeptCard; eligibility: Eligibility; linksRemovable?: boolean }>();
    private keptEl!: HTMLElement;
    private notReadyEl!: HTMLElement;
    /** Set while the re-check could not run because Obsidian is indexing; the selection is kept for a retry. */
    private notReadyPaths: string[] | null = null;
    /** One check or link-removal workflow at a time; the action buttons are disabled while it runs. */
    private busy = false;
    private duplicatesOnly = false;
    private orphansOpen = true;
    private chipsEl!: HTMLElement;
    private chipCleanups: (() => void)[] = [];
    private keptCleanups: (() => void)[] = [];
    private suggestions = new Map<string, SuggestState>();
    /** Set when the modal closes, so work that finishes later does not touch a dead modal. */
    private closed = false;
    /** Listener disposers for the tools row only; replaced on every progress render. */
    private toolsCleanups: (() => void)[] = [];
    /** Listeners of the re-rendered regions (rows, banner, toolbar); disposed before every render. */
    private renderCleanups: (() => void)[] = [];
    /** Listeners of the selection toolbar, which is rebuilt more often than the rest. */
    private toolbarCleanups: (() => void)[] = [];

    private filters: FilterState = {
        searchQuery: '',
        activeTypes: new Set(),
        sortField: 'size',
        sortDirection: 'desc',
        minSizeBytes: 0,
    };

    constructor(app: App, t: Translations, scanResult: EmbedScanResult, ctx?: EmbedScanModalContext) {
        super(app);
        this.scanResult = scanResult;
        this.t = t;
        this.ctx = ctx;
        const remember = (f: TFile | null) => {
            if (f) this.scanIdentity.set(f.path, { path: f.path, size: f.stat.size, mtime: f.stat.mtime });
        };
        for (const target of scanResult.targets) remember(target.file);
        for (const orphan of scanResult.possiblyOrphaned) remember(orphan);
    }

    // ─── Helper-action context ───────────────────────────────────────────────

    private get largeBytes(): number {
        return (this.ctx?.plugin.settings.attachmentLargeFileMB ?? 20) * 1024 * 1024;
    }

    private get protectedFolders(): readonly string[] {
        return this.ctx?.plugin.settings.protectedFolders ?? [];
    }

    /** Eligibility from the scan data (cheap, for display). The real check runs again at confirmation. */
    private eligibilityOf(file: TFile, referenceCount: number, ambiguous: boolean): Eligibility {
        const scanned = this.scanIdentity.get(file.path) ?? { path: file.path, size: file.stat.size, mtime: file.stat.mtime };
        return eligibilityFromScan(scanned, referenceCount, ambiguous, this.scanResult.coverageFailures ?? [], this.protectedFolders);
    }

    private reasonText(e: Eligibility): string {
        const es = this.t.embedScan;
        const parts: string[] = [];
        for (const reason of e.reasons) {
            switch (reason) {
                case 'still-referenced': parts.push(plural(es.reasonReferenced, e.referenceCount)); break;
                case 'ambiguous-reference': parts.push(es.reasonAmbiguous); break;
                case 'canvas-unreadable': parts.push(es.reasonCanvas); break;
                case 'scan-incomplete': parts.push(es.reasonIncomplete); break;
                case 'file-changed': parts.push(es.reasonChanged); break;
                case 'target-missing': parts.push(es.reasonMissing); break;
                case 'protected-path': parts.push(es.reasonProtected); break;
            }
        }
        return parts.join(' · ');
    }

    private targetEligibility(target: EmbedTarget): Eligibility | null {
        if (!target.file) return null;
        // "Used by N notes" counts notes and canvases, not the number of times each one links the file.
        const referrers = new Set(target.references.map((r) => r.sourceFile.path)).size;
        return this.eligibilityOf(target.file, referrers, !!target.ambiguous);
    }

    private orphanEligibility(file: TFile): Eligibility {
        return this.eligibilityOf(file, 0, (this.scanResult.ambiguousPaths ?? []).includes(file.path));
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

        // ── Out-of-date banner ──
        this.bannerEl = contentEl.createDiv({ cls: 'ai-organiser-embed-scan-banner hidden', attr: { role: 'status' } });

        // ── Scan summary ──
        this.summaryEl = contentEl.createDiv({ cls: 'ai-organiser-embed-scan-summary' });
        this.updateSummary();

        // ── Helper tools (duplicate analysis) ──
        this.toolsEl = contentEl.createDiv({ cls: 'ai-organiser-embed-scan-tools' });
        this.registerVaultEvents();

        // ── Filters row ──
        this.renderFilters(contentEl);

        // ── Selection toolbar (hidden until items selected) ──
        this.selectionToolbar = contentEl.createDiv({ cls: 'ai-organiser-embed-scan-selection-toolbar hidden' });

        // ── Status line (showing filtered count) ──
        this.statusEl = contentEl.createDiv({ cls: 'ai-organiser-embed-scan-status' });

        // ── Kept files (what the delete-time re-check refused, and why) and the not-ready row ──
        this.keptEl = contentEl.createDiv({ cls: 'ai-organiser-embed-scan-kept-wrap' });
        this.notReadyEl = contentEl.createDiv({ cls: 'ai-organiser-embed-scan-not-ready' });

        // ── Possibly orphaned section (vault scope only): the focus of the window, so it comes first ──
        if (this.scanResult.possiblyOrphaned.length > 0) {
            this.orphansContainer = contentEl.createDiv({ cls: 'ai-organiser-embed-scan-orphans' });
        }

        // ── Files that are in use (collapsed by default when there is anything to clean up) ──
        this.resultsContainer = contentEl.createDiv({ cls: 'ai-organiser-embed-scan-results' });

        // ── Files that could not be read (block deleting anything) ──
        this.couldNotReadEl = contentEl.createDiv({ cls: 'ai-organiser-embed-scan-could-not-read' });

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

        // Type, Large and Duplicates chips (rebuilt when the duplicate analysis finishes)
        this.chipsEl = controlsRow.createDiv({ cls: 'ai-organiser-embed-scan-type-chips' });
        this.renderChipRow();

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

    private orphanType(file: TFile): EmbedTargetType {
        return classifyExtension(`.${file.extension}`);
    }

    private isDuplicate(path: string): boolean {
        const members = this.duplicateOf.get(path);
        return !!members && members.length > 1;
    }

    /** Files of a type across the referenced files and the possibly orphaned ones. */
    private countOfType(type: EmbedTargetType): number {
        return this.scanResult.targets.filter((x) => x.type === type).length
            + this.scanResult.possiblyOrphaned.filter((f) => this.orphanType(f) === type).length;
    }

    private renderChipRow(): void {
        for (const dispose of this.chipCleanups) dispose();
        this.chipCleanups = [];
        this.chipsEl.empty();
        const embedScan = this.t.embedScan;

        for (const type of ALL_EMBED_TYPES) {
            const count = this.countOfType(type);
            if (count === 0) continue; // Don't show empty types

            const chip = this.chipsEl.createEl('button', {
                cls: `ai-organiser-embed-scan-chip ${this.filters.activeTypes.has(type) ? 'active' : ''}`,
            });
            chip.setAttribute('role', 'checkbox');
            chip.setAttribute('aria-checked', this.filters.activeTypes.has(type) ? 'true' : 'false');
            chip.setAttribute('aria-label', `${getTypeLabel(type, this.t)} (${count})`);
            chip.setAttribute('tabindex', '0');

            const chipIcon = chip.createSpan({ cls: 'ai-organiser-embed-scan-chip-icon' });
            setIcon(chipIcon, getEmbedTypeIcon(type));
            chip.createSpan({ text: `${getTypeLabel(type, this.t)} (${count})` });

            this.chipCleanups.push(listen(chip, 'click', () => this.toggleTypeFilter(type, chip)));
            this.chipCleanups.push(listen(chip, 'keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this.toggleTypeFilter(type, chip);
                }
            }));
        }

        // "Large files" chip (at or above the size set in settings)
        const hasLarge = this.scanResult.targets.some((x) => x.sizeBytes >= this.largeBytes)
            || this.scanResult.possiblyOrphaned.some((f) => f.stat.size >= this.largeBytes);
        if (hasLarge) {
            const largeChip = this.chipsEl.createEl('button', {
                cls: `ai-organiser-embed-scan-chip ${this.largeOnly ? 'active' : ''}`,
                attr: { role: 'checkbox', 'aria-checked': String(this.largeOnly), 'aria-label': embedScan.largeChip },
            });
            const largeIcon = largeChip.createSpan({ cls: 'ai-organiser-embed-scan-chip-icon' });
            setIcon(largeIcon, 'hard-drive');
            largeChip.createSpan({ text: embedScan.largeChip });
            this.chipCleanups.push(listen(largeChip, 'click', () => {
                this.largeOnly = !this.largeOnly;
                largeChip.toggleClass('active', this.largeOnly);
                largeChip.setAttribute('aria-checked', String(this.largeOnly));
                this.applyFiltersAndRender();
            }));
        }

        // "Duplicates" chip: only once the opt-in duplicate analysis has found some
        const duplicateFiles = [...this.duplicateOf.keys()].filter((path) => this.isDuplicate(path)).length;
        if (duplicateFiles > 0) {
            const dupChip = this.chipsEl.createEl('button', {
                cls: `ai-organiser-embed-scan-chip ${this.duplicatesOnly ? 'active' : ''}`,
                attr: { role: 'checkbox', 'aria-checked': String(this.duplicatesOnly), 'aria-label': `${embedScan.duplicatesChip} (${duplicateFiles})` },
            });
            setIcon(dupChip.createSpan({ cls: 'ai-organiser-embed-scan-chip-icon' }), 'copy');
            dupChip.createSpan({ text: `${embedScan.duplicatesChip} (${duplicateFiles})` });
            this.chipCleanups.push(listen(dupChip, 'click', () => {
                this.duplicatesOnly = !this.duplicatesOnly;
                dupChip.toggleClass('active', this.duplicatesOnly);
                dupChip.setAttribute('aria-checked', String(this.duplicatesOnly));
                this.applyFiltersAndRender();
            }));
        }
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
            text: plural(embedScan.scannedNotes, this.scanResult.notesScanned + (this.scanResult.canvasesScanned ?? 0)),
        });
        // One set of numbers: every file found (in use and not used), and its size across both lists.
        const inUse = this.scanResult.targets.filter((t) => t.file !== null);
        const unused = this.scanResult.possiblyOrphaned;
        const totalSize = inUse.reduce((sum, t) => sum + t.sizeBytes, 0) + unused.reduce((sum, f) => sum + f.stat.size, 0);
        this.summaryEl.createSpan({ text: ' · ' });
        this.summaryEl.createSpan({ text: plural(embedScan.totalFiles, inUse.length + unused.length) });
        if (unused.length > 0) {
            this.summaryEl.createSpan({ text: ' · ' });
            this.summaryEl.createSpan({ text: plural(embedScan.summaryInUse, inUse.length) });
            this.summaryEl.createSpan({ text: ' · ' });
            this.summaryEl.createSpan({ text: plural(embedScan.summaryUnused, unused.length) });
        }
        this.summaryEl.createSpan({ text: ' · ' });
        this.summaryEl.createSpan({
            text: embedScan.totalSize
                .replace('{size}', formatFileSize(totalSize)),
        });
    }

    // ─── Filter + Sort + Render ──────────────────────────────────────────────

    private applyFiltersAndRender(): void {
        if (this.closed) return;
        for (const dispose of this.renderCleanups) dispose();
        this.renderCleanups = [];
        this.updateSummary();
        const filtered = this.getFilteredTargets();
        // "Showing N of M" counts what is on screen against everything found: in-use files and orphans alike.
        const shown = filtered.filter((t) => t.file !== null).length + this.getFilteredOrphans().length;
        const found = this.scanResult.targets.filter((t) => t.file !== null).length + this.scanResult.possiblyOrphaned.length;
        this.updateStatus(shown, found);
        this.renderKept();
        this.renderNotReady();
        if (this.orphansContainer) {
            this.renderOrphans();
        }
        this.renderResults(filtered);
        this.updateSelectionToolbar();
        this.renderBanner();
        this.renderTools();
        this.renderCouldNotRead();
    }

    private getFilteredTargets(): EmbedTarget[] {
        let targets = this.scanResult.targets.filter(t => {
            // Type filter (no chip picked = no filter)
            if (this.filters.activeTypes.size > 0 && !this.filters.activeTypes.has(t.type)) return false;
            // Min size filter
            if (t.sizeBytes < this.filters.minSizeBytes) return false;
            if (this.largeOnly && t.sizeBytes < this.largeBytes) return false;
            if (this.duplicatesOnly && !(t.file && this.isDuplicate(t.file.path))) return false;
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

    private updateStatus(filteredCount: number, total: number): void {
        this.statusEl.empty();
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
        this.renderCleanups.push(listen(selectAllCb, 'change', () => {
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
        const inUse = targets.filter((x) => x.file !== null);
        const missing = targets.filter((x) => x.file === null);

        if (inUse.length === 0 && missing.length === 0) {
            if (this.getFilteredOrphans().length === 0) {
                const emptyEl = this.resultsContainer.createDiv({ cls: 'ai-organiser-embed-scan-empty' });
                emptyEl.createSpan({ text: this.t.embedScan.noResults });
            }
            return;
        }

        const es = this.t.embedScan;
        // With something to clean up the in-use files stay out of the way; with nothing else to show they open.
        const hasOrphanSection = this.scanResult.possiblyOrphaned.length > 0;
        if (inUse.length > 0) {
            this.renderGroup('inuse', plural(es.inUseSummary, inUse.length), inUse, sessionInUseOpen ?? !hasOrphanSection,
                (open) => { sessionInUseOpen = open; });
        }
        if (missing.length > 0) {
            this.renderGroup('missing', plural(es.missingTargetsSummary, missing.length), missing, sessionMissingOpen,
                (open) => { sessionMissingOpen = open; });
        }
    }

    /** A collapsible group of referenced files. The user's open/closed choice is remembered for the session. */
    private renderGroup(kind: 'inuse' | 'missing', title: string, targets: EmbedTarget[], open: boolean, remember: (open: boolean) => void): void {
        const details = this.resultsContainer.createEl('details', {
            cls: `ai-organiser-embed-scan-group ai-organiser-embed-scan-group-${kind}`,
        });
        details.open = open;
        const summary = details.createEl('summary', { cls: 'ai-organiser-embed-scan-group-summary', text: title });
        summary.setAttribute('tabindex', '0');
        // The click toggles `open` after this handler runs, so the new state is the opposite of the current one.
        this.renderCleanups.push(listen(summary, 'click', () => remember(!details.open)));
        const body = details.createDiv({ cls: 'ai-organiser-embed-scan-group-body' });
        for (const target of targets) this.renderTargetRow(body, target);
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

        // Checkbox (only for resolved files, and only when it is safe to delete)
        const eligibility = this.targetEligibility(target);
        if (target.file && eligibility) {
            this.createCheckbox(header, target.file.path, eligibility.eligible);
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

        this.renderFlagBadges(badges, target.file, target.sizeBytes);

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
        if (eligibility && !eligibility.eligible) {
            header.createDiv({ cls: 'ai-organiser-embed-scan-reason', text: this.reasonText(eligibility) });
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
        this.renderCleanups.push(listen(header, 'click', toggleExpand));
        this.renderCleanups.push(listen(header, 'keydown', (e) => {
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
                this.renderCleanups.push(listen(refRow, 'click', navigateToRef));
                this.renderCleanups.push(listen(refRow, 'keydown', (e) => {
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
                this.renderCleanups.push(listen(openBtn, 'click', (e) => {
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
                this.renderCleanups.push(listen(copyBtn, 'click', (e) => {
                    e.stopPropagation();
                    void navigator.clipboard.writeText(target.file!.path);
                    new Notice(embedScan.pathCopied);
                }));

                // Offload to Drive: desktop only, feature on, a large file that something refers to.
                const ctx = this.ctx;
                if (ctx && target.references.length > 0 && target.sizeBytes >= this.largeBytes
                    && !target.ambiguous && !isProtectedPath(this.protectedFolders, target.file.path)
                    && isOffloadAvailable(ctx.plugin)) {
                    const offloadBtn = actionsRow.createEl('button', {
                        text: ctx.plugin.t.offload.offloadAction,
                        cls: 'ai-organiser-embed-scan-action-btn',
                    });
                    const offloadIcon = offloadBtn.createSpan();
                    setIcon(offloadIcon, 'cloud-upload');
                    offloadBtn.prepend(offloadIcon);
                    this.renderCleanups.push(listen(offloadBtn, 'click', (e) => {
                        e.stopPropagation();
                        openOffloadForFile(ctx.plugin, target.file!);
                        this.close();
                    }));
                }
            }
        }
    }

    // ─── Orphan rendering ────────────────────────────────────────────────────

    /** The possibly orphaned files that pass the current filters, in the chosen order (largest first by default). */
    private getFilteredOrphans(): TFile[] {
        const { searchQuery, activeTypes, minSizeBytes, sortField, sortDirection } = this.filters;
        const dir = sortDirection === 'desc' ? -1 : 1;
        return this.scanResult.possiblyOrphaned
            .filter((f) =>
                f.stat.size >= minSizeBytes
                && (!this.largeOnly || f.stat.size >= this.largeBytes)
                && (activeTypes.size === 0 || activeTypes.has(this.orphanType(f)))
                && (!this.duplicatesOnly || this.isDuplicate(f.path))
                && (!searchQuery || f.path.toLowerCase().includes(searchQuery)))
            // A file nothing references has no reference count to sort by, so that order falls back to size.
            .sort((a, b) => sortField === 'name' ? a.path.localeCompare(b.path) * dir
                : sortField === 'size' ? (a.stat.size - b.stat.size) * dir
                : b.stat.size - a.stat.size);
    }

    private renderOrphans(): void {
        this.orphansContainer.empty();
        const embedScan = this.t.embedScan;

        // The same search, type, size, duplicates and sort controls as the referenced files
        const filteredOrphans = this.getFilteredOrphans();

        if (filteredOrphans.length === 0) return;

        // Collapsible section, open by default: this is what the user came to clean up
        const details = this.orphansContainer.createEl('details', {
            cls: 'ai-organiser-embed-scan-orphan-section'
        });
        details.open = this.orphansOpen;
        const summary = details.createEl('summary', {
            cls: 'ai-organiser-embed-scan-orphan-summary'
        });
        summary.setAttribute('tabindex', '0');
        this.renderCleanups.push(listen(summary, 'click', () => { this.orphansOpen = !details.open; }));

        const summaryIcon = summary.createSpan({ cls: 'ai-organiser-embed-scan-orphan-icon' });
        setIcon(summaryIcon, 'alert-triangle');
        summary.createSpan({
            text: `${embedScan.possiblyOrphanedTitle} (${plural(embedScan.orphanCount, filteredOrphans.length)})`,
        });

        const disclaimer = details.createDiv({ cls: 'ai-organiser-embed-scan-orphan-disclaimer' });
        disclaimer.textContent = embedScan.orphanDisclaimer;

        const orphanList = details.createDiv({ cls: 'ai-organiser-embed-scan-orphan-list' });
        for (const file of filteredOrphans) {
            const row = orphanList.createDiv({ cls: 'ai-organiser-embed-scan-orphan-row' });
            row.setAttribute('role', 'link');
            row.setAttribute('tabindex', '0');

            // Checkbox (disabled with a reason when it is not safe to delete)
            const orphanEligibility = this.orphanEligibility(file);
            this.createCheckbox(row, file.path, orphanEligibility.eligible);

            const icon = row.createSpan({ cls: 'ai-organiser-embed-scan-type-icon' });
            setIcon(icon, getEmbedTypeIcon(this.orphanType(file)));

            row.createSpan({ cls: 'ai-organiser-embed-scan-filename', text: file.name });
            const sizeBadge = row.createSpan({ cls: 'ai-organiser-embed-scan-badge size' });
            sizeBadge.textContent = formatFileSize(file.stat.size);
            this.renderFlagBadges(row, file, file.stat.size);

            const pathEl = row.createDiv({ cls: 'ai-organiser-embed-scan-path' });
            pathEl.textContent = file.path;
            if (!orphanEligibility.eligible) {
                row.createDiv({ cls: 'ai-organiser-embed-scan-reason', text: this.reasonText(orphanEligibility) });
            }
            if (this.ctx) this.renderSuggestHome(orphanList, row, file);

            const navigateToOrphan = () => {
                void this.app.workspace.openLinkText(file.path, '', false);
                this.close();
            };
            this.renderCleanups.push(listen(row, 'click', navigateToOrphan));
            this.renderCleanups.push(listen(row, 'keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    navigateToOrphan();
                }
            }));
        }
    }

    // ─── Selection toolbar ─────────────────────────────────────────────────

    private updateSelectionToolbar(): void {
        // The toolbar is rebuilt on every checkbox change: dispose its listeners each time.
        for (const dispose of this.toolbarCleanups) dispose();
        this.toolbarCleanups = [];
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
        this.toolbarCleanups.push(listen(toggleBtn, 'click', () => {
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
        this.toolbarCleanups.push(listen(deleteBtn, 'click', () => this.showDeleteConfirmation()));
    }

    /** Returns paths of all currently visible (filtered) targets + orphans that have a vault file */
    private getAllSelectablePaths(): string[] {
        const paths: string[] = [];
        const filtered = this.getFilteredTargets();
        for (const t of filtered) {
            if (t.file && this.targetEligibility(t)?.eligible) paths.push(t.file.path);
        }
        for (const f of this.getFilteredOrphans()) {
            if (this.orphanEligibility(f).eligible) paths.push(f.path);
        }
        return paths;
    }

    // ─── Delete confirmation & execution ──────────────────────────────────

    private showDeleteConfirmation(): void {
        const selected = this.getSelectedFiles();
        if (selected.length === 0) return;
        void this.revalidateAndConfirm(selected);
    }

    /**
     * Check the selected files against the CURRENT vault: the ones still safe, and the ones kept back with
     * the evidence for why. A failure to check is reported and treated as "nothing is safe"; a link index
     * that is still building is its own outcome, so the user gets an honest message and a retry.
     */
    private async checkSafe(selected: TFile[]): Promise<SafetyCheck> {
        const settings = this.ctx?.plugin.settings;
        const identities = selected.map((f) => this.scanIdentity.get(f.path) ?? { path: f.path, size: f.stat.size, mtime: f.stat.mtime });
        const res = await revalidate(createAppVaultPort(this.app), {
            files: identities,
            scanStartedAt: this.scanResult.scanStartedAt ?? 0,
            occurrences: this.scanResult.occurrences ?? [],
            scannedReferrers: this.scanResult.scannedReferrers,
            priorFailures: this.scanResult.coverageFailures ?? [],
            changes: this.changeLog.snapshot(),
            protectedFolders: settings?.protectedFolders ?? [],
        });
        if (!res.ok) {
            if (res.error === 'metadata-not-ready') return { status: 'not-ready' };
            if (res.error === 'scan-out-of-date') this.stale = true;
            new Notice(formatGuidance(describeError(this.t, res.error)), 8000);
            return { status: 'failed' };
        }
        const safe: TFile[] = [];
        const kept: Array<{ file: TFile; eligibility: Eligibility; linksRemovable?: boolean }> = [];
        for (const file of selected) {
            const eligibility = res.value.get(file.path);
            if (eligibility?.eligible) { safe.push(file); continue; }
            const verdict = eligibility ?? { eligible: false, reasons: ['target-missing' as const], referenceCount: 0 };
            kept.push({ file, eligibility: verdict, linksRemovable: await this.linksRemovableFor(file, verdict) });
        }
        return { status: 'ok', safe, kept };
    }

    /**
     * Whether every link to a kept file can be removed automatically: each referring note must yield a removal plan.
     * Undefined when the question does not apply (something else blocks too, or a canvas refers to it); false when a
     * link sits in the note properties or a code block, or the link index knows one the text does not show.
     */
    private async linksRemovableFor(file: TFile, eligibility: Eligibility): Promise<boolean | undefined> {
        const plugin = this.ctx?.plugin;
        if (!plugin || !isFeatureEnabled(plugin.settings, 'embed-scan')) return undefined;
        if (eligibility.reasons.length !== 1 || eligibility.reasons[0] !== 'still-referenced') return undefined;
        const referrers = eligibility.blockers?.referrers ?? [];
        if (referrers.length === 0 || referrers.some((r) => r.extension !== 'md')) return undefined;
        const resolve = (linktext: string, sourcePath: string): string | null =>
            this.app.metadataCache.getFirstLinkpathDest(linktext, sourcePath)?.path ?? null;
        try {
            for (const notePath of new Set(referrers.map((r) => r.path))) {
                const note = this.app.vault.getAbstractFileByPath(notePath);
                if (!(note instanceof TFile)) return false;
                if (planLinkRemoval(await this.app.vault.read(note), file.path, notePath, resolve).status !== 'ok') return false;
            }
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Take in what a re-check found: files now safe lose their Kept card, kept files get one (with the
     * blocking note, canvas or file named). False when nothing could be decided (not ready, or failed).
     */
    private recordCheck(selected: TFile[], checked: SafetyCheck): checked is Extract<SafetyCheck, { status: 'ok' }> {
        if (checked.status === 'not-ready') {
            this.notReadyPaths = selected.map((f) => f.path);
            this.applyFiltersAndRender();
            return false;
        }
        if (checked.status === 'failed') {
            // Nothing was decided, but the stale banner may have changed and the buttons must follow the lock.
            this.applyFiltersAndRender();
            return false;
        }
        this.notReadyPaths = null;
        for (const file of checked.safe) this.keptCards.delete(file.path);
        for (const { file, eligibility, linksRemovable } of checked.kept) {
            this.selectedPaths.delete(file.path);
            this.keptCards.set(file.path, {
                eligibility,
                linksRemovable,
                card: describeKept({ path: file.path, name: file.name, sizeBytes: file.stat.size }, eligibility, this.keptContext(), { linksRemovable }),
            });
        }
        if (checked.kept.length > 0) {
            new Notice(plural(this.t.embedScan.keptNotice, checked.kept.length), 8000);
            this.stale = true;
        }
        this.applyFiltersAndRender();
        return true;
    }

    /**
     * Rebuild the reference graph from the CURRENT vault, drop anything that is no longer safe,
     * and only then ask for confirmation. Fails closed if the link index is not ready.
     */
    private async revalidateAndConfirm(selected: TFile[]): Promise<void> {
        if (this.busy) return;
        const es = this.t.embedScan;
        this.busy = true;
        const checking = new Notice(es.revalidating, 0);
        let checked: SafetyCheck;
        try {
            checked = await this.checkSafe(selected);
        } finally {
            checking.hide();
            this.busy = false;
        }
        if (this.closed) return;
        if (!this.recordCheck(selected, checked)) return;
        const { safe } = checked;
        if (safe.length === 0) return;

        const totalSize = safe.reduce((sum, f) => sum + f.stat.size, 0);
        new DeleteConfirmModal(
            this.app,
            this.t,
            safe,
            totalSize,
            async () => {
                await this.executeDelete(safe);
            }
        ).open();
    }

    // ─── Kept files, not-ready row, remove-the-link flow ──────────────────

    private keptContext(): KeptContext {
        const plugin = this.ctx?.plugin;
        const settings = plugin?.settings;
        const linkRemoval = !settings ? 'unavailable'
            : isLinkRemovalEnabled(settings) ? 'on'
            : isFeatureEnabled(settings, 'embed-scan') ? 'off'
            : 'unavailable';
        return { protectedFolders: this.protectedFolders, linkRemoval };
    }

    /** Describe every kept file again (the link-removal setting may have changed). */
    private refreshKeptCards(): void {
        for (const [path, entry] of this.keptCards) {
            const file = this.app.vault.getAbstractFileByPath(path);
            const name = file instanceof TFile ? file.name : path.split('/').pop() ?? path;
            const size = file instanceof TFile ? file.stat.size : entry.card.sizeBytes;
            this.keptCards.set(path, {
                eligibility: entry.eligibility,
                linksRemovable: entry.linksRemovable,
                card: describeKept({ path, name, sizeBytes: size }, entry.eligibility, this.keptContext(), { linksRemovable: entry.linksRemovable }),
            });
        }
    }

    private renderKept(): void {
        if (!this.keptEl) return;
        for (const dispose of this.keptCleanups) dispose();
        this.keptEl.empty();
        this.keptCleanups = renderKeptPanel(
            this.keptEl,
            [...this.keptCards.values()].map((entry) => entry.card),
            this.t,
            {
                open: (path) => {
                    void this.app.workspace.openLinkText(path, '', false);
                    this.close();
                },
                removeAndDelete: (filePath) => { void this.startUnlinkFlow(filePath); },
                enableRemoval: (filePath) => { void this.enableRemovalAndStart(filePath); },
                scanAgain: () => {
                    this.close();
                    this.ctx?.onRescan?.();
                },
            },
            this.busy,
        );
    }

    private renderNotReady(): void {
        if (!this.notReadyEl) return;
        this.notReadyEl.empty();
        if (!this.notReadyPaths) return;
        const es = this.t.embedScan;
        const row = this.notReadyEl.createDiv({ cls: 'ai-organiser-embed-scan-banner', attr: { role: 'status' } });
        row.createSpan({ text: `${es.notReadyText} ${es.notReadyHint}` });
        const retry = row.createEl('button', { text: es.notReadyRetry, attr: { type: 'button' } });
        retry.disabled = this.busy;
        this.renderCleanups.push(listen(retry, 'click', () => this.retryNotReady()));
    }

    private retryNotReady(): void {
        const files = (this.notReadyPaths ?? [])
            .map((path) => this.app.vault.getAbstractFileByPath(path))
            .filter((f): f is TFile => f instanceof TFile);
        this.notReadyPaths = null;
        this.applyFiltersAndRender();
        if (files.length > 0) void this.revalidateAndConfirm(files);
    }

    /** One click on the card: turn the setting on, then carry on to the preview. */
    private async enableRemovalAndStart(filePath: string): Promise<void> {
        const plugin = this.ctx?.plugin;
        if (!plugin || this.busy) return;
        this.busy = true;
        this.applyFiltersAndRender();
        plugin.settings.attachmentAllowLinkRemoval = true;
        try {
            await plugin.saveSettings();
        } catch {
            plugin.settings.attachmentAllowLinkRemoval = false;
            new Notice(formatGuidance(describeError(this.t, 'write-failed')), 8000);
            this.busy = false;
            this.applyFiltersAndRender();
            return;
        }
        this.busy = false;
        if (this.closed) return;
        this.refreshKeptCards();
        this.applyFiltersAndRender();
        await this.startUnlinkFlow(filePath);
    }

    /**
     * Plan the removal of every link to a kept file from the notes that hold them, and show it. Nothing is
     * written until Apply; a note that cannot be edited safely (protected, or the link sits in a code block or
     * the properties) stops the whole action with a reason.
     */
    private async startUnlinkFlow(filePath: string): Promise<void> {
        const plugin = this.ctx?.plugin;
        const entry = this.keptCards.get(filePath);
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!plugin || !entry || !(file instanceof TFile) || this.busy) return;
        if (!isLinkRemovalEnabled(plugin.settings)) {
            new Notice(formatGuidance(describeError(this.t, 'link-removal-off')), 8000);
            return;
        }
        this.busy = true;
        this.applyFiltersAndRender();
        let handedOff = false;
        let alreadyGone = false;
        try {
            const resolve = (linktext: string, sourcePath: string): string | null =>
                this.app.metadataCache.getFirstLinkpathDest(linktext, sourcePath)?.path ?? null;
            const plans: NotePlan[] = [];
            for (const notePath of new Set((entry.eligibility.blockers?.referrers ?? []).map((r) => r.path))) {
                const note = this.app.vault.getAbstractFileByPath(notePath);
                if (!(note instanceof TFile) || !assertWritable(plugin.settings, 'modify', notePath).ok) {
                    new Notice(formatGuidance(describeError(this.t, 'protected-path')), 8000);
                    return;
                }
                const planned = planLinkRemoval(await this.app.vault.read(note), filePath, notePath, resolve);
                if (planned.status === 'not-removable') {
                    // Say it on the card as well as in the notice, which fades: the button goes and the reason stays.
                    this.keptCards.set(filePath, {
                        ...entry,
                        linksRemovable: false,
                        card: describeKept({ path: filePath, name: file.name, sizeBytes: file.stat.size }, entry.eligibility, this.keptContext(), { linksRemovable: false }),
                    });
                    new Notice(`${formatGuidance(describeError(this.t, 'link-not-removable'))} ${notePath}`, 10000);
                    return;
                }
                if (planned.status === 'ok') plans.push(planned.plan);
            }
            if (this.closed) return;
            if (plans.length === 0) {
                // The links are already gone: just check the file again (after the lock is released).
                alreadyGone = true;
                return;
            }
            // The lock stays on while the preview is open; Apply hands it to the job, closing it releases it.
            new RemoveLinkPreviewModal(
                this.app, this.t, file.name, plans,
                () => { void this.runUnlink(file, plans); },
                () => { this.busy = false; this.applyFiltersAndRender(); },
            ).open();
            handedOff = true;
        } catch {
            new Notice(formatGuidance(describeError(this.t, 'unlink-failed')), 8000);
        } finally {
            if (!handedOff) {
                this.busy = false;
                this.applyFiltersAndRender();
                if (alreadyGone && !this.closed) void this.revalidateAndConfirm([file]);
            }
        }
    }

    /**
     * Apply the approved plan. The job belongs to the service, not to this window: closing the window stops
     * it before the NEXT note (a note write is never interrupted) and the outcome is still announced.
     */
    private async runUnlink(file: TFile, plans: NotePlan[]): Promise<void> {
        const plugin = this.ctx?.plugin;
        if (!plugin) return;
        // The lock was taken when the flow started and is still held (the preview kept it).
        this.busy = true;
        this.applyFiltersAndRender();
        const res = await removeLinks(plugin, file.path, plans, { shouldContinue: () => !this.closed });
        announceUnlink(this.t, res, plans.length);
        if (this.closed) return;
        this.busy = false;
        if (res.ok && res.value.errors.some((e) => e.error === 'stale')) {
            // A note changed after the preview: nothing in it was written. Show the updated plan for a fresh Apply.
            this.applyFiltersAndRender();
            void this.startUnlinkFlow(file.path);
            return;
        }
        // Removing the links is not deleting: check again, and only a file that is now safe reaches the confirmation.
        await this.revalidateAndConfirm([file]);
    }

    private getSelectedFiles(): TFile[] {
        const files: TFile[] = [];
        for (const path of this.selectedPaths) {
            const file = this.app.vault.getAbstractFileByPath(path);
            if (file instanceof TFile) files.push(file);
        }
        return files;
    }

    private async executeDelete(candidates: TFile[]): Promise<void> {
        const embedScan = this.t.embedScan;
        let deletedCount = 0;

        // Confirmation approves a specific validated state. A reference may have appeared while
        // the dialog was open, so check again immediately before trashing.
        const checked = await this.checkSafe(candidates);
        if (this.closed) return;
        if (!this.recordCheck(candidates, checked)) return;
        const files = checked.safe;

        this.busy = true;
        try {
            let first = true;
            for (const file of files) {
                // Moving large files takes a while; the first verdict is not used for the later files.
                if (!first) {
                    const fresh = await this.checkSafe([file]);
                    if (this.closed) return;
                    const decided = this.recordCheck([file], fresh);
                    if (!decided) break; // not ready or failed: stop, nothing else is trashed on an old verdict
                    if (fresh.safe.length === 0) continue; // kept now, with its card
                }
                first = false;
                try {
                    if (!assertWritable(this.ctx?.plugin.settings, 'delete', file.path).ok) {
                        new Notice(formatGuidance(describeError(this.t, 'protected-path')), 6000);
                        continue;
                    }
                    await this.app.fileManager.trashFile(file);
                    deletedCount++;
                    // Remove from scan result
                    this.removeFromScanResult(file.path);
                    this.selectedPaths.delete(file.path);
                    this.keptCards.delete(file.path);
                } catch {
                    new Notice(embedScan.deleteError.replace('{file}', file.name));
                }
            }
        } finally {
            this.busy = false;
        }

        if (deletedCount > 0) {
            new Notice(plural(embedScan.deleteSuccess, deletedCount));
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

    private createCheckbox(container: HTMLElement, path: string, enabled = true): HTMLElement {
        const checkbox = container.createEl('input', {
            type: 'checkbox',
            cls: 'ai-organiser-embed-scan-checkbox',
        });
        checkbox.checked = enabled && this.selectedPaths.has(path);
        checkbox.disabled = !enabled;
        checkbox.setAttribute('aria-label', this.t.embedScan.selectFile);
        this.renderCleanups.push(listen(checkbox, 'click', (e) => {
            e.stopPropagation(); // Don't toggle row expand
        }));
        this.renderCleanups.push(listen(checkbox, 'keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation(); // Don't trigger row expand/navigate
            }
        }));
        this.renderCleanups.push(listen(checkbox, 'change', () => {
            if (checkbox.checked) {
                this.selectedPaths.add(path);
            } else {
                this.selectedPaths.delete(path);
            }
            this.updateSelectionToolbar();
        }));
        return checkbox;
    }

    // ─── Badges ──────────────────────────────────────────────────────────────

    /** "Large" and "Duplicate" badges. */
    private renderFlagBadges(container: HTMLElement, file: TFile | null, sizeBytes: number): void {
        const es = this.t.embedScan;
        if (sizeBytes >= this.largeBytes) {
            container.createSpan({ cls: 'ai-organiser-embed-scan-badge large', text: es.largeBadge });
        }
        if (file) {
            const members = this.duplicateOf.get(file.path);
            const others = members?.filter((p) => p !== file.path);
            if (others && others.length > 0) {
                const badge = container.createSpan({ cls: 'ai-organiser-embed-scan-badge duplicate', text: es.duplicateBadge });
                badge.setAttribute('title', es.duplicateBadgeTitle.replace('{others}', others.join(', ')));
            }
        }
    }

    // ─── Out-of-date banner, could-not-read group ────────────────────────────

    private registerVaultEvents(): void {
        const touch = () => { if (!this.stale) { this.stale = true; this.renderBanner(); } };
        const vault = this.app.vault;
        this.vaultRefs.push(
            vault.on('modify', (f) => { this.changeLog.recordModify(f.path); touch(); }),
            vault.on('create', (f) => { this.changeLog.recordCreate(f.path); touch(); }),
            vault.on('delete', (f) => { this.changeLog.recordDelete(f.path); touch(); }),
            vault.on('rename', (f, oldPath) => { this.changeLog.recordRename(oldPath, f.path); touch(); }),
        );
    }

    private renderBanner(): void {
        if (!this.bannerEl) return;
        this.bannerEl.empty();
        if (!this.stale) {
            this.bannerEl.addClass('hidden');
            return;
        }
        this.bannerEl.removeClass('hidden');
        this.bannerEl.createSpan({ text: this.t.embedScan.outOfDate });
        if (this.ctx?.onRescan) {
            const btn = this.bannerEl.createEl('button', { text: this.t.embedScan.scanAgain, attr: { type: 'button' } });
            this.renderCleanups.push(listen(btn, 'click', () => {
                this.close();
                this.ctx?.onRescan?.();
            }));
        }
    }

    private renderCouldNotRead(): void {
        if (!this.couldNotReadEl) return;
        this.couldNotReadEl.empty();
        const failures = this.scanResult.coverageFailures ?? [];
        if (failures.length === 0) return;
        const es = this.t.embedScan;
        const details = this.couldNotReadEl.createEl('details', { cls: 'ai-organiser-embed-scan-orphan-section' });
        details.open = true;
        const summary = details.createEl('summary', { cls: 'ai-organiser-embed-scan-orphan-summary' });
        const icon = summary.createSpan({ cls: 'ai-organiser-embed-scan-orphan-icon' });
        setIcon(icon, 'alert-triangle');
        summary.createSpan({ text: `${es.couldNotReadTitle} (${failures.length})` });
        details.createDiv({ cls: 'ai-organiser-embed-scan-orphan-disclaimer', text: es.couldNotReadHelp });
        const list = details.createEl('ul');
        for (const failure of failures) list.createEl('li', { text: failure.path });
    }

    // ─── Duplicate analysis (opt-in) ─────────────────────────────────────────

    private renderTools(): void {
        if (!this.toolsEl || !this.ctx || this.closed) return;
        const es = this.t.embedScan;
        // Progress re-renders this row many times: dispose the previous listeners instead of piling them up.
        for (const dispose of this.toolsCleanups) dispose();
        this.toolsCleanups = [];
        this.toolsEl.empty();
        const running = this.duplicateProgress !== null;
        if (!running) {
            const btn = this.toolsEl.createEl('button', { text: es.findDuplicates, attr: { type: 'button', 'aria-label': es.findDuplicates } });
            this.toolsCleanups.push(listen(btn, 'click', () => { void this.runDuplicates(); }));
            this.toolsEl.createSpan({ cls: 'setting-item-description', text: es.findDuplicatesHelp });
        } else {
            this.toolsEl.createSpan({
                text: es.duplicatesRunning
                    .replace('{done}', String(this.duplicateProgress!.done))
                    .replace('{total}', String(this.duplicateProgress!.total)),
            });
            const stop = this.toolsEl.createEl('button', { text: es.duplicatesCancel, attr: { type: 'button' } });
            this.toolsCleanups.push(listen(stop, 'click', () => this.duplicateAbort?.abort()));
        }
        const result = this.duplicates;
        if (result && !running) {
            const lines: string[] = [];
            if (result.cancelled) lines.push(es.duplicatesStopped);
            lines.push(result.groups.length === 0
                ? es.duplicatesNone
                : plural(es.duplicatesFound, result.groups.length));
            if (result.notAnalysed.length > 0) lines.push(plural(es.duplicatesSkipped, result.notAnalysed.length));
            this.toolsEl.createDiv({ cls: 'ai-organiser-embed-scan-duplicate-summary', text: lines.join(' '), attr: { role: 'status' } });
        }
    }

    private async runDuplicates(): Promise<void> {
        const plugin = this.ctx?.plugin;
        if (!plugin) return;
        const files = new Map<string, TFile>();
        for (const target of this.scanResult.targets) if (target.file) files.set(target.file.path, target.file);
        for (const orphan of this.scanResult.possiblyOrphaned) files.set(orphan.path, orphan);
        const list = [...files.values()].map((f) => ({ path: f.path, size: f.stat.size }));
        this.duplicateAbort = new AbortController();
        this.duplicateProgress = { done: 0, total: list.length };
        this.renderTools();
        const analysed = await analyseDuplicates(
            list,
            { readBinary: async (path) => {
                const f = files.get(path);
                if (!f) throw new Error('missing');
                return this.app.vault.readBinary(f);
            } },
            {
                maxBytes: plugin.settings.attachmentDuplicateMaxMB * 1024 * 1024,
                signal: this.duplicateAbort.signal,
                onProgress: (done, total) => {
                    this.duplicateProgress = { done, total };
                    this.renderTools();
                },
            },
        );
        this.duplicateProgress = null;
        this.duplicateAbort = null;
        if (this.closed) return;
        if (!analysed.ok) {
            new Notice(formatGuidance(describeError(this.t, analysed.error)), 8000);
            this.renderTools();
            return;
        }
        const result = analysed.value;
        this.duplicates = result;
        this.duplicateOf = new Map();
        for (const group of result.groups) {
            // One shared array per group (not one peer list per file); a row removes itself when it needs "the others".
            for (const path of group.paths) this.duplicateOf.set(path, group.paths);
        }
        this.renderChipRow();
        this.applyFiltersAndRender();
    }

    // ─── Suggest a home note ─────────────────────────────────────────────────

    private renderSuggestHome(list: HTMLElement, row: HTMLElement, file: TFile): void {
        const es = this.t.embedScan;
        const state = this.suggestions.get(file.path);
        const btn = row.createEl('button', {
            text: es.suggestHome,
            cls: 'ai-organiser-embed-scan-action-btn',
            attr: { type: 'button', 'aria-label': `${es.suggestHome}: ${file.name}` },
        });
        this.renderCleanups.push(listen(btn, 'click', (e) => {
            e.stopPropagation();
            void this.loadSuggestion(file);
        }));
        // Enter / Space on the button must not also activate the row it sits in.
        this.renderCleanups.push(listen(btn, 'keydown', (e) => { e.stopPropagation(); }));
        if (!state) return;
        const panel = list.createDiv({ cls: 'ai-organiser-embed-scan-suggestions' });
        row.after(panel);
        if (state.status === 'loading') {
            panel.createSpan({ text: es.suggestHomeLoading, attr: { role: 'status' } });
            return;
        }
        if (state.status === 'error') {
            panel.createSpan({ text: es.suggestHomeError, attr: { role: 'status' } });
            return;
        }
        const { suggestion } = state;
        if (suggestion.candidates.length === 0) {
            panel.createSpan({ text: es.suggestHomeNone, attr: { role: 'status' } });
        }
        if (suggestion.egressDeclined) panel.createDiv({ cls: 'setting-item-description', text: es.suggestHomeDeclined });
        for (const cand of suggestion.candidates) {
            const item = panel.createDiv({ cls: 'ai-organiser-embed-scan-suggestion' });
            item.createSpan({ text: cand.title, cls: 'ai-organiser-embed-scan-filename' });
            item.createSpan({ text: cand.path, cls: 'ai-organiser-embed-scan-path' });
            item.createSpan({
                cls: 'ai-organiser-embed-scan-badge',
                text: cand.method === 'semantic' ? es.suggestHomeSemantic : es.suggestHomeBasic,
            });
            const link = item.createEl('button', {
                text: es.linkButton,
                cls: 'ai-organiser-embed-scan-action-btn',
                attr: { type: 'button', 'aria-label': es.linkAriaLabel.replace('{file}', file.name).replace('{note}', cand.title) },
            });
            if (cand.protected) {
                link.disabled = true;
                link.setAttribute('aria-description', es.protectedNotLinkable);
                link.setAttribute('title', es.protectedNotLinkable);
                item.createSpan({ cls: 'ai-organiser-embed-scan-lock', text: es.protectedNotLinkable });
            } else {
                this.renderCleanups.push(listen(link, 'click', () => { void this.linkCandidate(file, cand.path, cand.title); }));
            }
        }
    }

    private async loadSuggestion(file: TFile): Promise<void> {
        const plugin = this.ctx?.plugin;
        if (!plugin) return;
        this.suggestions.set(file.path, { status: 'loading' });
        this.applyFiltersAndRender();
        const res = await suggestHomes(createHomeContext(plugin, () => this.confirmEgress()), file.path);
        if (this.closed) return;
        this.suggestions.set(file.path, res.ok ? { status: 'done', suggestion: res.value } : { status: 'error' });
        this.applyFiltersAndRender();
    }

    /** Ask once per session whether text may go to the (external) embedding provider. */
    private confirmEgress(): Promise<boolean> {
        const es = this.t.embedScan;
        const provider = this.ctx?.plugin.settings.embeddingProvider ?? '';
        const remembered = sessionEgressChoice.get(provider);
        if (remembered !== undefined) return Promise.resolve(remembered);
        const body = es.egressBody.replaceAll('{provider}', provider).replace('{chars}', HOME_QUERY_CHARS.toLocaleString('en-US'));
        return new Promise<boolean>((resolve) => {
            new EgressModal(this.app, es.egressTitle.replace('{provider}', provider), body, es.egressSend, es.egressBasic, (choice) => {
                sessionEgressChoice.set(provider, choice);
                resolve(choice);
            }).open();
        });
    }

    private async linkCandidate(file: TFile, notePath: string, noteTitle: string): Promise<void> {
        const plugin = this.ctx?.plugin;
        if (!plugin) return;
        const es = this.t.embedScan;
        const res = await linkToNote(plugin, file.path, notePath, plugin.settings.attachmentLinkHeading);
        if (!res.ok) {
            new Notice(formatGuidance(describeError(this.t, res.error)), 8000);
            return;
        }
        new Notice((res.value.changed ? es.linkedNotice : es.alreadyLinkedNotice).replace('{note}', noteTitle), 5000);
    }

    onClose(): void {
        this.closed = true;
        for (const dispose of this.toolsCleanups) dispose();
        this.toolsCleanups = [];
        for (const dispose of this.renderCleanups) dispose();
        this.renderCleanups = [];
        for (const dispose of this.toolbarCleanups) dispose();
        this.toolbarCleanups = [];
        this.duplicateAbort?.abort();
        for (const dispose of this.chipCleanups) dispose();
        this.chipCleanups = [];
        for (const dispose of this.keptCleanups) dispose();
        this.keptCleanups = [];
        for (const ref of this.vaultRefs) this.app.vault.offref(ref);
        this.vaultRefs = [];
        for (const cleanup of this.cleanups) cleanup();
        this.cleanups = [];
        this.contentEl.empty();
    }
}

// ─── Remove-the-link outcome ────────────────────────────────────────────────

/** Tell the user what happened. Touches nothing of the results window, so it is safe after the window closed. */
function announceUnlink(t: Translations, res: Result<BatchResult<UnlinkOutcome>>, total: number): void {
    const es = t.embedScan;
    if (!res.ok) {
        new Notice(formatGuidance(describeError(t, res.error === 'link-removal-off' ? 'link-removal-off' : 'unlink-failed')), 8000);
        return;
    }
    const written = res.value.items.length;
    if (written === total) {
        new Notice(plural(es.unlinkDone, written), 5000);
        return;
    }
    const blocked = res.value.errors.find((x) => x.error !== 'skipped');
    const code = blocked?.error === 'stale' ? 'link-changed' : blocked?.error === 'refused-protected' ? 'protected-path' : 'unlink-failed';
    new Notice(`${es.unlinkPartial.replace('{done}', String(written)).replace('{total}', String(total))} ${formatGuidance(describeError(t, code))}`, 10000);
}

// ─── Egress confirmation ───────────────────────────────────────────────────

class EgressModal extends Modal {
    private decided = false;

    constructor(
        app: App,
        private readonly title: string,
        private readonly body: string,
        private readonly sendLabel: string,
        private readonly basicLabel: string,
        private readonly onChoice: (send: boolean) => void,
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: this.title });
        contentEl.createEl('p', { text: this.body });
        const buttons = contentEl.createDiv({ cls: 'ai-organiser-embed-scan-buttons' });
        const basic = buttons.createEl('button', { text: this.basicLabel, cls: 'mod-cta', attr: { type: 'button' } });
        const send = buttons.createEl('button', { text: this.sendLabel, attr: { type: 'button' } });
        basic.addEventListener('click', () => { this.decide(false); });
        send.addEventListener('click', () => { this.decide(true); });
    }

    private decide(send: boolean): void {
        this.decided = true;
        this.onChoice(send);
        this.close();
    }

    onClose(): void {
        // Esc or the close button means "do not send".
        if (!this.decided) this.onChoice(false);
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
            text: plural(embedScan.deleteConfirmTitle, this.files.length),
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

        // What was and was not checked, with an acknowledgement before the confirm button works.
        contentEl.createEl('p', { text: embedScan.coverageNote, cls: 'ai-organiser-embed-scan-confirm-warning' });
        const ackRow = contentEl.createDiv({ cls: 'ai-organiser-embed-scan-ack' });
        const ack = ackRow.createEl('input', { type: 'checkbox', attr: { id: 'ai-organiser-embed-scan-ack' } });
        ackRow.createEl('label', { text: embedScan.coverageAcknowledge, attr: { for: 'ai-organiser-embed-scan-ack' } });

        // Buttons
        const buttons = contentEl.createDiv({ cls: 'ai-organiser-embed-scan-buttons' });
        const cancelBtn = buttons.createEl('button', { text: embedScan.cancelButton });
        cancelBtn.addEventListener('click', () => this.close());

        const confirmBtn = buttons.createEl('button', {
            text: embedScan.deleteSelected,
            cls: 'mod-warning',
        });
        confirmBtn.disabled = true;
        ack.addEventListener('change', () => { confirmBtn.disabled = !ack.checked; });
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
