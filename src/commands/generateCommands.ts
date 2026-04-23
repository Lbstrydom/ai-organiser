import { MarkdownView, Menu, Notice, TFile } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { ensureNoteStructureIfEnabled } from '../utils/noteStructure';
import { TagScopeModal, TagScope } from '../ui/modals/TagScopeModal';
import { withProgress } from '../services/progress';

export function registerGenerateCommands(plugin: AIOrganiserPlugin) {
    // Command: Tag (scope modal)
    plugin.addCommand({
        id: 'smart-tag',
        name: plugin.t.commands.tag || plugin.t.commands.generateTagsForCurrentNote,
        icon: 'tag',
        callback: () => {
            new TagScopeModal(plugin.app, plugin, (scope: TagScope) => { void (async () => {
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
            })(); }).open();
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
    const file = view.file; // capture non-null reference for closures below
    const selectedText = editor.getSelection();
    const content = selectedText || await plugin.app.vault.read(file);

    if (!content.trim()) {
        new Notice(plugin.t.messages.noContentToAnalyze);
        return;
    }

    // No separate folder-scope modal — persona round 2 (Maya) flagged the
    // double-modal as a P1 confusion ("I already picked 'This note' — why
    // another folder?"). Default is vault-wide taxonomy which matches the
    // most common intent. Users who need folder-scoped taxonomy can still
    // reach it via the batch tag commands (folder / vault scope in
    // TagScopeModal) which surface the picker where it belongs.
    //
    // Tag pipeline's inner onProgress callback emits already-localized phase
    // strings ("Gathering tags…", "Applying…"). We forward those through the
    // reporter's resolvePhase via the `raw` param so the user sees the exact
    // pipeline phase without our duplicating the string catalog here.
    type Phase = 'analyzing' | 'applying' | 'raw';

    const r = await withProgress<Awaited<ReturnType<typeof plugin.analyzeAndTagNote>>, Phase>(
        {
            plugin,
            initialPhase: { key: 'analyzing' },
            resolvePhase: (p) => {
                if (p.key === 'raw' && typeof p.params?.text === 'string') return p.params.text;
                if (p.key === 'analyzing') return plugin.t.progress.generateTags.analyzing;
                if (p.key === 'applying') return plugin.t.progress.generateTags.applying;
                return plugin.t.messages.analyzing;
            },
        },
        async (reporter) => {
            return plugin.analyzeAndTagNote(
                file,
                content,
                {
                    onProgress: (phase: string) => reporter.setPhase({ key: 'raw', params: { text: phase } }),
                },
            );
        },
    );
    if (!r.ok) return; // reporter already fired "Failed: <detail>" toast

    const result = r.value;
    if (selectedText && result.success) {
        editor.replaceSelection(selectedText);
    }
    plugin.handleTagUpdateResult(result);

    if (result.success) {
        ensureNoteStructureIfEnabled(editor, plugin.settings);
    }

    if (result.success && (result.suggestedTitle || result.suggestedFolder)) {
        await plugin.showSuggestionModal(file, result.suggestedTitle, result.suggestedFolder);
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
