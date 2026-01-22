/**
 * Dashboard Service
 * Generates Obsidian Bases dashboard (.base) files
 */

import { App, TFolder, Notice } from 'obsidian';
import { DASHBOARD_TEMPLATES, DashboardTemplate, getTemplateByName } from './dashboardTemplates';
import type AIOrganiserPlugin from '../main';

export interface DashboardCreationOptions {
    /** Template to use */
    template: string;
    
    /** Custom file name (optional) */
    customFileName?: string;
    
    /** Target folder for dashboard file */
    folder: TFolder;
}

/**
 * Dashboard Service for creating Bases dashboard files
 */
export class DashboardService {
    private app: App;
    private plugin: AIOrganiserPlugin;
    
    constructor(app: App, plugin: AIOrganiserPlugin) {
        this.app = app;
        this.plugin = plugin;
    }
    
    /**
     * Create a dashboard from a template
     */
    public async createDashboard(options: DashboardCreationOptions): Promise<boolean> {
        try {
            // Get template
            const template = getTemplateByName(options.template);
            if (!template) {
                new Notice(`Template not found: ${options.template}`);
                return false;
            }
            
            // Determine file name
            const fileName = options.customFileName || template.fileName;
            
            // Ensure .base extension
            const fullFileName = fileName.endsWith('.base') ? fileName : `${fileName}.base`;
            
            // Build full path
            const filePath = `${options.folder.path}/${fullFileName}`;
            
            // Check if file already exists
            const existingFile = this.app.vault.getAbstractFileByPath(filePath);
            if (existingFile) {
                new Notice(`Dashboard already exists: ${fullFileName}`);
                return false;
            }
            
            // Create dashboard file
            await this.app.vault.create(filePath, template.content);
            
            new Notice(`Dashboard created: ${fullFileName}`);
            return true;
            
        } catch (error) {
            console.error('[Dashboard] Error creating dashboard:', error);
            new Notice(`Failed to create dashboard: ${error instanceof Error ? error.message : 'Unknown error'}`);
            return false;
        }
    }
    
    /**
     * Create multiple dashboards from templates
     */
    public async createDashboardsFromTemplates(
        templateNames: string[],
        folder: TFolder
    ): Promise<{ created: number; failed: number }> {
        let created = 0;
        let failed = 0;
        
        for (const templateName of templateNames) {
            const success = await this.createDashboard({
                template: templateName,
                folder
            });
            
            if (success) {
                created++;
            } else {
                failed++;
            }
        }
        
        return { created, failed };
    }
    
    /**
     * Get all available templates
     */
    public getAvailableTemplates(): DashboardTemplate[] {
        return DASHBOARD_TEMPLATES;
    }
    
    /**
     * Create a custom dashboard with custom YAML
     */
    public async createCustomDashboard(
        fileName: string,
        content: string,
        folder: TFolder
    ): Promise<boolean> {
        try {
            // Ensure .base extension
            const fullFileName = fileName.endsWith('.base') ? fileName : `${fileName}.base`;
            
            // Build full path
            const filePath = `${folder.path}/${fullFileName}`;
            
            // Check if file already exists
            const existingFile = this.app.vault.getAbstractFileByPath(filePath);
            if (existingFile) {
                new Notice(`Dashboard already exists: ${fullFileName}`);
                return false;
            }
            
            // Validate YAML structure (basic check)
            if (!content.includes('---') || !content.includes('name:') || !content.includes('columns:')) {
                new Notice('Invalid dashboard format. Must contain YAML frontmatter with name and columns.');
                return false;
            }
            
            // Create dashboard file
            await this.app.vault.create(filePath, content);
            
            new Notice(`Custom dashboard created: ${fullFileName}`);
            return true;
            
        } catch (error) {
            console.error('[Dashboard] Error creating custom dashboard:', error);
            new Notice(`Failed to create dashboard: ${error instanceof Error ? error.message : 'Unknown error'}`);
            return false;
        }
    }
    
    /**
     * Get recommended folder for dashboards
     * Looks for common dashboard folders or suggests root
     */
    public getRecommendedDashboardFolder(): TFolder {
        // Check for common dashboard folders
        const commonNames = ['Dashboards', 'Views', 'Bases', 'Reports'];
        
        for (const name of commonNames) {
            const folder = this.app.vault.getAbstractFileByPath(name);
            if (folder && folder instanceof TFolder) {
                return folder;
            }
        }
        
        // Return root if no common folder found
        return this.app.vault.getRoot();
    }
    
    /**
     * Create dashboard folder if it doesn't exist
     */
    public async ensureDashboardFolder(folderName: string = 'Dashboards'): Promise<TFolder> {
        const existingFolder = this.app.vault.getAbstractFileByPath(folderName);
        
        if (existingFolder && existingFolder instanceof TFolder) {
            return existingFolder;
        }
        
        // Create folder
        await this.app.vault.createFolder(folderName);
        
        const newFolder = this.app.vault.getAbstractFileByPath(folderName);
        if (newFolder && newFolder instanceof TFolder) {
            return newFolder;
        }
        
        // Fallback to root
        return this.app.vault.getRoot();
    }
}
