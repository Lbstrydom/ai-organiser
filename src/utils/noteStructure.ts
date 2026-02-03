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

// Case-insensitive patterns for robust section detection
const REFERENCES_PATTERN = /^##\s*references\s*$/i;
const PENDING_INTEGRATION_PATTERN = /^##\s*pending\s*integration\s*$/i;

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
 * Get the detection pattern for a header (case-insensitive)
 */
function getHeaderPattern(header: string): RegExp {
    if (header === REFERENCES_HEADER) {
        return REFERENCES_PATTERN;
    } else if (header === PENDING_INTEGRATION_HEADER) {
        return PENDING_INTEGRATION_PATTERN;
    }
    // Fallback: create case-insensitive pattern from header
    const headerText = header.replaceAll(/^##\s*/g, '').trim();
    return new RegExp(String.raw`^##\s*` + headerText.replaceAll(/\s+/g, String.raw`\s*`) + String.raw`\s*$`, 'i');
}

/**
 * Find the location of a section header in the editor
 * Uses case-insensitive matching for robust detection
 */
export function findSectionInEditor(editor: Editor, header: string): SectionLocation {
    const lineCount = editor.lineCount();
    let headerLine = -1;
    let endLine = lineCount - 1;

    const pattern = getHeaderPattern(header);

    // Find the header line using case-insensitive pattern
    for (let i = 0; i < lineCount; i++) {
        const line = editor.getLine(i).trim();
        if (pattern.test(line)) {
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
 * Uses case-insensitive matching for robust detection
 */
export function findSectionInText(content: string, header: string): SectionLocation {
    const lines = content.split('\n');
    let headerLine = -1;
    let endLine = lines.length - 1;

    const pattern = getHeaderPattern(header);

    // Find the header line using case-insensitive pattern
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (pattern.test(line)) {
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
    | 'document'
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
        document: 'Document',
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
 * Creates the section if it doesn't exist using robust detection
 */
export function addToReferencesSection(
    editor: Editor,
    source: SourceReference
): void {
    // First ensure the section exists (idempotent - won't create duplicates)
    ensureReferencesExists(editor);

    // Now the section definitely exists, add content to it
    const structure = analyzeNoteStructure(editor);
    const referenceText = formatSourceReference(source);

    // Add to the References section
    const insertLine = structure.references.startLine;
    const insertPos = { line: insertLine, ch: 0 };

    editor.replaceRange(referenceText + '\n', insertPos);
}

/**
 * Detect source type from a link string
 */
function detectSourceTypeFromLink(link: string): SourceType {
    const lower = link.toLowerCase();
    if (lower.includes('youtube.com') || lower.includes('youtu.be')) return 'youtube';
    if (lower.endsWith('.pdf')) return 'pdf';
    if (/\.(mp3|wav|m4a|webm|ogg|aac)$/.test(lower)) return 'audio';
    if (/\.(mp4|mov|avi)$/.test(lower)) return 'video';
    if (/\.(docx|xlsx|pptx|doc|xls|ppt|rtf|txt)$/.test(lower)) return 'document';
    if (!link.startsWith('http')) return 'note';
    return 'web';
}

/**
 * Extract source references from pending integration content.
 * Handles two formats:
 * 1. Structured: ### Source: headings with > From: links
 * 2. Unstructured: Raw URLs, wikilinks (![[...]]), and markdown links in plain text
 */
export function extractSourcesFromPending(pendingContent: string): SourceReference[] {
    const sources: SourceReference[] = [];
    const seen = new Set<string>();

    // Pass 1: Extract from structured ### Source: blocks
    const blocks = pendingContent.split(/(?=^### Source:)/m);
    const headingRegex = /^### Source:\s*(.+?)(?:\s*\((\d{4}-\d{2}-\d{2})\))?\s*$/m;
    const linkRegex = /^> From:\s*(.+)$/m;

    for (const block of blocks) {
        const headingMatch = headingRegex.exec(block);
        if (!headingMatch) continue;

        const title = headingMatch[1].trim();
        const date = headingMatch[2] || undefined;

        const linkMatch = linkRegex.exec(block);
        if (!linkMatch) continue;

        const rawLink = linkMatch[1].trim();
        const isInternal = rawLink.startsWith('[[');
        const link = isInternal ? rawLink.replaceAll(/(?:^\[\[)|(?:\]\]$)/g, '') : rawLink;
        const type = detectSourceTypeFromLink(link);

        seen.add(link.toLowerCase());
        sources.push({ type, title, link, date, isInternal });
    }

    // Pass 2: Extract raw URLs from unstructured content
    const urlMatches = pendingContent.matchAll(/(?:^|\s)(https?:\/\/[^\s<>]+)/gm);
    for (const match of urlMatches) {
        const url = match[1].replace(/[.,;:!?)]+$/, ''); // Strip trailing punctuation
        if (seen.has(url.toLowerCase())) continue;
        seen.add(url.toLowerCase());

        const type = detectSourceTypeFromLink(url);
        const title = extractTitleFromUrl(url);
        sources.push({ type, title, link: url, isInternal: false });
    }

    // Pass 3: Extract wikilink embeds (![[...]])
    const embedMatches = pendingContent.matchAll(/!\[\[([^\]]+)\]\]/g);
    for (const match of embedMatches) {
        const path = match[1];
        if (seen.has(path.toLowerCase())) continue;
        seen.add(path.toLowerCase());

        const type = detectSourceTypeFromLink(path);
        sources.push({ type, title: path, link: path, isInternal: true });
    }

    return sources;
}

/**
 * Extract a readable title from a URL.
 * Uses the last meaningful path segment, falling back to hostname.
 */
function extractTitleFromUrl(url: string): string {
    try {
        const parsed = new URL(url);
        const hostname = parsed.hostname.replace(/^www\./, '');

        // Try to get a meaningful title from the URL path
        const pathSegments = parsed.pathname
            .split('/')
            .filter(s => s.length > 0)
            .map(s => decodeURIComponent(s));

        // Use the last meaningful segment (skip short IDs, file extensions)
        for (let i = pathSegments.length - 1; i >= 0; i--) {
            const segment = pathSegments[i]
                .replace(/\.[a-z]{2,4}$/i, '') // strip file extension
                .replaceAll(/[-_]/g, ' ')       // convert separators to spaces
                .trim();
            if (segment.length >= 3) {
                // Capitalize first letter of each word
                const title = segment.replaceAll(/\b\w/g, c => c.toUpperCase());
                return `${title} — ${hostname}`;
            }
        }

        return hostname;
    } catch {
        return url.slice(0, 50);
    }
}

/**
 * Get the text content of the References section for deduplication checks
 */
export function getReferencesContent(editor: Editor): string {
    const structure = analyzeNoteStructure(editor);
    if (!structure.references.found) return '';

    const lines: string[] = [];
    for (let i = structure.references.startLine; i <= structure.references.endLine; i++) {
        lines.push(editor.getLine(i));
    }
    return lines.join('\n');
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
 * Creates the section if it doesn't exist using robust detection
 */
export function addToPendingIntegration(
    editor: Editor,
    source: PendingSource
): void {
    // First ensure the section exists (idempotent - won't create duplicates)
    ensurePendingIntegrationExists(editor);

    // Now the section definitely exists, add content to it
    const structure = analyzeNoteStructure(editor);
    const pendingContent = formatPendingContent(source);

    // Add to the Pending Integration section
    const insertLine = structure.pendingIntegration.startLine;
    const insertPos = { line: insertLine, ch: 0 };

    editor.replaceRange(pendingContent + '\n', insertPos);
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
 * Replace the content of the Pending Integration section (keeps the header)
 */
export function setPendingIntegrationContent(editor: Editor, content: string): void {
    const structure = analyzeNoteStructure(editor);

    if (!structure.pendingIntegration.found) {
        return;
    }

    const startPos = {
        line: structure.pendingIntegration.startLine,
        ch: 0
    };
    const endPos = {
        line: structure.pendingIntegration.endLine + 1,
        ch: 0
    };

    const trimmedContent = content.trim();
    const replacement = trimmedContent ? trimmedContent + '\n' : '\n';
    editor.replaceRange(replacement, startPos, endPos);
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
 * Adds them if missing. Uses idempotent helper functions for robust detection.
 */
export function ensureStandardStructure(editor: Editor): void {
    // Use the idempotent functions that have robust detection
    // Order matters: add Pending Integration first, then References (which goes before it)
    ensurePendingIntegrationExists(editor);
    ensureReferencesExists(editor);
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
 * Check if the Pending Integration section exists in the editor
 * Uses case-insensitive matching for robust detection
 */
export function hasPendingIntegrationSection(editor: Editor): boolean {
    const location = findSectionInEditor(editor, PENDING_INTEGRATION_HEADER);
    return location.found;
}

/**
 * Ensure the Pending Integration section exists (idempotent)
 * Creates the section only if it doesn't already exist.
 * This is the single entry point for ensuring the section exists.
 *
 * @returns true if section was created, false if it already existed
 */
export function ensurePendingIntegrationExists(editor: Editor): boolean {
    // Check using robust detection
    if (hasPendingIntegrationSection(editor)) {
        return false; // Already exists, nothing to do
    }

    // Create the section at the end of the document
    const insertLine = editor.lineCount();
    const insertContent = `${SECTION_DIVIDER}\n${PENDING_INTEGRATION_HEADER}\n\n`;
    editor.replaceRange(insertContent, { line: insertLine, ch: 0 });

    return true; // Section was created
}

/**
 * Check if the References section exists in the editor
 * Uses case-insensitive matching for robust detection
 */
export function hasReferencesSection(editor: Editor): boolean {
    const location = findSectionInEditor(editor, REFERENCES_HEADER);
    return location.found;
}

/**
 * Ensure the References section exists (idempotent)
 * Creates the section only if it doesn't already exist.
 * Places it before Pending Integration if that section exists.
 *
 * @returns true if section was created, false if it already existed
 */
export function ensureReferencesExists(editor: Editor): boolean {
    // Check using robust detection
    if (hasReferencesSection(editor)) {
        return false; // Already exists, nothing to do
    }

    // Check if Pending Integration exists to place References before it
    const pendingLocation = findSectionInEditor(editor, PENDING_INTEGRATION_HEADER);

    if (pendingLocation.found) {
        // Insert before Pending Integration
        let insertLine = pendingLocation.headerLine;
        // Go back past any dividers
        while (insertLine > 0 && editor.getLine(insertLine - 1).trim() === '---') {
            insertLine--;
        }
        const insertContent = `${SECTION_DIVIDER}\n${REFERENCES_HEADER}\n\n`;
        editor.replaceRange(insertContent, { line: insertLine, ch: 0 });
    } else {
        // Insert at end of document
        const insertLine = editor.lineCount();
        const insertContent = `${SECTION_DIVIDER}\n${REFERENCES_HEADER}\n\n`;
        editor.replaceRange(insertContent, { line: insertLine, ch: 0 });
    }

    return true; // Section was created
}

/**
 * Strip trailing References and Pending Integration sections from text content.
 * Used to prevent duplication when sending content to LLM (since replaceMainContent
 * re-appends these sections from the editor).
 *
 * Strips from the earliest section boundary, including any preceding `---` divider
 * and blank lines.
 */
export function stripTrailingSections(content: string): string {
    const refsLocation = findSectionInText(content, REFERENCES_HEADER);
    const pendingLocation = findSectionInText(content, PENDING_INTEGRATION_HEADER);

    if (!refsLocation.found && !pendingLocation.found) {
        return content;
    }

    // Find the earliest section header line
    let cutLine = -1;
    if (refsLocation.found && pendingLocation.found) {
        cutLine = Math.min(refsLocation.headerLine, pendingLocation.headerLine);
    } else if (refsLocation.found) {
        cutLine = refsLocation.headerLine;
    } else {
        cutLine = pendingLocation.headerLine;
    }

    const lines = content.split('\n');

    // Walk back past any `---` dividers and blank lines before the section header
    while (cutLine > 0) {
        const prev = lines[cutLine - 1].trim();
        if (prev === '---' || prev === '') {
            cutLine--;
        } else {
            break;
        }
    }

    return lines.slice(0, cutLine).join('\n');
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
