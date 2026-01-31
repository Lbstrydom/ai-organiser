import { Notice, Platform } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { RAGService } from '../services/ragService';
import { pluginContext } from '../services/llmFacade';
import { buildInvestigationBoard } from '../services/canvas/investigationBoard';
import { buildContextBoard } from '../services/canvas/contextBoard';
import { buildClusterBoard } from '../services/canvas/clusterBoard';
import { getCanvasOutputFullPath } from '../core/settings';
import { withBusyIndicator } from '../utils/busyIndicator';
import { TagPickerModal } from '../ui/modals/TagPickerModal';

export function registerCanvasCommands(plugin: AIOrganiserPlugin) {
    plugin.addCommand({
        id: 'build-investigation-canvas',
        name: plugin.t.commands.buildInvestigationCanvas,
        icon: 'network',
        callback: async () => {
            if (Platform.isMobile) {
                showNotice(plugin.t.canvas.desktopOnly);
                return;
            }

            if (!plugin.settings.enableSemanticSearch || !plugin.vectorStore) {
                showNotice(plugin.t.canvas.requiresSemanticSearch);
                return;
            }

            const file = plugin.app.workspace.getActiveFile();
            if (!file) {
                showNotice(plugin.t.messages.openNote);
                return;
            }

            const content = await plugin.app.vault.read(file);
            if (!content.trim()) {
                showNotice(plugin.t.canvas.emptyNote);
                return;
            }

            const ragService = new RAGService(
                plugin.vectorStore,
                plugin.settings,
                plugin.embeddingService
            );

            const result = await withBusyIndicator(plugin, () =>
                buildInvestigationBoard(plugin.app, ragService, pluginContext(plugin), {
                    file,
                    content,
                    maxRelated: 8,
                    enableEdgeLabels: plugin.settings.canvasEnableEdgeLabels,
                    canvasFolder: getCanvasOutputFullPath(plugin.settings),
                    openAfterCreate: plugin.settings.canvasOpenAfterCreate
                })
            );

            if (result.success) {
                showNotice(plugin.t.canvas.created);
                return;
            }

            if (result.error === 'No related notes found') {
                showNotice(plugin.t.canvas.noRelatedNotes);
                return;
            }

            showNotice(result.error || plugin.t.canvas.creationFailed);
        }
    });

    plugin.addCommand({
        id: 'build-context-canvas',
        name: plugin.t.commands.buildContextCanvas,
        icon: 'git-branch',
        callback: async () => {
            if (Platform.isMobile) {
                showNotice(plugin.t.canvas.desktopOnly);
                return;
            }

            const file = plugin.app.workspace.getActiveFile();
            if (!file) {
                showNotice(plugin.t.messages.openNote);
                return;
            }

            const content = await plugin.app.vault.read(file);
            if (!content.trim()) {
                showNotice(plugin.t.canvas.emptyNote);
                return;
            }

            const result = await withBusyIndicator(plugin, () =>
                buildContextBoard(plugin.app, {
                    file,
                    content,
                    canvasFolder: getCanvasOutputFullPath(plugin.settings),
                    openAfterCreate: plugin.settings.canvasOpenAfterCreate
                })
            );

            if (result.success) {
                showNotice(plugin.t.canvas.created);
                return;
            }

            if (result.error === 'No sources detected') {
                showNotice(plugin.t.canvas.noSourcesDetected);
                return;
            }

            showNotice(result.error || plugin.t.canvas.creationFailed);
        }
    });

    plugin.addCommand({
        id: 'build-cluster-canvas',
        name: plugin.t.commands.buildClusterCanvas,
        icon: 'boxes',
        callback: async () => {
            if (Platform.isMobile) {
                showNotice(plugin.t.canvas.desktopOnly);
                return;
            }

            const modal = new TagPickerModal(plugin.app, plugin.t, async (tag) => {
                const files = getFilesWithTag(plugin, tag);
                const result = await withBusyIndicator(plugin, () =>
                    buildClusterBoard(plugin.app, pluginContext(plugin), {
                        tag,
                        files,
                        canvasFolder: getCanvasOutputFullPath(plugin.settings),
                        openAfterCreate: plugin.settings.canvasOpenAfterCreate,
                        useLLMClustering: true
                    })
                );

                if (result.success) {
                    showNotice(plugin.t.canvas.created);
                    return;
                }

                if (result.error === 'No notes with tag') {
                    showNotice(plugin.t.canvas.noNotesWithTag);
                    return;
                }

                showNotice(result.error || plugin.t.canvas.creationFailed);
            });

            modal.open();
        }
    });
}

function showNotice(message: string): Notice {
    return new Notice(message);
}

function getFilesWithTag(plugin: AIOrganiserPlugin, tag: string) {
    const files = plugin.app.vault.getMarkdownFiles();
    const matchTag = tag.startsWith('#') ? tag.substring(1) : tag;

    return files.filter(file => {
        const cache = plugin.app.metadataCache.getFileCache(file);
        if (!cache) return false;

        const tags = extractTags(cache);
        return tags.some((value: string) => {
            const clean = value.startsWith('#') ? value.substring(1) : value;
            return clean === matchTag || clean.startsWith(`${matchTag}/`);
        });
    });
}

function extractTags(cache: any): string[] {
    if (Array.isArray(cache.tags)) {
        return cache.tags.map((entry: any) => entry.tag || entry);
    }

    if (cache.frontmatter?.tags) {
        return Array.isArray(cache.frontmatter.tags)
            ? cache.frontmatter.tags
            : [cache.frontmatter.tags];
    }

    return [];
}
