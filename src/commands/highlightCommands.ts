/**
 * Highlight Commands
 * Commands for highlighting selected text with colors
 */

import { Editor, MarkdownView, MarkdownFileInfo, Notice } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { HighlightColorModal, HighlightColor, HIGHLIGHT_COLORS } from '../ui/modals/HighlightColorModal';

export function registerHighlightCommands(plugin: AIOrganiserPlugin): void {
    // Command: Highlight selection with color picker
    plugin.addCommand({
        id: 'highlight-selection',
        name: plugin.t.commands.highlightSelection || 'Highlight selection',
        icon: 'highlighter',
        editorCallback: (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
            const selection = editor.getSelection();

            if (!selection || selection.trim().length === 0) {
                new Notice(plugin.t.messages.noSelection || 'Please select text to highlight');
                return;
            }

            // Show color picker modal
            const modal = new HighlightColorModal(
                plugin.app,
                plugin.t,
                (color: HighlightColor) => {
                    applyHighlight(editor, selection, color);
                }
            );
            modal.open();
        }
    });

    // Quick highlight commands for each color (optional hotkey assignment)
    for (const color of HIGHLIGHT_COLORS) {
        plugin.addCommand({
            id: `highlight-${color.id}`,
            name: `${plugin.t.commands.highlightWith || 'Highlight with'} ${color.name}`,
            icon: 'highlighter',
            editorCallback: (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
                const selection = editor.getSelection();

                if (!selection || selection.trim().length === 0) {
                    new Notice(plugin.t.messages.noSelection || 'Please select text to highlight');
                    return;
                }

                applyHighlight(editor, selection, color);
            }
        });
    }

    // Command: Remove highlight from selection
    plugin.addCommand({
        id: 'remove-highlight',
        name: plugin.t.commands.removeHighlight || 'Remove highlight',
        icon: 'eraser',
        editorCallback: (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
            const selection = editor.getSelection();

            if (!selection || selection.trim().length === 0) {
                new Notice(plugin.t.messages.noSelection || 'Please select text to remove highlight');
                return;
            }

            removeHighlight(editor, selection);
        }
    });

    // Context menu registration moved to src/ui/contextMenu.ts
}

/**
 * Apply highlight to selected text
 */
function applyHighlight(editor: Editor, selection: string, color: HighlightColor): void {
    if (color.id === 'clear') {
        removeHighlight(editor, selection);
        return;
    }

    // Check if already highlighted and remove existing highlight first
    const cleanedSelection = stripExistingHighlight(selection);

    // Use HTML mark tag with inline style for custom colors
    // This provides the most flexibility and works in both edit and preview modes
    const highlighted = `<mark class="ao-highlight ao-highlight-${color.id}">${cleanedSelection}</mark>`;

    editor.replaceSelection(highlighted);
}

/**
 * Remove highlight from selected text
 */
function removeHighlight(editor: Editor, selection: string): void {
    const cleanedSelection = stripExistingHighlight(selection);
    editor.replaceSelection(cleanedSelection);
}

/**
 * Strip existing highlight markup from text
 */
export function stripExistingHighlight(text: string): string {
    // Remove our custom mark tags
    let cleaned = text.replace(/<mark[^>]*class="ao-highlight[^"]*"[^>]*>([\s\S]*?)<\/mark>/gi, '$1');

    // Also remove generic mark tags
    cleaned = cleaned.replace(/<mark[^>]*>([\s\S]*?)<\/mark>/gi, '$1');

    // Remove Obsidian's native highlight syntax ==text==
    cleaned = cleaned.replace(/==([\s\S]*?)==/g, '$1');

    return cleaned;
}
