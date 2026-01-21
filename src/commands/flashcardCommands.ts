/**
 * Flashcard Commands
 * Commands for generating and exporting flashcards from notes
 */

import { Notice, TFile, normalizePath } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { FlashcardExportModal, FlashcardExportResult } from '../ui/modals/FlashcardExportModal';
import {
    buildFlashcardPrompt,
    validateFlashcardCSV,
    cardsToCSV,
    type FlashcardFormat
} from '../services/prompts/flashcardPrompts';

/**
 * Register flashcard-related commands
 */
export function registerFlashcardCommands(plugin: AIOrganiserPlugin): void {
    // Export flashcards from current note
    plugin.addCommand({
        id: 'export-flashcards',
        name: plugin.t.commands.exportFlashcards || 'Export flashcards from current note',
        icon: 'layers',
        callback: () => exportFlashcardsFromCurrentNote(plugin)
    });
}

/**
 * Export flashcards from the current note
 */
async function exportFlashcardsFromCurrentNote(plugin: AIOrganiserPlugin): Promise<void> {
    const activeFile = plugin.app.workspace.getActiveFile();

    if (!activeFile) {
        new Notice(plugin.t.messages.openNoteFirst || 'Please open a note first');
        return;
    }

    // Read note content
    const content = await plugin.app.vault.read(activeFile);

    if (!content.trim()) {
        new Notice(plugin.t.messages.noContentToAnalyze || 'Note has no content to analyze');
        return;
    }

    // Show export modal
    new FlashcardExportModal(
        plugin.app,
        plugin.t,
        async (result: FlashcardExportResult) => {
            await generateAndExportFlashcards(plugin, content, activeFile, result);
        }
    ).open();
}

/**
 * Generate flashcards using LLM and export to file
 */
async function generateAndExportFlashcards(
    plugin: AIOrganiserPlugin,
    content: string,
    sourceFile: TFile,
    options: FlashcardExportResult
): Promise<void> {
    const { format, style, context } = options;
    const t = plugin.t.messages;

    // Show progress notice
    const progressNotice = new Notice(
        t.generatingFlashcards || 'Generating flashcards...',
        0 // Don't auto-dismiss
    );

    try {
        // Build the prompt
        const prompt = buildFlashcardPrompt(
            content,
            format,
            context,
            plugin.settings.summaryLanguage || undefined,
            style
        );

        // Call LLM using the summarizeText method (same approach as summarizeCommands.ts)
        const response = await callLLMForFlashcards(plugin, prompt);

        if (!response.success || !response.content) {
            throw new Error(response.error || 'Empty response from LLM');
        }

        // Clean up the response - remove any markdown code blocks if present
        let csvContent = response.content.trim();
        if (csvContent.startsWith('```')) {
            csvContent = csvContent.replace(/^```(?:csv)?\n?/, '').replace(/\n?```$/, '');
        }

        // Validate the CSV output
        const validation = validateFlashcardCSV(csvContent);

        if (!validation.valid || validation.cardCount === 0) {
            progressNotice.hide();
            const errorMsg = validation.errors.length > 0
                ? validation.errors.slice(0, 3).join('; ')
                : 'No valid flashcards generated';
            new Notice(
                `${t.flashcardGenerationFailed || 'Failed to generate flashcards'}: ${errorMsg}`,
                5000
            );
            return;
        }

        // Re-serialize to ensure proper CSV formatting
        const finalCSV = cardsToCSV(validation.cards);

        // Save to file
        const filePath = await saveFlashcardFile(plugin, sourceFile, format, finalCSV);

        progressNotice.hide();
        new Notice(
            `${t.flashcardsExported || 'Exported'} ${validation.cardCount} ${t.flashcardsTo || 'flashcards to'} ${filePath}`,
            5000
        );

    } catch (error) {
        progressNotice.hide();
        console.error('[AI Organiser] Flashcard generation error:', error);
        new Notice(
            `${t.flashcardGenerationFailed || 'Failed to generate flashcards'}: ${error instanceof Error ? error.message : 'Unknown error'}`,
            5000
        );
    }
}

/**
 * Save flashcard CSV to the configured folder
 */
async function saveFlashcardFile(
    plugin: AIOrganiserPlugin,
    sourceFile: TFile,
    format: FlashcardFormat,
    csvContent: string
): Promise<string> {
    // Build full path: pluginFolder/flashcardFolder
    const pluginFolder = plugin.settings.pluginFolder || 'AI-Organiser';
    const flashcardSubfolder = plugin.settings.flashcardFolder || 'Flashcards';
    const folder = `${pluginFolder}/${flashcardSubfolder}`;

    // Ensure plugin folder exists first
    const pluginFolderPath = normalizePath(pluginFolder);
    if (!plugin.app.vault.getAbstractFileByPath(pluginFolderPath)) {
        await plugin.app.vault.createFolder(pluginFolderPath);
    }

    // Ensure flashcard folder exists
    const folderPath = normalizePath(folder);
    if (!plugin.app.vault.getAbstractFileByPath(folderPath)) {
        await plugin.app.vault.createFolder(folderPath);
    }

    // Generate filename from source note
    const baseName = sourceFile.basename;
    const timestamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const formatSuffix = format.id; // 'anki' or 'brainscape'
    const fileName = `${baseName} - ${formatSuffix} - ${timestamp}.${format.fileExtension}`;
    const filePath = normalizePath(`${folder}/${fileName}`);

    // Check if file exists, add suffix if needed
    let finalPath = filePath;
    let counter = 1;
    while (plugin.app.vault.getAbstractFileByPath(finalPath)) {
        finalPath = normalizePath(`${folder}/${baseName} - ${formatSuffix} - ${timestamp} (${counter}).${format.fileExtension}`);
        counter++;
    }

    // Create the file
    await plugin.app.vault.create(finalPath, csvContent);

    return finalPath;
}

/**
 * Call LLM service to generate flashcards
 * Uses the same pattern as summarizeCommands.ts
 */
async function callLLMForFlashcards(
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
