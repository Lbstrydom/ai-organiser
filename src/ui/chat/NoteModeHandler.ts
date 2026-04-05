import { buildNoteChatPrompt } from '../../services/prompts';
import type { ChatModeHandler, ModalContext } from './ChatModeHandler';
import type { Translations } from '../../i18n/types';

export class NoteModeHandler implements ChatModeHandler {
    readonly mode = 'note' as const;

    isAvailable(ctx: ModalContext): boolean {
        return !!ctx.options.noteContent?.trim();
    }

    unavailableReason(t: Translations): string {
        return t.modals.unifiedChat.noteUnavailable;
    }

    getIntroMessage(t: Translations): string {
        return t.modals.unifiedChat.introNote;
    }

    getPlaceholder(t: Translations): string {
        return t.modals.unifiedChat.placeholderNote || t.modals.unifiedChat.placeholder;
    }

    renderContextPanel(container: HTMLElement, ctx: ModalContext): void {
        const t = ctx.plugin.t.modals.unifiedChat;
        const title = ctx.options.noteTitle || t.modeNote;
        container.createEl('div', {
            cls: 'ai-organiser-chat-context-line',
            text: t.discussingNote.replace('{title}', title)
        });
    }

    buildPrompt(query: string, history: string, ctx: ModalContext) {
        const t = ctx.plugin.t.modals.unifiedChat;
        const noteTitle = ctx.options.noteTitle || t.modeNote;
        const noteContent = ctx.options.noteContent || '';
        return Promise.resolve({
            prompt: buildNoteChatPrompt(query, noteContent, noteTitle, history)
        });
    }

    getActionDescriptors(_t: Translations): [] {
        return [];
    }

    dispose(): void {
        // No-op
    }
}
