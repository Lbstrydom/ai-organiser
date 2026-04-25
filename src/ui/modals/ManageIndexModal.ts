import { App, Modal, Notice, Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { INDEX_SCHEMA_VERSION } from '../../services/vector/vectorStoreService';
import { noticeWithSettingsLink } from '../../utils/noticeUtils';

export class ManageIndexModal extends Modal {
    private plugin: AIOrganiserPlugin;
    private statusEl: HTMLElement | null = null;

    constructor(app: App, plugin: AIOrganiserPlugin) {
        super(app);
        this.plugin = plugin;
    }

    async onOpen(): Promise<void> {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('ai-organiser-modal-content');
        contentEl.addClass('ai-organiser-manage-index-modal');

        contentEl.createEl('h2', { text: this.plugin.t.modals.manageIndex.title });
        contentEl.createEl('p', {
            text: this.plugin.t.modals.manageIndex.description,
            cls: 'setting-item-description'
        });

        // Show version warning if outdated
        if (this.plugin.vectorStore) {
            const metadata = await this.plugin.vectorStore.getMetadata();
            if (metadata && metadata.version !== INDEX_SCHEMA_VERSION) {
                contentEl.createEl('p', {
                    text: this.plugin.t.modals.manageIndex.indexOutdated,
                    cls: 'ai-organiser-warning'
                });
            }
        }

        // Show embedding service status
        const hasEmbedding = !!this.plugin.embeddingService;
        if (!hasEmbedding) {
            contentEl.createEl('p', {
                text: 'Embedding service not configured. Set an embedding provider and API key in semantic search settings before building.',
                cls: 'ai-organiser-warning'
            });
        }

        // Status area for progress/results
        this.statusEl = contentEl.createDiv({ cls: 'ai-organiser-index-status' });

        new Setting(contentEl)
            .setName(this.plugin.t.modals.manageIndex.buildLabel)
            .setDesc(this.plugin.t.modals.manageIndex.buildDesc)
            .addButton(btn => {
                btn.setButtonText(this.plugin.t.modals.manageIndex.buildButton)
                    .setCta()
                    .onClick(() => void this.handleBuildIndex());
                if (!hasEmbedding) btn.setDisabled(true);
            });

        new Setting(contentEl)
            .setName(this.plugin.t.modals.manageIndex.updateLabel)
            .setDesc(this.plugin.t.modals.manageIndex.updateDesc)
            .addButton(btn => {
                btn.setButtonText(this.plugin.t.modals.manageIndex.updateButton)
                    .onClick(() => void this.handleUpdateIndex());
                if (!hasEmbedding) btn.setDisabled(true);
            });

        new Setting(contentEl)
            .setName(this.plugin.t.modals.manageIndex.clearLabel)
            .setDesc(this.plugin.t.modals.manageIndex.clearDesc)
            .addButton(btn => btn
                .setButtonText(this.plugin.t.modals.manageIndex.clearButton)
                .setWarning()
                .onClick(() => void this.handleClearIndex()));

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(this.plugin.t.modals.manageIndex.closeButton)
                .onClick(() => this.close()));
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private ensureIndexingAvailable(): boolean {
        if (!this.plugin.settings.enableSemanticSearch) {
            noticeWithSettingsLink(this.plugin, this.plugin.t.messages.semanticSearchDisabled);
            return false;
        }

        if (!this.plugin.vectorStoreService || !this.plugin.vectorStore) {
            new Notice(this.plugin.t.messages.vectorStoreFailed);
            return false;
        }

        return true;
    }

    private setStatus(text: string, type: 'info' | 'success' | 'error' = 'info'): void {
        if (!this.statusEl) return;
        this.statusEl.empty();
        this.statusEl.textContent = text;
        this.statusEl.className = `ai-organiser-index-status ai-organiser-index-status-${type}`;
    }

    private async handleBuildIndex(): Promise<void> {
        if (!this.ensureIndexingAvailable() || !this.plugin.vectorStoreService) {
            return;
        }

        if (!this.plugin.embeddingService) {
            this.setStatus('Embedding service not configured. Set an embedding provider and API key first.', 'error');
            return;
        }

        this.setStatus(this.plugin.t.messages.buildingIndex);
        try {
            const result = await this.plugin.vectorStoreService.rebuildVault();
            const msg = this.plugin.t.messages.indexBuildComplete
                .replace('{indexed}', String(result.indexed))
                .replace('{failed}', String(result.failed));
            this.setStatus(msg, 'success');
            new Notice(msg);
        } catch (error) {
            const msg = `${this.plugin.t.messages.indexBuildFailed}: ${(error instanceof Error ? error.message : String(error))}`;
            this.setStatus(msg, 'error');
            new Notice(msg);
        }
    }

    private async handleUpdateIndex(): Promise<void> {
        if (!this.ensureIndexingAvailable() || !this.plugin.vectorStoreService) {
            return;
        }

        if (!this.plugin.embeddingService) {
            this.setStatus('Embedding service not configured. Set an embedding provider and API key first.', 'error');
            return;
        }

        this.setStatus(this.plugin.t.messages.updatingIndex);
        try {
            const result = await this.plugin.vectorStoreService.indexVault();
            const msg = this.plugin.t.messages.indexBuildComplete
                .replace('{indexed}', String(result.indexed))
                .replace('{failed}', String(result.failed));
            this.setStatus(msg, 'success');
            new Notice(msg);
        } catch (error) {
            const msg = `${this.plugin.t.messages.indexUpdateFailed}: ${(error instanceof Error ? error.message : String(error))}`;
            this.setStatus(msg, 'error');
            new Notice(msg);
        }
    }

    private async handleClearIndex(): Promise<void> {
        if (!this.ensureIndexingAvailable() || !this.plugin.vectorStore) {
            return;
        }

        const confirmed = await this.plugin.showConfirmationDialog(
            this.plugin.t.modals.manageIndex.clearConfirm
        );
        if (!confirmed) {
            return;
        }

        const statusNotice = new Notice(this.plugin.t.messages.clearingIndex, 0);
        try {
            await this.plugin.vectorStore.clear();
            statusNotice.hide();
            new Notice(this.plugin.t.messages.indexCleared);
            await this.onOpen();
        } catch (error) {
            statusNotice.hide();
            new Notice(`${this.plugin.t.messages.indexClearFailed}: ${(error instanceof Error ? error.message : String(error))}`);
        }
    }
}
