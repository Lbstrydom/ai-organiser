import { MarkdownView, Notice } from 'obsidian';
import AIOrganiserPlugin from '../main';
import { ensureNoteStructureIfEnabled } from '../utils/noteStructure';
import { ClearTagsScopeModal, ClearTagsScope } from '../ui/modals/ClearTagsScopeModal';
import { isProtectedPath, splitByProtection } from '../core/protectedPaths';
import { plural } from '../utils/plural';

export function registerClearCommands(plugin: AIOrganiserPlugin) {
    // Command: Clear Tags (scope modal)
    plugin.addCommand({
        id: 'clear-tags',
        name: plugin.t.commands.clearTags || plugin.t.commands.clearTagsForCurrentNote,
        icon: 'eraser',
        callback: () => {
            new ClearTagsScopeModal(plugin.app, plugin, (scope: ClearTagsScope) => { void (async () => {
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
            })(); }).open();
        }
    });
}

async function clearTagsForCurrentNote(plugin: AIOrganiserPlugin): Promise<void> {
    const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.file && view.editor) {
        if (isProtectedPath(plugin.settings.protectedFolders, view.file.path)) {
            new Notice(plugin.t.messages.protectedNoteNotModified, 6000); // one notice, and no structure edit to refuse a second time
            return;
        }
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

    const m = plugin.t.messages;
    const { writable, protectedOut } = splitByProtection(plugin.settings.protectedFolders, filesInFolder);
    if (writable.length === 0) {
        new Notice(m.clearTagsAllProtected);
        return;
    }

    const confirmed = await plugin.showConfirmationDialog(
        [plural(m.clearTagsForFolderConfirm, writable.length), protectedOut.length > 0 ? plural(m.clearTagsProtectedConfirm, protectedOut.length) : ''].filter(Boolean).join(' ')
    );

    if (!confirmed) {
        new Notice(m.operationCancelled);
        return;
    }

    const result = await plugin.clearDirectoryTags(writable);
    if (result.success) {
        new Notice([plural(m.tagsClearedFrom, result.successCount), protectedOut.length > 0 ? plural(m.clearTagsProtectedResult, protectedOut.length) : ''].filter(Boolean).join('. '), protectedOut.length > 0 ? 6000 : undefined);
        const activeView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
        if (activeView?.editor) {
            ensureNoteStructureIfEnabled(activeView.editor, plugin.settings);
        }
    } else {
        new Notice(plugin.t.messages.failedToClearTags);
    }
}

async function clearTagsForVault(plugin: AIOrganiserPlugin): Promise<void> {
    if (!(await plugin.clearAllNotesTags())) return; // declined, nothing allowed or failed: leave the open note alone
    const activeView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView?.editor) {
        ensureNoteStructureIfEnabled(activeView.editor, plugin.settings);
    }
}
