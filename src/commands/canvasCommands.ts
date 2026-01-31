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

function resolveCanvasLanguage(plugin: AIOrganiserPlugin): string {
    return plugin.settings.summaryLanguage || 'English';
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

            try {
                const result = await withBusyIndicator(plugin, () =>
                    buildInvestigationBoard(plugin.app, ragService, pluginContext(plugin), {
                        file,
                        content,
                        maxRelated: 8,
                        enableEdgeLabels: plugin.settings.canvasEnableEdgeLabels,
                        canvasFolder: getCanvasOutputFullPath(plugin.settings),
                        openAfterCreate: plugin.settings.canvasOpenAfterCreate,
                        language: resolveCanvasLanguage(plugin)
                    })
                );

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

            try {
                const result = await withBusyIndicator(plugin, () =>
                    buildContextBoard(plugin.app, {
                        file,
                        content,
                        canvasFolder: getCanvasOutputFullPath(plugin.settings),
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
        }
    });

    plugin.addCommand({
        id: 'build-cluster-canvas',
        name: plugin.t.commands.buildClusterCanvas,
        icon: 'boxes',
        callback: async () => {
            if (Platform.isMobile) {
                new Notice(plugin.t.canvas.desktopOnly);
                return;
            }

            const modal = new TagPickerModal(plugin.app, plugin.t, async (tag) => {
                const files = getFilesWithTag(plugin, tag);

                try {
                    const result = await withBusyIndicator(plugin, () =>
                        buildClusterBoard(plugin.app, pluginContext(plugin), {
                            tag,
                            files,
                            canvasFolder: getCanvasOutputFullPath(plugin.settings),
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
