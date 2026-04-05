/**
 * Context Menu Handler
 * Centralized right-click context menu registration for all plugin items.
 * Two independent guards:
 *   1. Selection-based items: Highlight, Ask AI, Translate, Add to Pending
 *   2. Cursor-position items: Digitise (when cursor is on an image embed line)
 */

import { Editor, MarkdownView, MarkdownFileInfo, Menu } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { HighlightColorModal, HighlightColor } from '../ui/modals/HighlightColorModal';
import { stripExistingHighlight } from '../commands/highlightCommands';
import { translateSelectionFromMenu } from '../commands/translateCommands';
import { openChatWithSelection } from '../commands/chatCommands';
import { dropSelectionToPending } from '../commands/integrationCommands';
import { quickPeekFromSelection } from '../commands/quickPeekCommands';
import { cursorInsideMermaidFence } from '../utils/mermaidUtils';
import { detectEmbeddedContent, getQuickPeekSources } from '../utils/embeddedContentDetector';

/** Image extensions for embed detection (without dots) */
const IMAGE_EXTS = new Set(['png','jpg','jpeg','gif','webp','bmp','svg','heic','heif','tiff','tif','avif']);

/** Check if a line contains an image embed (![[file.ext]] or ![](file.ext)) */
export function lineHasImageEmbed(line: string): boolean {
    // Wiki-link: ![[anything.ext]]
    const wiki = /!\[\[(.+?)\]\]/.exec(line);
    if (wiki) {
        const ext = wiki[1].split('.').pop()?.toLowerCase();
        if (ext && IMAGE_EXTS.has(ext)) return true;
    }
    // Markdown: ![...](path.ext)
    const md = /!\[.*?\]\(([^)]+)\)/.exec(line);
    if (md) {
        const ext = md[1].split('.').pop()?.toLowerCase();
        if (ext && IMAGE_EXTS.has(ext)) return true;
    }
    return false;
}

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
 * Check if cursor line contains an image embed
 */
export function cursorOnImageEmbed(editor: Editor): boolean {
    const cursor = editor.getCursor();
    const line = editor.getLine(cursor.line);
    return lineHasImageEmbed(line);
}

function openHighlightModal(plugin: AIOrganiserPlugin, editor: Editor, selection: string): void {
    new HighlightColorModal(
        plugin.app, plugin.t,
        (color) => applyHighlightFromMenu(editor, selection, color)
    ).open();
}

// ── Quick Peek helpers (extracted to keep registerContextMenu CC ≤ 15) ──────

function addQuickPeekSelectionItem(
    plugin: AIOrganiserPlugin,
    editor: Editor,
    view: MarkdownView | MarkdownFileInfo,
    menu: Menu
): void {
    const currentFile = view instanceof MarkdownView ? view.file : null;
    // editor lines are 0-based; detected lineNumbers are 1-based → add 1
    const from = editor.getCursor('from').line + 1;
    const to = editor.getCursor('to').line + 1;
    const detected = detectEmbeddedContent(plugin.app, editor.getValue(), currentFile ?? undefined);
    const inSelection = getQuickPeekSources(detected).filter(s => s.lineNumber >= from && s.lineNumber <= to);
    if (inSelection.length === 0) return;
    menu.addItem((item) => {
        item.setTitle(plugin.t.contextMenu.quickPeek || 'Quick Peek')
            .setIcon('zap')
            .onClick(() => quickPeekFromSelection(plugin, editor, inSelection));
    });
}

function addQuickPeekCursorItem(
    plugin: AIOrganiserPlugin,
    editor: Editor,
    view: MarkdownView | MarkdownFileInfo,
    menu: Menu
): void {
    const currentFile = view instanceof MarkdownView ? view.file : null;
    // editor lines are 0-based; detected lineNumbers are 1-based → add 1
    const cursorLine = editor.getCursor().line + 1;
    const detected = detectEmbeddedContent(plugin.app, editor.getValue(), currentFile ?? undefined);
    const onLine = getQuickPeekSources(detected).filter(s => s.lineNumber === cursorLine);
    if (onLine.length === 0) return;
    menu.addItem((item) => {
        item.setTitle(plugin.t.contextMenu.quickPeek || 'Quick Peek')
            .setIcon('zap')
            .onClick(() => quickPeekFromSelection(plugin, editor, onLine));
    });
}

/**
 * Register the centralized editor context menu handler.
 * All plugin right-click items are registered here.
 */
export function registerContextMenu(plugin: AIOrganiserPlugin): void {
    plugin.registerEvent(
        plugin.app.workspace.on('editor-menu', (menu: Menu, editor: Editor, view: MarkdownView | MarkdownFileInfo) => {
            const selection = editor.getSelection();
            const hasSelection = selection && selection.trim().length > 0;

            // ── Guard 1: Selection-based items ───────────────────────
            if (hasSelection) {
                menu.addItem((item) => {
                    item.setTitle(plugin.t.commands.highlightSelection || 'Highlight')
                        .setIcon('highlighter')
                        .onClick(() => openHighlightModal(plugin, editor, selection));
                });

                if (selection.length <= 5000) {
                    const stripped = stripExistingHighlight(selection);
                    if (stripped !== selection) {
                        menu.addItem((item) => {
                            item.setTitle(plugin.t.commands.removeHighlight || 'Remove highlight')
                                .setIcon('eraser')
                                .onClick(() => { editor.replaceSelection(stripped); });
                        });
                    }
                }

                menu.addItem((item) => {
                    item.setTitle(plugin.t.contextMenu.askAI || 'Ask AI')
                        .setIcon('sparkles')
                        .onClick(() => { openChatWithSelection(plugin, editor); });
                });

                menu.addItem((item) => {
                    item.setTitle(plugin.t.contextMenu.translate || 'Translate')
                        .setIcon('languages')
                        .onClick(() => { translateSelectionFromMenu(plugin, editor); });
                });

                menu.addSeparator();

                menu.addItem((item) => {
                    item.setTitle(plugin.t.contextMenu.addToPending || 'Add to Pending')
                        .setIcon('inbox')
                        .onClick(() => { dropSelectionToPending(plugin, editor); });
                });

                // Guard A: Quick Peek — selection contains links
                addQuickPeekSelectionItem(plugin, editor, view, menu);
            }

            // ── Guard 2: Cursor-position items (no selection required) ──
            const onImage = cursorOnImageEmbed(editor);
            const onMermaid = cursorInsideMermaidFence(editor.getValue(), editor.getCursor().line);

            if (onImage || onMermaid) {
                if (hasSelection) menu.addSeparator();
                if (onImage) {
                    menu.addItem((item) => {
                        item.setTitle(plugin.t.contextMenu.digitise || 'AI: Digitise')
                            .setIcon('sparkles')
                            .onClick(() => {
                                (plugin.app as import('obsidian').App & { commands: { executeCommandById: (id: string) => void } }).commands.executeCommandById('ai-organiser:digitise-image');
                            });
                    });
                }
                if (onMermaid) {
                    menu.addItem((item) => {
                        item.setTitle(plugin.t.contextMenu.editDiagram || 'AI: Edit Diagram')
                            .setIcon('git-branch')
                            .onClick(() => {
                                (plugin.app as import('obsidian').App & { commands: { executeCommandById: (id: string) => void } }).commands.executeCommandById('ai-organiser:edit-mermaid-diagram');
                            });
                    });
                }
            }

            // Guard B: Quick Peek — cursor on a link line (no selection)
            if (!hasSelection) {
                addQuickPeekCursorItem(plugin, editor, view, menu);
            }
        })
    );
}
