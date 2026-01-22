/**
 * Translate Commands
 * Commands for translating note content
 */

import { Editor, Notice } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { TranslateModal } from '../ui/modals/TranslateModal';
import { buildTranslatePrompt, insertContentIntoTranslatePrompt } from '../services/prompts/translatePrompts';
import { replaceMainContent, ensureNoteStructureIfEnabled } from '../utils/noteStructure';

export function registerTranslateCommands(plugin: AIOrganiserPlugin): void {
    // Command: Translate (smart dispatcher)
    plugin.addCommand({
        id: 'smart-translate',
        name: plugin.t.commands.translate || plugin.t.commands.translateNote || 'Translate',
        icon: 'languages',
        editorCallback: async (editor: Editor) => {
            const selection = editor.getSelection();
            const hasSelection = !!selection.trim();
            const content = editor.getValue();

            if (!content.trim()) {
                new Notice(plugin.t.messages.noContent);
                return;
            }

            const modal = new TranslateModal(
                plugin.app,
                plugin.t,
                async (result) => {
                    if (hasSelection) {
                        await translateSelection(plugin, editor, selection, result.targetLanguageName);
                        return;
                    }

                    await translateNote(
                        plugin,
                        editor,
                        content,
                        result.targetLanguageName,
                        plugin.t.messages.translatingFullNote
                    );
                }
            );
            modal.open();
        }
    });
}

/**
 * Translate entire note content
 */
async function translateNote(
    plugin: AIOrganiserPlugin,
    editor: Editor,
    content: string,
    targetLanguage: string,
    noticeMessage?: string
): Promise<void> {
    new Notice(noticeMessage || plugin.t.messages.translating || 'Translating...');

    const promptTemplate = buildTranslatePrompt({ targetLanguage });
    const prompt = insertContentIntoTranslatePrompt(promptTemplate, content);

    try {
        const response = await translateWithLLM(plugin, prompt);

        if (response.success && response.content) {
            // Replace main content while preserving References and Pending Integration sections
            replaceMainContent(editor, response.content);

            // Ensure standard structure exists after translation
            ensureNoteStructureIfEnabled(editor, plugin.settings);

            new Notice(plugin.t.messages.translationComplete || 'Translation complete');
        } else {
            new Notice(`Translation failed: ${response.error || 'Unknown error'}`);
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        new Notice(`Error translating: ${errorMessage}`);
    }
}

/**
 * Translate selected text
 */
async function translateSelection(
    plugin: AIOrganiserPlugin,
    editor: Editor,
    selection: string,
    targetLanguage: string
): Promise<void> {
    new Notice(plugin.t.messages.translating || 'Translating...');

    const promptTemplate = buildTranslatePrompt({ targetLanguage });
    const prompt = insertContentIntoTranslatePrompt(promptTemplate, selection);

    try {
        const response = await translateWithLLM(plugin, prompt);

        if (response.success && response.content) {
            // Replace selection with translated content
            editor.replaceSelection(response.content);
            ensureNoteStructureIfEnabled(editor, plugin.settings);
            new Notice(plugin.t.messages.translationComplete || 'Translation complete');
        } else {
            new Notice(`Translation failed: ${response.error || 'Unknown error'}`);
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        new Notice(`Error translating: ${errorMessage}`);
    }
}

/**
 * Call LLM service for translation
 */
async function translateWithLLM(
    plugin: AIOrganiserPlugin,
    prompt: string
): Promise<{ success: boolean; content?: string; error?: string }> {
    try {
        if (plugin.settings.serviceType === 'cloud') {
            const { CloudLLMService } = await import('../services/cloudService');
            const cloudService = plugin.llmService as InstanceType<typeof CloudLLMService>;
            return await cloudService.summarizeText(prompt);
        } else {
            const { LocalLLMService } = await import('../services/localService');
            const localService = plugin.llmService as InstanceType<typeof LocalLLMService>;
            return await localService.summarizeText(prompt);
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return { success: false, error: errorMessage };
    }
}
