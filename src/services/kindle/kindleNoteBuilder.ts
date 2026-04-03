/**
 * Kindle Note Builder
 *
 * Builds structured markdown notes from Kindle book highlights.
 * Supports multiple highlight styles and optional cover images.
 */

import { KindleBook, KindleHighlight, KindleHighlightColor } from './kindleTypes';

export type KindleHighlightStyle = 'blockquote' | 'callout' | 'bullet';

export interface KindleNoteOptions {
    highlightStyle: KindleHighlightStyle;
    groupByColor: boolean;
    includeCoverImage: boolean;
}

/**
 * Build a complete markdown note for a book with its highlights.
 */
export function buildBookNote(book: KindleBook, options: KindleNoteOptions): string {
    const parts: string[] = [];

    // Frontmatter
    parts.push(buildFrontmatter(book));

    // Title and author
    parts.push(`# ${book.title}`);
    parts.push(`*by ${book.author}*`);
    parts.push('');

    // Cover image
    if (options.includeCoverImage && book.imageUrl) {
        parts.push(`![cover](${book.imageUrl})`);
        parts.push('');
    }

    // Highlights section
    if (book.highlights.length > 0) {
        if (options.groupByColor) {
            parts.push(formatHighlightsGroupedByColor(book.highlights, options.highlightStyle));
        } else {
            parts.push('## Highlights');
            parts.push('');
            parts.push(formatHighlightList(book.highlights, options.highlightStyle));
        }

        // Standalone notes section (highlights that are notes-only)
        const standaloneNotes = book.highlights.filter(h => !h.text && h.note);
        if (standaloneNotes.length > 0) {
            parts.push('## Notes');
            parts.push('');
            for (const n of standaloneNotes) {
                parts.push(formatNote(n));
                parts.push('');
            }
        }
    }

    return parts.join('\n');
}

/**
 * Build YAML frontmatter for a book note.
 */
export function buildFrontmatter(book: KindleBook): string {
    const fm: Record<string, string | number> = {
        title: book.title,
        author: book.author,
        source: 'kindle',
        highlights_count: book.highlightCount,
        last_synced: new Date().toISOString(),
    };

    if (book.asin) {
        fm.kindle_asin = book.asin;
    }

    const lines = ['---'];
    for (const [key, value] of Object.entries(fm)) {
        if (typeof value === 'string') {
            // Quote strings that contain special YAML characters
            const needsQuotes = /[:#{}[\],&*?|<>=!%@`]/.test(value) || value.includes('\n');
            lines.push(`${key}: ${needsQuotes ? `"${value.replace(/"/g, '\\"')}"` : value}`);
        } else {
            lines.push(`${key}: ${value}`);
        }
    }
    lines.push('tags: []');
    lines.push('---');
    lines.push('');

    return lines.join('\n');
}

/**
 * Format a single highlight according to the chosen style.
 */
export function formatHighlight(highlight: KindleHighlight, style: KindleHighlightStyle): string {
    if (!highlight.text) return '';

    const location = formatLocation(highlight);

    switch (style) {
        case 'blockquote':
            return formatBlockquote(highlight.text, location, highlight.note);

        case 'callout':
            return formatCallout(highlight.text, location, highlight.note);

        case 'bullet':
            return formatBullet(highlight.text, location, highlight.note);

        default:
            return formatBlockquote(highlight.text, location, highlight.note);
    }
}

/**
 * Format a list of highlights (excluding note-only entries).
 */
function formatHighlightList(highlights: KindleHighlight[], style: KindleHighlightStyle): string {
    return highlights
        .filter(h => h.text) // Skip note-only entries
        .map(h => formatHighlight(h, style))
        .join('\n\n');
}

/**
 * Group highlights by color and format each group with a heading.
 */
function formatHighlightsGroupedByColor(highlights: KindleHighlight[], style: KindleHighlightStyle): string {
    const colorOrder: (KindleHighlightColor | 'none')[] = ['yellow', 'blue', 'pink', 'orange', 'none'];
    const groups = new Map<string, KindleHighlight[]>();

    for (const h of highlights) {
        if (!h.text) continue;
        const key = h.color || 'none';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(h);
    }

    const parts: string[] = [];

    for (const color of colorOrder) {
        const group = groups.get(color);
        if (!group || group.length === 0) continue;

        const label = color === 'none' ? 'Highlights' : `${capitalize(color)} Highlights`;
        parts.push(`## ${label}`);
        parts.push('');
        parts.push(formatHighlightList(group, style));
        parts.push('');
    }

    return parts.join('\n');
}

/**
 * Format location info string from a highlight.
 */
function formatLocation(highlight: KindleHighlight): string {
    const parts: string[] = [];
    if (highlight.page) parts.push(`Page ${highlight.page}`);
    if (highlight.location) parts.push(`Location ${highlight.location}`);
    return parts.join(', ');
}

/**
 * Blockquote style: > text\n> — location
 */
function formatBlockquote(text: string, location: string, note?: string): string {
    const lines = text.split('\n').map(l => `> ${l}`);
    if (location) {
        lines.push(`> — ${location}`);
    }
    let result = lines.join('\n');
    if (note) {
        result += `\n\n**Note:** ${note}`;
    }
    return result;
}

/**
 * Callout style: > [!quote] location\n> text
 */
function formatCallout(text: string, location: string, note?: string): string {
    const header = location ? `> [!quote] ${location}` : '> [!quote]';
    const bodyLines = text.split('\n').map(l => `> ${l}`);
    let result = `${header}\n${bodyLines.join('\n')}`;
    if (note) {
        result += `\n>\n> **Note:** ${note}`;
    }
    return result;
}

/**
 * Bullet style: - text — *location*
 */
function formatBullet(text: string, location: string, note?: string): string {
    const locationSuffix = location ? ` — *${location}*` : '';
    let result = `- ${text}${locationSuffix}`;
    if (note) {
        result += `\n  - **Note:** ${note}`;
    }
    return result;
}

/**
 * Format a standalone note (no associated highlight text).
 */
function formatNote(highlight: KindleHighlight): string {
    const location = formatLocation(highlight);
    const header = location ? `> [!note] ${location}` : '> [!note]';
    return `${header}\n> ${highlight.note}`;
}

/**
 * Append new highlights to an existing note's content.
 * Inserts before the "## Notes" section if it exists, otherwise appends at end.
 */
export function appendHighlightsToExisting(
    existingContent: string,
    newHighlights: KindleHighlight[],
    style: KindleHighlightStyle
): string {
    if (newHighlights.length === 0) return existingContent;

    const newContent = newHighlights
        .filter(h => h.text)
        .map(h => formatHighlight(h, style))
        .join('\n\n');

    if (!newContent) return existingContent;

    // Try to insert before "## Notes" section
    const notesIndex = existingContent.indexOf('\n## Notes');
    if (notesIndex !== -1) {
        return existingContent.slice(0, notesIndex) + '\n\n' + newContent + existingContent.slice(notesIndex);
    }

    // Append at end
    return existingContent.trimEnd() + '\n\n' + newContent + '\n';
}

/**
 * Update specific frontmatter fields in an existing note's content.
 * Replaces existing keys or appends new ones before the closing ---.
 */
export function updateFrontmatterInContent(
    content: string,
    updates: Record<string, string | number>
): string {
    const fmStart = content.indexOf('---');
    if (fmStart === -1) return content;
    const fmEnd = content.indexOf('---', fmStart + 3);
    if (fmEnd === -1) return content;

    let frontmatter = content.slice(fmStart + 3, fmEnd);

    for (const [key, value] of Object.entries(updates)) {
        const regex = new RegExp(`^${key}:.*$`, 'm');
        let formatted: string;
        if (typeof value === 'string') {
            const needsQuotes = /[:#{}[\],&*?|<>=!%@`]/.test(value) || value.includes('\n');
            const escaped = value.replaceAll('"', String.raw`\"`);
            formatted = needsQuotes ? '"' + escaped + '"' : value;
        } else {
            formatted = String(value);
        }

        if (regex.test(frontmatter)) {
            frontmatter = frontmatter.replace(regex, `${key}: ${formatted}`);
        } else {
            frontmatter = frontmatter.trimEnd() + `\n${key}: ${formatted}\n`;
        }
    }

    return content.slice(0, fmStart + 3) + frontmatter + content.slice(fmEnd);
}

function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}
