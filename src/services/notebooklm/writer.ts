/**
 * Writer Service for NotebookLM Source Packs
 *
 * Generates README.md (per-file checklist), manifest.json, and changelog.md.
 */

import { App } from 'obsidian';
import { PackManifest, Changelog } from './types';
import { formatBytes } from './notebooklmUtils';

export class WriterService {
    constructor(private app: App) {}

    async writeReadme(packFolderPath: string, manifest: PackManifest): Promise<void> {
        const content = this.generateReadmeContent(manifest);
        await this.writeFile(`${packFolderPath}/README.md`, content);
    }

    async writeManifest(packFolderPath: string, manifest: PackManifest): Promise<void> {
        await this.writeFile(`${packFolderPath}/manifest.json`, JSON.stringify(manifest, null, 2));
    }

    async writeChangelog(packFolderPath: string, changelog: Changelog): Promise<void> {
        await this.writeFile(`${packFolderPath}/changelog.md`, this.generateChangelogContent(changelog));
    }

    async ensureFolder(folderPath: string): Promise<void> {
        const folder = this.app.vault.getAbstractFileByPath(folderPath);
        if (!folder) {
            await this.app.vault.createFolder(folderPath);
        }
    }

    private async writeFile(path: string, content: string): Promise<void> {
        const existing = this.app.vault.getAbstractFileByPath(path);
        if (existing) {
            await this.app.vault.modify(existing as import('obsidian').TFile, content);
        } else {
            await this.app.vault.create(path, content);
        }
    }

    private generateReadmeContent(manifest: PackManifest): string {
        const lines: string[] = [];
        const noteEntries = manifest.entries.filter(e => e.type === 'note-text' || e.type === 'note-pdf');
        const sidecarEntries = manifest.entries.filter(e => e.type === 'attachment');

        lines.push('# NotebookLM source pack');
        lines.push('');
        lines.push(`**Generated:** ${manifest.generatedAt}`);
        lines.push(`**Notes:** ${manifest.stats.noteCount}`);
        lines.push(`**Total size:** ${formatBytes(manifest.stats.totalBytes)}`);
        lines.push('');

        // Upload instructions with direct link
        lines.push('## Upload instructions');
        lines.push('');
        lines.push('1. Open [NotebookLM](https://notebooklm.google.com) and create or open a notebook');
        lines.push('2. Click **Add source** → **Upload**');
        lines.push('3. Upload all note files listed below');
        lines.push('4. If there are attached documents, upload those too — they contain charts and graphs');
        lines.push('5. Click **Audio Overview** to generate your podcast');
        lines.push('');
        lines.push('> **Do not upload** `manifest.json`, `changelog.md`, or `README.md`');
        lines.push('');

        // Notes checklist
        lines.push(`## Notes (${noteEntries.length} files)`);
        lines.push('');
        for (const entry of noteEntries) {
            lines.push(`- [ ] ${entry.outputName} — ${entry.title} (${formatBytes(entry.sizeBytes)})`);
        }
        lines.push('');

        // Attached documents checklist (only if there are any)
        if (sidecarEntries.length > 0) {
            lines.push(`## Attached documents — upload these too (${sidecarEntries.length} files)`);
            lines.push('');
            for (const entry of sidecarEntries) {
                lines.push(`- [ ] ${entry.outputName} ← contains charts/graphs (${formatBytes(entry.sizeBytes)})`);
            }
            lines.push('');
        }

        // Tips
        lines.push('## Tips');
        lines.push('');
        lines.push('- Maximum 50 sources per notebook');
        lines.push('- Each source can be up to 200 MB');
        lines.push('- NotebookLM reads charts and graphs from PDFs directly');

        return lines.join('\n');
    }

    private generateChangelogContent(changelog: Changelog): string {
        const lines: string[] = [];

        lines.push('# Changelog');
        lines.push('');
        lines.push(`**From revision:** ${changelog.fromRevision}`);
        lines.push(`**To revision:** ${changelog.toRevision}`);
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
                if (entry.details) lines.push(`  - ${entry.details}`);
            }
        }

        return lines.join('\n');
    }
}
