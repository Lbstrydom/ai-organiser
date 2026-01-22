import { MarkdownView, Menu, Notice, TFile } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { ensureNoteStructureIfEnabled } from '../utils/noteStructure';
import { TagScopeModal, TagScope } from '../ui/modals/TagScopeModal';

export function registerGenerateCommands(plugin: AIOrganiserPlugin) {
    // Command: Tag (scope modal)
    plugin.addCommand({
        id: 'smart-tag',
        name: plugin.t.commands.tag || plugin.t.commands.generateTagsForCurrentNote,
        icon: 'tag',
        callback: () => {
            new TagScopeModal(plugin.app, plugin, async (scope: TagScope) => {
                switch (scope) {
                    case 'note':
                        await tagCurrentNote(plugin);
                        break;
                    case 'folder':
                        await tagCurrentFolder(plugin);
                        break;
                    case 'vault':
                        await tagVault(plugin);
                        break;
                    default:
                        break;
                }
            }).open();
        }
    });

    // Register file menu items for batch tagging
    plugin.registerEvent(
        // @ts-ignore - File menu event is not properly typed in Obsidian API
        plugin.app.workspace.on('file-menu', (menu: Menu, file: TFile, source: string, files?: TFile[]) => {
            if (files && files.length > 0) {
                // Multiple files selected
                const markdownFiles = files.filter(f => f.extension === 'md');
                if (markdownFiles.length > 0) {
                    menu.addItem((item) => {
                        item
                            .setTitle(`${plugin.t.commands.aiTagSelectedNotes.replace('{count}', String(markdownFiles.length))}`)
                            .setIcon('tag')
                            .onClick(async () => {
                                const confirmed = await plugin.showConfirmationDialog(
                                    `${plugin.t.messages.generateTagsForSelectedConfirm.replace('{count}', String(markdownFiles.length))}`
                                );

                                if (!confirmed) {
                                    new Notice(plugin.t.messages.operationCancelled);
                                    return;
                                }

                                await plugin.analyzeAndTagFiles(markdownFiles);
                            });
                    });
                }
            } else if (file.extension === 'md') {
                // Single file selected
                menu.addItem((item) => {
                    item
                        .setTitle(plugin.t.commands.aiTagThisNote)
                        .setIcon('tag')
                        .onClick(() => plugin.analyzeAndTagFiles([file]));
                });
            }
        })
    );
}

async function tagCurrentNote(plugin: AIOrganiserPlugin): Promise<void> {
    const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file || !view.editor) {
        new Notice(plugin.t.messages.openNote);
        return;
    }

    const editor = view.editor;
    const selectedText = editor.getSelection();
    const content = selectedText || await plugin.app.vault.read(view.file);

    if (!content.trim()) {
        new Notice(plugin.t.messages.noContentToAnalyze);
        return;
    }

    new Notice(plugin.t.messages.analyzing);

    try {
        const result = await plugin.analyzeAndTagNote(view.file, content);

        if (selectedText && result.success) {
            editor.replaceSelection(selectedText);
        }
        plugin.handleTagUpdateResult(result);

        if (result.success) {
            ensureNoteStructureIfEnabled(editor, plugin.settings);
        }

        if (result.success && (result.suggestedTitle || result.suggestedFolder)) {
            await plugin.showSuggestionModal(view.file, result.suggestedTitle, result.suggestedFolder);
        }
    } catch (error) {
        new Notice(plugin.t.messages.failedToGenerateTags);
    }
}

async function tagCurrentFolder(plugin: AIOrganiserPlugin): Promise<void> {
    const activeFile = plugin.app.workspace.getActiveFile();
    if (!activeFile) {
        new Notice(plugin.t.messages.openNote);
        return;
    }

    const parentFolder = activeFile.parent;
    if (!parentFolder) {
        new Notice(plugin.t.messages.noParentFolder);
        return;
    }

    const filesInFolder = plugin.getNonExcludedMarkdownFilesFromFolder(parentFolder);

    if (filesInFolder.length === 0) {
        new Notice(plugin.t.messages.noMdFiles);
        return;
    }

    const confirmed = await plugin.showConfirmationDialog(
        `${plugin.t.messages.generateTagsForFolderConfirm.replace('{count}', String(filesInFolder.length))}`
    );

    if (!confirmed) {
        new Notice(plugin.t.messages.operationCancelled);
        return;
    }

    await plugin.analyzeAndTagFiles(filesInFolder);
    const activeView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView?.editor) {
        ensureNoteStructureIfEnabled(activeView.editor, plugin.settings);
    }
}

async function tagVault(plugin: AIOrganiserPlugin): Promise<void> {
    const files = plugin.getNonExcludedMarkdownFiles();
    if (files.length === 0) {
        new Notice(plugin.t.messages.noMdFiles);
        return;
    }

    const confirmed = await plugin.showConfirmationDialog(
        `${plugin.t.messages.generateTagsForVaultConfirm.replace('{count}', String(files.length))}`
    );

    if (!confirmed) {
        new Notice(plugin.t.messages.operationCancelled);
        return;
    }

    await plugin.analyzeAndTagFiles(files);
    const activeView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView?.editor) {
        ensureNoteStructureIfEnabled(activeView.editor, plugin.settings);
    }
}
