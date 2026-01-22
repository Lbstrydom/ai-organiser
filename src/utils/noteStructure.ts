/**
 * Note Structure Utilities
 * Handles standard note sections: References and Pending Integration
 *
 * Standard structure:
 * [Main content]
 * ---
 * ## References
 * [Source citations]
 * ---
 * ## Pending Integration
 * [Content awaiting merge]
 */

import { Editor } from 'obsidian';
import { AIOrganiserSettings } from '../core/settings';

// Section markers
export const REFERENCES_HEADER = '## References';
export const PENDING_INTEGRATION_HEADER = '## Pending Integration';
export const SECTION_DIVIDER = '\n---\n';

export interface SectionLocation {
    found: boolean;
    startLine: number;
    endLine: number;      // Line before next section or end of document
    headerLine: number;   // The line with the ## header
}

export interface NoteStructure {
    references: SectionLocation;
    pendingIntegration: SectionLocation;
    mainContentEndLine: number;  // Last line of main content (before References)
}

/**
 * Find the location of a section header in the editor
 */
export function findSectionInEditor(editor: Editor, header: string): SectionLocation {
    const lineCount = editor.lineCount();
    let headerLine = -1;
    let endLine = lineCount - 1;

    // Find the header line
    for (let i = 0; i < lineCount; i++) {
        const line = editor.getLine(i).trim();
        if (line === header || line === header.trim()) {
            headerLine = i;
            break;
        }
    }

    if (headerLine === -1) {
        return { found: false, startLine: -1, endLine: -1, headerLine: -1 };
    }

    // Find where this section ends (next ## header or end of doc)
    for (let i = headerLine + 1; i < lineCount; i++) {
        const line = editor.getLine(i).trim();
        if (line.startsWith('## ')) {
            endLine = i - 1;
            break;
        }
    }

    return {
        found: true,
        startLine: headerLine + 1,  // First content line after header
        endLine,
        headerLine
    };
}

/**
 * Find the location of a section header in text content
 */
export function findSectionInText(content: string, header: string): SectionLocation {
    const lines = content.split('\n');
    let headerLine = -1;
    let endLine = lines.length - 1;

    // Find the header line
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === header || line === header.trim()) {
            headerLine = i;
            break;
        }
    }

    if (headerLine === -1) {
        return { found: false, startLine: -1, endLine: -1, headerLine: -1 };
    }

    // Find where this section ends (next ## header or end of doc)
    for (let i = headerLine + 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('## ')) {
            endLine = i - 1;
            break;
        }
    }

    return {
        found: true,
        startLine: headerLine + 1,
        endLine,
        headerLine
    };
}

/**
 * Analyze the note structure to find all standard sections
 */
export function analyzeNoteStructure(editor: Editor): NoteStructure {
    const references = findSectionInEditor(editor, REFERENCES_HEADER);
    const pendingIntegration = findSectionInEditor(editor, PENDING_INTEGRATION_HEADER);

    // Main content ends where References begins, or where Pending Integration begins,
    // or at the end if neither exists
    let mainContentEndLine = editor.lineCount() - 1;

    if (references.found) {
        // Look for divider above references
        mainContentEndLine = references.headerLine - 1;
        while (mainContentEndLine > 0 && editor.getLine(mainContentEndLine).trim() === '---') {
            mainContentEndLine--;
        }
    } else if (pendingIntegration.found) {
        mainContentEndLine = pendingIntegration.headerLine - 1;
        while (mainContentEndLine > 0 && editor.getLine(mainContentEndLine).trim() === '---') {
            mainContentEndLine--;
        }
    }

    return {
        references,
        pendingIntegration,
        mainContentEndLine
    };
}

/**
 * Source types for the References section
 */
export type SourceType =
    | 'audio'
    | 'video'
    | 'youtube'
    | 'web'
    | 'pdf'
    | 'transcript'
    | 'image'
    | 'note'
    | 'manual';

export interface SourceReference {
    type: SourceType;
    title: string;
    link: string;           // URL or [[wikilink]]
    date?: string;          // ISO date string
    author?: string;
    duration?: string;      // For audio/video
    isInternal: boolean;    // true for vault files, false for URLs
}

/**
 * Format a source reference for the References section
 */
export function formatSourceReference(source: SourceReference): string {
    const dateStr = source.date ? ` (${source.date})` : '';
    const authorStr = source.author ? ` by ${source.author}` : '';
    const durationStr = source.duration ? ` [${source.duration}]` : '';

    const typeLabels: Record<SourceType, string> = {
        audio: 'Audio',
        video: 'Video',
        youtube: 'YouTube',
        web: 'Web',
        pdf: 'PDF',
        transcript: 'Transcript',
        image: 'Image',
        note: 'Note',
        manual: 'Source'
    };

    const label = typeLabels[source.type];

    // Format link based on whether it's internal or external
    const formattedLink = source.isInternal
        ? `[[${source.link}]]`
        : `[${source.title}](${source.link})`;

    return `> **${label}:** ${formattedLink}${authorStr}${durationStr}${dateStr}`;
}

/**
 * Add a reference to the References section
 * Creates the section if it doesn't exist
 */
export function addToReferencesSection(
    editor: Editor,
    source: SourceReference
): void {
    const structure = analyzeNoteStructure(editor);
    const referenceText = formatSourceReference(source);

    if (structure.references.found) {
        // Add to existing References section
        const insertLine = structure.references.startLine;
        const insertPos = { line: insertLine, ch: 0 };

        // Check if there's already content, add newline if needed
        const existingFirstLine = editor.getLine(insertLine)?.trim();
        const prefix = existingFirstLine ? '' : '';
        const suffix = existingFirstLine ? '\n' : '\n';

        editor.replaceRange(prefix + referenceText + suffix, insertPos);
    } else {
        // Create References section
        // Insert before Pending Integration if it exists, otherwise at end
        let insertLine: number;
        let insertContent: string;

        if (structure.pendingIntegration.found) {
            // Insert before Pending Integration
            insertLine = structure.pendingIntegration.headerLine;
            // Go back past any dividers
            while (insertLine > 0 && editor.getLine(insertLine - 1).trim() === '---') {
                insertLine--;
            }
            insertContent = `${SECTION_DIVIDER}\n${REFERENCES_HEADER}\n\n${referenceText}\n`;
        } else {
            // Insert at end of document
            insertLine = editor.lineCount();
            insertContent = `${SECTION_DIVIDER}\n${REFERENCES_HEADER}\n\n${referenceText}\n`;
        }

        const insertPos = { line: insertLine, ch: 0 };
        editor.replaceRange(insertContent, insertPos);
    }
}

/**
 * Pending integration source with content
 */
export interface PendingSource {
    type: SourceType;
    title: string;
    date: string;
    content: string;
    link?: string;
}

/**
 * Format content for the Pending Integration section
 */
export function formatPendingContent(source: PendingSource): string {
    const dateStr = source.date ? ` (${source.date})` : '';
    const linkStr = source.link ? `\n> From: ${source.link}` : '';

    return `### Source: ${source.title}${dateStr}${linkStr}\n\n${source.content}\n`;
}

/**
 * Add content to the Pending Integration section
 * Creates the section if it doesn't exist
 */
export function addToPendingIntegration(
    editor: Editor,
    source: PendingSource
): void {
    const structure = analyzeNoteStructure(editor);
    const pendingContent = formatPendingContent(source);

    if (structure.pendingIntegration.found) {
        // Add to existing Pending Integration section
        const insertLine = structure.pendingIntegration.startLine;
        const insertPos = { line: insertLine, ch: 0 };

        // Check if there's already content
        const existingFirstLine = editor.getLine(insertLine)?.trim();
        const suffix = existingFirstLine ? '\n' : '\n';

        editor.replaceRange(pendingContent + suffix, insertPos);
    } else {
        // Create Pending Integration section at end
        const insertLine = editor.lineCount();
        const insertContent = `${SECTION_DIVIDER}\n${PENDING_INTEGRATION_HEADER}\n\n${pendingContent}`;

        const insertPos = { line: insertLine, ch: 0 };
        editor.replaceRange(insertContent, insertPos);
    }
}

/**
 * Get the content of the Pending Integration section
 */
export function getPendingIntegrationContent(editor: Editor): string | null {
    const structure = analyzeNoteStructure(editor);

    if (!structure.pendingIntegration.found) {
        return null;
    }

    const lines: string[] = [];
    for (let i = structure.pendingIntegration.startLine; i <= structure.pendingIntegration.endLine; i++) {
        lines.push(editor.getLine(i));
    }

    const content = lines.join('\n').trim();
    return content || null;
}

/**
 * Get the main content of the note (before References/Pending sections)
 */
export function getMainContent(editor: Editor): string {
    const structure = analyzeNoteStructure(editor);
    const lines: string[] = [];

    for (let i = 0; i <= structure.mainContentEndLine; i++) {
        lines.push(editor.getLine(i));
    }

    return lines.join('\n').trim();
}

/**
 * Clear the Pending Integration section content (keep the header)
 */
export function clearPendingIntegration(editor: Editor): void {
    const structure = analyzeNoteStructure(editor);

    if (!structure.pendingIntegration.found) {
        return;
    }

    // Delete content between header and end of section
    const startPos = {
        line: structure.pendingIntegration.startLine,
        ch: 0
    };
    const endPos = {
        line: structure.pendingIntegration.endLine + 1,
        ch: 0
    };

    editor.replaceRange('\n', startPos, endPos);
}

/**
 * Ensure the note has the standard structure (References and Pending Integration sections)
 * Adds them if missing
 */
export function ensureStandardStructure(editor: Editor): void {
    const structure = analyzeNoteStructure(editor);

    // Add Pending Integration if missing
    if (!structure.pendingIntegration.found) {
        const insertLine = editor.lineCount();
        const insertContent = `${SECTION_DIVIDER}\n${PENDING_INTEGRATION_HEADER}\n\n`;
        editor.replaceRange(insertContent, { line: insertLine, ch: 0 });
    }

    // Re-analyze after potential change
    const newStructure = analyzeNoteStructure(editor);

    // Add References if missing (before Pending Integration)
    if (!newStructure.references.found && newStructure.pendingIntegration.found) {
        let insertLine = newStructure.pendingIntegration.headerLine;
        // Go back past any dividers
        while (insertLine > 0 && editor.getLine(insertLine - 1).trim() === '---') {
            insertLine--;
        }
        const insertContent = `${SECTION_DIVIDER}\n${REFERENCES_HEADER}\n\n`;
        editor.replaceRange(insertContent, { line: insertLine, ch: 0 });
    }
}

/**
 * Ensure the note has the standard structure only if enabled in settings
 */
export function ensureNoteStructureIfEnabled(
    editor: Editor,
    settings: AIOrganiserSettings
): void {
    if (settings.autoEnsureNoteStructure) {
        ensureStandardStructure(editor);
    }
}

/**
 * Replace the main content while preserving References and Pending Integration sections
 */
export function replaceMainContent(editor: Editor, newContent: string): void {
    const structure = analyzeNoteStructure(editor);

    // Get the preserved sections
    let preservedSections = '';

    if (structure.references.found) {
        // Find the start of the divider before References
        let dividerStart = structure.references.headerLine;
        while (dividerStart > 0 && editor.getLine(dividerStart - 1).trim() === '---') {
            dividerStart--;
        }

        // Collect everything from divider to end
        const lines: string[] = [];
        for (let i = dividerStart; i < editor.lineCount(); i++) {
            lines.push(editor.getLine(i));
        }
        preservedSections = '\n' + lines.join('\n');
    } else if (structure.pendingIntegration.found) {
        let dividerStart = structure.pendingIntegration.headerLine;
        while (dividerStart > 0 && editor.getLine(dividerStart - 1).trim() === '---') {
            dividerStart--;
        }

        const lines: string[] = [];
        for (let i = dividerStart; i < editor.lineCount(); i++) {
            lines.push(editor.getLine(i));
        }
        preservedSections = '\n' + lines.join('\n');
    }

    // Replace entire document
    const fullContent = newContent + preservedSections;
    editor.setValue(fullContent);
}

/**
 * Get today's date in YYYY-MM-DD format
 */
export function getTodayDate(): string {
    return new Date().toISOString().split('T')[0];
}

/**
 * Format duration in seconds to MM:SS or HH:MM:SS
 */
export function formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.round(seconds % 60);

    if (hours > 0) {
        return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
}
