import { Notice, Platform } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { RAGService } from '../services/ragService';
import { pluginContext } from '../services/llmFacade';
import { buildInvestigationBoard } from '../services/canvas/investigationBoard';
import { buildContextBoard } from '../services/canvas/contextBoard';
import { buildClusterBoard } from '../services/canvas/clusterBoard';
import { getCanvasOutputFullPath } from '../core/settings';
import { withBusyIndicator } from '../utils/busyIndicator';
import { extractTagsFromCache } from '../utils/tagUtils';
import { TagPickerModal } from '../ui/modals/TagPickerModal';
import { FolderScopePickerModal } from '../ui/modals/FolderScopePickerModal';

function resolveCanvasLanguage(plugin: AIOrganiserPlugin): string {
    return plugin.settings.summaryLanguage || 'English';
}

/** Get the folder path of the current note, or fallback to settings default */
function getCurrentNoteFolder(plugin: AIOrganiserPlugin): string {
    const file = plugin.app.workspace.getActiveFile();
    if (file?.parent) {
        return file.parent.path;
    }
    return getCanvasOutputFullPath(plugin.settings);
}

export function registerCanvasCommands(plugin: AIOrganiserPlugin) {
    plugin.addCommand({
        id: 'build-investigation-canvas',
        name: plugin.t.commands.buildInvestigationCanvas,
        icon: 'network',
        callback: async () => {
            if (Platform.isMobile) {
                new Notice(plugin.t.canvas.desktopOnly);
                return;
            }

            if (!plugin.settings.enableSemanticSearch || !plugin.vectorStore) {
                new Notice(plugin.t.canvas.requiresSemanticSearch);
                return;
            }

            const file = plugin.app.workspace.getActiveFile();
            if (!file) {
                new Notice(plugin.t.messages.openNote);
                return;
            }

            const content = await plugin.app.vault.read(file);
            if (!content.trim()) {
                new Notice(plugin.t.canvas.emptyNote);
                return;
            }

            const ragService = new RAGService(
                plugin.vectorStore,
                plugin.settings,
                plugin.embeddingService
            );

            // Show folder picker with current note's folder as default
            const defaultFolder = getCurrentNoteFolder(plugin);
            const folderPicker = new FolderScopePickerModal(plugin.app, plugin, {
                title: plugin.t.canvas.chooseFolder,
                description: plugin.t.canvas.chooseFolderDesc,
                defaultFolder,
                allowSkip: false,
                allowNewFolder: true,
                confirmButtonText: plugin.t.canvas.chooseFolder,
                onSelect: (selectedFolder) => { void (async () => {
                    const canvasFolder = selectedFolder || defaultFolder;

                    try {
                        const progressNotice = new Notice(plugin.t.canvas.building || 'Building investigation canvas…', 0);
                        let result: Awaited<ReturnType<typeof buildInvestigationBoard>>;
                        try {
                            result = await withBusyIndicator(plugin, () =>
                                buildInvestigationBoard(plugin.app, ragService, pluginContext(plugin), {
                                    file,
                                    content,
                                    maxRelated: plugin.settings.relatedNotesCount || 15,
                                    enableEdgeLabels: plugin.settings.canvasEnableEdgeLabels,
                                    canvasFolder,
                                    openAfterCreate: plugin.settings.canvasOpenAfterCreate,
                                    language: resolveCanvasLanguage(plugin),
                                    edgeLabelStrings: {
                                        closelyRelated: plugin.t.canvas.edgeCloselyRelated,
                                        related: plugin.t.canvas.edgeRelated,
                                        looselyRelated: plugin.t.canvas.edgeLooselyRelated
                                    },
                                    progressStrings: {
                                        findingRelated: plugin.t.canvas.progressFindingRelated,
                                        labeling: plugin.t.canvas.progressLabelingRelationships,
                                        building: plugin.t.canvas.progressBuildingCanvas,
                                    },
                                    onProgress: (phase: string) => progressNotice.setMessage(phase),
                                })
                            );
                        } finally {
                            progressNotice.hide();
                        }

                        if (result.success) {
                            new Notice(plugin.t.canvas.created);
                            return;
                        }

                        if (result.errorCode === 'no-related-notes') {
                            new Notice(plugin.t.canvas.noRelatedNotes);
                            return;
                        }

                        new Notice(result.error || plugin.t.canvas.creationFailed);
                    } catch {
                        new Notice(plugin.t.canvas.creationFailed);
                    }
                })(); }
            });
            folderPicker.open();
        }
    });

    plugin.addCommand({
        id: 'build-context-canvas',
        name: plugin.t.commands.buildContextCanvas,
        icon: 'git-branch',
        callback: async () => {
            if (Platform.isMobile) {
                new Notice(plugin.t.canvas.desktopOnly);
                return;
            }

            const file = plugin.app.workspace.getActiveFile();
            if (!file) {
                new Notice(plugin.t.messages.openNote);
                return;
            }

            const content = await plugin.app.vault.read(file);
            if (!content.trim()) {
                new Notice(plugin.t.canvas.emptyNote);
                return;
            }

            // Show folder picker with current note's folder as default
            const defaultFolder = getCurrentNoteFolder(plugin);
            const folderPicker = new FolderScopePickerModal(plugin.app, plugin, {
                title: plugin.t.canvas.chooseFolder,
                description: plugin.t.canvas.chooseFolderDesc,
                defaultFolder,
                allowSkip: false,
                allowNewFolder: true,
                confirmButtonText: plugin.t.canvas.chooseFolder,
                onSelect: (selectedFolder) => { void (async () => {
                    const canvasFolder = selectedFolder || defaultFolder;

                    try {
                        const result = await withBusyIndicator(plugin, () =>
                            buildContextBoard(plugin.app, {
                                file,
                                content,
                                canvasFolder,
                                openAfterCreate: plugin.settings.canvasOpenAfterCreate
                            })
                        );

                        if (result.success) {
                            new Notice(plugin.t.canvas.created);
                            return;
                        }

                        if (result.errorCode === 'no-sources-detected') {
                            new Notice(plugin.t.canvas.noSourcesDetected);
                            return;
                        }

                        new Notice(result.error || plugin.t.canvas.creationFailed);
                    } catch {
                        new Notice(plugin.t.canvas.creationFailed);
                    }
                })(); }
            });
            folderPicker.open();
        }
    });

    plugin.addCommand({
        id: 'build-cluster-canvas',
        name: plugin.t.commands.buildClusterCanvas,
        icon: 'boxes',
        callback: () => {
            if (Platform.isMobile) {
                new Notice(plugin.t.canvas.desktopOnly);
                return;
            }

            const modal = new TagPickerModal(plugin.app, plugin.t, (tag) => {
                const files = getFilesWithTag(plugin, tag);

                // Show folder picker - default to current note folder or settings default
                const defaultFolder = getCurrentNoteFolder(plugin);
                const folderPicker = new FolderScopePickerModal(plugin.app, plugin, {
                    title: plugin.t.canvas.chooseFolder,
                    description: plugin.t.canvas.chooseFolderDesc,
                    defaultFolder,
                    allowSkip: false,
                    allowNewFolder: true,
                    confirmButtonText: plugin.t.canvas.chooseFolder,
                    onSelect: (selectedFolder) => { void (async () => {
                        const canvasFolder = selectedFolder || defaultFolder;

                        try {
                            const result = await withBusyIndicator(plugin, () =>
                                buildClusterBoard(plugin.app, pluginContext(plugin), {
                                    tag,
                                    files,
                                    canvasFolder,
                                    openAfterCreate: plugin.settings.canvasOpenAfterCreate,
                                    useLLMClustering: plugin.settings.canvasUseLLMClustering,
                                    language: resolveCanvasLanguage(plugin)
                                })
                            );

                            if (result.success) {
                                new Notice(plugin.t.canvas.created);
                                return;
                            }

                            if (result.errorCode === 'no-notes-with-tag') {
                                new Notice(plugin.t.canvas.noNotesWithTag);
                                return;
                            }

                            new Notice(result.error || plugin.t.canvas.creationFailed);
                        } catch {
                            new Notice(plugin.t.canvas.creationFailed);
                        }
                    })(); }
                });
                folderPicker.open();
            });

            modal.open();
        }
    });
}

function getFilesWithTag(plugin: AIOrganiserPlugin, tag: string) {
    const files = plugin.app.vault.getMarkdownFiles();
    const matchTag = tag.startsWith('#') ? tag.substring(1) : tag;

    return files.filter(file => {
        const cache = plugin.app.metadataCache.getFileCache(file);
        const tags = extractTagsFromCache(cache);
        return tags.some((value: string) => {
            const clean = value.startsWith('#') ? value.substring(1) : value;
            return clean === matchTag || clean.startsWith(`${matchTag}/`);
        });
    });
}
