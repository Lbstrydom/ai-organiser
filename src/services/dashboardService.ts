/**
 * Dashboard Service
 * Generates Obsidian Bases dashboard (.base) files
 */

import { App, TFolder, Notice } from 'obsidian';
import * as yaml from 'js-yaml';
import type AIOrganiserPlugin from '../main';
import type { BasesTemplate } from './configurationService';
import { logger } from '../utils/logger';

function isMapping(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse a .base document that must be a single YAML mapping; otherwise throw. */
function parseBaseMapping(content: string): Record<string, unknown> {
    let parsed: unknown;
    try {
        parsed = yaml.load(content);
    } catch (error) {
        throw new Error(`Dashboard template is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isMapping(parsed)) {
        throw new Error('Dashboard template is not valid YAML: the document must be a mapping');
    }
    return parsed;
}

/**
 * Structural check for a .base document. Accepts the native Bases shape (a `views`
 * list) and the plugin's template dialect (`name` + `columns`); unrelated keys are
 * allowed. Returns null when valid, otherwise a short reason.
 */
export function validateBaseContent(content: string): string | null {
    let root: Record<string, unknown>;
    try {
        root = parseBaseMapping(content);
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
    const hasViews = Array.isArray(root.views) && root.views.length > 0 && root.views.every(isMapping);
    const hasTemplateShape = typeof root.name === 'string' && root.name.trim() !== ''
        && Array.isArray(root.columns) && root.columns.length > 0;
    if (!hasViews && !hasTemplateShape) {
        return 'it needs a views list, or a name and a columns list';
    }
    if (root.filters !== undefined && root.filters !== null && typeof root.filters !== 'string' && !isMapping(root.filters)) {
        return 'filters must be text or an and/or/not group';
    }
    return null;
}

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
        // Check if Bases is recommended/needed
        if (!this.plugin.basesService.isBasesEnabled()) {
             // We don't block creation, but we log a recommendation
             logger.debug('Dashboard', 'Bases plugin not enabled, creating file anyway (metadata-only mode)');
        }

        try {
            // Get template from config service
            const template = await this.plugin.configService.getBasesTemplateByName(options.template);
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

            // Inject folder filter into template content
            const content = this.injectFolderFilter(template.content, options.folder.path);

            // Create dashboard file
            await this.app.vault.create(filePath, content);

            new Notice(`Dashboard created: ${fullFileName}`);
            return true;

        } catch (error) {
            logger.error('Dashboard', 'Error creating dashboard:', error);
            new Notice(`Failed to create dashboard: ${error instanceof Error ? error.message : 'Unknown error'}`);
            return false;
        }
    }

    /**
     * Inject folder filter into template content
     * Wraps existing filters with folder restriction using file.inFolder()
     * Uses 'filters:' (plural) as per Bases syntax
     */
    private injectFolderFilter(content: string, folderPath: string): string {
        // Skip folder filter for root folder
        if (!folderPath || folderPath === '/') {
            return content;
        }

        // Bases string literal: backslash and quote are escaped here; the YAML layer
        // (single quotes doubled, etc.) is done by the serializer below.
        const folderFilter = `file.inFolder("${folderPath.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}")`;

        const before = parseBaseMapping(content);
        const existing = before.filters;
        let scoped: unknown;
        if (existing === undefined || existing === null) {
            scoped = folderFilter;
        } else if (isMapping(existing) && Object.keys(existing).length === 1 && Array.isArray(existing.and)) {
            scoped = { and: [folderFilter, ...existing.and] };
        } else {
            scoped = { and: [folderFilter, existing] };
        }

        const eol = content.includes('\r\n') ? '\r\n' : '\n';
        const rendered = yaml
            .dump({ filters: scoped }, { quotingType: "'", forceQuotes: true, lineWidth: -1 })
            .replaceAll('\n', eol);
        const lines = content.split('\n');

        // The top-level `filters` entry: a column-0 line, plain or quoted key.
        const keyLine = /^["']?filters["']?[ \t]*:/;
        const at = lines.flatMap((l, i) => (keyLine.test(l) ? [i] : []));
        if ('filters' in before && at.length !== 1) {
            throw new Error('Dashboard template cannot be scoped to the folder: unsupported filters layout');
        }

        let out: string;
        if (at.length === 1) {
            // Replace the whole entry: its line plus the indented lines that belong to it.
            let end = at[0] + 1;
            for (let i = at[0] + 1; i < lines.length; i++) {
                if (/^[ \t]+\S/.test(lines[i])) end = i + 1;
                else if (lines[i].trim() !== '') break;
            }
            out = [...lines.slice(0, at[0]), rendered.slice(0, -1), ...lines.slice(end)].join('\n');
        } else {
            const columnsAt = lines.findIndex(l => /^columns[ \t]*:/.test(l));
            if (columnsAt === -1) {
                out = content + (content.endsWith('\n') ? '' : eol) + rendered;
            } else {
                out = [...lines.slice(0, columnsAt), rendered.slice(0, -1), ...lines.slice(columnsAt)].join('\n');
            }
        }

        // Verify before emitting: one filters entry holding the intended value, everything
        // else exactly as parsed from the template.
        let reason = '';
        try {
            const after = parseBaseMapping(out);
            const rest = { ...before };
            const afterRest = { ...after };
            delete rest.filters;
            delete afterRest.filters;
            if (JSON.stringify(after.filters) !== JSON.stringify(scoped)) reason = 'filters did not survive the edit';
            else if (JSON.stringify(afterRest) !== JSON.stringify(rest)) reason = 'other settings changed';
        } catch (error) {
            reason = error instanceof Error ? error.message : String(error);
        }
        if (reason) {
            throw new Error(`Dashboard template cannot be scoped to the folder: ${reason}`);
        }
        return out;
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
    public async getAvailableTemplates(): Promise<BasesTemplate[]> {
        return this.plugin.configService.getBasesTemplates();
    }

    /**
     * Get templates by category
     */
    public async getTemplatesByCategory(category: 'default' | 'persona'): Promise<BasesTemplate[]> {
        return this.plugin.configService.getBasesTemplatesByCategory(category);
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
            
            // Validate the YAML structure
            const invalid = validateBaseContent(content);
            if (invalid) {
                new Notice(`Invalid dashboard format: ${invalid}. Fix the YAML and try again.`);
                return false;
            }
            
            // Create dashboard file
            await this.app.vault.create(filePath, content);
            
            new Notice(`Custom dashboard created: ${fullFileName}`);
            return true;
            
        } catch (error) {
            logger.error('Dashboard', 'Error creating custom dashboard:', error);
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
