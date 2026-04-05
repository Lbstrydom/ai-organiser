/**
 * Writer Service for NotebookLM Source Packs
 *
 * NOTE: With PDF-based export, most of this functionality is not needed.
 * This file is kept as a stub for future PDF export implementation.
 */

import { App } from 'obsidian';
import { PackManifest, Changelog } from './types';

/**
 * Writer service for pack file generation
 */
export class WriterService {
    constructor(private app: App) {}

    /**
     * Write README.md with upload instructions
     */
    async writeReadme(packFolderPath: string, manifest: PackManifest): Promise<void> {
        const content = this.generateReadmeContent(manifest);
        const readmePath = `${packFolderPath}/README.md`;

        const existingFile = this.app.vault.getAbstractFileByPath(readmePath);
        if (existingFile) {
            await this.app.vault.modify(existingFile as import('obsidian').TFile, content);
        } else {
            await this.app.vault.create(readmePath, content);
        }
    }

    /**
     * Write manifest.json
     */
    async writeManifest(packFolderPath: string, manifest: PackManifest): Promise<void> {
        const content = JSON.stringify(manifest, null, 2);
        const manifestPath = `${packFolderPath}/manifest.json`;

        const existingFile = this.app.vault.getAbstractFileByPath(manifestPath);
        if (existingFile) {
            await this.app.vault.modify(existingFile as import('obsidian').TFile, content);
        } else {
            await this.app.vault.create(manifestPath, content);
        }
    }

    /**
     * Write changelog.md
     */
    async writeChangelog(packFolderPath: string, changelog: Changelog): Promise<void> {
        const content = this.generateChangelogContent(changelog);
        const changelogPath = `${packFolderPath}/changelog.md`;

        const existingFile = this.app.vault.getAbstractFileByPath(changelogPath);
        if (existingFile) {
            await this.app.vault.modify(existingFile as import('obsidian').TFile, content);
        } else {
            await this.app.vault.create(changelogPath, content);
        }
    }

    /**
     * Ensure folder exists
     */
    async ensureFolder(folderPath: string): Promise<void> {
        const folder = this.app.vault.getAbstractFileByPath(folderPath);
        if (!folder) {
            await this.app.vault.createFolder(folderPath);
        }
    }

    /**
     * Generate README content
     */
    private generateReadmeContent(manifest: PackManifest): string {
        const lines: string[] = [];

        lines.push(`# NotebookLM Source Pack`);
        lines.push('');
        lines.push(`**Generated:** ${manifest.generatedAt}`);
        lines.push(`**Notes:** ${manifest.stats.noteCount}`);
        lines.push(`**Total Size:** ${this.formatBytes(manifest.stats.totalBytes)}`);
        lines.push('');
        lines.push('## Upload Instructions');
        lines.push('');
        lines.push('1. Open NotebookLM and create/open a notebook');
        lines.push('2. Click "Add Source" → "Upload"');
        lines.push('3. Select all PDF files from this folder');
        lines.push('4. Do NOT upload `manifest.json`, `changelog.md`, or `README.md`');
        lines.push('');
        lines.push('## Notes Included');
        lines.push('');
        lines.push('| # | Note | Size |');
        lines.push('|---|------|------|');

        manifest.entries.forEach((entry, index) => {
            lines.push(`| ${index + 1} | ${entry.pdfName} (${entry.title}) | ${this.formatBytes(entry.sizeBytes)} |`);
        });

        lines.push('');
        lines.push('## Tips');
        lines.push('');
        lines.push('- NotebookLM can analyze images and diagrams in PDFs');
        lines.push('- Maximum 50 sources per notebook');
        lines.push('- Each source can be up to 200MB');

        return lines.join('\n');
    }

    /**
     * Generate changelog content
     */
    private generateChangelogContent(changelog: Changelog): string {
        const lines: string[] = [];

        lines.push(`# Changelog`);
        lines.push('');
        lines.push(`**From Revision:** ${changelog.fromRevision}`);
        lines.push(`**To Revision:** ${changelog.toRevision}`);
        lines.push(`**Generated:** ${changelog.generatedAt}`);
        lines.push('');
        lines.push('## Summary');
        lines.push('');
        lines.push(`- Added: ${changelog.summary.added}`);
        lines.push(`- Removed: ${changelog.summary.removed}`);
        lines.push(`- Changed: ${changelog.summary.changed}`);
        lines.push('');

        if (changelog.entries.length > 0) {
            lines.push('## Changes');
            lines.push('');

            for (const entry of changelog.entries) {
                const icon = entry.type === 'added' ? '➕' : entry.type === 'removed' ? '➖' : '📝';
                lines.push(`${icon} **${entry.type.toUpperCase()}:** ${entry.title}`);
                if (entry.details) {
                    lines.push(`  - ${entry.details}`);
                }
            }
        }

        return lines.join('\n');
    }

    /**
     * Format bytes to human readable string
     */
    private formatBytes(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
}
