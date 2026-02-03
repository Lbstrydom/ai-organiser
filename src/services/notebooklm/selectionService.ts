/**
 * Selection Service for NotebookLM Source Packs
 *
 * Handles note selection for export via:
 * - Tag-based selection (notes with specified tag)
 * - Manual selection (specific note list)
 * - Toggle selection (add/remove tag from current note)
 */

import { App, TFile } from 'obsidian';
import { SelectionResult } from './types';

/**
 * Service for selecting notes for NotebookLM export
 */
export class SelectionService {
    constructor(
        private app: App,
        private selectionTag: string = 'notebooklm'
    ) {}

    /**
     * Get notes selected by tag
     * @param tag Tag to search for (default: 'notebooklm')
     * @returns Selection result with files
     */
    async getSelectedNotes(tag?: string): Promise<SelectionResult> {
        const searchTag = tag || this.selectionTag;
        const files: TFile[] = [];

        // Get all markdown files
        const allFiles = this.app.vault.getMarkdownFiles();

        for (const file of allFiles) {
            // Check if file has the tag in frontmatter
            if (await this.hasTag(file, searchTag)) {
                files.push(file);
            }
        }

        return {
            files,
            selectionMethod: 'tag',
            scopeValue: searchTag
        };
    }

    /**
     * Select notes from a specific folder
     * @param folderPath Folder path (vault-relative)
     * @param recursive Include subfolders (default: true)
     * @returns Selection result
     */
    async selectByFolder(folderPath: string, recursive: boolean = true): Promise<SelectionResult> {
        const files: TFile[] = [];

        const allFiles = this.app.vault.getMarkdownFiles();

        for (const file of allFiles) {
            const inFolder = recursive
                ? file.path.startsWith(folderPath + '/')
                : file.parent?.path === folderPath;

            if (inFolder) {
                files.push(file);
            }
        }

        return {
            files,
            selectionMethod: 'folder',
            scopeValue: folderPath
        };
    }

    /**
     * Manual selection from array of file paths
     * @param filePaths Array of vault-relative file paths
     * @returns Selection result
     */
    async selectManual(filePaths: string[]): Promise<SelectionResult> {
        const files: TFile[] = [];

        for (const path of filePaths) {
            const file = this.app.vault.getAbstractFileByPath(path);
            if (file instanceof TFile && file.extension === 'md') {
                files.push(file);
            }
        }

        return {
            files,
            selectionMethod: 'manual',
            scopeValue: `${files.length} notes`
        };
    }

    /**
     * Toggle selection tag on a note (add if missing, remove if present)
     * @param file File to toggle
     * @returns True if tag was added, false if removed
     */
    async toggleSelection(file: TFile): Promise<boolean> {
        const hasSelectionTag = await this.hasTag(file, this.selectionTag);

        await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
            // Initialize tags array if needed
            if (!frontmatter.tags) {
                frontmatter.tags = [];
            } else if (typeof frontmatter.tags === 'string') {
                // Convert single tag to array
                frontmatter.tags = [frontmatter.tags];
            }

            if (hasSelectionTag) {
                // Remove tag
                frontmatter.tags = frontmatter.tags.filter((t: string) =>
                    t !== this.selectionTag && t !== `#${this.selectionTag}`
                );

                // Clean up empty tags array
                if (frontmatter.tags.length === 0) {
                    delete frontmatter.tags;
                }
            } else {
                // Add tag
                if (!frontmatter.tags.includes(this.selectionTag)) {
                    frontmatter.tags.push(this.selectionTag);
                }
            }
        });

        return !hasSelectionTag; // Return true if tag was added
    }

    /**
     * Clear selection tag from files
     * @param files Files to clear tag from
     */
    async clearSelection(files: TFile[]): Promise<void> {
        for (const file of files) {
            await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
                if (frontmatter.tags) {
                    if (typeof frontmatter.tags === 'string') {
                        frontmatter.tags = [frontmatter.tags];
                    }

                    frontmatter.tags = frontmatter.tags.filter((t: string) =>
                        t !== this.selectionTag && t !== `#${this.selectionTag}`
                    );

                    if (frontmatter.tags.length === 0) {
                        delete frontmatter.tags;
                    }
                }
            });
        }
    }

    /**
     * Archive selection tag (replace with 'notebooklm/exported' and add metadata)
     * @param files Files to archive
     * @param packId Pack ID to add to metadata
     * @param revision Revision number
     */
    async archiveSelection(files: TFile[], packId: string, revision: number): Promise<void> {
        const archiveTag = 'notebooklm/exported';
        const exportDate = new Date().toISOString();

        for (const file of files) {
            await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
                // Replace selection tag with archive tag
                if (frontmatter.tags) {
                    if (typeof frontmatter.tags === 'string') {
                        frontmatter.tags = [frontmatter.tags];
                    }

                    frontmatter.tags = frontmatter.tags.filter((t: string) =>
                        t !== this.selectionTag && t !== `#${this.selectionTag}`
                    );

                    if (!frontmatter.tags.includes(archiveTag)) {
                        frontmatter.tags.push(archiveTag);
                    }
                }

                // Add export metadata
                frontmatter.notebooklm_pack_id = packId;
                frontmatter.notebooklm_revision = revision;
                frontmatter.notebooklm_exported_at = exportDate;
            });
        }
    }

    /**
     * Check if file has a specific tag in frontmatter
     * @param file File to check
     * @param tag Tag to look for
     * @returns True if tag is present
     */
    private async hasTag(file: TFile, tag: string): Promise<boolean> {
        // Try metadata cache first (fastest)
        const cache = this.app.metadataCache.getFileCache(file);
        if (cache?.frontmatter?.tags) {
            const tags = cache.frontmatter.tags;
            const tagArray = Array.isArray(tags) ? tags : [tags];

            // Check for tag with or without # prefix
            return tagArray.some((t: string) =>
                t === tag || t === `#${tag}` || t.replace(/^#/, '') === tag
            );
        }

        // Fallback: parse frontmatter manually
        const content = await this.app.vault.read(file);
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);

        if (!frontmatterMatch) return false;

        // Simple tag check in frontmatter (covers most cases)
        const frontmatterText = frontmatterMatch[1];
        return frontmatterText.includes(tag);
    }

    /**
     * Get all files with selection tag
     * @returns Array of files with selection tag
     */
    async getSelectedFiles(): Promise<TFile[]> {
        const result = await this.getSelectedNotes();
        return result.files;
    }

    /**
     * Get count of selected files (cache-only, no file reads).
     * Optimized for frequent calls (e.g., status bar updates).
     * @returns Number of files with selection tag
     */
    getSelectionCount(): number {
        const tag = this.selectionTag;
        let count = 0;
        for (const file of this.app.vault.getMarkdownFiles()) {
            const cache = this.app.metadataCache.getFileCache(file);
            if (cache?.frontmatter?.tags) {
                const tags = cache.frontmatter.tags;
                const tagArray = Array.isArray(tags) ? tags : [tags];
                if (tagArray.some((t: string) => t === tag || t === `#${tag}` || t.replace(/^#/, '') === tag)) {
                    count++;
                }
            }
        }
        return count;
    }
}
