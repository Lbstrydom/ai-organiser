/**
 * Context Menu Handler
 * Centralized right-click context menu registration for all plugin items.
 * Groups items with a single separator:
 *   Actions (Highlight, Remove Highlight, Ask AI, Translate)
 *   Workflow (Add to Pending) — instant, no modal
 */

import { Editor, MarkdownView, MarkdownFileInfo, Menu } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { HighlightColorModal, HighlightColor } from '../ui/modals/HighlightColorModal';
import { stripExistingHighlight } from '../commands/highlightCommands';
import { translateSelectionFromMenu } from '../commands/translateCommands';
import { openChatWithSelection } from '../commands/chatCommands';
import { dropSelectionToPending } from '../commands/integrationCommands';

/**
 * Apply highlight to selected text
 */
function applyHighlightFromMenu(editor: Editor, selection: string, color: HighlightColor): void {
    if (color.id === 'clear') {
        const cleaned = stripExistingHighlight(selection);
        editor.replaceSelection(cleaned);
        return;
    }
    const cleanedSelection = stripExistingHighlight(selection);
    const highlighted = `<mark class="ao-highlight ao-highlight-${color.id}">${cleanedSelection}</mark>`;
    editor.replaceSelection(highlighted);
}

/**
 * Register the centralized editor context menu handler.
 * All plugin right-click items are registered here.
 */
export function registerContextMenu(plugin: AIOrganiserPlugin): void {
    plugin.registerEvent(
        plugin.app.workspace.on('editor-menu', (menu: Menu, editor: Editor, view: MarkdownView | MarkdownFileInfo) => {
            const selection = editor.getSelection();
            if (!selection || selection.trim().length === 0) return;

            // ── Group 1: Visual ──────────────────────────────────────

            // Highlight (always when selection present)
            menu.addItem((item) => {
                item.setTitle(plugin.t.commands.highlightSelection || 'Highlight')
                    .setIcon('highlighter')
                    .onClick(() => {
                        const modal = new HighlightColorModal(
                            plugin.app, plugin.t,
                            (color) => applyHighlightFromMenu(editor, selection, color)
                        );
                        modal.open();
                    });
            });

            // Remove highlight (only when markup detected, with performance guard)
            if (selection.length <= 5000) {
                const stripped = stripExistingHighlight(selection);
                if (stripped !== selection) {
                    menu.addItem((item) => {
                        item.setTitle(plugin.t.commands.removeHighlight || 'Remove highlight')
                            .setIcon('eraser')
                            .onClick(() => {
                                editor.replaceSelection(stripped);
                            });
                    });
                }
            }

            // Ask AI (opens UnifiedChatModal with selection locked)
            menu.addItem((item) => {
                item.setTitle(plugin.t.contextMenu.askAI || 'Ask AI')
                    .setIcon('sparkles')
                    .onClick(() => {
                        openChatWithSelection(plugin, editor);
                    });
            });

            // Translate (opens TranslateModal for selection)
            menu.addItem((item) => {
                item.setTitle(plugin.t.contextMenu.translate || 'Translate')
                    .setIcon('languages')
                    .onClick(() => {
                        translateSelectionFromMenu(plugin, editor);
                    });
            });

            // ── Separator: Workflow ───────────────────────────────────
            menu.addSeparator();

            // Add to Pending (instant, no modal)
            menu.addItem((item) => {
                item.setTitle(plugin.t.contextMenu.addToPending || 'Add to Pending')
                    .setIcon('inbox')
                    .onClick(() => {
                        dropSelectionToPending(plugin, editor);
                    });
            });
        })
    );
}
