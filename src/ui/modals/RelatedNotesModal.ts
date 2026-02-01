import { App, Modal, TFile } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { RAGService } from '../../services/ragService';
import { SearchResult } from '../../services/vector/types';

export class RelatedNotesModal extends Modal {
    private plugin: AIOrganiserPlugin;
    private ragService: RAGService | null = null;
    private results: SearchResult[] = [];
    private statusEl: HTMLElement | null = null;
    private listEl: HTMLElement | null = null;
    private folderScope: string | null = null;

    constructor(app: App, plugin: AIOrganiserPlugin) {
        super(app);
        this.plugin = plugin;
        this.initializeRAGService();
        this.titleEl.setText(this.plugin.t.commands.showRelatedNotes);
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

    private normalizeFolderPath(path: string | undefined | null): string | null {
        if (!path || path === '/' || path === '') return null;
        return path;
    }

    async onOpen(): Promise<void> {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('related-notes-modal');

        // Derive initial folder scope from active file
        const currentFile = this.app.workspace.getActiveFile();
        this.folderScope = this.normalizeFolderPath(currentFile?.parent?.path);

        const header = contentEl.createDiv({ cls: 'related-notes-header' });
        header.createEl('h3', { text: this.plugin.t.commands.showRelatedNotes });

        // Scope toggle + refresh in a controls row
        const controls = header.createDiv({ cls: 'related-notes-modal-controls' });

        const t = this.plugin.t?.modals?.relatedNotes;

        // Scope toggle buttons
        const scopeGroup = controls.createDiv({ cls: 'related-notes-scope-toggle' });

        const isRootLevel = this.folderScope === null;

        const folderBtn = scopeGroup.createEl('button', {
            text: t?.scopeFolder || 'This folder',
            cls: !isRootLevel ? 'mod-cta' : ''
        });
        if (isRootLevel) {
            folderBtn.disabled = true;
            folderBtn.title = 'Note is at vault root — no parent folder';
        }
        const vaultBtn = scopeGroup.createEl('button', {
            text: t?.scopeAllNotes || 'All notes',
            cls: isRootLevel ? 'mod-cta' : ''
        });

        folderBtn.addEventListener('click', () => {
            const scope = this.normalizeFolderPath(this.app.workspace.getActiveFile()?.parent?.path);
            if (scope === null) return; // Root-level — no-op
            this.folderScope = scope;
            folderBtn.addClass('mod-cta');
            vaultBtn.removeClass('mod-cta');
            this.fetchRelatedNotes();
        });

        vaultBtn.addEventListener('click', () => {
            this.folderScope = null;
            vaultBtn.addClass('mod-cta');
            folderBtn.removeClass('mod-cta');
            this.fetchRelatedNotes();
        });

        const refreshButton = controls.createEl('button', {
            cls: 'mod-cta',
            text: t?.refresh || 'Refresh'
        });
        refreshButton.addEventListener('click', async () => {
            refreshButton.disabled = true;
            await this.fetchRelatedNotes();
            refreshButton.disabled = false;
        });

        this.statusEl = contentEl.createDiv({ cls: 'related-notes-status' });
        this.listEl = contentEl.createEl('ul', { cls: 'related-notes-list' });

        await this.fetchRelatedNotes();
    }

    private async fetchRelatedNotes(): Promise<void> {
        if (!this.statusEl || !this.listEl) {
            return;
        }

        if (!this.ragService) {
            this.initializeRAGService();
        }

        if (!this.plugin.settings.enableSemanticSearch) {
            this.statusEl.setText(this.plugin.t.messages.semanticSearchDisabled);
            this.listEl.empty();
            return;
        }

        if (!this.plugin.embeddingService || !this.plugin.vectorStore || !this.ragService) {
            this.statusEl.setText(this.plugin.t.messages.vectorStoreFailed);
            this.listEl.empty();
            return;
        }

        const currentFile = this.app.workspace.getActiveFile();
        if (!currentFile || currentFile.extension !== 'md') {
            this.statusEl.setText(this.plugin.t.messages.noActiveFile);
            this.listEl.empty();
            return;
        }

        this.statusEl.setText(this.plugin.t.messages.findingRelatedNotes);
        this.listEl.empty();

        try {
            const content = await this.app.vault.cachedRead(currentFile);
            if (!content.trim()) {
                this.statusEl.setText(this.plugin.t.messages.noContent);
                return;
            }

            const limit = this.plugin.settings.relatedNotesCount || 15;
            this.results = await this.ragService.getRelatedNotes(
                currentFile, content, limit,
                { folderScope: this.folderScope }
            );
            if (this.results.length === 0) {
                this.statusEl.setText(this.plugin.t.messages.noRelatedNotes);
                return;
            }

            this.statusEl.setText('');
            this.renderResults();
        } catch (error) {
            console.error('Related notes modal error:', error);
            this.statusEl.setText(this.plugin.t.messages.relatedNotesFailed);
            this.listEl.empty();
        }
    }

    private renderResults(): void {
        if (!this.listEl) return;
        this.listEl.empty();

        for (const result of this.results) {
            const itemEl = this.listEl.createEl('li', { cls: 'related-notes-item' });
            const fileName = result.document.filePath.split('/').pop()?.replace('.md', '') || 'Untitled';
            const linkEl = itemEl.createEl('a', {
                cls: 'related-notes-link internal-link',
                text: fileName
            });

            linkEl.addEventListener('click', (e) => {
                e.preventDefault();
                void this.openNote(result.document.filePath);
                this.close();
            });
        }
    }

    private async openNote(filePath: string): Promise<void> {
        const file = this.app.vault.getFileByPath(filePath);
        if (file && file instanceof TFile) {
            await this.app.workspace.openLinkText(filePath, '', false);
        }
    }
}
