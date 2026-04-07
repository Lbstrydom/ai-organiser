import { App, TFile } from 'obsidian';
import type { AIOrganiserSettings } from '../../core/settings';
import { getChatRootFullPath } from '../../core/settings';
import { ensureFolderExists } from '../../utils/minutesUtils';
import { logger } from '../../utils/logger';
import { type Result, ok, err } from '../../core/result';

export interface ProjectConfig {
    id: string;
    name: string;
    slug: string;
    folderPath: string;
    instructions: string;
    memory: string[];
    pinnedFiles: string[];
    created: string;
}

/** Public project shape used by UI and tests (maps ProjectConfig fields to friendlier names). */
export interface Project {
    id: string;
    name: string;
    slug: string;
    folderPath: string;
    filePath: string;
    instructions: string;
    memory: string[];
    pinnedLinks: string[];
    createdAt: string;
}

export interface ProjectTreeNode {
    type: 'project' | 'group';
    name: string;
    path: string;                    // vault folder path
    children: ProjectTreeNode[];
    project?: ProjectConfig;         // only if type === 'project'
    depth: number;                   // distance from Projects/ root
}

export const MAX_PROJECT_DEPTH = 3;

const PLACEHOLDER_INSTRUCTIONS = '_No instructions configured._';
const PLACEHOLDER_MEMORY = '_No memories yet._';

export function extractWikilinks(text: string): string[] {
    const matches = text.matchAll(/\[\[([^\]]+)\]\]/g);
    return [...matches].map(m => m[1].split('|')[0].trim());
}

function slugify(name: string): string {
    return name.replace(/[/\\:*?"<>|]/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function parseProjectMd(content: string, folderPath: string): ProjectConfig | null {
    // Extract frontmatter fields
    const idMatch = content.match(/^project_id:\s*"?([^"\n]+)"?/m);
    const createdMatch = content.match(/^created:\s*(\S+)/m);
    if (!idMatch) return null;

    // Extract name from h1
    const nameMatch = content.match(/^#\s+(.+)$/m);
    const name = nameMatch?.[1]?.trim() ?? 'Unnamed Project';

    // Extract instructions section
    const instrMatch = content.match(/##\s+Instructions\s*\n([\s\S]*?)(?=\n##\s|\n---|\s*$)/);
    let instructions = instrMatch?.[1]?.trim() ?? '';
    if (instructions === PLACEHOLDER_INSTRUCTIONS) instructions = '';

    // Extract memory section
    const memMatch = content.match(/##\s+Memory\s*\n([\s\S]*?)(?=\n##\s|\n---|\s*$)/);
    const memBlock = memMatch?.[1]?.trim() ?? '';
    let memory: string[] = [];
    if (memBlock && memBlock !== PLACEHOLDER_MEMORY) {
        memory = memBlock.split('\n')
            .filter(l => l.startsWith('- '))
            .map(l => l.slice(2).trim())
            .filter(Boolean);
    }

    // Extract pinned files section
    const pinnedMatch = content.match(/##\s+Pinned Files\s*\n([\s\S]*?)(?=\n##\s|\n---|\s*$)/);
    const pinnedBlock = pinnedMatch?.[1]?.trim() ?? '';
    const pinnedFiles = extractWikilinks(pinnedBlock);

    const folderName = folderPath.split('/').pop() ?? name;

    return {
        id: idMatch[1].trim(),
        name,
        slug: folderName,
        folderPath,
        instructions,
        memory,
        pinnedFiles,
        created: createdMatch?.[1]?.trim() ?? new Date().toISOString().slice(0, 10),
    };
}

function buildProjectMd(config: ProjectConfig): string {
    const lines: string[] = [
        '---',
        'tags:',
        '  - ai-project',
        `project_id: "${config.id}"`,
        `created: ${config.created}`,
        '---',
        '',
        `# ${config.name}`,
        '',
        '## Instructions',
        '',
        config.instructions.trim() || PLACEHOLDER_INSTRUCTIONS,
        '',
        '## Memory',
        '',
        config.memory.length > 0
            ? config.memory.map(m => `- ${m}`).join('\n')
            : PLACEHOLDER_MEMORY,
        '',
        '## Pinned Files',
        '',
        config.pinnedFiles.length > 0
            ? config.pinnedFiles.map(p => `- [[${p}]]`).join('\n')
            : '',
    ];
    return lines.join('\n');
}

export interface IndexedDocumentEntry {
    /** Wikilink display name (basename without extension) */
    name: string;
    /** Vault path to the stored text note */
    path: string;
    /** Number of chunks when last indexed */
    chunkCount: number;
}

export class ProjectService {
    constructor(private app: App, private settings: AIOrganiserSettings) {}

    async listProjects(): Promise<ProjectConfig[]> {
        const rootPath = getChatRootFullPath(this.settings);
        const projectsPath = `${rootPath}/Projects`;
        const folder = this.app.vault.getFolderByPath(projectsPath);
        if (!folder) return [];

        const configs: ProjectConfig[] = [];
        for (const child of folder.children) {
            if (child instanceof TFile) continue;
            const configFile = this.app.vault.getAbstractFileByPath(`${child.path}/_project.md`);
            if (configFile instanceof TFile) {
                const content = await this.app.vault.read(configFile);
                const config = parseProjectMd(content, child.path);
                if (config) configs.push(config);
            }
        }
        return configs.sort((a, b) => a.name.localeCompare(b.name));
    }

    async findProject(projectId: string): Promise<ProjectConfig | null> {
        // Use recursive scan so nested projects (inside groups) are found
        const allProjects = await this.listAllProjectsRecursive();
        return allProjects.find(p => p.id === projectId) ?? null;
    }

    async createProject(name: string, instructions = ''): Promise<string> {
        const id = crypto.randomUUID();
        let slug = slugify(name) || 'project';
        const rootPath = getChatRootFullPath(this.settings);

        // Check for slug collision and append numeric suffix if needed
        let folderPath = `${rootPath}/Projects/${slug}`;
        let suffix = 1;
        while (this.app.vault.getFolderByPath(folderPath)) {
            suffix++;
            slug = `${slugify(name) || 'project'}-${suffix}`;
            folderPath = `${rootPath}/Projects/${slug}`;
        }

        await ensureFolderExists(this.app.vault, folderPath);

        const config: ProjectConfig = {
            id, name, slug, folderPath,
            instructions,
            memory: [],
            pinnedFiles: [],
            created: new Date().toISOString().slice(0, 10),
        };

        await this.app.vault.create(`${folderPath}/_project.md`, buildProjectMd(config));
        return id;
    }

    async updateProject(projectId: string, updates: Partial<Pick<ProjectConfig, 'instructions' | 'memory' | 'pinnedFiles'>>): Promise<void> {
        const config = await this.findProject(projectId);
        if (!config) return;

        const updated: ProjectConfig = { ...config, ...updates };
        const file = this.app.vault.getAbstractFileByPath(`${config.folderPath}/_project.md`);
        if (file instanceof TFile) {
            await this.app.vault.modify(file, buildProjectMd(updated));
        }
    }

    async addMemory(projectId: string, fact: string): Promise<void> {
        const config = await this.findProject(projectId);
        if (!config) return;
        const lower = fact.toLowerCase();
        if (config.memory.some(m => m.toLowerCase() === lower)) return; // dedup
        await this.updateProject(projectId, { memory: [...config.memory, fact] });
    }

    async removeMemory(projectId: string, index: number): Promise<void> {
        const config = await this.findProject(projectId);
        if (!config) return;
        const memory = config.memory.filter((_, i) => i !== index);
        await this.updateProject(projectId, { memory });
    }

    async readPinnedFiles(config: ProjectConfig, maxChars: number): Promise<string> {
        const parts: string[] = [];
        let remaining = maxChars;

        for (const linkPath of config.pinnedFiles) {
            if (remaining <= 0) break;
            const file = this.app.metadataCache.getFirstLinkpathDest(linkPath, '');
            if (!file) continue;
            const content = await this.app.vault.read(file);
            const chunk = content.slice(0, remaining);
            parts.push(`--- ${linkPath} ---\n${chunk}`);
            remaining -= chunk.length;
        }

        return parts.join('\n\n');
    }

    async countConversations(projectId: string): Promise<number> {
        const config = await this.findProject(projectId);
        if (!config) return 0;
        const folder = this.app.vault.getFolderByPath(config.folderPath);
        if (!folder) return 0;
        return folder.children.filter(
            c => c instanceof TFile && c.extension === 'md' && c.basename !== '_project'
        ).length;
    }

    async deleteProject(projectId: string): Promise<void> {
        const config = await this.findProject(projectId);
        if (!config) return;
        const folder = this.app.vault.getFolderByPath(config.folderPath);
        if (folder) {
            await this.app.fileManager.trashFile(folder);
        }
    }

    getProjectFolder(slug: string): string {
        const rootPath = getChatRootFullPath(this.settings);
        return `${rootPath}/Projects/${slug}`;
    }

    /**
     * Persist an indexed document's extracted text as a vault note inside the project folder,
     * and record its metadata in the project's `_project.md` under `## Indexed Documents`.
     */
    async saveIndexedDocument(projectId: string, fileName: string, extractedText: string, chunkCount: number): Promise<void> {
        const config = await this.findProject(projectId);
        if (!config) return;

        // Sanitize the file name to a safe basename
        const safeName = fileName.replace(/[/\\:*?"<>|]/g, '-').replace(/\.[^.]+$/, '');
        const indexedFolder = `${config.folderPath}/indexed`;
        await ensureFolderExists(this.app.vault, indexedFolder);

        const notePath = `${indexedFolder}/${safeName}.md`;
        const noteContent = `---\ntags:\n  - ai-indexed\n---\n\n# ${fileName}\n\n${extractedText}`;

        const existing = this.app.vault.getAbstractFileByPath(notePath);
        if (existing instanceof TFile) {
            await this.app.vault.modify(existing, noteContent);
        } else {
            await this.app.vault.create(notePath, noteContent);
        }

        // Append to ## Indexed Documents section in _project.md
        const projectFilePath = `${config.folderPath}/_project.md`;
        const projectFile = this.app.vault.getAbstractFileByPath(projectFilePath);
        if (!(projectFile instanceof TFile)) return;

        let content = await this.app.vault.read(projectFile);
        const entry = `- [[indexed/${safeName}]] (${chunkCount} chunks)`;

        if (content.includes('## Indexed Documents')) {
            const linkRef = `[[indexed/${safeName}]]`;
            if (content.includes(linkRef)) {
                // Re-index: update the existing entry's chunk count in-place
                content = content.replace(
                    new RegExp(`- \\[\\[indexed/${safeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\] \\(\\d+ chunks\\)`),
                    entry
                );
            } else {
                // Append new entry to existing section
                content = content.replace(
                    /(## Indexed Documents\s*\n)([\s\S]*?)(\n##\s|\s*$)/,
                    (_match, heading, body, tail) => {
                        const trimmed = body.trimEnd();
                        const newBody = trimmed ? `${trimmed}\n${entry}` : entry;
                        return `${heading}${newBody}${tail}`;
                    }
                );
            }
        } else {
            content = `${content.trimEnd()}\n\n## Indexed Documents\n\n${entry}\n`;
        }
        await this.app.vault.modify(projectFile, content);
    }

    /**
     * Load persisted indexed document entries from a project's `_project.md`.
     * Re-reads vault notes to reconstruct extractedText.
     */
    async loadIndexedDocuments(config: ProjectConfig): Promise<Array<{ name: string; path: string; extractedText: string; chunkCount: number }>> {
        const projectFilePath = `${config.folderPath}/_project.md`;
        const projectFile = this.app.vault.getAbstractFileByPath(projectFilePath);
        if (!(projectFile instanceof TFile)) return [];

        const content = await this.app.vault.read(projectFile);
        const sectionMatch = /## Indexed Documents\s*\n([\s\S]*?)(\n##\s|\s*$)/.exec(content);
        if (!sectionMatch) return [];

        const block = sectionMatch[1].trim();
        const results: Array<{ name: string; path: string; extractedText: string; chunkCount: number }> = [];

        for (const line of block.split('\n')) {
            const lineMatch = /- \[\[([^\]]+)\]\]\s*\((\d+) chunks?\)/.exec(line);
            if (!lineMatch) continue;

            const wikilink = lineMatch[1].trim();
            const chunkCount = parseInt(lineMatch[2], 10);
            const notePath = `${config.folderPath}/${wikilink}.md`;
            const noteFile = this.app.vault.getAbstractFileByPath(notePath);
            if (!(noteFile instanceof TFile)) continue;

            const noteContent = await this.app.vault.read(noteFile);
            // Strip frontmatter and h1 title, return body
            const bodyMatch = /^---[\s\S]*?---\s*\n(?:#[^\n]*\n\n?)?/.exec(noteContent);
            const extractedText = bodyMatch ? noteContent.slice(bodyMatch[0].length) : noteContent;

            results.push({
                name: noteFile.basename,
                path: notePath,
                extractedText,
                chunkCount,
            });
        }
        return results;
    }

    // ── Tree / Group / Nesting ─────────────────────────────────────────

    /**
     * Recursively scan `{chatRoot}/Projects/` and return a tree of projects
     * and organizational groups. Folders with `_project.md` are projects;
     * folders without are groups.
     */
    async listProjectTree(): Promise<Result<ProjectTreeNode[]>> {
        const rootPath = this.getProjectsRoot();
        const folder = this.app.vault.getFolderByPath(rootPath);
        if (!folder) return ok([]);

        try {
            const children = await this.buildTreeChildren(folder, 0);
            return ok(children);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            logger.error('ProjectService', `listProjectTree failed: ${msg}`);
            return err(`Failed to list project tree: ${msg}`);
        }
    }

    /**
     * Create an organizational group folder (no `_project.md`).
     */
    async createGroup(name: string, parentPath?: string): Promise<Result<string>> {
        const trimmed = name.trim();
        if (!trimmed) return err('Group name cannot be empty');

        const slug = slugify(trimmed);
        if (!slug) return err('Group name contains only invalid characters');

        const parent = parentPath ?? this.getProjectsRoot();
        const targetPath = `${parent}/${slug}`;

        // Depth check (M9)
        const depth = this.getDepth(targetPath);
        if (depth > MAX_PROJECT_DEPTH) {
            return err(`Maximum nesting depth of ${MAX_PROJECT_DEPTH} exceeded`);
        }

        // Sibling collision check (M8)
        if (this.hasSiblingCollision(parent, trimmed)) {
            return err(`A sibling with name "${trimmed}" already exists`);
        }

        try {
            await ensureFolderExists(this.app.vault, targetPath);
            logger.debug('ProjectService', `Created group: ${targetPath}`);
            return ok(targetPath);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return err(`Failed to create group: ${msg}`);
        }
    }

    /**
     * Create a project inside a specific parent folder.
     * Unlike `createProject()`, returns `Result<string>` and supports nesting.
     */
    async createProjectInGroup(name: string, parentPath: string, instructions = ''): Promise<Result<string>> {
        const trimmed = name.trim();
        if (!trimmed) return err('Project name cannot be empty');

        const slug = slugify(trimmed) || 'project';
        const folderPath = `${parentPath}/${slug}`;

        // Depth check (M9)
        const depth = this.getDepth(folderPath);
        if (depth > MAX_PROJECT_DEPTH) {
            return err(`Maximum nesting depth of ${MAX_PROJECT_DEPTH} exceeded`);
        }

        // Sibling collision check (M8)
        if (this.hasSiblingCollision(parentPath, trimmed)) {
            return err(`A sibling with name "${trimmed}" already exists`);
        }

        try {
            await ensureFolderExists(this.app.vault, folderPath);

            const id = crypto.randomUUID();
            const config: ProjectConfig = {
                id, name: trimmed, slug, folderPath,
                instructions,
                memory: [],
                pinnedFiles: [],
                created: new Date().toISOString().slice(0, 10),
            };

            await this.app.vault.create(`${folderPath}/_project.md`, buildProjectMd(config));
            logger.debug('ProjectService', `Created project in group: ${folderPath}`);
            return ok(id);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return err(`Failed to create project: ${msg}`);
        }
    }

    /**
     * Move a project to a new parent folder. Identity is UUID-based (H1).
     */
    async moveProject(projectId: string, newParentPath: string): Promise<Result<void>> {
        // Find project by UUID (H1)
        const allProjects = await this.listAllProjectsRecursive();
        const config = allProjects.find(p => p.id === projectId);
        if (!config) return err(`Project with id "${projectId}" not found`);

        const oldFolder = this.app.vault.getFolderByPath(config.folderPath);
        if (!oldFolder) return err(`Project folder not found at "${config.folderPath}"`);

        const slug = config.folderPath.split('/').pop() ?? config.slug;
        const newPath = `${newParentPath}/${slug}`;

        // Prevent circular move (move into own subtree)
        if (newParentPath === config.folderPath || newParentPath.startsWith(config.folderPath + '/')) {
            return err('Cannot move a project into its own subtree');
        }

        // Depth check (M9)
        const depth = this.getDepth(newPath);
        if (depth > MAX_PROJECT_DEPTH) {
            return err(`Maximum nesting depth of ${MAX_PROJECT_DEPTH} exceeded`);
        }

        // Sibling collision at target (M8)
        if (this.hasSiblingCollision(newParentPath, config.name)) {
            return err(`A sibling with name "${config.name}" already exists at the target`);
        }

        try {
            await ensureFolderExists(this.app.vault, newParentPath);
            await this.app.vault.rename(oldFolder, newPath);

            // Update folderPath in _project.md
            const updatedConfig: ProjectConfig = { ...config, folderPath: newPath, slug };
            const projectFile = this.app.vault.getAbstractFileByPath(`${newPath}/_project.md`);
            if (projectFile instanceof TFile) {
                await this.app.vault.modify(projectFile, buildProjectMd(updatedConfig));
            }

            logger.debug('ProjectService', `Moved project ${projectId} to ${newPath}`);
            return ok(undefined);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return err(`Failed to move project: ${msg}`);
        }
    }

    // ── Private helpers ────────────────────────────────────────────────

    private getProjectsRoot(): string {
        const rootPath = getChatRootFullPath(this.settings);
        return `${rootPath}/Projects`;
    }

    /**
     * Compute depth relative to Projects/ root.
     * e.g. "AI Chat/Projects/group/project" → depth 2
     */
    private getDepth(path: string): number {
        const root = this.getProjectsRoot();
        const relative = path.startsWith(root + '/')
            ? path.slice(root.length + 1)
            : path;
        return relative.split('/').filter(Boolean).length;
    }

    /**
     * Case-insensitive sibling collision check (M8).
     */
    private hasSiblingCollision(parentPath: string, name: string): boolean {
        const parentFolder = this.app.vault.getFolderByPath(parentPath);
        if (!parentFolder) return false;

        const targetSlug = slugify(name).toLowerCase();
        for (const child of parentFolder.children) {
            if (child instanceof TFile) continue;
            const childName = child.path.split('/').pop() ?? '';
            if (childName.toLowerCase() === targetSlug) return true;
        }
        return false;
    }

    /**
     * Recursively build tree nodes from a folder's children.
     * Uses the same pattern as `listProjects()`: skip TFile instances,
     * treat remaining children as folders.
     */
    private async buildTreeChildren(folder: { children: Array<{ path: string; children?: unknown[] }> }, currentDepth: number): Promise<ProjectTreeNode[]> {
        const nodes: ProjectTreeNode[] = [];

        for (const child of folder.children) {
            if (child instanceof TFile) continue;
            // Remaining children are folders (TFolder or mock equivalent)
            if (!('children' in child)) continue;

            const childDepth = currentDepth + 1;
            if (childDepth > MAX_PROJECT_DEPTH) continue;

            const projectFile = this.app.vault.getAbstractFileByPath(`${child.path}/_project.md`);
            if (projectFile instanceof TFile) {
                // Project node
                const content = await this.app.vault.read(projectFile);
                const config = parseProjectMd(content, child.path);
                if (config) {
                    nodes.push({
                        type: 'project',
                        name: config.name,
                        path: child.path,
                        children: [],
                        project: config,
                        depth: childDepth,
                    });
                }
            } else {
                // Group node — recurse into children
                const childFolder = child as { path: string; children: Array<{ path: string; children?: unknown[] }> };
                const children = await this.buildTreeChildren(childFolder, childDepth);
                nodes.push({
                    type: 'group',
                    name: child.path.split('/').pop() ?? '',
                    path: child.path,
                    children,
                    depth: childDepth,
                });
            }
        }

        // Sort: groups first, then projects, alphabetically within each
        nodes.sort((a, b) => {
            if (a.type !== b.type) return a.type === 'group' ? -1 : 1;
            return a.name.localeCompare(b.name);
        });

        return nodes;
    }

    /**
     * List all projects recursively (for UUID-based lookup in moveProject).
     */
    private async listAllProjectsRecursive(): Promise<ProjectConfig[]> {
        const result = await this.listProjectTree();
        if (!result.ok) return [];

        const configs: ProjectConfig[] = [];
        const walk = (nodes: ProjectTreeNode[]) => {
            for (const node of nodes) {
                if (node.type === 'project' && node.project) {
                    configs.push(node.project);
                }
                walk(node.children);
            }
        };
        walk(result.value);
        return configs;
    }
}
