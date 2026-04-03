/**
 * Research Commands
 *
 * Registers the research-web command that opens the unified chat modal
 * in research mode.
 */

import type AIOrganiserPlugin from '../main';
import { UnifiedChatModal } from '../ui/modals/UnifiedChatModal';

export function registerResearchCommands(plugin: AIOrganiserPlugin): void {
    plugin.addCommand({
        id: 'research-web',
        name: (plugin.t.commands as any).researchWeb || 'Research',
        icon: 'telescope',
        callback: async () => {
            const activeEditor = plugin.app.workspace.activeEditor?.editor;
            const activeFile = plugin.app.workspace.getActiveFile();
            const content = activeEditor?.getValue() || undefined;
            const selection = activeEditor?.getSelection() || undefined;

            const modal = new UnifiedChatModal(plugin.app, plugin as any, {
                noteContent: content,
                noteTitle: activeFile?.basename,
                editorSelection: selection,
                initialMode: 'research',
            });
            modal.open();
        },
    });
}
