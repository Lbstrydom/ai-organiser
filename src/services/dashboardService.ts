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
    const hasViews = Array.isArray(root.views) && root.views.length > 0
        && root.views.every(v => isMapping(v) && typeof v.type === 'string' && v.type.trim() !== '');
    const hasTemplateShape = typeof root.name === 'string' && root.name.trim() !== ''
        && Array.isArray(root.columns) && root.columns.length > 0;
    if (!hasViews && !hasTemplateShape) {
        return 'it needs a views list (each view with a type), or a name and a columns list';
    }
    const filtered = [root, ...(Array.isArray(root.views) ? root.views : [])];
    for (const holder of filtered) {
        if (isMapping(holder) && holder.filters !== undefined && holder.filters !== null && !isFilterNode(holder.filters)) {
            return 'filters must be text or an and/or/not group of filters';
        }
    }
    return null;
}

/** `property.<name>` is the template dialect's spelling; Bases reads a bare name (or `note["x"]`). */
const PROPERTY_REF = /(?<![\w.])property\.([A-Za-z0-9_-]+)/g;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function filterRef(name: string): string {
    return IDENTIFIER.test(name) ? name : `note["${name}"]`;
}

/** Rewrite `property.<name>` references outside string literals (double or single quoted). */
function rewriteFilterText(expression: string): string {
    return expression
        .split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/)
        .map((part, i) => (i % 2 === 1 ? part : part.replace(PROPERTY_REF, (_m, name: string) => filterRef(name))))
        .join('');
}

/** Most filter nodes a template may expand to (a shared YAML alias counts once per use). */
const MAX_FILTER_NODES = 2000;

/**
 * Convert a filter tree. A node that contains itself (a YAML alias cycle), nesting beyond
 * MAX_FILTER_DEPTH, or an alias fan-out that expands past MAX_FILTER_NODES is refused instead of
 * expanded; ordinary reuse of a small alias converts (each use becomes its own copy).
 */
function nativeFilter(node: unknown, path: Set<object> = new Set(), budget = { nodes: 0 }, depth = 0): unknown {
    if (typeof node === 'string') return rewriteFilterText(node);
    if (typeof node !== 'object' || node === null) return node;
    if (depth > MAX_FILTER_DEPTH || path.has(node) || ++budget.nodes > MAX_FILTER_NODES) {
        throw new Error('Dashboard template cannot be converted: its filters nest too deeply, repeat themselves or expand too far');
    }
    path.add(node);
    const out = Array.isArray(node)
        ? node.map((child) => nativeFilter(child, path, budget, depth + 1))
        : Object.fromEntries(Object.entries(node).map(([key, value]) => [key, nativeFilter(value, path, budget, depth + 1)]));
    path.delete(node);
    return out;
}

/** A document written with front-matter style fences: the text between the first two `---` lines (the whole text when there is no closing fence). */
function unfence(content: string): string {
    const lines = content.split(/\r?\n/);
    // A fence is `---` at column 0 (an indented one is block-scalar text).
    const fence = /^---[ \t]*$/;
    if (!fence.test(lines[0] ?? '')) return content;
    const close = lines.findIndex((l, i) => i > 0 && fence.test(l));
    return close === -1 ? content : lines.slice(1, close).join('\n');
}

/** A template-dialect column as a Bases `order` entry. */
function nativeColumn(column: string): string {
    if (column === 'name' || column === 'property.name') return 'file.name';
    if (column === 'created') return 'file.ctime';
    const prop = /^property\.(.+)$/.exec(column);
    if (!prop) return column;
    return IDENTIFIER.test(prop[1]) ? prop[1] : `note.${prop[1]}`;
}

/**
 * The text of a .base document in the native Bases schema (`filters` + `views` with `order`).
 *
 * The plugin's own template dialect (`name` + `columns`, filters written `property.<name>`) is
 * not read by Obsidian: such a file opens with 0 results and a single file-name column. A
 * document that already has a `views` list (or is not a dialect document at all) is returned
 * unchanged; a dialect document becomes one table view. Invalid YAML throws like the other helpers.
 */
export function toNativeBase(content: string): string {
    const root = parseBaseMapping(unfence(content));
    const hasViews = Array.isArray(root.views) && root.views.length > 0;
    const hasTemplateShape = typeof root.name === 'string' && root.name.trim() !== ''
        && Array.isArray(root.columns) && root.columns.length > 0;
    if (hasViews || !hasTemplateShape) return content;

    const out: Record<string, unknown> = {};
    if (root.filters !== undefined && root.filters !== null) out.filters = nativeFilter(root.filters);
    for (const [key, value] of Object.entries(root)) {
        if (!['name', 'description', 'columns', 'filters', 'views'].includes(key)) out[key] = value;
    }
    const order = (root.columns as unknown[]).filter((c): c is string => typeof c === 'string' && c.trim() !== '').map(nativeColumn);
    out.views = [{ type: 'table', name: root.name, order }];
    return yaml.dump(out, { lineWidth: -1 });
}

/** A Bases filter: an expression string, or a group whose keys are and / or / not holding filter lists. */
function isFilterNode(node: unknown): boolean {
    return filterHeight(node, new Set(), new Map()) >= 0;
}

const MAX_FILTER_DEPTH = 32;

/**
 * Height of a valid filter subtree (0 for a string, 1 + deepest child for a group), or -1
 * when it is invalid. YAML aliases can turn the value into a graph, so cycles on the active
 * path and nesting beyond MAX_FILTER_DEPTH are rejected, and each shared node is measured
 * once (its height is memoised, so the depth limit still applies through every alias).
 */
function filterHeight(node: unknown, path: Set<object>, heights: Map<object, number>): number {
    if (typeof node === 'string') return node.trim() !== '' ? 0 : -1;
    if (!isMapping(node)) return -1;
    const known = heights.get(node);
    if (known !== undefined) return path.size + known > MAX_FILTER_DEPTH ? -1 : known;
    if (path.has(node) || path.size >= MAX_FILTER_DEPTH) return -1;
    const keys = Object.keys(node);
    if (keys.length === 0) return -1;
    path.add(node);
    let height = 1;
    for (const key of keys) {
        const group = node[key];
        if (!(key === 'and' || key === 'or' || key === 'not') || !Array.isArray(group)) {
            height = -1;
            break;
        }
        for (const child of group) {
            const childHeight = filterHeight(child, path, heights);
            if (childHeight < 0) {
                height = -1;
                break;
            }
            height = Math.max(height, childHeight + 1);
        }
        if (height < 0) break;
    }
    path.delete(node);
    if (height >= 0) heights.set(node, height);
    return height;
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

            // Write the native Bases schema (a template-dialect document is converted), scoped to the folder
            const content = this.injectFolderFilter(toNativeBase(template.content), options.folder.path);

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
            const columnsAt = lines.findIndex(l => /^(?:columns|views)[ \t]*:/.test(l));
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
            
            // Create dashboard file (a template-dialect document is written in the native schema)
            await this.app.vault.create(filePath, toNativeBase(content));

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
