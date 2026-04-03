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
    private isEditingFolder: boolean = false;
    private folderInputValue: string = '';

    constructor(app: App, plugin: AIOrganiserPlugin, targetFolder?: TFolder) {
        super(app);
        this.plugin = plugin;
        this.dashboardService = new DashboardService(app, plugin);
        this.targetFolder = targetFolder || this.dashboardService.getRecommendedDashboardFolder();
        this.folderInputValue = this.targetFolder.path || '/';
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

        // Folder section
        if (this.isEditingFolder) {
            // Edit mode - show input field
            const folderSetting = new Setting(container)
                .setName(this.plugin.t.modals.dashboardCreation.folderLabel)
                .addText(text => {
                    text
                        .setPlaceholder(this.plugin.t.modals.dashboardCreation.folderPlaceholder || '/')
                        .setValue(this.folderInputValue)
                        .onChange((value) => {
                            this.folderInputValue = value;
                        });
                });

            // Action buttons for folder input
            const buttonContainer = folderSetting.controlEl.createDiv({ cls: 'ai-organiser-folder-buttons' });
            
            const confirmBtn = buttonContainer.createEl('button', {
                text: this.plugin.t.modals.confirm,
                cls: 'mod-cta'
            });
            confirmBtn.style.marginRight = '8px';
            confirmBtn.addEventListener('click', async () => {
                await this.setFolderPath(this.folderInputValue);
            });

            const cancelBtn = buttonContainer.createEl('button', {
                text: this.plugin.t.modals.cancel
            });
            cancelBtn.addEventListener('click', () => {
                this.isEditingFolder = false;
                this.contentEl.empty();
                this.renderContent();
            });
        } else {
            // Display mode - show folder path with change button
            new Setting(container)
                .setName(this.plugin.t.modals.dashboardCreation.folderLabel)
                .setDesc(this.targetFolder.path || '/')
                .addButton(button => {
                    button
                        .setButtonText(this.plugin.t.modals.dashboardCreation.changeFolder)
                        .onClick(() => {
                            this.isEditingFolder = true;
                            this.folderInputValue = this.targetFolder.path || '/';
                            this.contentEl.empty();
                            this.renderContent();
                        });
                });
        }

        // Info about what will be created
        const infoEl = container.createEl('p', { cls: 'setting-item-description' });
        infoEl.setText(
            this.plugin.t.modals.dashboardCreation.willCreate ||
            'This will create a dashboard showing all AI-processed notes in this folder and subfolders.'
        );

        // Footer (only show in non-edit mode)
        if (!this.isEditingFolder) {
            const footer = container.createDiv({ cls: 'ai-organiser-modal-footer' });

            const cancelBtn = footer.createEl('button', { text: this.plugin.t.modals.cancel });
            cancelBtn.addEventListener('click', () => this.close());

            const createBtn = footer.createEl('button', {
                text: this.plugin.t.modals.dashboardCreation.createButton,
                cls: 'mod-cta'
            });
            createBtn.addEventListener('click', () => this.createDashboard());
        }
    }

    /**
     * Set the folder path and validate/create if needed
     */
    private async setFolderPath(path: string) {
        const trimmedPath = path.trim() || '/';

        // Try to get existing folder
        let folder = this.app.vault.getAbstractFileByPath(trimmedPath);
        
        if (folder && folder instanceof TFolder) {
            // Folder exists
            this.targetFolder = folder;
            this.isEditingFolder = false;
            this.contentEl.empty();
            await this.renderContent();
            new Notice(this.plugin.t.modals.dashboardCreation.folderSelected.replace('{folder}', trimmedPath));
        } else if (folder) {
            // Path exists but is a file, not a folder
            new Notice(this.plugin.t.modals.dashboardCreation.folderIsFile.replace('{path}', trimmedPath));
        } else {
            // Folder doesn't exist - try to create it
            try {
                await this.app.vault.createFolder(trimmedPath);
                const newFolder = this.app.vault.getAbstractFileByPath(trimmedPath);
                if (newFolder && newFolder instanceof TFolder) {
                    this.targetFolder = newFolder;
                    this.isEditingFolder = false;
                    this.contentEl.empty();
                    await this.renderContent();
                    new Notice(this.plugin.t.modals.dashboardCreation.folderCreated.replace('{folder}', trimmedPath));
                }
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : 'Unknown error';
                new Notice(this.plugin.t.modals.dashboardCreation.folderError.replace('{error}', errorMsg));
            }
        }
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
