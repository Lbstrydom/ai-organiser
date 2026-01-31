/**
 * Related Notes View
 * Sidebar panel showing notes semantically similar to the current note
 */

import { ItemView, TFile, WorkspaceLeaf, Menu, Notice } from 'obsidian';
import AIOrganiserPlugin from '../../main';
import { RAGService } from '../../services/ragService';
import { SearchResult } from '../../services/vector/types';

export const RELATED_NOTES_VIEW_TYPE = 'related-notes-view';

interface RelatedNotesState {
    currentFilePath?: string;
    results: SearchResult[];
    isLoading: boolean;
    error?: string;
    timestamp?: number;
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
        isLoading: false
    };
    private debounceTimer: NodeJS.Timeout | null = null;
    private readonly DEBOUNCE_MS = 500;
    private resultContainer: HTMLElement | null = null;

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
        return 'Related Notes';
    }

    getIcon(): string {
        return 'link-2';
    }

    async onOpen(): Promise<void> {
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        container.addClass('related-notes-view-container');

        // Header
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

        // Settings changes will be handled by workspace updates
        // since we track active note changes automatically
    }

    private renderHeader(container: HTMLElement): void {
        const header = container.createEl('div', { cls: 'related-notes-header' });

        header.createEl('h3', { text: 'Related Notes', cls: 'related-notes-title' });

        const controls = header.createEl('div', { cls: 'related-notes-controls' });

        // Refresh button
        const refreshBtn = controls.createEl('button', {
            cls: 'clickable-icon related-notes-refresh-btn',
            title: 'Refresh'
        });
        refreshBtn.innerHTML = '⟳';
        refreshBtn.addEventListener('click', async () => {
            refreshBtn.classList.add('loading');
            await this.updateRelatedNotes(true); // Force refresh
            refreshBtn.classList.remove('loading');
        });

        // Options button
        const optionsBtn = controls.createEl('button', {
            cls: 'clickable-icon related-notes-options-btn',
            title: 'Options'
        });
        optionsBtn.innerHTML = '⋯';
        optionsBtn.addEventListener('click', (e) => {
            this.showOptionsMenu(e);
        });
    }

    private showOptionsMenu(e: Event): void {
        const menu = new Menu();

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
        // Debounce updates to avoid excessive searches
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

        // Check if already processing same file (skip unless forced)
        if (!forceRefresh && this.state.currentFilePath === currentFile.path && !this.state.isLoading) {
            // File unchanged, skip unnecessary search
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
                this.renderEmptyState('Current note is empty');
                return;
            }

            // Get related notes
            console.log('[Related Notes] Searching for related notes...');
            const results = await this.ragService.getRelatedNotes(
                currentFile,
                content,
                5  // Max 5 related notes
            );
            console.log(`[Related Notes] Found ${results.length} related notes`);

            this.state.results = results;
            this.state.timestamp = Date.now();
            this.renderResults();
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

        this.resultContainer.empty();
        this.resultContainer.createEl('div', {
            cls: 'related-notes-loading',
            text: 'Searching for related notes...'
        });
    }

    private renderEmptyState(message: string = 'No note open'): void {
        if (!this.resultContainer) return;

        this.resultContainer.empty();
        const emptyEl = this.resultContainer.createEl('div', { cls: 'related-notes-empty' });
        emptyEl.createEl('p', { text: message });
        emptyEl.createEl('small', {
            text: 'Open a note to find related content',
            cls: 'related-notes-empty-hint'
        });
    }

    private renderDisabledState(reason: string): void {
        if (!this.resultContainer) return;

        this.resultContainer.empty();
        const disabledEl = this.resultContainer.createEl('div', { cls: 'related-notes-disabled' });
        disabledEl.createEl('p', { text: '🔒 ' + reason });
        disabledEl.createEl('small', {
            text: 'Configure semantic search in plugin settings to use this feature',
            cls: 'related-notes-disabled-hint'
        });
    }

    private renderErrorState(): void {
        if (!this.resultContainer) return;

        this.resultContainer.empty();
        const errorEl = this.resultContainer.createEl('div', { cls: 'related-notes-error' });
        errorEl.createEl('p', { text: '⚠️ Error' });
        errorEl.createEl('small', {
            text: this.state.error || 'Unknown error',
            cls: 'related-notes-error-message'
        });

        const retryBtn = errorEl.createEl('button', {
            text: 'Retry',
            cls: 'mod-cta'
        });
        retryBtn.addEventListener('click', () => {
            this.updateRelatedNotes(true); // Force refresh on retry
        });
    }

    private renderResults(): void {
        if (!this.resultContainer) return;

        this.resultContainer.empty();

        if (this.state.results.length === 0) {
            this.renderEmptyState('No related notes found');
            return;
        }

        const listEl = this.resultContainer.createEl('ul', { cls: 'related-notes-list' });

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

            itemEl.addEventListener('mouseleave', () => {
                this.hidePreviewPopup();
            });
        }

        // Show timestamp
        if (this.state.timestamp) {
            const footerEl = this.resultContainer.createEl('div', { cls: 'related-notes-footer' });
            const timeEl = footerEl.createEl('small', { cls: 'related-notes-timestamp' });
            timeEl.textContent = `Updated ${this.getRelativeTime(this.state.timestamp)}`;
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
        // Cleanup
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        return Promise.resolve();
    }
}
