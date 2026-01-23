/**
 * Folder Context Utilities
 * Utilities for building folder context to constrain LLM suggestions
 */

import { App, TFolder, TFile } from 'obsidian';

/**
 * Folder context data passed to LLM prompts
 */
export interface FolderContext {
    /** Root folder path selected by user */
    rootPath: string;
    /** All subfolders under the root */
    subfolders: string[];
    /** Existing tags used in notes within this scope */
    existingTags: string[];
    /** Number of notes in this scope */
    noteCount: number;
}

/**
 * Get all subfolders under a root folder (recursive)
 * @param app - Obsidian App instance
 * @param rootPath - Root folder path to search from
 * @returns Array of subfolder paths relative to vault root
 */
export function getSubfolders(app: App, rootPath: string): string[] {
    const folders: string[] = [];
    const rootFolder = app.vault.getAbstractFileByPath(rootPath);

    if (!(rootFolder instanceof TFolder)) {
        return folders;
    }

    function collectFolders(folder: TFolder): void {
        for (const child of folder.children) {
            if (child instanceof TFolder) {
                folders.push(child.path);
                collectFolders(child);
            }
        }
    }

    collectFolders(rootFolder);
    return folders.sort();
}

/**
 * Get all tags used within a folder scope
 * @param app - Obsidian App instance
 * @param rootPath - Root folder path to search from
 * @returns Array of unique tags found in notes within the scope
 */
export function getTagsInScope(app: App, rootPath: string): string[] {
    const tags = new Set<string>();
    const files = getNotesInScope(app, rootPath);

    for (const file of files) {
        const cache = app.metadataCache.getFileCache(file);
        if (cache?.frontmatter?.tags) {
            const fileTags = Array.isArray(cache.frontmatter.tags)
                ? cache.frontmatter.tags
                : [cache.frontmatter.tags];

            for (const tag of fileTags) {
                if (tag && typeof tag === 'string') {
                    // Remove # prefix if present
                    const cleanTag = tag.startsWith('#') ? tag.substring(1) : tag;
                    tags.add(cleanTag);
                }
            }
        }
    }

    return Array.from(tags).sort();
}

/**
 * Get all markdown files within a folder scope
 * @param app - Obsidian App instance
 * @param rootPath - Root folder path to search from
 * @returns Array of TFile objects for markdown files in scope
 */
export function getNotesInScope(app: App, rootPath: string): TFile[] {
    const files: TFile[] = [];
    const rootFolder = app.vault.getAbstractFileByPath(rootPath);

    if (!(rootFolder instanceof TFolder)) {
        return files;
    }

    function collectFiles(folder: TFolder): void {
        for (const child of folder.children) {
            if (child instanceof TFile && child.extension === 'md') {
                files.push(child);
            } else if (child instanceof TFolder) {
                collectFiles(child);
            }
        }
    }

    collectFiles(rootFolder);
    return files;
}

/**
 * Count the number of notes in a folder scope
 * @param app - Obsidian App instance
 * @param rootPath - Root folder path to search from
 * @returns Number of markdown files in scope
 */
export function countNotesInScope(app: App, rootPath: string): number {
    return getNotesInScope(app, rootPath).length;
}

/**
 * Build complete folder context for LLM prompt injection
 * @param app - Obsidian App instance
 * @param rootPath - Root folder path selected by user
 * @returns FolderContext object with all scope information
 */
export function buildFolderContext(app: App, rootPath: string): FolderContext {
    return {
        rootPath,
        subfolders: getSubfolders(app, rootPath),
        existingTags: getTagsInScope(app, rootPath),
        noteCount: countNotesInScope(app, rootPath)
    };
}

/**
 * Get all top-level folders in the vault
 * @param app - Obsidian App instance
 * @returns Array of top-level folder paths
 */
export function getTopLevelFolders(app: App): string[] {
    const folders: string[] = [];
    const root = app.vault.getRoot();

    for (const child of root.children) {
        if (child instanceof TFolder) {
            folders.push(child.path);
        }
    }

    return folders.sort();
}

/**
 * Get all folders in the vault (flat list)
 * @param app - Obsidian App instance
 * @returns Array of all folder paths
 */
export function getAllFolders(app: App): TFolder[] {
    const folders: TFolder[] = [];
    const allFiles = app.vault.getAllLoadedFiles();

    for (const file of allFiles) {
        if (file instanceof TFolder && file.path !== '/') {
            folders.push(file);
        }
    }

    return folders.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Build a hierarchical tree structure of folders
 * @param app - Obsidian App instance
 * @returns Nested folder tree
 */
export interface FolderTreeNode {
    folder: TFolder;
    path: string;
    name: string;
    depth: number;
    children: FolderTreeNode[];
}

export function buildFolderTree(app: App): FolderTreeNode[] {
    const root = app.vault.getRoot();
    const tree: FolderTreeNode[] = [];

    function buildNode(folder: TFolder, depth: number): FolderTreeNode {
        const children: FolderTreeNode[] = [];

        for (const child of folder.children) {
            if (child instanceof TFolder) {
                children.push(buildNode(child, depth + 1));
            }
        }

        // Sort children alphabetically
        children.sort((a, b) => a.name.localeCompare(b.name));

        return {
            folder,
            path: folder.path,
            name: folder.name,
            depth,
            children
        };
    }

    // Build tree from root children
    for (const child of root.children) {
        if (child instanceof TFolder) {
            tree.push(buildNode(child, 0));
        }
    }

    // Sort top-level folders alphabetically
    tree.sort((a, b) => a.name.localeCompare(b.name));

    return tree;
}
