/**
 * Semantic search command handlers
 * Enables searching vault by semantic similarity
 */

import { Notice, Modal, App, Setting } from 'obsidian';
import AIOrganiserPlugin from '../main';

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
        this.titleEl.setText('Semantic Search Results');
    }

    async onOpen(): Promise<void> {
        const { contentEl } = this;
        contentEl.empty();

        // Search input
        contentEl.createEl('div', { cls: 'search-input-container' });
        const searchDiv = contentEl.querySelector('.search-input-container') as HTMLElement;
        
        new Setting(searchDiv)
            .setName('Search Query')
            .addText(text => {
                text.setPlaceholder('Enter search query...')
                    .setValue(this.query)
                    .onChange(value => {
                        this.query = value;
                    });
            })
            .addButton(btn => {
                btn.setButtonText('Search')
                    .onClick(async () => {
                        await this.performSearch();
                    });
            });

        // Results container
        const resultsDiv = contentEl.createEl('div', { cls: 'search-results' });
        if (this.results.length === 0) {
            resultsDiv.createEl('p', {
                text: 'No results yet. Enter a query and click Search.',
                cls: 'search-empty'
            });
        } else {
            this.displayResults(resultsDiv);
        }
    }

    private async performSearch(): Promise<void> {
        if (!this.query.trim()) {
            new Notice('Please enter a search query');
            return;
        }

        try {
            if (!this.plugin.vectorStore) {
                new Notice('Vector store not initialized. Enable semantic search in settings.');
                return;
            }

            new Notice('Searching...', 2000);
            this.results = await this.plugin.vectorStore.searchByContent(
                this.query,
                (this.plugin.llmService as any).getEmbeddingService?.(),
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
                text: 'No results found.',
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
                text: 'Open',
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
        id: 'semantic-search-vault',
        name: 'Semantic Search: Search vault by meaning',
        callback: async () => {
            if (!plugin.settings.enableSemanticSearch) {
                new Notice('Semantic search is not enabled. Enable it in settings.');
                return;
            }

            if (!plugin.vectorStore) {
                new Notice('Vector store not initialized. Please try again in a moment.');
                return;
            }

            const modal = new SemanticSearchResultsModal(plugin.app, plugin);
            modal.open();
        }
    });

    // Index vault command
    plugin.addCommand({
        id: 'semantic-search-index-vault',
        name: 'Semantic Search: Index entire vault',
        callback: async () => {
            if (!plugin.vectorStoreService) {
                new Notice('Vector store service not initialized.');
                return;
            }

            const statusNotice = new Notice('Indexing vault...', 0);
            try {
                const result = await plugin.vectorStoreService.indexVault();
                statusNotice.hide();
                new Notice(`Indexed ${result.indexed} notes. Failed: ${result.failed}`);
            } catch (error) {
                statusNotice.hide();
                new Notice('Indexing error: ' + (error as any).message, 5000);
            }
        }
    });

    // Index current note command
    plugin.addCommand({
        id: 'semantic-search-index-note',
        name: 'Semantic Search: Index current note',
        editorCallback: async (editor, view) => {
            if (!plugin.vectorStoreService) {
                new Notice('Vector store service not initialized.');
                return;
            }

            try {
                const file = view.file;
                if (file) {
                    await plugin.vectorStoreService.indexNote(file);
                    new Notice('Note indexed for semantic search');
                }
            } catch (error) {
                new Notice('Indexing error: ' + (error as any).message, 5000);
            }
        }
    });

    // Clear index command
    plugin.addCommand({
        id: 'semantic-search-clear-index',
        name: 'Semantic Search: Clear index',
        callback: async () => {
            if (!plugin.vectorStore) {
                new Notice('Vector store not initialized.');
                return;
            }

            const shouldClear = await plugin.showConfirmationDialog(
                'Clear all semantic search data? You can rebuild it anytime.'
            );

            if (shouldClear) {
                try {
                    await plugin.vectorStore.clear();
                    new Notice('Search index cleared');
                } catch (error) {
                    new Notice('Clear error: ' + (error as any).message, 5000);
                }
            }
        }
    });

    // Show related notes view command
    plugin.addCommand({
        id: 'related-notes-show',
        name: 'Show Related Notes Panel',
        callback: async () => {
            if (!plugin.settings.enableSemanticSearch) {
                new Notice('Semantic search is not enabled. Enable it in settings.');
                return;
            }

            if (!plugin.vectorStore) {
                new Notice('Vector store not initialized. Try reloading Obsidian or check settings.');
                return;
            }

            // Check if index has any documents and notify if empty
            try {
                const metadata = await plugin.vectorStore.getMetadata();
                if (metadata.totalDocuments === 0) {
                    new Notice('Index is empty. Run "Build semantic search index" first.');
                }
            } catch {
                // Ignore errors checking metadata
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
