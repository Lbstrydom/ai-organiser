/**
 * Semantic search command handlers
 * Enables searching vault by semantic similarity
 */

import { Notice, Modal, App, Platform, ButtonComponent, TFile, Setting } from 'obsidian';
import AIOrganiserPlugin from '../main';
import { logger } from '../utils/logger';
import { ManageIndexModal } from '../ui/modals/ManageIndexModal';
import { FolderScopePickerModal } from '../ui/modals/FolderScopePickerModal';
import { SearchResult } from '../services/vector/types';
import { summarizeText, pluginContext } from '../services/llmFacade';

/** Over-fetch multiplier to compensate for dedup (multiple chunks per file). */
const SEARCH_OVERFETCH_MULTIPLIER = 5;
/** Hard ceiling for over-fetch. */
const MAX_SEARCH_FETCH = 200;

/**
 * Build a prompt that asks the LLM to expand a user query with related terms.
 * Returns a short expanded query suitable for embedding search.
 */
function buildQueryExpansionPrompt(query: string, language: string): string {
    return `<task>
Expand the following search query with related terms, synonyms, and closely associated concepts.
The goal is to improve semantic search recall in a personal knowledge base.
</task>

<query>${query}</query>

<requirements>
- Output ONLY the expanded query text, nothing else
- Include the original terms plus 5-10 related terms/phrases
- Include specific names, techniques, frameworks, and models related to the topic
- Keep it under 200 words
- Language: ${language}
- Do NOT explain or add commentary — just the expanded search terms
</requirements>`;
}

/**
 * Modal for displaying semantic search results
 */
class SemanticSearchResultsModal extends Modal {
    private plugin: AIOrganiserPlugin;
    private query: string = '';
    private results: SearchResult[] = [];
    private resultsDiv!: HTMLElement;
    private searchTextarea!: HTMLTextAreaElement;
    private searchButton!: ButtonComponent;
    private expandToggle!: HTMLInputElement;
    private isSearching: boolean = false;
    private selectedResults: Set<string> = new Set(); // Track selected file paths
    private selectionHeader!: HTMLElement; // Header with Select All/Export buttons

    constructor(app: App, plugin: AIOrganiserPlugin) {
        super(app);
        this.plugin = plugin;
        this.titleEl.setText(this.plugin.t.modals.semanticSearch.title);
    }

    async onOpen(): Promise<void> {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('ai-organiser-semantic-search');

        const t = this.plugin.t.modals.semanticSearch;

        // Description
        const descEl = contentEl.createEl('p', {
            text: t.description,
            cls: 'ai-organiser-semantic-search-description'
        });
        descEl.addClass('ai-organiser-text-muted');
        descEl.addClass('ai-organiser-text-base');
        descEl.addClass('ai-organiser-mb-12');

        // Search input area
        const searchContainer = contentEl.createDiv({ cls: 'ai-organiser-semantic-search-input-container' });

        this.searchTextarea = searchContainer.createEl('textarea', {
            placeholder: t.searchPlaceholder,
            cls: 'ai-organiser-semantic-search-textarea'
        });
        this.searchTextarea.value = this.query;
        this.searchTextarea.rows = 3;
        this.searchTextarea.addClass('ai-organiser-w-full');
        this.searchTextarea.setCssProps({ '--pad': '10px 12px' }); this.searchTextarea.addClass('ai-organiser-pad-custom');
        this.searchTextarea.addClass('ai-organiser-text-lg');
        this.searchTextarea.addClass('ai-organiser-border');
        this.searchTextarea.addClass('ai-organiser-rounded-md');
        this.searchTextarea.addClass('ai-organiser-bg-primary');
        this.searchTextarea.addClass('ai-organiser-text-normal');
        this.searchTextarea.addClass('ai-organiser-resize-vertical');
        this.searchTextarea.addClass('ai-organiser-font-inherit');
        this.searchTextarea.addClass('ai-organiser-line-height-relaxed');

        this.searchTextarea.addEventListener('input', () => {
            this.query = this.searchTextarea.value;
        });

        // Enter key triggers search (Shift+Enter for newline)
        this.searchTextarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (!this.isSearching) {
                    void this.performSearch();
                }
            }
        });

        // Controls row: expand toggle + search button
        const controlsRow = contentEl.createDiv({ cls: 'ai-organiser-semantic-search-controls' });
        controlsRow.addClass('ai-organiser-flex-between');
        controlsRow.addClass('ai-organiser-mt-8');
        controlsRow.addClass('ai-organiser-mb-16');

        // LLM expand toggle
        const expandLabel = controlsRow.createEl('label', {
            cls: 'ai-organiser-semantic-search-expand-label'
        });
        expandLabel.addClass('ai-organiser-flex-center', 'ai-organiser-gap-6');
        expandLabel.addClass('ai-organiser-text-base');
        expandLabel.addClass('ai-organiser-text-muted');
        expandLabel.addClass('ai-organiser-cursor-pointer');

        this.expandToggle = expandLabel.createEl('input', {
            type: 'checkbox',
            cls: 'ai-organiser-semantic-search-expand-checkbox'
        });
        this.expandToggle.checked = true;

        expandLabel.createSpan({
            text: t.expandWithAI || 'Expand query with AI'
        });

        // Tooltip
        const infoIcon = expandLabel.createSpan({ text: '?' });
        infoIcon.addClass('ai-organiser-inline-flex');
        infoIcon.addClass('ai-organiser-items-center');
        infoIcon.addClass('ai-organiser-flex-end');
        infoIcon.setCssProps({ '--w': '16px' }); infoIcon.addClass('ai-organiser-w-custom');
        infoIcon.setCssProps({ '--h': '16px' }); infoIcon.addClass('ai-organiser-h-custom');
        infoIcon.addClass('ai-organiser-rounded-full');
        infoIcon.setCssProps({ '--border': '1px solid var(--text-muted)' }); infoIcon.addClass('ai-organiser-border-custom');
        infoIcon.addClass('ai-organiser-text-xs');
        infoIcon.addClass('ai-organiser-text-muted');
        infoIcon.title = t.expandTooltip || 'Uses your LLM to add related terms, synonyms, and concepts to improve search results';

        // Search button
        const buttonContainer = controlsRow.createDiv();
        this.searchButton = new ButtonComponent(buttonContainer)
            .setButtonText(t.searchButton)
            .setCta()
            .onClick(async () => {
                await this.performSearch();
            });

        // Results container
        this.resultsDiv = contentEl.createDiv({ cls: 'ai-organiser-semantic-search-results' });
        this.resultsDiv.createEl('p', {
            text: t.enterQueryHint || 'Enter a query and press Enter or click Search',
            cls: 'search-empty'
        });
        const emptyEl = this.resultsDiv.querySelector('.search-empty') as HTMLElement;
        emptyEl.addClass('ai-organiser-semantic-search-empty');

        // Focus textarea
        setTimeout(() => this.searchTextarea.focus(), 50);
    }

    private async performSearch(): Promise<void> {
        if (!this.query.trim() || this.isSearching) return;

        try {
            this.isSearching = true;
            this.searchButton.setDisabled(true);
            this.searchButton.setButtonText(this.plugin.t.modals.semanticSearch.searching || 'Searching...');

            if (!this.plugin.vectorStore) {
                new Notice(this.plugin.t.messages.vectorStoreFailed);
                return;
            }

            const embeddingService =
                this.plugin.embeddingService ||
                (this.plugin.llmService as any).getEmbeddingService?.();

            // Determine search query: optionally expand with LLM
            let searchQuery = this.query.trim();
            if (this.expandToggle.checked) {
                try {
                    const language = this.plugin.settings.summaryLanguage || 'English';
                    const prompt = buildQueryExpansionPrompt(searchQuery, language);
                    const result = await summarizeText(pluginContext(this.plugin), prompt);
                    if (result.success && result.content) {
                        searchQuery = result.content.trim();
                    }
                } catch {
                    // Fallback to original query if LLM expansion fails
                }
            }

            // Over-fetch for dedup
            const maxResults = this.plugin.settings.relatedNotesCount || 15;
            const fetchLimit = Math.min(maxResults * SEARCH_OVERFETCH_MULTIPLIER, MAX_SEARCH_FETCH);

            const rawResults = await this.plugin.vectorStore.searchByContent(
                searchQuery,
                embeddingService,
                fetchLimit
            );

            // Deduplicate by file: keep highest-scoring chunk per unique file
            const bestByFile = new Map<string, SearchResult>();
            for (const r of rawResults) {
                const existing = bestByFile.get(r.document.filePath);
                if (!existing || r.score > existing.score) {
                    bestByFile.set(r.document.filePath, r);
                }
            }

            // Sort by score descending, slice to maxResults
            this.results = Array.from(bestByFile.values())
                .sort((a, b) => b.score - a.score)
                .slice(0, maxResults);

            // Refresh results display
            this.resultsDiv.empty();
            this.displayResults(this.resultsDiv);
        } catch (error) {
            new Notice('Search error: ' + (error as any).message, 5000);
            logger.error('Search', 'Semantic search error:', error);
        } finally {
            this.isSearching = false;
            this.searchButton.setDisabled(false);
            this.searchButton.setButtonText(this.plugin.t.modals.semanticSearch.searchButton);
        }
    }

    private displayResults(container: HTMLElement): void {
        const t = this.plugin.t.modals.semanticSearch;

        if (this.results.length === 0) {
            const emptyEl = container.createEl('p', {
                text: t.noResults,
                cls: 'search-empty'
            });
            emptyEl.addClass('ai-organiser-text-muted');
            emptyEl.addClass('ai-organiser-text-center');
            emptyEl.setCssProps({ '--pad': '30px 20px' }); emptyEl.addClass('ai-organiser-pad-custom');
            return;
        }

        // Header with controls
        this.selectionHeader = container.createEl('div', { cls: 'ai-organiser-semantic-search-results-header' });
        this.selectionHeader.addClass('ai-organiser-flex');
        this.selectionHeader.addClass('ai-organiser-flex-between');
        this.selectionHeader.addClass('ai-organiser-items-center');
        this.selectionHeader.addClass('ai-organiser-mb-10');
        this.selectionHeader.addClass('ai-organiser-pb-8');
        this.selectionHeader.addClass('ai-organiser-border-b');

        // Left side: result count + AI badge + selection count
        const leftSide = this.selectionHeader.createDiv();
        leftSide.addClass('ai-organiser-flex-center', 'ai-organiser-gap-8');

        leftSide.createEl('span', {
            text: `${this.results.length} ${t.resultsFound || 'results found'}`,
            cls: 'ai-organiser-semantic-search-count ai-organiser-text-muted'
        });

        if (this.expandToggle.checked) {
            const aiLabel = leftSide.createEl('span', {
                text: t.aiExpanded || 'AI-expanded',
                cls: 'ai-organiser-semantic-search-ai-badge'
            });
            aiLabel.addClass('ai-organiser-text-sm', 'ai-organiser-bg-accent', 'ai-organiser-text-on-accent', 'ai-organiser-rounded-lg');
        }

        // Selection count badge
        const selectionBadge = leftSide.createEl('span', {
            text: this.selectedResults.size > 0 
                ? `${this.selectedResults.size} ${t.selected}` 
                : t.noneSelected,
            cls: 'ai-organiser-semantic-search-selection-badge'
        });
        selectionBadge.addClass('ai-organiser-text-sm', 'ai-organiser-rounded-lg');
        if (this.selectedResults.size > 0) {
            selectionBadge.addClass('is-active');
        }

        // Right side: Select All/Deselect All + Export buttons
        const rightSide = this.selectionHeader.createDiv();
        rightSide.addClass('ai-organiser-flex-row', 'ai-organiser-gap-8');

        // Select All/Deselect All toggle button
        const selectToggleBtn = new ButtonComponent(rightSide);
        selectToggleBtn
            .setButtonText(this.selectedResults.size === this.results.length ? t.deselectAll : t.selectAll)
            .onClick(() => {
                if (this.selectedResults.size === this.results.length) {
                    // Deselect all
                    this.selectedResults.clear();
                } else {
                    // Select all
                    this.results.forEach(r => this.selectedResults.add(r.document.filePath));
                }
                // Refresh display
                container.empty();
                this.displayResults(container);
            });

        // Export Selected button (disabled if none selected)
        const exportBtn = new ButtonComponent(rightSide);
        exportBtn
            .setButtonText(t.exportSelected)
            .setCta()
            .setDisabled(this.selectedResults.size === 0)
            .onClick(async () => {
                await this.openExportModal();
            });

        const listEl = container.createDiv({ cls: 'ai-organiser-semantic-search-list' });
        listEl.setCssProps({ '--max-h': '400px' }); listEl.addClass('ai-organiser-max-h-custom');
        listEl.addClass('ai-organiser-overflow-y-auto');

        for (const result of this.results) {
            const resultEl = listEl.createEl('div', {
                cls: 'ai-organiser-semantic-search-result-item'
            });
            resultEl.setCssProps({ '--pad': '10px 12px' }); resultEl.addClass('ai-organiser-pad-custom');
            resultEl.addClass('ai-organiser-border-b');
            resultEl.addClass('ai-organiser-flex-row', 'ai-organiser-gap-10');
            resultEl.addClass('ai-organiser-items-start');

            // Checkbox
            const checkboxContainer = resultEl.createDiv();
            checkboxContainer.addClass('ai-organiser-pt-2');
            const checkbox = checkboxContainer.createEl('input', { type: 'checkbox' });
            checkbox.checked = this.selectedResults.has(result.document.filePath);
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) {
                    this.selectedResults.add(result.document.filePath);
                } else {
                    this.selectedResults.delete(result.document.filePath);
                }
                // Update header display
                container.empty();
                this.displayResults(container);
            });

            // Content area
            const contentEl = resultEl.createDiv();
            contentEl.addClass('ai-organiser-flex-1');
            contentEl.addClass('ai-organiser-cursor-pointer');

            contentEl.addEventListener('mouseenter', () => {
                contentEl.addClass('ai-organiser-opacity-85');
            });
            contentEl.addEventListener('mouseleave', () => {
                contentEl.removeClass('ai-organiser-opacity-85');
            });

            // Title row with score badge
            const titleRow = contentEl.createDiv();
            titleRow.addClass('ai-organiser-flex-between');
            titleRow.addClass('ai-organiser-mb-4');

            const title = result.document.metadata?.title || result.document.filePath.split('/').pop() || 'Untitled';
            titleRow.createEl('span', {
                text: title,
                cls: 'ai-organiser-semantic-search-result-title ai-organiser-font-semibold'
            });

            // Score badge
            const score = result.score;
            const scorePercent = (score * 100).toFixed(0);
            const badgeEl = titleRow.createEl('span', {
                text: `${scorePercent}%`,
                cls: 'ai-organiser-semantic-search-score-badge'
            });
            badgeEl.addClass('ai-organiser-text-sm');
            badgeEl.setCssProps({ '--pad': '1px 6px' }); badgeEl.addClass('ai-organiser-pad-custom');
            badgeEl.addClass('ai-organiser-rounded-md');
            if (score >= 0.8) {
                badgeEl.addClass('score-high');
            } else if (score >= 0.6) {
                badgeEl.addClass('score-medium');
            } else {
                badgeEl.addClass('ai-organiser-bg-border');
                badgeEl.addClass('ai-organiser-text-muted');
            }

            // File path
            const pathEl = contentEl.createEl('div', {
                text: result.document.filePath,
                cls: 'ai-organiser-semantic-search-result-path'
            });
            pathEl.addClass('ai-organiser-text-sm');
            pathEl.addClass('ai-organiser-text-muted');
            pathEl.addClass('ai-organiser-mb-4');

            // Preview text
            const preview = result.highlightedText || result.document.content.substring(0, 200);
            const previewEl = contentEl.createEl('p', {
                text: preview.length > 200 ? preview.substring(0, 200) + '...' : preview,
                cls: 'ai-organiser-semantic-search-result-preview'
            });
            previewEl.addClass('ai-organiser-text-md');
            previewEl.addClass('ai-organiser-text-muted');
            previewEl.setCssProps({ '--margin': '0' }); previewEl.addClass('ai-organiser-margin-custom');
            previewEl.addClass('ai-organiser-line-height-normal');

            // Click content to open note
            contentEl.addEventListener('click', () => {
                const file = this.app.vault.getFileByPath(result.document.filePath);
                if (file && file instanceof TFile) {
                    void this.app.workspace.getLeaf().openFile(file);
                    this.close();
                }
            });
        }
    }

    private async openExportModal(): Promise<void> {
        if (this.selectedResults.size === 0) {
            new Notice(this.plugin.t.modals.exportSearchResults.noNotesSelected);
            return;
        }

        // Get selected results data
        const selectedData = this.results.filter(r => 
            this.selectedResults.has(r.document.filePath)
        );

        const modal = new ExportSearchResultsModal(
            this.app, 
            this.plugin, 
            selectedData
        );
        modal.open();
    }

    onClose(): void {
        const { contentEl } = this;
        contentEl.empty();
    }
}

/**
 * Modal for exporting selected search results
 */
class ExportSearchResultsModal extends Modal {
    private plugin: AIOrganiserPlugin;
    private results: SearchResult[];
    private exportTarget: 'new' | 'existing' = 'new';
    private includeExcerpts: boolean = false;
    private selectedFolder: string = '';
    private selectedNote: TFile | null = null;

    constructor(app: App, plugin: AIOrganiserPlugin, results: SearchResult[]) {
        super(app);
        this.plugin = plugin;
        this.results = results;
        this.selectedFolder = this.getDefaultFolder();
    }

    private getDefaultFolder(): string {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile?.parent) {
            return activeFile.parent.path;
        }
        return '';
    }

    async onOpen(): Promise<void> {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('ai-organiser-export-search-results');

        const t = this.plugin.t.modals.exportSearchResults;

        this.titleEl.setText(t.title);

        // Description
        contentEl.createEl('p', {
            text: t.description,
            cls: 'export-description ai-organiser-mb-16'
        });

        // Export target (New note vs Existing note)
        new Setting(contentEl)
            .setName(t.targetLabel)
            .addDropdown(dropdown => {
                dropdown
                    .addOption('new', t.newNote)
                    .addOption('existing', t.existingNote)
                    .setValue(this.exportTarget)
                    .onChange((value) => {
                        this.exportTarget = value as 'new' | 'existing';
                        void this.refresh();
                    });
            });

        // Folder picker (for new note) or Note picker (for existing note)
        if (this.exportTarget === 'new') {
            new Setting(contentEl)
                .setName(t.folderLabel)
                .setDesc(this.selectedFolder || t.chooseFolder)
                .addButton(button => {
                    button
                        .setButtonText(t.chooseFolder)
                        .onClick(() => {
                            const modal = new FolderScopePickerModal(
                                this.app,
                                this.plugin,
                                {
                                    defaultFolder: this.selectedFolder,
                                    onSelect: (folder: string | null) => {
                                        this.selectedFolder = folder || '';
                                        void this.refresh();
                                    }
                                }
                            );
                            modal.open();
                        });
                });
        } else {
            // Note picker for existing note
            new Setting(contentEl)
                .setName(t.noteLabel)
                .setDesc(this.selectedNote ? this.selectedNote.basename : t.chooseNote)
                .addButton(button => {
                    button
                        .setButtonText(t.chooseNote)
                        .onClick(() => {
                            // Simple file suggester
                            const files = this.app.vault.getMarkdownFiles();
                            // names used implicitly by file search below
                            
                            // Create a minimal suggester using Setting
                            const suggestSetting = new Setting(contentEl)
                                .setName('Select note')
                                .addText(text => {
                                    text.inputEl.placeholder = 'Type to search...';
                                    text.inputEl.addEventListener('input', () => {
                                        const query = text.inputEl.value.toLowerCase();
                                        // Simple filter (in production would use a proper suggester)
                                        const matches = files.filter(f => 
                                            f.basename.toLowerCase().includes(query)
                                        );
                                        // For now, just take first match on Enter
                                        text.inputEl.addEventListener('keydown', (e) => {
                                            if (e.key === 'Enter' && matches.length > 0) {
                                                this.selectedNote = matches[0];
                                                void this.refresh();
                                                suggestSetting.settingEl.remove();
                                            }
                                        });
                                    });
                                });
                        });
                });
        }

        // Format option
        new Setting(contentEl)
            .setName(t.formatLabel)
            .addDropdown(dropdown => {
                dropdown
                    .addOption('links', t.linksOnly)
                    .addOption('excerpts', t.linksWithExcerpts)
                    .setValue(this.includeExcerpts ? 'excerpts' : 'links')
                    .onChange(value => {
                        this.includeExcerpts = value === 'excerpts';
                    });
            });

        // Export button
        const buttonContainer = contentEl.createDiv({ cls: 'export-button-container' });
        buttonContainer.addClass('ai-organiser-flex-end');
        buttonContainer.addClass('ai-organiser-mt-20');
        buttonContainer.addClass('ai-organiser-gap-8');

        new ButtonComponent(buttonContainer)
            .setButtonText('Cancel')
            .onClick(() => this.close());

        new ButtonComponent(buttonContainer)
            .setButtonText(t.exportButton)
            .setCta()
            .onClick(async () => {
                await this.performExport();
            });
    }

    private async refresh(): Promise<void> {
        await this.onOpen();
    }

    private async performExport(): Promise<void> {
        const t = this.plugin.t.modals.exportSearchResults;

        try {
            let content = this.buildExportContent();

            if (this.exportTarget === 'new') {
                // Create new note
                const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
                const filename = `Search Results ${timestamp}.md`;
                const filePath = this.selectedFolder 
                    ? `${this.selectedFolder}/${filename}` 
                    : filename;

                await this.app.vault.create(filePath, content);
                new Notice(t.success.replace('{count}', this.results.length.toString()));
                
                // Open the new note
                const file = this.app.vault.getFileByPath(filePath);
                if (file) {
                    await this.app.workspace.getLeaf().openFile(file);
                }
            } else {
                // Append to existing note
                if (!this.selectedNote) {
                    new Notice(t.chooseNote);
                    return;
                }

                const existingContent = await this.app.vault.read(this.selectedNote);
                const newContent = existingContent + '\n\n' + content;
                await this.app.vault.modify(this.selectedNote, newContent);
                new Notice(t.success.replace('{count}', this.results.length.toString()));
            }

            this.close();
        } catch (error) {
            new Notice('Export failed: ' + (error as Error).message);
            logger.error('Search', 'Export error:', error);
        }
    }

    private buildExportContent(): string {
        const lines: string[] = [];
        const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
        
        lines.push(`## Search Results — ${timestamp}\n`);

        for (const result of this.results) {
            const wikilink = `[[${result.document.filePath.replace('.md', '')}]]`;
            
            if (this.includeExcerpts) {
                const excerpt = result.highlightedText || 
                              result.document.content.substring(0, 150);
                const cleanExcerpt = excerpt.length > 150 
                    ? excerpt.substring(0, 150).trim() + '...' 
                    : excerpt.trim();
                
                lines.push(`- ${wikilink}`);
                lines.push(`  > ${cleanExcerpt}\n`);
            } else {
                lines.push(`- ${wikilink}`);
            }
        }

        return lines.join('\n');
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

            // Reuse existing leaf if one is already open (prevents duplicates)
            const existing = plugin.app.workspace.getLeavesOfType(RELATED_NOTES_VIEW_TYPE);
            if (existing.length > 0) {
                void plugin.app.workspace.revealLeaf(existing[0]);
                return;
            }

            const leaf = plugin.app.workspace.getRightLeaf(false);
            if (leaf) {
                await leaf.setViewState({
                    type: RELATED_NOTES_VIEW_TYPE,
                    active: true
                });
                void plugin.app.workspace.revealLeaf(leaf);
            }
        }
    });
}
