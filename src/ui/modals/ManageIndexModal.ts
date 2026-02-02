import { App, Modal, Notice, Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { INDEX_SCHEMA_VERSION } from '../../services/vector/vectorStoreService';

export class ManageIndexModal extends Modal {
    private plugin: AIOrganiserPlugin;

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

        new Setting(contentEl)
            .setName(this.plugin.t.modals.manageIndex.buildLabel)
            .setDesc(this.plugin.t.modals.manageIndex.buildDesc)
            .addButton(btn => btn
                .setButtonText(this.plugin.t.modals.manageIndex.buildButton)
                .setCta()
                .onClick(() => void this.handleBuildIndex()));

        new Setting(contentEl)
            .setName(this.plugin.t.modals.manageIndex.updateLabel)
            .setDesc(this.plugin.t.modals.manageIndex.updateDesc)
            .addButton(btn => btn
                .setButtonText(this.plugin.t.modals.manageIndex.updateButton)
                .onClick(() => void this.handleUpdateIndex()));

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

        if (this.plugin.vectorStore) {
            const metadata = await this.plugin.vectorStore.getMetadata();
            if (metadata && metadata.version !== INDEX_SCHEMA_VERSION) {
                contentEl.createEl('p', {
                    text: this.plugin.t.modals.manageIndex.indexOutdated,
                    cls: 'ai-organiser-warning'
                });
            }
        }
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private ensureIndexingAvailable(): boolean {
        if (!this.plugin.settings.enableSemanticSearch) {
            new Notice(this.plugin.t.messages.semanticSearchDisabled);
            return false;
        }

        if (!this.plugin.vectorStoreService || !this.plugin.vectorStore) {
            new Notice(this.plugin.t.messages.vectorStoreFailed);
            return false;
        }

        return true;
    }

    private async handleBuildIndex(): Promise<void> {
        if (!this.ensureIndexingAvailable() || !this.plugin.vectorStoreService) {
            return;
        }

        const statusNotice = new Notice(this.plugin.t.messages.buildingIndex, 0);
        try {
            const result = await this.plugin.vectorStoreService.indexVault();
            statusNotice.hide();
            new Notice(
                this.plugin.t.messages.indexBuildComplete
                    .replace('{indexed}', String(result.indexed))
                    .replace('{failed}', String(result.failed))
            );
        } catch (error) {
            statusNotice.hide();
            new Notice(`${this.plugin.t.messages.indexBuildFailed}: ${(error as any).message}`);
        }
    }

    private async handleUpdateIndex(): Promise<void> {
        if (!this.ensureIndexingAvailable() || !this.plugin.vectorStoreService) {
            return;
        }

        const statusNotice = new Notice(this.plugin.t.messages.updatingIndex, 0);
        try {
            const result = await this.plugin.vectorStoreService.indexVault();
            statusNotice.hide();
            new Notice(
                this.plugin.t.messages.indexBuildComplete
                    .replace('{indexed}', String(result.indexed))
                    .replace('{failed}', String(result.failed))
            );
        } catch (error) {
            statusNotice.hide();
            new Notice(`${this.plugin.t.messages.indexUpdateFailed}: ${(error as any).message}`);
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
        } catch (error) {
            statusNotice.hide();
            new Notice(`${this.plugin.t.messages.indexClearFailed}: ${(error as any).message}`);
        }
    }
}
