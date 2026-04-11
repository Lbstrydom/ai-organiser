/**
 * NotebookLM Commands
 *
 * Command registration for NotebookLM source pack features:
 * - Export source pack (with preview modal, text/PDF generation, incremental support)
 * - Toggle selection on current note
 * - Clear selection tags
 * - Open export folder
 */

import { Notice, Platform, TFile } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { logger } from '../utils/logger';
import { getNotebookLMExportFullPath } from '../core/settings';
import { NotebookLMExportModal } from '../ui/modals/NotebookLMExportModal';
import { pluginContext, summarizeText } from '../services/llmFacade';
import { buildFolderNamePrompt } from '../services/prompts/notebookLMPrompts';
import { getElectron } from '../utils/desktopRequire';

export function registerNotebookLMCommands(plugin: AIOrganiserPlugin): void {
    const t = plugin.t;

    // Export Source Pack command
    plugin.addCommand({
        id: 'notebooklm-export',
        name: t.commands?.notebookLMExport || 'NotebookLM: Export Source Pack',
        icon: 'package-export',
        callback: async () => {
            if (!plugin.sourcePackService) {
                new Notice(t.messages?.notebookLMServiceNotReady || 'NotebookLM service not initialized');
                return;
            }

            try {
                // Get preview (scans linked docs once — avoids double-scan in executeExport)
                const preview = await plugin.sourcePackService.getExportPreview();

                if (preview.selection.files.length === 0) {
                    new Notice(t.messages?.notebookLMNoSelection || 'No notes selected for export. Add the "notebooklm" tag to notes you want to export.');
                    return;
                }

                let exportModal: NotebookLMExportModal | null = null;

                exportModal = new NotebookLMExportModal(
                    plugin.app,
                    t,
                    preview,
                    (result, signal) => { void (async () => {
                        if (!result.proceed) return;

                        // Update service config with any modal changes
                        plugin.sourcePackService!.updateConfig(result.config);

                        try {
                            const folderName = await generateExportFolderName(plugin, preview.selection.files);

                            const exportFn = result.mode === 'update'
                                ? plugin.sourcePackService!.executeIncrementalExport.bind(plugin.sourcePackService!)
                                : plugin.sourcePackService!.executeExport.bind(plugin.sourcePackService!);

                            const exportResult = await exportFn(
                                preview.selection,
                                (current, total, message) => {
                                    exportModal?.updateProgress(current, total, message);
                                },
                                folderName,
                                preview.linkedDocuments, // pass pre-scanned docs (no double-scan)
                                signal
                            );

                            if (exportResult.success) {
                                exportModal?.showComplete(
                                    true,
                                    exportResult.packFolderPath,
                                    exportResult.warnings
                                );

                                const noteCount = exportResult.stats?.noteCount ?? 0;
                                const successMessage = (t.messages?.notebookLMExportComplete || 'Source pack exported: {notes} notes, {modules} modules')
                                    .replace('{notes}', String(noteCount))
                                    .replace('{modules}', String(noteCount));
                                new Notice(successMessage, 5000);
                            } else {
                                exportModal?.showComplete(false, undefined, undefined, exportResult.errorMessage);
                                const errorMessage = (t.messages?.notebookLMExportFailed || 'Export failed: {error}')
                                    .replace('{error}', exportResult.errorMessage || 'Unknown error');
                                new Notice(errorMessage, 5000);
                            }
                        } catch (error) {
                            const errorMessage = error instanceof Error ? error.message : String(error);
                            const failMessage = (t.messages?.notebookLMExportFailed || 'Export failed: {error}')
                                .replace('{error}', errorMessage);
                            exportModal?.showComplete(false, undefined, undefined, failMessage);
                            new Notice(failMessage, 5000);
                            logger.error('Export', 'NotebookLM export error:', error);
                        }
                    })(); }
                );

                exportModal.open();

            } catch (error) {
                logger.error('Export', 'Failed to start NotebookLM export:', error);
                new Notice(t.messages?.notebookLMExportFailed || 'Failed to start export');
            }
        }
    });

    // Toggle selection on current note
    plugin.addCommand({
        id: 'notebooklm-toggle-selection',
        name: t.commands?.notebookLMToggle || 'NotebookLM: Toggle Selection',
        icon: 'tag',
        callback: async () => {
            const file = plugin.app.workspace.getActiveFile();
            if (!file) {
                new Notice(t.messages?.noActiveFile || 'No active file');
                return;
            }

            try {
                const selectionTag = plugin.settings.notebooklmSelectionTag || 'notebooklm';
                let wasAdded = false;

                await plugin.app.fileManager.processFrontMatter(file, (frontmatter) => {
                    if (!frontmatter.tags) {
                        frontmatter.tags = [];
                    } else if (typeof frontmatter.tags === 'string') {
                        frontmatter.tags = [frontmatter.tags];
                    }

                    const hasTag = frontmatter.tags.some((tag: string) =>
                        tag === selectionTag || tag === `#${selectionTag}`
                    );

                    if (hasTag) {
                        frontmatter.tags = frontmatter.tags.filter((tag: string) =>
                            tag !== selectionTag && tag !== `#${selectionTag}`
                        );
                        if (frontmatter.tags.length === 0) delete frontmatter.tags;
                        wasAdded = false;
                    } else {
                        frontmatter.tags.push(selectionTag);
                        wasAdded = true;
                    }
                });

                new Notice(wasAdded
                    ? (t.messages?.notebookLMSelectionAdded || 'Note added to NotebookLM selection')
                    : (t.messages?.notebookLMSelectionRemoved || 'Note removed from NotebookLM selection')
                );
                plugin.updateNotebookLMStatus();
            } catch (error) {
                logger.error('Export', 'Failed to toggle selection:', error);
                new Notice(t.messages?.notebookLMToggleFailed || 'Failed to toggle selection');
            }
        }
    });

    // Clear selection tags
    plugin.addCommand({
        id: 'notebooklm-clear-selection',
        name: t.commands?.notebookLMClear || 'NotebookLM: Clear Selection',
        icon: 'x-circle',
        callback: async () => {
            if (!plugin.sourcePackService) {
                new Notice(t.messages?.notebookLMServiceNotReady || 'NotebookLM service not initialized');
                return;
            }

            try {
                const preview = await plugin.sourcePackService.getExportPreview();
                const files = preview.selection.files;

                if (files.length === 0) {
                    new Notice(t.messages?.notebookLMNoSelection || 'No notes selected');
                    return;
                }

                const selectionTag = plugin.settings.notebooklmSelectionTag || 'notebooklm';

                for (const file of files) {
                    await plugin.app.fileManager.processFrontMatter(file, (frontmatter) => {
                        if (frontmatter.tags) {
                            if (typeof frontmatter.tags === 'string') frontmatter.tags = [frontmatter.tags];
                            frontmatter.tags = frontmatter.tags.filter((tag: string) =>
                                tag !== selectionTag && tag !== `#${selectionTag}`
                            );
                            if (frontmatter.tags.length === 0) delete frontmatter.tags;
                        }
                    });
                }

                new Notice(
                    (t.messages?.notebookLMSelectionCleared || 'Cleared selection from {count} notes')
                        .replace('{count}', String(files.length))
                );
                plugin.updateNotebookLMStatus();

            } catch (error) {
                logger.error('Export', 'Failed to clear selection:', error);
                new Notice(t.messages?.notebookLMClearFailed || 'Failed to clear selection');
            }
        }
    });

    // Open export folder
    plugin.addCommand({
        id: 'notebooklm-open-export-folder',
        name: t.commands?.notebookLMOpenFolder || 'NotebookLM: Open Export Folder',
        icon: 'folder-open',
        callback: () => {
            const exportFolder = getNotebookLMExportFullPath(plugin.settings);

            try {
                const folder = plugin.app.vault.getAbstractFileByPath(exportFolder);

                if (!folder) {
                    new Notice(t.messages?.notebookLMFolderNotFound || 'Export folder not found. Run an export first.');
                    return;
                }

                if (Platform.isDesktopApp) {
                    const adapter = plugin.app.vault.adapter as import('obsidian').DataAdapter & { getBasePath?: () => string };
                    const basePath = adapter.getBasePath?.() || '';
                    const folderPath = `${basePath}/${exportFolder}`;

                    const electron = getElectron();
                    if (electron?.shell?.openPath) {
                        void electron.shell.openPath(folderPath);
                    }
                } else {
                    new Notice(t.messages?.desktopOnly || 'This feature is only available on desktop');
                }
            } catch (error) {
                logger.error('Export', 'Failed to open export folder:', error);
                new Notice(t.messages?.notebookLMOpenFolderFailed || 'Failed to open export folder');
            }
        }
    });
}

/** Sanitize a raw LLM response into a valid folder name */
function sanitizeFolderName(raw: string): string {
    return raw
        .trim()
        .replaceAll(/[`'"\n\r]/g, '')
        .toLowerCase()
        .replaceAll(/[^a-z0-9-]/g, '-')
        .replaceAll(/-+/g, '-')
        .replaceAll(/(^-)|(-$)/g, '')
        .slice(0, 40);
}

/** Generate a descriptive export folder name via LLM; returns undefined on failure */
async function generateExportFolderName(
    plugin: AIOrganiserPlugin,
    files: TFile[]
): Promise<string | undefined> {
    try {
        const titles = files.slice(0, 10).map(f => f.basename);
        const prompt = buildFolderNamePrompt(titles, files.length);
        const ctx = pluginContext(plugin);
        const result = await summarizeText(ctx, prompt);

        if (result.success && result.content) {
            const slug = sanitizeFolderName(result.content);
            if (slug.length > 0) {
                const dateSuffix = new Date().toISOString().slice(0, 10);
                return `${slug}_${dateSuffix}`;
            }
        }
    } catch {
        // Silent fallback to timestamp
    }
    return undefined;
}
