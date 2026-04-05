/**
 * Embed Scan Commands
 * Registers the find-embeds command with scope selection, progress UI, and cancel support.
 */

import { MarkdownView, Notice } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { logger } from '../utils/logger';
import {
    scanNotes,
    getMarkdownFilesInFolder,
    EmbedScanOptions,
} from '../services/embedScanService';
import { EmbedScanResultsModal } from '../ui/modals/EmbedScanResultsModal';
import { EmbedScanScopeModal, EmbedScanScope } from '../ui/modals/EmbedScanScopeModal';

export function registerEmbedScanCommands(plugin: AIOrganiserPlugin): void {
    const t = plugin.t;

    plugin.addCommand({
        id: 'find-embeds',
        name: t.commands.findEmbeds,
        icon: 'hard-drive',
        callback: () => {
            const modal = new EmbedScanScopeModal(plugin.app, plugin, (scope) => {
                void executeScan(plugin, scope);
            });
            modal.open();
        }
    });
}

async function executeScan(plugin: AIOrganiserPlugin, scope: EmbedScanScope): Promise<void> {
    const t = plugin.t;
    const app = plugin.app;

    // Determine files to scan
    let files: import('obsidian').TFile[];
    const isVaultScope = scope === 'vault';

    switch (scope) {
        case 'note': {
            const view = app.workspace.getActiveViewOfType(MarkdownView);
            if (!view?.file) {
                new Notice(t.messages.pleaseOpenNote);
                return;
            }
            files = [view.file];
            break;
        }
        case 'folder': {
            const activeFile = app.workspace.getActiveFile();
            if (!activeFile?.parent) {
                new Notice(t.messages.pleaseOpenNote);
                return;
            }
            files = getMarkdownFilesInFolder(app, activeFile.parent);
            break;
        }
        case 'vault': {
            files = plugin.getNonExcludedMarkdownFiles();
            break;
        }
    }

    if (files.length === 0) {
        new Notice(t.embedScan.noNotesToScan);
        return;
    }

    // Progress notice with cancel support
    const abortController = new AbortController();
    let progressNotice: Notice | null = null;

    const embedScan = t.embedScan;

    // For vault/folder scans, show progress
    if (files.length > 1) {
        progressNotice = new Notice('', 0); // Persistent notice
        const noticeEl = progressNotice.messageEl;
        if (noticeEl) {
            noticeEl.empty();
            const wrapper = noticeEl.createDiv({ cls: 'ai-organiser-embed-scan-progress' });
            wrapper.createDiv({ cls: 'ai-organiser-embed-scan-progress-text', text: embedScan.scanning });
            const progressBar = wrapper.createDiv({ cls: 'ai-organiser-embed-scan-progress-bar' });
            const progressFill = progressBar.createDiv({ cls: 'ai-organiser-embed-scan-progress-fill' });
            
            const cancelBtn = wrapper.createEl('button', {
                text: embedScan.cancelButton,
                cls: 'ai-organiser-embed-scan-cancel-btn'
            });
            cancelBtn.addEventListener('click', () => {
                abortController.abort();
                progressNotice?.hide();
                new Notice(embedScan.scanCancelled);
            });

            // Store reference for progress updates
            (progressNotice as any).__progressFill = progressFill;
            (progressNotice as any).__progressText = wrapper.querySelector('.ai-organiser-embed-scan-progress-text');
        }
    }

    const options: EmbedScanOptions = {
        includeOrphans: isVaultScope,
        signal: abortController.signal,
        onProgress: (current, total, currentFile) => {
            if (progressNotice) {
                const pct = Math.round((current / total) * 100);
                const fill = (progressNotice as any).__progressFill as HTMLElement;
                const text = (progressNotice as any).__progressText as HTMLElement;
                if (fill) {
                    fill.addClass('ai-organiser-dynamic-width');
                    fill.setCssProps({ '--dynamic-width': `${pct}%` });
                }
                if (text) text.textContent = embedScan.scanProgress
                    .replace('{current}', String(current))
                    .replace('{total}', String(total))
                    .replace('{file}', currentFile ?? '');
            }
        }
    };

    try {
        const result = await scanNotes(app, files, options);
        progressNotice?.hide();

        if (result.cancelled) return; // User cancelled

        if (result.targets.length === 0 && result.possiblyOrphaned.length === 0) {
            new Notice(embedScan.noEmbedsFound);
            return;
        }

        // Show results modal
        const modal = new EmbedScanResultsModal(app, t, result);
        modal.open();
    } catch (error) {
        progressNotice?.hide();
        logger.error('Core', 'Embed scan error:', error);
        new Notice(embedScan.scanError);
    }
}
