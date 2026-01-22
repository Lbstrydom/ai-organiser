/**
 * Dashboard Creation Modal
 * Simple confirmation UI for creating Obsidian Bases dashboards
 */

import { App, Modal, Notice, TFolder, Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { DashboardService } from '../../services/dashboardService';

/**
 * Modal for creating Bases dashboards
 */
export class DashboardCreationModal extends Modal {
    private plugin: AIOrganiserPlugin;
    private dashboardService: DashboardService;
    private targetFolder: TFolder;

    constructor(app: App, plugin: AIOrganiserPlugin, targetFolder?: TFolder) {
        super(app);
        this.plugin = plugin;
        this.dashboardService = new DashboardService(app, plugin);
        this.targetFolder = targetFolder || this.dashboardService.getRecommendedDashboardFolder();
    }

    onOpen() {
        this.titleEl.setText(this.plugin.t.modals.dashboardCreation.title);
        this.renderContent();
    }

    onClose() {
        this.contentEl.empty();
    }

    /**
     * Render modal content
     */
    private async renderContent() {
        const container = this.contentEl.createDiv({ cls: 'ai-organiser-dashboard-modal' });

        // Description
        container.createEl('p', {
            text: this.plugin.t.modals.dashboardCreation.description,
            cls: 'ai-organiser-dashboard-description'
        });

        // Folder display
        new Setting(container)
            .setName(this.plugin.t.modals.dashboardCreation.folderLabel)
            .setDesc(this.targetFolder.path || '/')
            .addButton(button => {
                button
                    .setButtonText(this.plugin.t.modals.dashboardCreation.changeFolder)
                    .onClick(async () => {
                        const newPath = prompt(
                            this.plugin.t.modals.dashboardCreation.folderPrompt,
                            this.targetFolder.path || '/'
                        );

                        if (newPath) {
                            const folder = this.app.vault.getAbstractFileByPath(newPath);
                            if (folder && folder instanceof TFolder) {
                                this.targetFolder = folder;
                                this.contentEl.empty();
                                await this.renderContent();
                            } else {
                                try {
                                    await this.app.vault.createFolder(newPath);
                                    const newFolder = this.app.vault.getAbstractFileByPath(newPath);
                                    if (newFolder && newFolder instanceof TFolder) {
                                        this.targetFolder = newFolder;
                                        this.contentEl.empty();
                                        await this.renderContent();
                                    }
                                } catch {
                                    new Notice(this.plugin.t.modals.dashboardCreation.folderError);
                                }
                            }
                        }
                    });
            });

        // Info about what will be created
        const infoEl = container.createEl('p', { cls: 'setting-item-description' });
        infoEl.setText(
            this.plugin.t.modals.dashboardCreation.willCreate ||
            'This will create a dashboard showing all AI-processed notes in this folder and subfolders.'
        );

        // Footer
        const footer = container.createDiv({ cls: 'ai-organiser-modal-footer' });

        const cancelBtn = footer.createEl('button', { text: this.plugin.t.modals.cancel });
        cancelBtn.addEventListener('click', () => this.close());

        const createBtn = footer.createEl('button', {
            text: this.plugin.t.modals.dashboardCreation.createButton,
            cls: 'mod-cta'
        });
        createBtn.addEventListener('click', () => this.createDashboard());
    }

    /**
     * Create the dashboard
     */
    private async createDashboard() {
        this.close();

        // Get the first (and only) template
        const templates = await this.dashboardService.getAvailableTemplates();
        if (templates.length === 0) {
            new Notice('No dashboard templates available');
            return;
        }

        const success = await this.dashboardService.createDashboard({
            template: templates[0].name,
            folder: this.targetFolder
        });

        if (success) {
            new Notice(
                (this.plugin.t.modals.dashboardCreation.created || 'Dashboard created in {folder}')
                    .replace('{folder}', this.targetFolder.path || '/')
            );
        }
    }
}
