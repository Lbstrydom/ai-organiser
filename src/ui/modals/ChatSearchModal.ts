import { App, Modal, setIcon } from 'obsidian';
import type { Translations } from '../../i18n/types';
import type { ChatSearchService, SearchResult, SearchFilters, ExcerptSegment } from '../../services/chat/chatSearchService';
import type { ChatMode } from '../chat/ChatModeHandler';
import { listen } from '../utils/domUtils';

export interface ChatSearchCallbacks {
    onSelect: (filePath: string, projectId?: string) => void;
}

const MODE_ICONS: Record<string, string> = {
    free: 'message-square',
    research: 'globe',
    presentation: 'presentation',
    note: 'file-text',
    vault: 'library',
    highlight: 'highlighter',
};

const MODE_LABELS: Record<string, string> = {
    free: 'Free chat',
    research: 'Research',
    presentation: 'Slides',
    note: 'Note',
    vault: 'Vault',
    highlight: 'Highlight',
};

/** Time filter presets mapped to dateRange values. */
const TIME_FILTERS: { label: string; value: string }[] = [
    { label: 'Any time', value: 'all' },
    { label: 'Past week', value: 'week' },
    { label: 'Past month', value: 'month' },
    { label: 'Past quarter', value: 'quarter' },
    { label: 'Past year', value: 'year' },
];

const DEBOUNCE_MS = 300;
const MAX_TITLE_LENGTH = 80;

export class ChatSearchModal extends Modal {
    private searchService: ChatSearchService;
    private callbacks: ChatSearchCallbacks;
    private t: Translations;

    // State
    private query = '';
    private filters: SearchFilters = {};
    private results: SearchResult[] = [];
    private selectedIndex = 0;
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private searchGeneration = 0;

    // DOM refs
    private inputEl!: HTMLInputElement;
    private resultsEl!: HTMLElement;
    private countEl!: HTMLElement;

    // Cleanup
    private cleanups: (() => void)[] = [];

    constructor(
        app: App,
        t: Translations,
        searchService: ChatSearchService,
        callbacks: ChatSearchCallbacks,
    ) {
        super(app);
        this.t = t;
        this.searchService = searchService;
        this.callbacks = callbacks;
    }

    onOpen(): void {
        const { contentEl, modalEl } = this;
        modalEl.addClass('ai-organiser-chat-search-modal');
        contentEl.empty();

        // --- Search input ---
        const inputWrapper = contentEl.createDiv({ cls: 'ai-organiser-chat-search-input-wrapper' });
        const searchIconEl = inputWrapper.createSpan({ cls: 'ai-organiser-chat-search-input-icon' });
        setIcon(searchIconEl, 'search');
        this.inputEl = inputWrapper.createEl('input', {
            cls: 'ai-organiser-chat-search-input',
            attr: {
                type: 'text',
                placeholder: 'Search conversations...',
                'aria-label': 'Search conversations',
            },
        });

        this.cleanups.push(listen(this.inputEl, 'input', () => {
            this.query = this.inputEl.value;
            this.scheduleSearch();
        }));

        // --- Filter row ---
        const filterRow = contentEl.createDiv({ cls: 'ai-organiser-chat-search-filters' });

        // Mode filter
        const modeSelect = filterRow.createEl('select', {
            cls: 'ai-organiser-chat-search-filter-select dropdown',
            attr: { 'aria-label': 'Filter by mode' },
        });
        modeSelect.createEl('option', { text: 'All modes', attr: { value: '' } });
        for (const [mode, label] of Object.entries(MODE_LABELS)) {
            modeSelect.createEl('option', { text: label, attr: { value: mode } });
        }
        this.cleanups.push(listen(modeSelect, 'change', () => {
            const value = modeSelect.value as ChatMode | '';
            this.filters = { ...this.filters, mode: value || undefined };
            void this.executeSearch();
        }));

        // Time filter
        const timeSelect = filterRow.createEl('select', {
            cls: 'ai-organiser-chat-search-filter-select dropdown',
            attr: { 'aria-label': 'Filter by time' },
        });
        for (const preset of TIME_FILTERS) {
            timeSelect.createEl('option', { text: preset.label, attr: { value: preset.value } });
        }
        this.cleanups.push(listen(timeSelect, 'change', () => {
            const val = timeSelect.value;
            this.filters = {
                ...this.filters,
                dateRange: val === 'all' ? undefined : val as SearchFilters['dateRange'],
            };
            void this.executeSearch();
        }));

        // --- Results container ---
        this.resultsEl = contentEl.createDiv({
            cls: 'ai-organiser-chat-search-results',
            attr: { role: 'listbox', 'aria-label': 'Search results' },
        });

        // --- Count ---
        this.countEl = contentEl.createDiv({ cls: 'ai-organiser-chat-search-count' });

        // --- Keyboard navigation ---
        this.cleanups.push(listen(this.modalEl, 'keydown', (e: KeyboardEvent) => {
            this.handleKeydown(e);
        }));

        // Focus input
        this.inputEl.focus();

        // Show recent conversations initially
        void this.executeSearch();
    }

    onClose(): void {
        // Clear debounce timer
        if (this.debounceTimer !== null) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }

        // Run cleanups
        for (const cleanup of this.cleanups) cleanup();
        this.cleanups = [];

        // Clear service cache
        this.searchService.clearCache();

        // Clear DOM
        this.contentEl.empty();
    }

    // ---- Private ----

    private scheduleSearch(): void {
        if (this.debounceTimer !== null) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            void this.executeSearch();
        }, DEBOUNCE_MS);
    }

    private async executeSearch(): Promise<void> {
        const gen = ++this.searchGeneration;
        const effectiveFilters: SearchFilters = {
            ...this.filters,
        };
        const result = await this.searchService.search(this.query, effectiveFilters);
        // Discard stale results if a newer search was triggered while awaiting
        if (gen !== this.searchGeneration) return;
        if (!result.ok) {
            this.renderError(result.error);
            return;
        }
        this.results = result.value;
        this.selectedIndex = 0;
        this.renderResults();
    }

    private renderResults(): void {
        this.resultsEl.empty();

        if (this.results.length === 0) {
            const emptyEl = this.resultsEl.createDiv({ cls: 'ai-organiser-chat-search-empty' });
            emptyEl.setText(
                this.query.trim()
                    ? 'No conversations found'
                    : 'No conversations yet',
            );
            this.countEl.setText('');
            return;
        }

        for (let i = 0; i < this.results.length; i++) {
            const sr = this.results[i];
            const row = this.resultsEl.createDiv({
                cls: 'ai-organiser-chat-search-result',
                attr: {
                    role: 'option',
                    'aria-selected': String(i === this.selectedIndex),
                    tabindex: '0',
                },
            });

            if (i === this.selectedIndex) {
                row.addClass('is-selected');
            }

            // Mode icon
            const iconEl = row.createSpan({ cls: 'ai-organiser-chat-search-result-icon' });
            setIcon(iconEl, MODE_ICONS[sr.mode] ?? 'message-square');

            // Content wrapper
            const content = row.createDiv({ cls: 'ai-organiser-chat-search-result-content' });

            // Title
            const titleText = sr.title.length > MAX_TITLE_LENGTH
                ? sr.title.slice(0, MAX_TITLE_LENGTH) + '...'
                : sr.title;
            content.createDiv({ cls: 'ai-organiser-chat-search-title', text: titleText });

            // Meta line
            const metaParts: string[] = [];
            metaParts.push(MODE_LABELS[sr.mode] ?? sr.mode);
            if (sr.projectName) {
                metaParts.push(sr.projectName);
            }
            metaParts.push(this.formatTimeAgo(sr.updatedAt));
            metaParts.push(`${sr.messageCount} msgs`);
            content.createDiv({
                cls: 'ai-organiser-chat-search-meta',
                text: metaParts.join(' \u00B7 '),
            });

            // Excerpt with highlighted matches
            if (sr.excerptSegments && sr.excerptSegments.length > 0) {
                const excerptEl = content.createDiv({ cls: 'ai-organiser-chat-search-excerpt' });
                this.renderExcerpt(excerptEl, sr.excerptSegments);
            }

            // Click handler
            const idx = i;
            this.cleanups.push(listen(row, 'click', () => {
                this.selectResult(idx);
            }));
        }

        // Count
        this.countEl.setText(`Showing ${this.results.length} conversation${this.results.length === 1 ? '' : 's'}`);
    }

    private renderExcerpt(container: HTMLElement, segments: ExcerptSegment[]): void {
        for (const seg of segments) {
            if (seg.highlight) {
                container.createEl('mark', { text: seg.text });
            } else {
                container.createEl('span', { text: seg.text });
            }
        }
    }

    private renderError(message: string): void {
        this.resultsEl.empty();
        const errorEl = this.resultsEl.createDiv({ cls: 'ai-organiser-chat-search-error' });
        errorEl.setText(`Could not search: ${message}`);
        this.countEl.setText('');
    }

    private handleKeydown(e: KeyboardEvent): void {
        if (this.results.length === 0) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            this.selectedIndex = Math.min(this.selectedIndex + 1, this.results.length - 1);
            this.updateSelection();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
            this.updateSelection();
        } else if (e.key === 'Enter' && this.results.length > 0) {
            e.preventDefault();
            this.selectResult(this.selectedIndex);
        }
    }

    private updateSelection(): void {
        const rows = this.resultsEl.querySelectorAll<HTMLElement>('.ai-organiser-chat-search-result');
        rows.forEach((row, i) => {
            if (i === this.selectedIndex) {
                row.addClass('is-selected');
                row.setAttribute('aria-selected', 'true');
                row.scrollIntoView({ block: 'nearest' });
            } else {
                row.removeClass('is-selected');
                row.setAttribute('aria-selected', 'false');
            }
        });
    }

    private selectResult(index: number): void {
        const sr = this.results[index];
        if (!sr) return;
        this.callbacks.onSelect(sr.filePath, sr.projectId);
        this.close();
    }

    private formatTimeAgo(isoString: string): string {
        const diff = Date.now() - new Date(isoString).getTime();
        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        const weeks = Math.floor(days / 7);

        if (weeks > 0) return `${weeks}w ago`;
        if (days > 0) return `${days}d ago`;
        if (hours > 0) return `${hours}h ago`;
        return `${minutes}m ago`;
    }
}
