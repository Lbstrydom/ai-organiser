/**
 * Chunking Service for NotebookLM Source Packs
 * 
 * Partitions sanitised notes into modules based on word budget.
 * Ensures each module stays within NotebookLM limits.
 */

import { SanitisedNote, ModuleContent, PackEntry } from './types';

/**
 * Partition notes into modules based on word budget
 * @param sanitisedNotes Array of sanitised notes
 * @param maxWordsPerModule Maximum words per module
 * @returns Array of module contents
 */
export function chunkNotesIntoModules(
    sanitisedNotes: SanitisedNote[],
    maxWordsPerModule: number
): ModuleContent[] {
    const modules: ModuleContent[] = [];
    let currentModule: ModuleContent | null = null;
    let currentWords = 0;
    let moduleNumber = 1;

    for (const note of sanitisedNotes) {
        // Check if note fits in current module
        if (currentModule && currentWords + note.wordCount <= maxWordsPerModule) {
            // Add to current module
            currentModule.noteContents.push(formatNoteWithAnchor(note));
            currentModule.wordCount += note.wordCount;
            currentModule.byteCount += note.byteCount;
            currentModule.entries.push(noteToPackEntry(note));
            currentWords += note.wordCount;
        } else {
            // Start new module
            if (currentModule) {
                modules.push(currentModule);
            }

            currentModule = {
                moduleNumber,
                fileName: `module_${String(moduleNumber).padStart(2, '0')}.md`,
                noteContents: [formatNoteWithAnchor(note)],
                wordCount: note.wordCount,
                byteCount: note.byteCount,
                entries: [noteToPackEntry(note)]
            };
            currentWords = note.wordCount;
            moduleNumber++;
        }
    }

    // Add final module
    if (currentModule) {
        modules.push(currentModule);
    }

    return modules;
}

/**
 * Format note with stable anchor for traceability
 * @param note Sanitised note
 * @returns Markdown content with anchor
 */
function formatNoteWithAnchor(note: SanitisedNote): string {
    const parts: string[] = [];

    // Anchor header
    parts.push(`## Note: ${note.title} (id: ${note.shortId})`);
    parts.push('');

    // Metadata line
    const metadata = [
        `Source: ${note.filePath}`,
        `Words: ${note.wordCount}`,
        `ID: ${note.shortId}`
    ].join(' | ');
    parts.push(metadata);
    parts.push('');

    // Separator
    parts.push('---');
    parts.push('');

    // Content
    parts.push(note.content);
    parts.push('');
    parts.push(''); // Extra blank line between notes

    return parts.join('\n');
}

/**
 * Convert sanitised note to pack entry
 * @param note Sanitised note
 * @returns Pack entry
 */
function noteToPackEntry(note: SanitisedNote): PackEntry {
    return {
        filePath: note.filePath,
        title: note.title,
        mtime: new Date().toISOString(), // Use current time as export time
        tags: [], // Tags already stripped from frontmatter
        wordCount: note.wordCount,
        byteCount: note.byteCount,
        sha256: note.sha256,
        shortId: note.shortId
    };
}

/**
 * Estimate module count for preview
 * @param notes Array of notes
 * @param maxWordsPerModule Maximum words per module
 * @returns Estimated number of modules
 */
export function estimateModuleCount(
    notes: Array<{ wordCount: number }>,
    maxWordsPerModule: number
): number {
    let totalWords = notes.reduce((sum, note) => sum + note.wordCount, 0);
    return Math.ceil(totalWords / maxWordsPerModule);
}

/**
 * Check if module count exceeds NotebookLM limits
 * @param moduleCount Number of modules
 * @returns Warning message if limit exceeded, null otherwise
 */
export function checkModuleLimits(moduleCount: number): string | null {
    const MAX_SOURCES_PER_NOTEBOOK = 50;

    if (moduleCount > MAX_SOURCES_PER_NOTEBOOK) {
        return `⚠️ Module count (${moduleCount}) exceeds NotebookLM's limit of ${MAX_SOURCES_PER_NOTEBOOK} sources per notebook. Consider increasing the word budget per module or reducing your selection.`;
    }

    if (moduleCount > MAX_SOURCES_PER_NOTEBOOK * 0.8) {
        return `⚠️ Module count (${moduleCount}) is approaching NotebookLM's limit of ${MAX_SOURCES_PER_NOTEBOOK} sources. You may want to increase the word budget per module.`;
    }

    return null;
}

/**
 * Check if module word count exceeds limits
 * @param maxWordsPerModule Maximum words per module
 * @returns Warning message if limit exceeded, null otherwise
 */
export function checkModuleWordLimit(maxWordsPerModule: number): string | null {
    const MAX_WORDS_PER_SOURCE = 500000;

    if (maxWordsPerModule > MAX_WORDS_PER_SOURCE) {
        return `⚠️ Word budget per module (${maxWordsPerModule}) exceeds NotebookLM's limit of ${MAX_WORDS_PER_SOURCE} words per source. This will be capped at ${MAX_WORDS_PER_SOURCE}.`;
    }

    if (maxWordsPerModule > MAX_WORDS_PER_SOURCE * 0.8) {
        return `⚠️ Word budget per module (${maxWordsPerModule}) is approaching NotebookLM's limit of ${MAX_WORDS_PER_SOURCE} words per source.`;
    }

    return null;
}

/**
 * Validate export parameters and generate warnings
 * @param noteCount Number of notes
 * @param totalWords Total word count
 * @param maxWordsPerModule Maximum words per module
 * @returns Array of warning messages
 */
export function validateExportParameters(
    noteCount: number,
    totalWords: number,
    maxWordsPerModule: number
): string[] {
    const warnings: string[] = [];

    // Check module count
    const estimatedModules = Math.ceil(totalWords / maxWordsPerModule);
    const moduleLimitWarning = checkModuleLimits(estimatedModules);
    if (moduleLimitWarning) {
        warnings.push(moduleLimitWarning);
    }

    // Check word budget
    const wordLimitWarning = checkModuleWordLimit(maxWordsPerModule);
    if (wordLimitWarning) {
        warnings.push(wordLimitWarning);
    }

    // Check total size estimate (rough)
    const estimatedMB = (totalWords * 6) / (1024 * 1024); // ~6 bytes per word
    const MAX_MB_PER_SOURCE = 200;
    if (estimatedMB / estimatedModules > MAX_MB_PER_SOURCE) {
        warnings.push(`⚠️ Estimated size per module (~${(estimatedMB / estimatedModules).toFixed(1)}MB) may exceed NotebookLM's 200MB per source limit.`);
    }

    return warnings;
}

/**
 * Auto-determine export mode based on selection
 * @param noteCount Number of notes
 * @param totalWords Total word count
 * @param maxWordsPerModule Maximum words per module
 * @returns Recommended export mode
 */
export function autoSelectExportMode(
    noteCount: number,
    totalWords: number,
    maxWordsPerModule: number
): 'single' | 'modular' {
    // If total words fit in one module, use single
    if (totalWords <= maxWordsPerModule) {
        return 'single';
    }

    // Otherwise, use modular
    return 'modular';
}
