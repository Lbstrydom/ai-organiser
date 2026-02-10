/**
 * Companion Output Utilities
 * Handles Study persona companion note creation alongside summaries.
 * Never throws — errors are caught and surfaced as Notice.
 */

import { Notice, TFile } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { ensureFolderExists, getAvailableFilePath } from './minutesUtils';

/** Study persona ID — the only persona that supports companion output. */
const STUDY_PERSONA_ID = 'study';

/**
 * Centralized predicate: should companion output be generated?
 * Hard-guards companion to Study persona at the code level.
 * Three conditions must ALL be true:
 *   1. The global `enableStudyCompanion` setting is on (default: true for backward compat)
 *   2. The user toggled `includeCompanion` in the modal
 *   3. The selected persona is `study`
 */
export function shouldIncludeCompanion(
    personaId: string | undefined,
    includeCompanion: boolean | undefined,
    enableStudyCompanion?: boolean
): boolean {
    if (enableStudyCompanion === false) return false;
    return includeCompanion === true && personaId === STUDY_PERSONA_ID;
}

/**
 * Process companion output from an LLM response.
 * Creates a companion note if companion content is present.
 * Never throws — errors are logged and shown as Notice.
 *
 * @param plugin - Plugin instance (for vault access, translations)
 * @param companionContent - The extracted companion text (may be undefined/empty)
 * @param originalFile - The TFile of the note being summarized
 * @returns Path to the created companion file, or null
 */
export async function processCompanionOutput(
    plugin: AIOrganiserPlugin,
    companionContent: string | undefined,
    originalFile: TFile
): Promise<string | null> {
    if (!companionContent || companionContent.trim().length === 0) {
        return null;
    }

    try {
        const vault = plugin.app.vault;
        const folderPath = originalFile.parent?.path ?? '';
        const fileName = `${originalFile.basename} (Study Companion).md`;

        await ensureFolderExists(vault, folderPath);
        const filePath = await getAvailableFilePath(vault, folderPath, fileName);

        // Build frontmatter with path-safe wikilink to avoid basename ambiguity
        const frontmatter = [
            '---',
            `companion_to: "[[${originalFile.path}|${originalFile.basename}]]"`,
            '---',
            '',
        ].join('\n');

        const content = frontmatter + companionContent;

        await vault.create(filePath, content);
        new Notice(plugin.t.messages.companionCreated);

        return filePath;
    } catch (error) {
        console.error('[AI Organiser] Failed to create companion note:', error);
        new Notice(plugin.t.messages.companionCreateFailed);
        return null;
    }
}
