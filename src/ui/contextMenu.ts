/**
 * Context Menu Handler
 * Centralized right-click context menu registration for all plugin items.
 * Contributes the editor's right-click items to the one AI Organiser section
 * (src/ui/pluginMenu.ts): selection items (Highlight, Ask AI, Translate, Add to pending) and
 * cursor items (Digitise on an image line, Edit diagram in a mermaid fence, Quick peek on a source).
 */

import { type App, Editor, TFile } from 'obsidian';
import { addMenuProvider, type MenuContribution } from './pluginMenu';
import type AIOrganiserPlugin from '../main';
import { HighlightColorModal, HighlightColor } from '../ui/modals/HighlightColorModal';
import { stripExistingHighlight } from '../commands/highlightCommands';
import { translateSelectionFromMenu } from '../commands/translateCommands';
import { openChatWithSelection } from '../commands/chatCommands';
import { dropSelectionToPending } from '../commands/integrationCommands';
import { quickPeekFromSelection } from '../commands/quickPeekCommands';
import { cursorInsideMermaidFence } from '../utils/mermaidUtils';
import { detectEmbeddedContent, getQuickPeekSources } from '../utils/embeddedContentDetector';
import { isFeatureEnabled } from '../services/featureService';

import { guardActiveNote } from '../utils/protectedGuard';
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
        if (!guardActiveNote(editor)) return;
        editor.replaceSelection(cleaned);
        return;
    }
    const cleanedSelection = stripExistingHighlight(selection);
    const highlighted = `<mark class="ao-highlight ao-highlight-${color.id}">${cleanedSelection}</mark>`;
    if (!guardActiveNote(editor)) return;
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

// ── Editor contributions to the AI Organiser section ─────────────────────────

const runCommand = (plugin: AIOrganiserPlugin, id: string): void => {
    (plugin.app as App & { commands: { executeCommandById: (id: string) => void } }).commands.executeCommandById(`ai-organiser:${id}`);
};

/** Quick peek: the sources inside the selection, or on the cursor line when nothing is selected. */
function quickPeekContribution(plugin: AIOrganiserPlugin, editor: Editor, file: TFile | null, hasSelection: boolean): MenuContribution[] {
    if (!isFeatureEnabled(plugin.settings, 'quick-peek')) return [];
    // editor lines are 0-based; detected lineNumbers are 1-based → add 1
    const from = editor.getCursor('from').line + 1;
    const to = editor.getCursor('to').line + 1;
    const cursorLine = editor.getCursor().line + 1;
    const detected = detectEmbeddedContent(plugin.app, editor.getValue(), file ?? undefined);
    const sources = getQuickPeekSources(detected).filter((src) => (hasSelection
        ? src.lineNumber >= from && src.lineNumber <= to
        : src.lineNumber === cursorLine));
    if (sources.length === 0) return [];
    return [{ id: 'quick-peek', title: plugin.t.contextMenu.quickPeek || 'Quick peek', icon: 'zap', priority: 'cursor', run: () => quickPeekFromSelection(plugin, editor, sources) }];
}

/**
 * Everything the editor right-click offers, as contributions. All of it is specific to the
 * selection or the cursor, so it is all `cursor` priority: it comes first in the section.
 * Each item gates inline by its owning feature (Gemini-G2).
 */
export function editorContributions(plugin: AIOrganiserPlugin, editor: Editor, file: TFile | null): MenuContribution[] {
    const out: MenuContribution[] = [];
    const selection = editor.getSelection();
    const hasSelection = !!selection && selection.trim().length > 0;
    const t = plugin.t;
    if (hasSelection) {
        if (isFeatureEnabled(plugin.settings, 'smart-note')) {
            out.push({ id: 'highlight-selection', title: t.commands.highlightSelection || 'Highlight', icon: 'highlighter', priority: 'cursor', run: () => openHighlightModal(plugin, editor, selection) });
            if (selection.length <= 5000) {
                const stripped = stripExistingHighlight(selection);
                if (stripped !== selection) {
                    out.push({ id: 'remove-highlight', title: t.commands.removeHighlight || 'Remove highlight', icon: 'eraser', priority: 'cursor', run: () => { if (guardActiveNote(editor)) editor.replaceSelection(stripped); } });
                }
            }
        }
        out.push({ id: 'ask-ai-selection', title: t.contextMenu.askAI || 'Ask AI', icon: 'sparkles', priority: 'cursor', run: () => { openChatWithSelection(plugin, editor); } });
        if (isFeatureEnabled(plugin.settings, 'translate')) {
            out.push({ id: 'translate-selection', title: t.contextMenu.translate || 'Translate', icon: 'languages', priority: 'cursor', run: () => { translateSelectionFromMenu(plugin, editor); } });
        }
        if (isFeatureEnabled(plugin.settings, 'smart-note')) {
            out.push({ id: 'drop-selection-pending', title: t.contextMenu.addToPending || 'Add to pending', icon: 'inbox', priority: 'cursor', run: () => { dropSelectionToPending(plugin, editor); } });
        }
    }
    if (cursorOnImageEmbed(editor) && isFeatureEnabled(plugin.settings, 'digitisation')) {
        out.push({ id: 'digitise-image', title: t.contextMenu.digitise || 'AI: digitise', icon: 'sparkles', priority: 'cursor', run: () => runCommand(plugin, 'digitise-image') });
    }
    if (cursorInsideMermaidFence(editor.getValue(), editor.getCursor().line) && isFeatureEnabled(plugin.settings, 'mermaid-chat')) {
        out.push({ id: 'edit-mermaid-diagram', title: t.contextMenu.editDiagram || 'AI: edit diagram', icon: 'git-branch', priority: 'cursor', run: () => runCommand(plugin, 'edit-mermaid-diagram') });
    }
    out.push(...quickPeekContribution(plugin, editor, file, hasSelection));
    return out;
}

/**
 * Register the editor's contributions. Unconditional (cross-cutting); each item gates by its
 * feature. The menu itself is rendered once by src/ui/pluginMenu.ts.
 */
export function registerContextMenu(plugin: AIOrganiserPlugin): void {
    addMenuProvider(plugin, (target) => (target.kind === 'editor' ? editorContributions(plugin, target.editor, target.file) : []));
}
