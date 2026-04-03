import { MarkdownView, Notice } from 'obsidian';
import AIOrganiserPlugin from '../main';
import { ensureNoteStructureIfEnabled } from '../utils/noteStructure';
import { ClearTagsScopeModal, ClearTagsScope } from '../ui/modals/ClearTagsScopeModal';

export function registerClearCommands(plugin: AIOrganiserPlugin) {
    // Command: Clear Tags (scope modal)
    plugin.addCommand({
        id: 'clear-tags',
        name: plugin.t.commands.clearTags || plugin.t.commands.clearTagsForCurrentNote,
        icon: 'eraser',
        callback: () => {
            new ClearTagsScopeModal(plugin.app, plugin, async (scope: ClearTagsScope) => {
                switch (scope) {
                    case 'note':
                        await clearTagsForCurrentNote(plugin);
                        break;
                    case 'folder':
                        await clearTagsForCurrentFolder(plugin);
                        break;
                    case 'vault':
                        await clearTagsForVault(plugin);
                        break;
                    default:
                        break;
                }
            }).open();
        }
    });
}

async function clearTagsForCurrentNote(plugin: AIOrganiserPlugin): Promise<void> {
    const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.file && view.editor) {
        await plugin.clearNoteTags();
        ensureNoteStructureIfEnabled(view.editor, plugin.settings);
    } else {
        new Notice(plugin.t.messages.openNoteFirst);
    }
}

async function clearTagsForCurrentFolder(plugin: AIOrganiserPlugin): Promise<void> {
    const activeFile = plugin.app.workspace.getActiveFile();
    if (!activeFile) {
        new Notice(plugin.t.messages.openNoteFirst);
        return;
    }

    const parentFolder = activeFile.parent;
    if (!parentFolder) {
        new Notice(plugin.t.messages.noParentFolderFound);
        return;
    }

    const filesInFolder = plugin.getNonExcludedMarkdownFilesFromFolder(parentFolder);

    if (filesInFolder.length === 0) {
        new Notice(plugin.t.messages.noMarkdownFilesFound);
        return;
    }

    const confirmed = await plugin.showConfirmationDialog(
        `${plugin.t.messages.clearTagsForFolderConfirm.replace('{count}', String(filesInFolder.length))}`
    );

    if (!confirmed) {
        new Notice(plugin.t.messages.operationCancelled);
        return;
    }

    const result = await plugin.clearDirectoryTags(filesInFolder);
    if (result.success) {
        new Notice(`${plugin.t.messages.tagsClearedFrom.replace('{count}', String(result.successCount))}`);
        const activeView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
        if (activeView?.editor) {
            ensureNoteStructureIfEnabled(activeView.editor, plugin.settings);
        }
    } else {
        new Notice(plugin.t.messages.failedToClearTags);
    }
}

async function clearTagsForVault(plugin: AIOrganiserPlugin): Promise<void> {
    await plugin.clearAllNotesTags();
    const activeView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView?.editor) {
        ensureNoteStructureIfEnabled(activeView.editor, plugin.settings);
    }
}
