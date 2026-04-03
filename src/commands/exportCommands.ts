import { Notice } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { ExportModal } from '../ui/modals/ExportModal';

export function registerExportCommands(plugin: AIOrganiserPlugin): void {
    plugin.addCommand({
        id: 'export-note',
        name: plugin.t.commands.exportNote || 'Export note as\u2026',
        icon: 'file-output',
        callback: () => {
            const activeFile = plugin.app.workspace.getActiveFile();
            const initialNotes = activeFile ? [activeFile] : [];

            if (initialNotes.length === 0) {
                new Notice(plugin.t.messages.openNoteFirst || 'Please open a note first');
            }

            const modal = new ExportModal(plugin.app, plugin, initialNotes);
            modal.open();
        },
    });
}
