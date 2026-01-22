/**
 * Semantic search command handlers
 * Enables searching vault by semantic similarity
 */

import { Notice, Modal, App, Setting, Platform } from 'obsidian';
import AIOrganiserPlugin from '../main';
import { ManageIndexModal } from '../ui/modals/ManageIndexModal';

/**
 * Modal for displaying semantic search results
 */
class SemanticSearchResultsModal extends Modal {
    private plugin: AIOrganiserPlugin;
    private query: string = '';
    private results: any[] = [];

    constructor(app: App, plugin: AIOrganiserPlugin) {
        super(app);
        this.plugin = plugin;
        this.titleEl.setText(this.plugin.t.modals.semanticSearch.title);
    }

    async onOpen(): Promise<void> {
        const { contentEl } = this;
        contentEl.empty();

        // Search input
        contentEl.createEl('div', { cls: 'search-input-container' });
        const searchDiv = contentEl.querySelector('.search-input-container') as HTMLElement;
        
        new Setting(searchDiv)
            .setName(this.plugin.t.modals.semanticSearch.title)
            .addText(text => {
                text.setPlaceholder(this.plugin.t.modals.semanticSearch.searchPlaceholder)
                    .setValue(this.query)
                    .onChange(value => {
                        this.query = value;
                    });
            })
            .addButton(btn => {
                btn.setButtonText(this.plugin.t.modals.semanticSearch.searchButton)
                    .onClick(async () => {
                        await this.performSearch();
                    });
            });

        // Results container
        const resultsDiv = contentEl.createEl('div', { cls: 'search-results' });
        if (this.results.length === 0) {
            resultsDiv.createEl('p', {
                text: this.plugin.t.modals.semanticSearch.noResults,
                cls: 'search-empty'
            });
        } else {
            this.displayResults(resultsDiv);
        }
    }

    private async performSearch(): Promise<void> {
        if (!this.query.trim()) {
            new Notice(this.plugin.t.modals.semanticSearch.searchPlaceholder);
            return;
        }

        try {
            if (!this.plugin.vectorStore) {
                new Notice(this.plugin.t.messages.vectorStoreFailed);
                return;
            }

            new Notice(this.plugin.t.messages.searchingVault, 2000);
            const embeddingService =
                this.plugin.embeddingService ||
                (this.plugin.llmService as any).getEmbeddingService?.();
            this.results = await this.plugin.vectorStore.searchByContent(
                this.query,
                embeddingService,
                5
            );

            // Refresh results display
            const resultsDiv = this.contentEl.querySelector('.search-results') as HTMLElement;
            if (resultsDiv) {
                resultsDiv.empty();
                this.displayResults(resultsDiv);
            }
        } catch (error) {
            new Notice('Search error: ' + (error as any).message, 5000);
            console.error('Semantic search error:', error);
        }
    }

    private displayResults(container: HTMLElement): void {
        if (this.results.length === 0) {
            container.createEl('p', {
                text: this.plugin.t.modals.semanticSearch.noResults,
                cls: 'search-empty'
            });
            return;
        }

        container.createEl('h3', { text: `Found ${this.results.length} results` });

        for (const result of this.results) {
            const resultEl = container.createEl('div', {
                cls: 'search-result-item'
            });

            resultEl.createEl('h4', { text: result.document.metadata.title });
            resultEl.createEl('p', {
                text: result.highlightedText || result.document.content.substring(0, 200),
                cls: 'search-result-preview'
            });

            const scoreEl = resultEl.createEl('span', {
                cls: 'search-result-score',
                text: `Similarity: ${(result.score * 100).toFixed(1)}%`
            });

            resultEl.createEl('button', {
                text: this.plugin.t.modals.semanticSearch.clickToOpen,
                cls: 'search-result-open'
            }).onclick = () => {
                const file = this.app.vault.getFileByPath(result.document.filePath);
                if (file) {
                    this.app.workspace.getLeaf().openFile(file);
                    this.close();
                }
            };
        }
    }

    onClose(): void {
        const { contentEl } = this;
        contentEl.empty();
    }
}

/**
 * Register all semantic search commands
 */
export function registerSemanticSearchCommands(plugin: AIOrganiserPlugin): void {
    // Semantic search command
    plugin.addCommand({
        id: 'semantic-search',
        name: plugin.t.commands.searchSemanticVault,
        callback: async () => {
            if (!plugin.settings.enableSemanticSearch) {
                new Notice(plugin.t.messages.semanticSearchDisabled);
                return;
            }

            if (!plugin.vectorStore) {
                new Notice(plugin.t.messages.vectorStoreFailed);
                return;
            }

            const modal = new SemanticSearchResultsModal(plugin.app, plugin);
            modal.open();
        }
    });

    // Manage index command
    plugin.addCommand({
        id: 'manage-index',
        name: plugin.t.commands.manageIndex,
        callback: async () => {
            const modal = new ManageIndexModal(plugin.app, plugin);
            modal.open();
        }
    });

    // Show related notes view command
    plugin.addCommand({
        id: 'find-related',
        name: plugin.t.commands.showRelatedNotes,
        callback: async () => {
            if (!plugin.settings.enableSemanticSearch) {
                new Notice(plugin.t.messages.semanticSearchDisabled);
                return;
            }

            if (!plugin.vectorStore) {
                new Notice(plugin.t.messages.vectorStoreFailed);
                return;
            }

            // Check if index has any documents and notify if empty
            try {
                const metadata = await plugin.vectorStore.getMetadata();
                if (metadata.totalDocuments === 0) {
                    new Notice(plugin.t.messages.noIndexFound);
                }
            } catch {
                // Ignore errors checking metadata
            }

            if (Platform.isMobile) {
                const { RelatedNotesModal } = await import('../ui/modals/RelatedNotesModal');
                new RelatedNotesModal(plugin.app, plugin).open();
                return;
            }

            // Import here to avoid circular dependency
            const { RELATED_NOTES_VIEW_TYPE } = await import('../ui/views/RelatedNotesView');
            
            const leaf = plugin.app.workspace.getRightLeaf(false);
            if (leaf) {
                await leaf.setViewState({
                    type: RELATED_NOTES_VIEW_TYPE,
                    active: true
                });
                plugin.app.workspace.revealLeaf(leaf);
            }
        }
    });
}
