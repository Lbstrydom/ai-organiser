/**
 * Writer Service for NotebookLM Source Packs
 * 
 * Handles file generation:
 * - index.md (upload instructions)
 * - module_XX.md files
 * - manifest.json (sidecar metadata)
 * - changelog.md (revision changes)
 */

import { App, TFolder } from 'obsidian';
import { 
    ModuleContent, 
    PackManifest, 
    Changelog, 
    ChangelogEntry, 
    PackEntry,
    PackStats
} from './types';

/**
 * Writer service for pack file generation
 */
export class WriterService {
    constructor(private app: App) {}

    /**
     * Write complete source pack to disk
     * @param packFolderPath Path to pack folder
     * @param modules Module contents
     * @param manifest Pack manifest
     * @param changelog Optional changelog (for revisions)
     */
    async writeSourcePack(
        packFolderPath: string,
        modules: ModuleContent[],
        manifest: PackManifest,
        changelog?: Changelog
    ): Promise<void> {
        // Ensure pack folder exists
        await this.ensureFolder(packFolderPath);

        // Write module files
        for (const module of modules) {
            const modulePath = `${packFolderPath}/${module.fileName}`;
            await this.writeModuleFile(modulePath, module);
        }

        // Write manifest.json
        const manifestPath = `${packFolderPath}/manifest.json`;
        await this.writeManifest(manifestPath, manifest);

        // Write index.md
        const indexPath = `${packFolderPath}/index.md`;
        await this.writeIndexFile(indexPath, manifest, modules);

        // Write changelog if provided
        if (changelog) {
            const changelogPath = `${packFolderPath}/changelog.md`;
            await this.writeChangelog(changelogPath, changelog);
        }
    }

    /**
     * Write module file
     */
    private async writeModuleFile(path: string, module: ModuleContent): Promise<void> {
        const content = module.noteContents.join('\n---\n\n');
        await this.app.vault.adapter.write(path, content);
    }

    /**
     * Write manifest file
     */
    private async writeManifest(path: string, manifest: PackManifest): Promise<void> {
        const content = JSON.stringify(manifest, null, 2);
        await this.app.vault.adapter.write(path, content);
    }

    /**
     * Write index.md file
     */
    private async writeIndexFile(
        path: string,
        manifest: PackManifest,
        modules: ModuleContent[]
    ): Promise<void> {
        const lines: string[] = [];

        // Header
        lines.push(`# Source Pack: ${manifest.scope.value}`);
        lines.push('');
        lines.push(`**Revision:** ${manifest.revision}`);
        lines.push(`**Generated:** ${new Date(manifest.generatedAt).toLocaleString()}`);
        lines.push(`**Notes:** ${manifest.stats.noteCount} | **Words:** ${manifest.stats.totalWords.toLocaleString()} | **Modules:** ${manifest.stats.moduleCount}`);
        lines.push('');

        // Upload Instructions
        lines.push('## Upload Instructions');
        lines.push('');
        lines.push('1. Open NotebookLM and create/open a notebook');
        lines.push('2. Click "Add Source" → "Upload"');
        lines.push(`3. Upload all \`module_*.md\` files from this folder (${manifest.stats.moduleCount} files)`);
        lines.push('4. Do **NOT** upload `manifest.json` or `changelog.md`');
        lines.push('');

        // Recommended Notebook Naming
        lines.push('## Recommended Notebook Naming');
        lines.push('');
        lines.push(`\`${manifest.scope.value} - v${manifest.revision}\``);
        lines.push('');

        // Updating Sources
        lines.push('## Updating Sources');
        lines.push('');
        lines.push('When you re-export:');
        lines.push('1. A new revision folder is created');
        lines.push('2. Check `changelog.md` for what changed');
        lines.push('3. In NotebookLM: remove changed sources, re-upload new versions');
        lines.push('4. Or: create new notebook with new revision');
        lines.push('');

        // Module Contents Table
        lines.push('## Module Contents');
        lines.push('');
        lines.push('| Module | Notes | Words |');
        lines.push('|--------|-------|-------|');
        for (const module of modules) {
            const noteList = module.entries.map(e => e.title).slice(0, 3).join(', ');
            const moreNotes = module.entries.length > 3 ? ` (+${module.entries.length - 3} more)` : '';
            lines.push(`| ${module.fileName} | ${noteList}${moreNotes} | ${module.wordCount.toLocaleString()} |`);
        }
        lines.push('');

        // Note Index
        lines.push('## Note Index');
        lines.push('');
        lines.push('| Note | Module | ID |');
        lines.push('|------|--------|----|');
        for (const module of modules) {
            for (const entry of module.entries) {
                lines.push(`| ${entry.title} | ${module.fileName} | ${entry.shortId} |`);
            }
        }
        lines.push('');

        // Citation Guide
        lines.push('## Using Citations');
        lines.push('');
        lines.push('Each note in the modules has a stable ID. When NotebookLM cites a source, you can:');
        lines.push('1. Find the note ID in the citation');
        lines.push('2. Look it up in the Note Index above');
        lines.push('3. Return to the original note in Obsidian');
        lines.push('');

        await this.app.vault.adapter.write(path, lines.join('\n'));
    }

    /**
     * Write changelog file
     */
    private async writeChangelog(path: string, changelog: Changelog): Promise<void> {
        const lines: string[] = [];

        lines.push(`# Changelog: Revision ${changelog.fromRevision} → ${changelog.toRevision}`);
        lines.push('');
        lines.push(`**Generated:** ${new Date(changelog.generatedAt).toLocaleString()}`);
        lines.push('');

        // Summary
        lines.push('## Summary');
        lines.push('');
        lines.push(`- **Added:** ${changelog.summary.added} notes`);
        lines.push(`- **Removed:** ${changelog.summary.removed} notes`);
        lines.push(`- **Changed:** ${changelog.summary.changed} notes`);
        if (changelog.summary.warnings > 0) {
            lines.push(`- **Warnings:** ${changelog.summary.warnings}`);
        }
        lines.push('');

        // Details by type
        const addedEntries = changelog.entries.filter(e => e.type === 'added');
        const removedEntries = changelog.entries.filter(e => e.type === 'removed');
        const changedEntries = changelog.entries.filter(e => e.type === 'changed');
        const warningEntries = changelog.entries.filter(e => e.type === 'warning');

        if (addedEntries.length > 0) {
            lines.push('## Added Notes');
            lines.push('');
            for (const entry of addedEntries) {
                lines.push(`- **${entry.title}** (${entry.filePath})`);
            }
            lines.push('');
        }

        if (removedEntries.length > 0) {
            lines.push('## Removed Notes');
            lines.push('');
            for (const entry of removedEntries) {
                lines.push(`- **${entry.title}** (${entry.filePath})`);
            }
            lines.push('');
        }

        if (changedEntries.length > 0) {
            lines.push('## Changed Notes');
            lines.push('');
            for (const entry of changedEntries) {
                lines.push(`- **${entry.title}** (${entry.filePath})`);
                if (entry.details) {
                    lines.push(`  - ${entry.details}`);
                }
            }
            lines.push('');
        }

        if (warningEntries.length > 0) {
            lines.push('## Warnings');
            lines.push('');
            for (const entry of warningEntries) {
                lines.push(`- ${entry.title}: ${entry.details || 'See logs'}`);
            }
            lines.push('');
        }

        await this.app.vault.adapter.write(path, lines.join('\n'));
    }

    /**
     * Ensure folder exists (create if needed)
     */
    private async ensureFolder(folderPath: string): Promise<void> {
        const folder = this.app.vault.getAbstractFileByPath(folderPath);
        if (!folder) {
            await this.app.vault.createFolder(folderPath);
        }
    }

    /**
     * Generate changelog by comparing manifests
     * @param oldManifest Previous manifest (null for first export)
     * @param newManifest New manifest
     * @returns Changelog
     */
    generateChangelog(
        oldManifest: PackManifest | null,
        newManifest: PackManifest
    ): Changelog {
        const entries: ChangelogEntry[] = [];

        if (!oldManifest) {
            // First export - all notes are "added"
            for (const entry of newManifest.entries) {
                entries.push({
                    type: 'added',
                    filePath: entry.filePath,
                    title: entry.title
                });
            }
        } else {
            // Compare manifests
            const oldPaths = new Map(oldManifest.entries.map(e => [e.filePath, e]));
            const newPaths = new Map(newManifest.entries.map(e => [e.filePath, e]));

            // Find added notes
            for (const [path, entry] of newPaths) {
                if (!oldPaths.has(path)) {
                    entries.push({
                        type: 'added',
                        filePath: entry.filePath,
                        title: entry.title
                    });
                }
            }

            // Find removed notes
            for (const [path, entry] of oldPaths) {
                if (!newPaths.has(path)) {
                    entries.push({
                        type: 'removed',
                        filePath: entry.filePath,
                        title: entry.title
                    });
                }
            }

            // Find changed notes (hash mismatch)
            for (const [path, newEntry] of newPaths) {
                const oldEntry = oldPaths.get(path);
                if (oldEntry && oldEntry.sha256 !== newEntry.sha256) {
                    const wordDiff = newEntry.wordCount - oldEntry.wordCount;
                    const diffSign = wordDiff > 0 ? '+' : '';
                    entries.push({
                        type: 'changed',
                        filePath: newEntry.filePath,
                        title: newEntry.title,
                        details: `Content modified (${diffSign}${wordDiff} words)`
                    });
                }
            }
        }

        // Calculate summary
        const summary = {
            added: entries.filter(e => e.type === 'added').length,
            removed: entries.filter(e => e.type === 'removed').length,
            changed: entries.filter(e => e.type === 'changed').length,
            warnings: entries.filter(e => e.type === 'warning').length
        };

        return {
            fromRevision: oldManifest?.revision || 0,
            toRevision: newManifest.revision,
            generatedAt: new Date().toISOString(),
            entries,
            summary
        };
    }
}
