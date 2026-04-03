import { Editor, MarkdownFileInfo, MarkdownView, Notice } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import type { DetectedContent } from '../utils/embeddedContentDetector';
import { detectEmbeddedContent, getQuickPeekSources } from '../utils/embeddedContentDetector';
import { QuickPeekModal } from '../ui/modals/QuickPeekModal';

export function registerQuickPeekCommands(plugin: AIOrganiserPlugin): void {
    plugin.addCommand({
        id: 'quick-peek',
        name: plugin.t.commands.quickPeek,
        icon: 'zap',
        editorCallback: (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
            const file = ctx.file;
            const fullContent = editor.getValue();
            const allDetected = detectEmbeddedContent(plugin.app, fullContent, file ?? undefined);
            const allSources = getQuickPeekSources(allDetected);

            // Smart dispatch: if there's a selection, scope to selected lines
            const selection = editor.getSelection();
            let sources = allSources;
            if (selection) {
                // editor lines are 0-based; detected lineNumbers are 1-based → add 1
                const from = editor.getCursor('from').line + 1;
                const to = editor.getCursor('to').line + 1;
                sources = allSources.filter(s => s.lineNumber >= from && s.lineNumber <= to);
            }

            if (sources.length === 0) {
                new Notice(plugin.t.commands.quickPeekNoSources);
                return;
            }

            new QuickPeekModal(plugin, sources, editor).open();
        }
    });
}

/**
 * Open Quick Peek modal with a pre-scoped list of sources (Phase 2 context menu).
 * Called directly from contextMenu.ts with already-filtered items.
 */
export function quickPeekFromSelection(
    plugin: AIOrganiserPlugin,
    editor: Editor,
    items: DetectedContent[]
): void {
    new QuickPeekModal(plugin, items, editor).open();
}
