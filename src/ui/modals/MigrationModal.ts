/**
 * Migration Modal
 * 4-stage UI for migrating notes to Bases format
 */

import { App, Modal, TFolder } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { 
    MigrationService, 
    MigrationOptions, 
    MigrationResult,
    MigrationScope 
} from '../../services/migrationService';

type MigrationStage = 'analysis' | 'options' | 'progress' | 'results';

/**
 * Modal for migrating notes to Obsidian Bases format
 */
export class MigrationModal extends Modal {
    private plugin: AIOrganiserPlugin;
    private migrationService: MigrationService;
    private stage: MigrationStage = 'analysis';
    private migrationScope: MigrationScope | null = null;
    private options: MigrationOptions;
    private result: MigrationResult | null = null;
    private targetFolder: TFolder | null = null;
    
    constructor(app: App, plugin: AIOrganiserPlugin, targetFolder?: TFolder) {
        super(app);
        this.plugin = plugin;
        this.migrationService = new MigrationService(app, plugin);
        this.targetFolder = targetFolder || null;
        
        // Default options
        this.options = {
            overwriteExisting: false,
            extractSummary: true,
            excludedFolders: plugin.settings.excludedFolders || []
        };
    }
    
    onOpen() {
        this.renderStage();
    }
    
    onClose() {
        this.contentEl.empty();
    }
    
    /**
     * Render current stage
     */
    private renderStage() {
        this.contentEl.empty();
        
        switch (this.stage) {
            case 'analysis':
                void this.renderAnalysisStage();
                break;
            case 'options':
                this.renderOptionsStage();
                break;
            case 'progress':
                this.renderProgressStage();
                break;
            case 'results':
                this.renderResultsStage();
                break;
        }
    }
    
    /**
     * Stage 1: Analysis
     */
    private async renderAnalysisStage() {
        this.titleEl.setText(this.plugin.t.modals.migration.title);
        
        const container = this.contentEl.createDiv({ cls: 'ai-organiser-migration-modal' });
        
        // Show loading state
        container.createEl('p', { 
            text: this.plugin.t.modals.migration.analyzing,
            cls: 'ai-organiser-migration-loading'
        });
        
        container.createDiv({ cls: 'ai-organiser-spinner' });
        
        // Analyze scope
        try {
            this.migrationScope = await this.migrationService.analyzeMigrationScope(this.targetFolder || undefined);
            
            // Clear loading state
            container.empty();
            
            // Show analysis results
            container.createEl('h3', { text: this.plugin.t.modals.migration.analysisTitle });
            
            const stats = container.createDiv({ cls: 'ai-organiser-migration-stats' });
            
            stats.createEl('p', { 
                text: `${this.plugin.t.modals.migration.totalNotes}: ${this.migrationScope.total}` 
            });
            stats.createEl('p', { 
                text: `${this.plugin.t.modals.migration.needsMigration}: ${this.migrationScope.needsMigration}`,
                cls: 'ai-organiser-migration-highlight'
            });
            stats.createEl('p', { 
                text: `${this.plugin.t.modals.migration.alreadyMigrated}: ${this.migrationScope.alreadyMigrated}` 
            });
            
            if (this.migrationScope.needsMigration === 0) {
                container.createEl('p', { 
                    text: this.plugin.t.modals.migration.noMigrationNeeded,
                    cls: 'ai-organiser-migration-success'
                });
                
                // Close button
                const footer = container.createDiv({ cls: 'ai-organiser-modal-footer' });
                const closeBtn = footer.createEl('button', { 
                    text: this.plugin.t.common.close,
                    cls: 'mod-cta'
                });
                closeBtn.addEventListener('click', () => this.close());
            } else {
                // Continue to options
                const footer = container.createDiv({ cls: 'ai-organiser-modal-footer' });
                
                const cancelBtn = footer.createEl('button', { text: this.plugin.t.common.cancel });
                cancelBtn.addEventListener('click', () => this.close());
                
                const nextBtn = footer.createEl('button', { 
                    text: this.plugin.t.common.next,
                    cls: 'mod-cta'
                });
                nextBtn.addEventListener('click', () => {
                    this.stage = 'options';
                    this.renderStage();
                });
            }
            
        } catch (error) {
            container.empty();
            container.createEl('p', { 
                text: `${this.plugin.t.modals.migration.analysisFailed}: ${error instanceof Error ? error.message : 'Unknown error'}`,
                cls: 'ai-organiser-error'
            });
            
            const footer = container.createDiv({ cls: 'ai-organiser-modal-footer' });
            const closeBtn = footer.createEl('button', { 
                text: this.plugin.t.common.close,
                cls: 'mod-cta'
            });
            closeBtn.addEventListener('click', () => this.close());
        }
    }
    
    /**
     * Stage 2: Options
     */
    private renderOptionsStage() {
        const container = this.contentEl.createDiv({ cls: 'ai-organiser-migration-modal' });
        
        container.createEl('h3', { text: this.plugin.t.modals.migration.optionsTitle });
        
        // Option: Overwrite existing
        const overwriteContainer = container.createDiv({ cls: 'ai-organiser-setting-item' });
        overwriteContainer.createEl('label', { text: this.plugin.t.modals.migration.overwriteExisting });
        const overwriteCheckbox = overwriteContainer.createEl('input', { type: 'checkbox' });
        overwriteCheckbox.checked = this.options.overwriteExisting;
        overwriteCheckbox.addEventListener('change', () => {
            this.options.overwriteExisting = overwriteCheckbox.checked;
        });
        
        // Option: Extract summary
        const extractContainer = container.createDiv({ cls: 'ai-organiser-setting-item' });
        extractContainer.createEl('label', { text: this.plugin.t.modals.migration.extractSummary });
        const extractCheckbox = extractContainer.createEl('input', { type: 'checkbox' });
        extractCheckbox.checked = this.options.extractSummary;
        extractCheckbox.addEventListener('change', () => {
            this.options.extractSummary = extractCheckbox.checked;
        });
        
        // Info text
        container.createEl('p', { 
            text: this.plugin.t.modals.migration.optionsInfo,
            cls: 'ai-organiser-migration-info'
        });
        
        // Footer buttons
        const footer = container.createDiv({ cls: 'ai-organiser-modal-footer' });
        
        const backBtn = footer.createEl('button', { text: this.plugin.t.common.back });
        backBtn.addEventListener('click', () => {
            this.stage = 'analysis';
            this.renderStage();
        });
        
        const startBtn = footer.createEl('button', { 
            text: this.plugin.t.modals.migration.startMigration,
            cls: 'mod-cta'
        });
        startBtn.addEventListener('click', () => {
            this.stage = 'progress';
            this.renderStage();
            void this.executeMigration();
        });
    }
    
    /**
     * Stage 3: Progress
     */
    private renderProgressStage() {
        const container = this.contentEl.createDiv({ cls: 'ai-organiser-migration-modal' });
        
        container.createEl('h3', { text: this.plugin.t.modals.migration.progressTitle });
        
        const progressContainer = container.createDiv({ cls: 'ai-organiser-migration-progress' });
        
        const progressBar = progressContainer.createDiv({ cls: 'ai-organiser-progress-bar' });
        const progressFill = progressBar.createDiv({ cls: 'ai-organiser-progress-fill' });
        progressFill.setCssProps({ '--progress-width': '0%' }); progressFill.addClass('ai-organiser-dynamic-width');
        
        const statusText = progressContainer.createEl('p', { 
            text: this.plugin.t.modals.migration.starting,
            cls: 'ai-organiser-migration-status'
        });
        
        // Store references for updates
        this.contentEl.dataset.progressFill = progressFill.id = 'migration-progress-fill';
        this.contentEl.dataset.statusText = statusText.id = 'migration-status-text';
    }
    
    /**
     * Execute migration with progress updates
     */
    private async executeMigration() {
        if (!this.migrationScope) return;
        
        const progressFill = this.contentEl.querySelector('#migration-progress-fill') as HTMLElement;
        const statusText = this.contentEl.querySelector('#migration-status-text') as HTMLElement;
        
        const progressCallback = (current: number, total: number, fileName: string) => {
            const percent = Math.round((current / total) * 100);
            if (progressFill) {
                progressFill.setCssProps({ '--dynamic-width': `${percent}%` });
            }
            if (statusText) {
                statusText.setText(`${this.plugin.t.modals.migration.processing} ${current}/${total}: ${fileName}`);
            }
        };
        
        try {
            if (this.targetFolder) {
                this.result = await this.migrationService.migrateFolder(
                    this.targetFolder,
                    this.options,
                    progressCallback
                );
            } else {
                this.result = await this.migrationService.migrateVault(
                    this.options,
                    progressCallback
                );
            }
            
            // Move to results stage
            this.stage = 'results';
            this.renderStage();
            
        } catch (error) {
            if (statusText) {
                statusText.setText(`${this.plugin.t.modals.migration.failed}: ${error instanceof Error ? error.message : 'Unknown error'}`);
                statusText.addClass('ai-organiser-error');
            }
            
            const footer = this.contentEl.createDiv({ cls: 'ai-organiser-modal-footer' });
            const closeBtn = footer.createEl('button', { 
                text: this.plugin.t.common.close,
                cls: 'mod-cta'
            });
            closeBtn.addEventListener('click', () => this.close());
        }
    }
    
    /**
     * Stage 4: Results
     */
    private renderResultsStage() {
        const container = this.contentEl.createDiv({ cls: 'ai-organiser-migration-modal' });
        
        if (!this.result) return;
        
        container.createEl('h3', { text: this.plugin.t.modals.migration.resultsTitle });
        
        const stats = container.createDiv({ cls: 'ai-organiser-migration-stats' });
        
        stats.createEl('p', { 
            text: `${this.plugin.t.modals.migration.processed}: ${this.result.processed}` 
        });
        stats.createEl('p', { 
            text: `${this.plugin.t.modals.migration.updated}: ${this.result.updated}`,
            cls: 'ai-organiser-migration-success'
        });
        stats.createEl('p', { 
            text: `${this.plugin.t.modals.migration.skipped}: ${this.result.skipped}` 
        });
        
        if (this.result.errors > 0) {
            stats.createEl('p', { 
                text: `${this.plugin.t.modals.migration.errors}: ${this.result.errors}`,
                cls: 'ai-organiser-error'
            });
            
            // Show error messages
            const errorContainer = container.createDiv({ cls: 'ai-organiser-migration-errors' });
            errorContainer.createEl('h4', { text: this.plugin.t.modals.migration.errorList });
            const errorList = errorContainer.createEl('ul');
            
            this.result.errorMessages.slice(0, 10).forEach(msg => {
                errorList.createEl('li', { text: msg });
            });
            
            if (this.result.errorMessages.length > 10) {
                errorList.createEl('li', { 
                    text: `... ${this.plugin.t.modals.migration.moreErrors.replace('{count}', String(this.result.errorMessages.length - 10))}` 
                });
            }
        } else {
            container.createEl('p', { 
                text: this.plugin.t.modals.migration.completed,
                cls: 'ai-organiser-migration-success'
            });
        }
        
        // Footer
        const footer = container.createDiv({ cls: 'ai-organiser-modal-footer' });
        const closeBtn = footer.createEl('button', { 
            text: this.plugin.t.common.close,
            cls: 'mod-cta'
        });
        closeBtn.addEventListener('click', () => this.close());
    }
}


