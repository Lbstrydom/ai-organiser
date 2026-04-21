/**
 * Chat Commands
 * Single unified chat command + related notes insertion
 */

import { Editor, Notice } from 'obsidian';
import AIOrganiserPlugin from '../main';
import { RAGService } from '../services/ragService';
import { ensureNoteStructureIfEnabled } from '../utils/noteStructure';
import { UnifiedChatModal } from '../ui/modals/UnifiedChatModal';

function notify(message: string, duration?: number): Notice {
    return new Notice(message, duration);
}

/**
 * Open UnifiedChatModal with the current editor selection locked.
 * Called from the right-click context menu.
 */
export function openChatWithSelection(plugin: AIOrganiserPlugin, editor: Editor): void {
    const activeFile = plugin.app.workspace.getActiveFile();
    const content = editor.getValue() || undefined;
    const selection = editor.getSelection() || undefined;

    const modal = new UnifiedChatModal(plugin.app, plugin, {
        noteContent: content,
        noteTitle: activeFile?.basename,
        editorSelection: selection,
    });
    modal.open();
}

/**
 * Open UnifiedChatModal with whatever context is available from the active
 * editor, auto-selecting the best mode. Shared by the `chat-with-ai` command
 * and the dedicated Chat ribbon icon (R5 menu audit 2026-04-21).
 */
export function openAIChat(plugin: AIOrganiserPlugin): void {
    const activeEditor = plugin.app.workspace.activeEditor?.editor;
    const activeFile = plugin.app.workspace.getActiveFile();
    const content = activeEditor?.getValue() || undefined;
    const selection = activeEditor?.getSelection() || undefined;

    const modal = new UnifiedChatModal(plugin.app, plugin, {
        noteContent: content,
        noteTitle: activeFile?.basename,
        editorSelection: selection,
        // No initialMode — let auto-selection pick the best mode
    });
    modal.open();
}

/**
 * Register chat commands
 */
export function registerChatCommands(plugin: AIOrganiserPlugin): void {
    // Unified chat command — auto-selects best mode based on context
    plugin.addCommand({
        id: 'chat-with-ai',
        name: plugin.t.commands.chatWithAI,
        icon: 'message-circle',
        callback: () => openAIChat(plugin),
    });

    // Presentation chat — opens UnifiedChatModal in presentation mode
    plugin.addCommand({
        id: 'presentation-chat',
        name: plugin.t.commands.presentationChat,
        icon: 'presentation',
        callback: () => {
            const activeEditor = plugin.app.workspace.activeEditor?.editor;
            const activeFile = plugin.app.workspace.getActiveFile();
            const content = activeEditor?.getValue() || undefined;

            const modal = new UnifiedChatModal(plugin.app, plugin, {
                noteContent: content,
                noteTitle: activeFile?.basename,
                initialMode: 'presentation',
            });
            modal.open();
        }
    });

    // Find and insert related notes
    plugin.addCommand({
        id: 'insert-related-notes',
        name: plugin.t.commands.insertRelatedNotes,
        editorCallback: async (editor, view) => {
            if (!plugin.vectorStore || !plugin.settings.enableSemanticSearch) {
                notify(plugin.t.messages.semanticSearchNotEnabledDetailed);
                return;
            }

            const file = view.file;
            if (!file) return;

            try {
                const content = editor.getValue();
                const ragService = new RAGService(
                    plugin.vectorStore,
                    plugin.settings,
                    plugin.embeddingService
                );

                const statusNotice = new Notice(plugin.t.messages.findingRelatedNotesDetailed, 0);
                const related = await ragService.getRelatedNotes(
                    file,
                    content,
                    plugin.settings.relatedNotesCount || 15
                );
                statusNotice.hide();

                if (related.length === 0) {
                    new Notice(plugin.t.messages.noRelatedNotes);
                    return;
                }

                // Format related notes
                const relatedSection = [
                    '\n\n---\n',
                    '## Related Notes\n',
                    ...related.map(r =>
                        `- [[${r.document.filePath}|${r.document.metadata.title}]] (related)`
                    ),
                    '\n'
                ].join('\n');

                // Insert at cursor or end
                const cursor = editor.getCursor();
                editor.replaceRange(relatedSection, cursor);
                ensureNoteStructureIfEnabled(editor, plugin.settings);
                new Notice(plugin.t.messages.insertedRelatedNotes.replace('{count}', String(related.length)));
            } catch (error) {
                notify(plugin.t.messages.semanticSearchDisabled + ': ' + (error instanceof Error ? error.message : String(error)));
            }
        }
    });
}
