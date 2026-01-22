/**
 * NotebookLM Commands
 *
 * Command registration for NotebookLM source pack features:
 * - Export source pack (with preview modal)
 * - Toggle selection on current note
 * - Clear selection tags
 * - Open export folder
 */

import { Notice, Platform } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { NotebookLMExportModal, NotebookLMExportResult } from '../ui/modals/NotebookLMExportModal';

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
                // Get selection by tag
                const selection = await plugin.sourcePackService.getSelectionByTag();

                if (selection.files.length === 0) {
                    new Notice(t.messages?.notebookLMNoSelection || 'No notes selected for export. Add the "notebooklm" tag to notes you want to export.');
                    return;
                }

                // Generate preview
                const preview = await plugin.sourcePackService.generatePreview(selection);

                // Open preview modal
                const modal = new NotebookLMExportModal(
                    plugin.app,
                    plugin.t,
                    preview,
                    async (result: NotebookLMExportResult) => {
                        if (!result.proceed) return;

                        // Update service config
                        plugin.sourcePackService!.updateConfig(result.config);

                        // Execute export with progress notification
                        const progressNotice = new Notice(
                            t.messages?.notebookLMExporting || 'Exporting source pack...',
                            0
                        );

                        try {
                            const exportResult = await plugin.sourcePackService!.exportSourcePack(
                                selection,
                                (stage, progress) => {
                                    progressNotice.setMessage(
                                        `${stage} (${Math.round(progress * 100)}%)`
                                    );
                                }
                            );

                            progressNotice.hide();

                            if (exportResult.success) {
                                new Notice(
                                    (t.messages?.notebookLMExportComplete || 'Source pack exported: {notes} notes, {modules} modules')
                                        .replace('{notes}', String(exportResult.stats?.noteCount || 0))
                                        .replace('{modules}', String(exportResult.stats?.moduleCount || 0))
                                );
                            } else {
                                new Notice(
                                    (t.messages?.notebookLMExportFailed || 'Export failed: {error}')
                                        .replace('{error}', exportResult.errorMessage || 'Unknown error')
                                );
                            }
                        } catch (error) {
                            progressNotice.hide();
                            console.error('NotebookLM export failed:', error);
                            new Notice(t.messages?.notebookLMExportFailed || 'Export failed');
                        }
                    }
                );
                modal.open();

            } catch (error) {
                console.error('Failed to start NotebookLM export:', error);
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

            if (!plugin.sourcePackService) {
                new Notice(t.messages?.notebookLMServiceNotReady || 'NotebookLM service not initialized');
                return;
            }

            try {
                const added = await plugin.sourcePackService.toggleSelection(file);

                if (added) {
                    new Notice(t.messages?.notebookLMSelectionAdded || 'Note added to NotebookLM selection');
                } else {
                    new Notice(t.messages?.notebookLMSelectionRemoved || 'Note removed from NotebookLM selection');
                }
            } catch (error) {
                console.error('Failed to toggle selection:', error);
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
                const selection = await plugin.sourcePackService.getSelectionByTag();

                if (selection.files.length === 0) {
                    new Notice(t.messages?.notebookLMNoSelection || 'No notes selected');
                    return;
                }

                await plugin.sourcePackService.clearSelectionTags(selection.files);
                new Notice(
                    (t.messages?.notebookLMSelectionCleared || 'Cleared selection from {count} notes')
                        .replace('{count}', String(selection.files.length))
                );

            } catch (error) {
                console.error('Failed to clear selection:', error);
                new Notice(t.messages?.notebookLMClearFailed || 'Failed to clear selection');
            }
        }
    });

    // Open export folder
    plugin.addCommand({
        id: 'notebooklm-open-export-folder',
        name: t.commands?.notebookLMOpenFolder || 'NotebookLM: Open Export Folder',
        icon: 'folder-open',
        callback: async () => {
            const exportFolder = `${plugin.settings.pluginFolder}/${plugin.settings.notebooklmExportFolder}`;

            try {
                const folder = plugin.app.vault.getAbstractFileByPath(exportFolder);

                if (!folder) {
                    new Notice(t.messages?.notebookLMFolderNotFound || 'Export folder not found. Run an export first.');
                    return;
                }

                // Open folder in file explorer (desktop only)
                if (Platform.isDesktopApp) {
                    const adapter = plugin.app.vault.adapter as any;
                    const basePath = adapter.getBasePath?.() || '';
                    const folderPath = `${basePath}/${exportFolder}`;

                    if (Platform.isWin) {
                        require('child_process').exec(`explorer "${folderPath.replace(/\//g, '\\')}"`);
                    } else if (Platform.isMacOS) {
                        require('child_process').exec(`open "${folderPath}"`);
                    } else {
                        require('child_process').exec(`xdg-open "${folderPath}"`);
                    }
                } else {
                    new Notice(t.messages?.desktopOnly || 'This feature is only available on desktop');
                }
            } catch (error) {
                console.error('Failed to open export folder:', error);
                new Notice(t.messages?.notebookLMOpenFolderFailed || 'Failed to open export folder');
            }
        }
    });
}
