/**
 * Dashboard Creation Modal
 * UI for creating Obsidian Bases dashboards
 */

import { App, Modal, Notice, TFolder, Setting, setIcon } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { DashboardService } from '../../services/dashboardService';
import { DashboardTemplate, getTemplatesByCategory } from '../../services/dashboardTemplates';

/**
 * Modal for creating Bases dashboards
 */
export class DashboardCreationModal extends Modal {
    private plugin: AIOrganiserPlugin;
    private dashboardService: DashboardService;
    private selectedTemplates: Set<string> = new Set();
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
    private renderContent() {
        const container = this.contentEl.createDiv({ cls: 'ai-organiser-dashboard-modal' });
        
        // Description
        container.createEl('p', { 
            text: this.plugin.t.modals.dashboardCreation.description,
            cls: 'ai-organiser-dashboard-description'
        });
        
        // Folder selection
        const folderSection = container.createDiv({ cls: 'ai-organiser-dashboard-section' });
        folderSection.createEl('h3', { text: this.plugin.t.modals.dashboardCreation.folderTitle });
        
        const folderSetting = new Setting(folderSection)
            .setName(this.plugin.t.modals.dashboardCreation.folderLabel)
            .setDesc(this.targetFolder.path || '/')
            .addButton(button => {
                button
                    .setButtonText(this.plugin.t.modals.dashboardCreation.changeFolder)
                    .onClick(async () => {
                        // Simple folder picker - user can type path
                        const newPath = prompt(
                            this.plugin.t.modals.dashboardCreation.folderPrompt,
                            this.targetFolder.path || '/'
                        );
                        
                        if (newPath) {
                            const folder = this.app.vault.getAbstractFileByPath(newPath);
                            if (folder && folder instanceof TFolder) {
                                this.targetFolder = folder;
                                this.contentEl.empty();
                                this.renderContent();
                            } else {
                                // Try to create folder
                                try {
                                    await this.app.vault.createFolder(newPath);
                                    const newFolder = this.app.vault.getAbstractFileByPath(newPath);
                                    if (newFolder && newFolder instanceof TFolder) {
                                        this.targetFolder = newFolder;
                                        this.contentEl.empty();
                                        this.renderContent();
                                    }
                                } catch (error) {
                                    new Notice(this.plugin.t.modals.dashboardCreation.folderError);
                                }
                            }
                        }
                    });
            });
        
        // Template selection
        const templateSection = container.createDiv({ cls: 'ai-organiser-dashboard-section' });
        templateSection.createEl('h3', { text: this.plugin.t.modals.dashboardCreation.templateTitle });
        
        // Default templates section
        const defaultSection = templateSection.createDiv({ cls: 'ai-organiser-template-category' });
        defaultSection.createEl('h4', { text: this.plugin.t.modals.dashboardCreation.defaultTemplates || 'Default Templates' });
        const defaultTemplates = getTemplatesByCategory('default');
        defaultTemplates.forEach(template => {
            this.createTemplateCheckbox(defaultSection, template);
        });
        
        // Persona templates section
        const personaSection = templateSection.createDiv({ cls: 'ai-organiser-template-category' });
        personaSection.createEl('h4', { text: this.plugin.t.modals.dashboardCreation.personaTemplates || 'Persona Templates' });
        const personaTemplates = getTemplatesByCategory('persona');
        personaTemplates.forEach(template => {
            this.createTemplateCheckbox(personaSection, template);
        });
        
        // Get all templates for quick actions
        const allTemplates = [...defaultTemplates, ...personaTemplates];
        
        // Quick actions
        const quickActions = templateSection.createDiv({ cls: 'ai-organiser-dashboard-quick-actions' });
        
        const selectAllBtn = quickActions.createEl('button', { 
            text: this.plugin.t.modals.dashboardCreation.selectAll
        });
        selectAllBtn.addEventListener('click', () => {
            allTemplates.forEach(t => this.selectedTemplates.add(t.name));
            this.contentEl.empty();
            this.renderContent();
        });
        
        const selectNoneBtn = quickActions.createEl('button', { 
            text: this.plugin.t.modals.dashboardCreation.selectNone
        });
        selectNoneBtn.addEventListener('click', () => {
            this.selectedTemplates.clear();
            this.contentEl.empty();
            this.renderContent();
        });
        
        // Footer
        const footer = container.createDiv({ cls: 'ai-organiser-modal-footer' });
        
        const cancelBtn = footer.createEl('button', { text: this.plugin.t.modals.cancel });
        cancelBtn.addEventListener('click', () => this.close());
        
        const createBtn = footer.createEl('button', { 
            text: this.plugin.t.modals.dashboardCreation.createButton,
            cls: 'mod-cta'
        });
        createBtn.disabled = this.selectedTemplates.size === 0;
        createBtn.addEventListener('click', () => this.createDashboards());
    }
    
    /**
     * Create template checkbox
     */
    private createTemplateCheckbox(container: HTMLElement, template: DashboardTemplate) {
        const templateItem = container.createDiv({ cls: 'ai-organiser-template-item' });
        
        const checkbox = templateItem.createEl('input', { type: 'checkbox' });
        checkbox.checked = this.selectedTemplates.has(template.name);
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
                this.selectedTemplates.add(template.name);
            } else {
                this.selectedTemplates.delete(template.name);
            }
            this.contentEl.empty();
            this.renderContent();
        });
        
        // Add icon for persona templates
        if (template.icon) {
            const iconSpan = templateItem.createSpan({ cls: 'ai-organiser-template-icon' });
            setIcon(iconSpan, template.icon);
        }
        
        const label = templateItem.createDiv({ cls: 'ai-organiser-template-label' });
        label.createEl('strong', { text: template.name });
        label.createEl('p', { 
            text: template.description,
            cls: 'ai-organiser-template-description'
        });
    }
    
    /**
     * Create selected dashboards
     */
    private async createDashboards() {
        if (this.selectedTemplates.size === 0) {
            new Notice(this.plugin.t.modals.dashboardCreation.noTemplatesSelected);
            return;
        }
        
        // Close modal immediately
        this.close();
        
        // Create dashboards
        const result = await this.dashboardService.createDashboardsFromTemplates(
            Array.from(this.selectedTemplates),
            this.targetFolder
        );
        
        // Show result
        if (result.failed === 0) {
            new Notice(
                this.plugin.t.modals.dashboardCreation.allCreated
                    .replace('{count}', String(result.created))
            );
        } else {
            new Notice(
                this.plugin.t.modals.dashboardCreation.someCreated
                    .replace('{created}', String(result.created))
                    .replace('{failed}', String(result.failed))
            );
        }
    }
}

