/**
 * Chat with Vault Commands
 * Interactive chat using RAG (Retrieval-Augmented Generation)
 */

import { Notice } from 'obsidian';
import AIOrganiserPlugin from '../main';
import { RAGService } from '../services/ragService';
import { ensureNoteStructureIfEnabled } from '../utils/noteStructure';
import { UnifiedChatModal } from '../ui/modals/UnifiedChatModal';

function notify(message: string, duration?: number): Notice {
    return new Notice(message, duration);
}

/**
 * Register chat with vault commands
 */
export function registerChatCommands(plugin: AIOrganiserPlugin): void {
    // Chat with vault command
    plugin.addCommand({
        id: 'chat-with-vault',
        name: plugin.t.commands.chatWithVault,
        callback: async () => {
            const activeEditor = plugin.app.workspace.activeEditor?.editor;
            const activeFile = plugin.app.workspace.getActiveFile();
            const content = activeEditor?.getValue() || undefined;
            const selection = activeEditor?.getSelection() || undefined;

            const modal = new UnifiedChatModal(plugin.app, plugin, {
                noteContent: content,
                noteTitle: activeFile?.basename,
                editorSelection: selection,
                initialMode: 'vault'
            });
            modal.open();
        }
    });

    // Ask about current note
    plugin.addCommand({
        id: 'ask-about-current-note',
        name: plugin.t.commands.askAboutCurrentNote,
        editorCallback: async (editor, view) => {
            const file = view.file;
            if (!file) return;

            const selection = editor.getSelection();
            const content = selection || editor.getValue();

            if (!content.trim()) {
                notify(plugin.t.messages.noContentToAnalyzeDetailed);
                return;
            }
            const modal = new UnifiedChatModal(plugin.app, plugin, {
                noteContent: editor.getValue(),
                noteTitle: file.basename,
                editorSelection: selection || undefined,
                initialMode: 'note'
            });
            modal.open();
        }
    });

    // Chat about highlights
    plugin.addCommand({
        id: 'chat-about-highlights',
        name: plugin.t.commands.chatAboutHighlights || 'Chat about highlights',
        icon: 'message-square-quote',
        editorCallback: (editor, view) => {
            const file = view.file;
            if (!file) return;

            const content = editor.getValue();
            if (!content.trim()) {
                notify(plugin.t.messages.noContentToAnalyzeDetailed);
                return;
            }

            const selection = editor.getSelection();
            const modal = new UnifiedChatModal(plugin.app, plugin, {
                noteContent: content,
                noteTitle: file.basename,
                editorSelection: selection || undefined,
                initialMode: 'highlight'
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
                notify(plugin.t.messages.semanticSearchDisabled + ': ' + (error as any).message);
            }
        }
    });
}
