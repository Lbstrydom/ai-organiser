import { actionName } from '../core/actionRegistry';
import { Editor, MarkdownFileInfo, MarkdownView, Notice } from 'obsidian';
import AIOrganiserPlugin from '../main';
import { SketchPadModal } from '../ui/modals/SketchPadModal';

export function registerSketchCommands(plugin: AIOrganiserPlugin): void {
    plugin.addCommand({
        id: 'new-sketch',
        name: actionName(plugin.t, 'new-sketch'),
        icon: 'pencil',
        editorCallback: (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
            const view = ctx instanceof MarkdownView ? ctx : null;
            if (!view) {
                new Notice(plugin.t.messages.openNoteFirst || 'Open a note first');
                return;
            }
            new SketchPadModal(plugin, editor).open();
        }
    });
}

