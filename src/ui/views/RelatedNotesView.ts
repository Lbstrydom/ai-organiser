/**
 * Related Notes View
 * Sidebar panel showing notes semantically similar to the current note
 * Defaults to current folder scope with pin/unpin for manual override
 */

import { ItemView, TFile, TFolder, WorkspaceLeaf, Menu, Notice } from 'obsidian';
import AIOrganiserPlugin from '../../main';
import { RAGService } from '../../services/ragService';
import { SearchResult } from '../../services/vector/types';
import { FolderScopePickerModal } from '../modals/FolderScopePickerModal';

export const RELATED_NOTES_VIEW_TYPE = 'related-notes-view';

interface RelatedNotesState {
    currentFilePath?: string;
    results: SearchResult[];
    isLoading: boolean;
    error?: string;
    timestamp?: number;
    folderScope: string | null;   // null = whole vault
    lastFetchedScope?: string | null; // scope used for last successful fetch
    scopePinned: boolean;         // true = user manually chose scope
}

/**
 * Related Notes sidebar view
 * Shows semantically similar notes with similarity scores
 */
export class RelatedNotesView extends ItemView {
    private plugin: AIOrganiserPlugin;
    private ragService: RAGService | null = null;
    private state: RelatedNotesState = {
        results: [],
        isLoading: false,
        folderScope: null,
        scopePinned: false
    };
    private debounceTimer: NodeJS.Timeout | null = null;
    private readonly DEBOUNCE_MS = 500;
    private resultContainer: HTMLElement | null = null;
    private headerContainer: HTMLElement | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: AIOrganiserPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.initializeRAGService();
    }

    private initializeRAGService(): void {
        if (this.plugin.vectorStore && this.plugin.settings.enableSemanticSearch) {
            this.ragService = new RAGService(
                this.plugin.vectorStore,
                this.plugin.settings,
                this.plugin.embeddingService
            );
        }
    }

    getViewType(): string {
        return RELATED_NOTES_VIEW_TYPE;
    }

    getDisplayText(): string {
        const t = this.plugin.t?.modals?.relatedNotes;
        return t?.title || 'Related Notes';
    }

    getIcon(): string {
        return 'link-2';
    }

    async onOpen(): Promise<void> {
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        container.addClass('related-notes-view-container');

        // Derive initial folder scope from active file before first fetch
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile && !this.state.scopePinned) {
            this.state.folderScope = this.normalizeFolderPath(activeFile.parent?.path);
        }

        // Header
        this.headerContainer = container;
        this.renderHeader(container);

        // Result container
        this.resultContainer = container.createEl('div', { cls: 'related-notes-results' });

        // Initial render
        this.updateRelatedNotes();

        // Register event listener for note changes
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                this.onActiveNoteChanged();
            })
        );

        // Handle folder renames — update scope if the pinned folder was renamed
        this.registerEvent(
            this.app.vault.on('rename', (file, oldPath) => {
                if (!this.state.scopePinned || !this.state.folderScope) return;
                if (!(file instanceof TFolder)) return;
                if (this.state.folderScope === oldPath || this.state.folderScope.startsWith(oldPath + '/')) {
                    this.state.folderScope = this.state.folderScope.replace(oldPath, file.path);
                    this.rerenderHeader();
                    this.updateRelatedNotes(true);
                }
            })
        );

        // Handle folder deletions — reset to auto-follow
        this.registerEvent(
            this.app.vault.on('delete', (file) => {
                if (!(file instanceof TFolder)) return;
                if (this.state.folderScope === file.path || this.state.folderScope?.startsWith(file.path + '/')) {
                    this.state.scopePinned = false;
                    this.state.folderScope = this.normalizeFolderPath(this.app.workspace.getActiveFile()?.parent?.path);
                    this.rerenderHeader();
                    this.updateRelatedNotes(true);
                }
            })
        );
    }

    private normalizeFolderPath(path: string | undefined | null): string | null {
        if (!path || path === '/' || path === '') return null;
        return path;
    }

    private rerenderHeader(): void {
        if (!this.headerContainer) return;
        // Remove old header
        const oldHeader = this.headerContainer.querySelector('.related-notes-header');
        if (oldHeader) oldHeader.remove();
        // Re-render before result container
        this.renderHeader(this.headerContainer);
    }

    private renderHeader(container: HTMLElement): void {
        const t = this.plugin.t?.modals?.relatedNotes;
        const header = container.createEl('div', { cls: 'related-notes-header' });

        // Left group: title + scope button
        const leftGroup = header.createEl('div', { cls: 'related-notes-header-left' });
        leftGroup.createEl('h3', { text: t?.title || 'Related Notes', cls: 'related-notes-title' });

        // Scope button
        const scopeBtn = leftGroup.createEl('button', {
            cls: 'clickable-icon related-notes-scope-btn',
            title: this.state.folderScope
                ? (t?.scopeFolder || 'Current folder')
                : (t?.scopeAllNotes || 'All notes')
        });
        scopeBtn.textContent = this.getScopeDisplayText();
        scopeBtn.addEventListener('click', () => this.showFolderPicker());

        // Pin button (only shown when scoped to a folder)
        if (this.state.folderScope !== null) {
            const pinBtn = leftGroup.createEl('button', {
                cls: `clickable-icon related-notes-pin-btn${this.state.scopePinned ? ' is-pinned' : ''}`,
                title: this.state.scopePinned
                    ? (t?.unpinScope || 'Unpin (follow active note)')
                    : (t?.pinScope || 'Pin scope')
            });
            pinBtn.textContent = this.state.scopePinned ? '📌' : '📍';
            pinBtn.addEventListener('click', () => {
                if (this.state.scopePinned) {
                    // Unpin → revert to current file's folder
                    this.state.scopePinned = false;
                    const activeFile = this.app.workspace.getActiveFile();
                    this.state.folderScope = this.normalizeFolderPath(activeFile?.parent?.path);
                    this.rerenderHeader();
                    this.updateRelatedNotes(true);
                } else {
                    // Pin current scope
                    this.state.scopePinned = true;
                    this.rerenderHeader();
                }
            });
        }

        // Right group: controls
        const controls = header.createEl('div', { cls: 'related-notes-controls' });

        // Refresh button
        const refreshBtn = controls.createEl('button', {
            cls: 'clickable-icon related-notes-refresh-btn',
            title: 'Refresh'
        });
        refreshBtn.innerHTML = '&#8635;';
        refreshBtn.addEventListener('click', async () => {
            refreshBtn.classList.add('loading');
            await this.updateRelatedNotes(true);
            refreshBtn.classList.remove('loading');
        });

        // Options button
        const optionsBtn = controls.createEl('button', {
            cls: 'clickable-icon related-notes-options-btn',
            title: 'Options'
        });
        optionsBtn.innerHTML = '&#8943;';
        optionsBtn.addEventListener('click', (e) => {
            this.showOptionsMenu(e);
        });

        // Insert header before resultContainer if it exists
        if (this.resultContainer && container.contains(this.resultContainer)) {
            container.insertBefore(header, this.resultContainer);
        }
    }

    private getScopeDisplayText(): string {
        const t = this.plugin.t?.modals?.relatedNotes;
        if (!this.state.folderScope) {
            return t?.scopeAllNotes || 'All notes';
        }
        // Show last folder name for brevity
        const parts = this.state.folderScope.split('/');
        return parts[parts.length - 1] || this.state.folderScope;
    }

    private showFolderPicker(): void {
        const t = this.plugin.t?.modals?.relatedNotes;
        new FolderScopePickerModal(this.app, this.plugin, {
            title: t?.searchingIn || 'Search scope',
            allowSkip: true,
            defaultFolder: this.state.folderScope || undefined,
            onSelect: (folderPath: string | null) => {
                this.state.folderScope = folderPath;
                this.state.scopePinned = true; // User explicitly chose
                this.rerenderHeader();
                this.updateRelatedNotes(true);
            }
        }).open();
    }

    private showOptionsMenu(e: Event): void {
        const t = this.plugin.t?.modals?.relatedNotes;
        const menu = new Menu();

        menu.addItem(item => {
            item
                .setTitle(t?.searchCurrentFolder || 'Search current folder')
                .setIcon('folder')
                .onClick(() => {
                    this.state.scopePinned = false;
                    const activeFile = this.app.workspace.getActiveFile();
                    this.state.folderScope = this.normalizeFolderPath(activeFile?.parent?.path);
                    this.rerenderHeader();
                    this.updateRelatedNotes(true);
                });
        });

        menu.addItem(item => {
            item
                .setTitle(t?.searchEntireVault || 'Search entire vault')
                .setIcon('vault')
                .onClick(() => {
                    this.state.folderScope = null;
                    this.state.scopePinned = true;
                    this.rerenderHeader();
                    this.updateRelatedNotes(true);
                });
        });

        menu.addSeparator();

        menu.addItem(item => {
            item
                .setTitle('Copy as Markdown')
                .setIcon('copy')
                .onClick(() => this.copyAsMarkdown());
        });

        menu.addItem(item => {
            item
                .setTitle('Clear Cache')
                .setIcon('trash-2')
                .onClick(() => this.clearCache());
        });

        menu.showAtMouseEvent(e as MouseEvent);
    }

    private async onActiveNoteChanged(): Promise<void> {
        // Auto-update folder scope when not pinned
        if (!this.state.scopePinned) {
            const activeFile = this.app.workspace.getActiveFile();
            if (activeFile) {
                const newScope = this.normalizeFolderPath(activeFile.parent?.path);
                if (newScope !== this.state.folderScope) {
                    this.state.folderScope = newScope;
                    this.rerenderHeader();
                }
            }
        }

        // Debounce the search update
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }

        this.debounceTimer = setTimeout(
            () => this.updateRelatedNotes(),
            this.DEBOUNCE_MS
        );
    }

    private async updateRelatedNotes(forceRefresh: boolean = false): Promise<void> {
        // Try to re-initialize RAG service if not available
        if (!this.ragService) {
            this.initializeRAGService();
        }

        // Check prerequisites with detailed messages
        if (!this.plugin.settings.enableSemanticSearch) {
            this.renderDisabledState('Semantic search is disabled');
            return;
        }

        if (!this.plugin.embeddingService) {
            this.renderDisabledState('Embedding service not configured - check API key in settings');
            return;
        }

        if (!this.plugin.vectorStore) {
            this.renderDisabledState('Vector store not initialized');
            return;
        }

        if (!this.ragService) {
            this.renderDisabledState('RAG service not initialized');
            return;
        }

        // Get current file
        const currentFile = this.app.workspace.getActiveFile();
        if (!currentFile || currentFile.extension !== 'md') {
            this.renderEmptyState();
            return;
        }

        // Cache key: same file + same scope = skip (unless forced)
        if (!forceRefresh
            && this.state.currentFilePath === currentFile.path
            && this.state.lastFetchedScope === this.state.folderScope
            && !this.state.isLoading) {
            return;
        }

        try {
            this.state.isLoading = true;
            this.state.currentFilePath = currentFile.path;
            this.state.error = undefined;
            this.renderLoadingState();

            // Read file content
            const content = await this.app.vault.cachedRead(currentFile);

            if (!content.trim()) {
                const tEmpty = this.plugin.t?.modals?.relatedNotes;
                this.renderEmptyState(tEmpty?.noteEmpty || 'Current note is empty');
                return;
            }

            // Get related notes with folder scope
            const limit = this.plugin.settings.relatedNotesCount || 15;
            const results = await this.ragService.getRelatedNotes(
                currentFile,
                content,
                limit,
                { folderScope: this.state.folderScope }
            );

            this.state.results = results;
            this.state.timestamp = Date.now();
            this.state.lastFetchedScope = this.state.folderScope;

            // Decide which render path based on results + scope
            if (results.length === 0 && this.state.folderScope !== null) {
                this.renderScopedEmptyState();
            } else {
                this.renderResults();
            }
        } catch (error) {
            console.error('Error fetching related notes:', error);
            this.state.error = (error as any).message || 'Failed to fetch related notes';
            this.renderErrorState();
        } finally {
            this.state.isLoading = false;
        }
    }

    private renderLoadingState(): void {
        if (!this.resultContainer) return;
        const t = this.plugin.t?.modals?.relatedNotes;

        this.resultContainer.empty();
        this.resultContainer.createEl('div', {
            cls: 'related-notes-loading',
            text: t?.searching || 'Searching for related notes...'
        });
    }

    private renderEmptyState(message?: string): void {
        if (!this.resultContainer) return;
        const t = this.plugin.t?.modals?.relatedNotes;

        this.resultContainer.empty();
        const emptyEl = this.resultContainer.createEl('div', { cls: 'related-notes-empty' });
        emptyEl.createEl('p', { text: message || t?.noNoteOpen || 'No note open' });
        emptyEl.createEl('small', {
            text: t?.openNoteHint || 'Open a note to find related content',
            cls: 'related-notes-empty-hint'
        });
    }

    /** Scoped empty state — preserves scope indicator and offers "Search all notes" action */
    private renderScopedEmptyState(): void {
        if (!this.resultContainer) return;

        this.resultContainer.empty();
        const t = this.plugin.t?.modals?.relatedNotes;
        const emptyEl = this.resultContainer.createEl('div', { cls: 'related-notes-scoped-empty' });

        emptyEl.createEl('p', { text: t?.noResultsInFolder || 'No related notes in this folder' });

        // Show scope indicator
        const scopeText = this.state.folderScope
            ? `${t?.searchingIn || 'Searching in:'} ${this.state.folderScope}/`
            : `${t?.searchingIn || 'Searching in:'} ${t?.scopeAllNotes || 'All notes'}`;
        emptyEl.createEl('small', {
            text: scopeText,
            cls: 'related-notes-scope-indicator'
        });

        // Action: expand to vault
        const expandBtn = emptyEl.createEl('button', {
            text: t?.tryAllNotes || 'Search all notes',
            cls: 'mod-cta related-notes-expand-btn'
        });
        expandBtn.addEventListener('click', () => {
            this.state.folderScope = null;
            this.state.scopePinned = true;
            this.rerenderHeader();
            this.updateRelatedNotes(true);
        });
    }

    private renderDisabledState(reason: string): void {
        if (!this.resultContainer) return;
        const t = this.plugin.t?.modals?.relatedNotes;

        this.resultContainer.empty();
        const disabledEl = this.resultContainer.createEl('div', { cls: 'related-notes-disabled' });
        disabledEl.createEl('p', { text: reason });
        disabledEl.createEl('small', {
            text: t?.configureHint || 'Configure semantic search in plugin settings to use this feature',
            cls: 'related-notes-disabled-hint'
        });
    }

    private renderErrorState(): void {
        if (!this.resultContainer) return;
        const t = this.plugin.t?.modals?.relatedNotes;

        this.resultContainer.empty();
        const errorEl = this.resultContainer.createEl('div', { cls: 'related-notes-error' });
        errorEl.createEl('p', { text: t?.error || 'Error' });
        errorEl.createEl('small', {
            text: this.state.error || 'Unknown error',
            cls: 'related-notes-error-message'
        });

        const retryBtn = errorEl.createEl('button', {
            text: t?.retry || 'Retry',
            cls: 'mod-cta'
        });
        retryBtn.addEventListener('click', () => {
            this.updateRelatedNotes(true);
        });
    }

    private renderResults(): void {
        if (!this.resultContainer) return;

        this.hidePreviewPopup();
        this.resultContainer.empty();
        const t = this.plugin.t?.modals?.relatedNotes;

        if (this.state.results.length === 0) {
            this.renderEmptyState(t?.noResults || 'No related notes found');
            return;
        }

        const listEl = this.resultContainer.createEl('ul', { cls: 'related-notes-list' });

        // Dismiss popup on scroll (prevents orphaned popups)
        listEl.addEventListener('scroll', () => this.hidePreviewPopup());

        for (const result of this.state.results) {
            const itemEl = listEl.createEl('li', { cls: 'related-notes-item' });

            // Main link
            const linkEl = itemEl.createEl('a', {
                cls: 'related-notes-link internal-link'
            });

            // Get file name from path
            const fileName = result.document.filePath.split('/').pop()?.replace('.md', '') || 'Untitled';
            linkEl.textContent = fileName;

            linkEl.addEventListener('click', (e) => {
                e.preventDefault();
                this.openNote(result.document.filePath);
            });

            // Similarity badge color-coded by score
            const { cls: scoreClass, label: scoreLabel } = this.getScoreBadge(result.score);
            itemEl.createEl('span', {
                cls: `related-notes-score ${scoreClass}`,
                text: scoreLabel
            });

            // Preview (optional)
            if (result.document.metadata.title) {
                itemEl.createEl('small', {
                    cls: 'related-notes-preview',
                    text: result.document.metadata.title
                });
            }

            // Hover: show context
            itemEl.addEventListener('mouseenter', () => {
                this.showPreviewPopup(itemEl, result);
            });

            itemEl.addEventListener('mouseleave', (e) => {
                // Don't hide if mouse moved into the popup itself
                const related = e.relatedTarget as Node | null;
                const popup = document.querySelector('.related-notes-popup');
                if (popup && related && popup.contains(related)) return;
                this.hidePreviewPopup();
            });
        }

        // Footer: scope indicator + timestamp
        const footerEl = this.resultContainer.createEl('div', { cls: 'related-notes-footer' });

        // Scope indicator
        const scopeText = this.state.folderScope
            ? `${t?.searchingIn || 'Searching in:'} ${this.state.folderScope}/`
            : `${t?.searchingIn || 'Searching in:'} ${t?.scopeAllNotes || 'All notes'}`;
        footerEl.createEl('small', {
            text: scopeText,
            cls: 'related-notes-scope-indicator'
        });

        // Few results hint
        if (this.state.results.length < 2 && this.state.folderScope !== null) {
            const hintEl = footerEl.createEl('small', {
                text: ` · ${t?.fewResultsInFolder || 'Few results in this folder'}`,
                cls: 'related-notes-few-hint'
            });
            const expandLink = hintEl.createEl('a', {
                text: ` ${t?.tryAllNotes || 'Search all notes'}`,
                cls: 'related-notes-expand-link'
            });
            expandLink.addEventListener('click', (e) => {
                e.preventDefault();
                this.state.folderScope = null;
                this.state.scopePinned = true;
                this.rerenderHeader();
                this.updateRelatedNotes(true);
            });
        }

        // Timestamp
        if (this.state.timestamp) {
            footerEl.createEl('small', {
                text: `Updated ${this.getRelativeTime(this.state.timestamp)}`,
                cls: 'related-notes-timestamp'
            });
        }
    }

    private showPreviewPopup(itemEl: HTMLElement, result: SearchResult): void {
        // Remove existing popup
        document.querySelectorAll('.related-notes-popup').forEach(el => el.remove());

        // Create popup
        const popup = document.createElement('div');
        popup.className = 'related-notes-popup';

        popup.createEl('strong', {
            text: result.document.metadata.title || 'No title',
            cls: 'popup-title'
        });

        popup.createEl('small', {
            text: result.document.filePath,
            cls: 'popup-path'
        });

        const previewText = result.document.content.substring(0, 150).trim();
        popup.createEl('p', {
            text: previewText + (previewText.length === 150 ? '...' : ''),
            cls: 'popup-preview'
        });

        // Hide popup when mouse leaves it
        popup.addEventListener('mouseleave', () => {
            this.hidePreviewPopup();
        });

        // Position popup near item, flipping left if near right edge
        document.body.appendChild(popup);
        const rect = itemEl.getBoundingClientRect();
        const popupWidth = popup.offsetWidth || 300;
        const spaceRight = window.innerWidth - rect.right;
        const left = spaceRight > popupWidth + 20
            ? rect.right + 10
            : rect.left - popupWidth - 10;

        popup.style.position = 'fixed';
        popup.style.top = `${Math.max(0, rect.top)}px`;
        popup.style.left = `${Math.max(0, left)}px`;
        popup.style.zIndex = '1000';
    }

    private hidePreviewPopup(): void {
        document.querySelectorAll('.related-notes-popup').forEach(el => el.remove());
    }

    private getScoreBadge(score: number): { cls: string; label: string } {
        if (score >= 0.8) return { cls: 'score-excellent', label: 'Excellent' };
        if (score >= 0.6) return { cls: 'score-good', label: 'Good' };
        return { cls: 'score-fair', label: 'Fair' };
    }

    private async openNote(filePath: string): Promise<void> {
        const file = this.app.vault.getFileByPath(filePath);
        if (file && file instanceof TFile) {
            await this.app.workspace.openLinkText(filePath, '', false);
        }
    }

    private copyAsMarkdown(): void {
        const lines: string[] = [];

        if (this.state.results.length === 0) {
            lines.push('## Related Notes\n\nNo related notes found.');
        } else {
            lines.push('## Related Notes\n');
            for (const result of this.state.results) {
                const fileName = result.document.filePath.split('/').pop()?.replace('.md', '') || 'Untitled';
                const { label } = this.getScoreBadge(result.score);
                lines.push(`- [[${result.document.filePath}|${fileName}]] (${label.toLowerCase()})`);
            }
        }

        const markdown = lines.join('\n');
        navigator.clipboard.writeText(markdown).then(() => {
            const t = this.plugin.t?.messages;
            new Notice(t?.relatedNotesCopiedToClipboard || 'Related notes copied to clipboard');
        });
    }

    private clearCache(): void {
        this.state.results = [];
        this.state.currentFilePath = undefined;
        this.state.error = undefined;
        this.renderEmptyState();
        const t = this.plugin.t?.messages;
        new Notice(t?.cacheClearedSuccessfully || 'Cache cleared');
    }

    private getRelativeTime(timestamp: number): string {
        const now = Date.now();
        const diff = now - timestamp;

        if (diff < 60000) return 'just now';
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
        return `${Math.floor(diff / 86400000)}d ago`;
    }

    onClose(): Promise<void> {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        return Promise.resolve();
    }
}
