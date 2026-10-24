/**
 * Kindle Note Builder
 *
 * Builds structured markdown notes from Kindle book highlights.
 * Supports multiple highlight styles and optional cover images.
 */

import * as yaml from 'js-yaml';
import { FenceTracker } from '../../utils/markdownFences';
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
        lines.push(`${key}: ${formatYamlScalar(value)}`);
    }
    lines.push('tags: []');
    lines.push('---');
    lines.push('');

    return lines.join('\n');
}

/**
 * One YAML scalar on one line. Strings the previous serialiser quoted (colon, hash,
 * brackets, ... or a newline) stay double-quoted, now with full escaping; anything else
 * is plain unless js-yaml says the plain form would be invalid or mistyped (`yes`,
 * `123`, a leading `-`, a timestamp-like string, padding).
 */
function formatYamlScalar(value: string | number): string {
    if (typeof value === 'number') return String(value);
    if (/[:#{}[\],&*?|<>=!%@`]/.test(value) || value.includes('\n')) return JSON.stringify(value);
    const dumped = yaml.dump(value, { quotingType: '"', lineWidth: -1 }).trimEnd();
    return dumped.includes('\n') ? JSON.stringify(value) : dumped;
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

interface NoteLine {
    /** Offset of the first character of the line. */
    start: number;
    /** Offset just past the line's break (or the end of the content). */
    end: number;
    text: string;
    /** On a code-fence delimiter line or inside a fenced block. */
    fenced: boolean;
}

/** Split content into lines, flagging fenced code so headings inside it are not mistaken for sections. */
function scanNoteLines(content: string): NoteLine[] {
    const lines: NoteLine[] = [];
    const fences = new FenceTracker();
    let offset = 0;
    // The leading frontmatter is YAML, not Markdown: nothing in it is a fence or a heading.
    const frontmatterEnd = FRONTMATTER_BLOCK.exec(content)?.[0].length ?? 0;
    while (offset <= content.length) {
        const nl = content.indexOf('\n', offset);
        const lineEnd = nl === -1 ? content.length : nl;
        const text = content.slice(offset, lineEnd).replace(/\r$/, '');
        const fenced = offset < frontmatterEnd ? true : fences.next(text);
        lines.push({ start: offset, end: nl === -1 ? content.length : nl + 1, text, fenced });
        if (nl === -1) break;
        offset = nl + 1;
    }
    return lines;
}

/** The "## Notes" heading line (the exact title, outside code fences, never the first line). */
function findNotesHeading(content: string): NoteLine | undefined {
    return scanNoteLines(content).find(l => !l.fenced && l.start > 0 && /^## Notes[ \t]*$/.test(l.text));
}

/**
 * Append new highlights to an existing note's content.
 * Text highlights go before the "## Notes" section if it exists, otherwise at the end.
 * Note-only highlights (a note with no highlighted text) go at the end of the Notes
 * section, which is created when missing.
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
    const noteBlock = newHighlights
        .filter(h => !h.text && h.note)
        .map(h => formatNote(h))
        .join('\n\n');

    if (!newContent && !noteBlock) return existingContent;

    let result = existingContent;

    if (newContent) {
        const notes = findNotesHeading(result);
        // Insert at the line break that precedes the heading, as before.
        result = notes === undefined
            ? result.trimEnd() + '\n\n' + newContent + '\n'
            : result.slice(0, notes.start - 1) + '\n\n' + newContent + result.slice(notes.start - 1);
    }

    return noteBlock ? appendToNotesSection(result, noteBlock) : result;
}

/** Insert `block` at the end of the "## Notes" section (before the next level 1-2 heading). */
function appendToNotesSection(content: string, block: string): string {
    const lines = scanNoteLines(content);
    const heading = lines.find(l => !l.fenced && l.start > 0 && /^## Notes[ \t]*$/.test(l.text));
    if (!heading) return content.trimEnd() + '\n\n## Notes\n\n' + block + '\n';

    let head = content.slice(0, heading.end);
    if (!head.endsWith('\n')) head += '\n';
    const nextHeading = lines.find(l => l.start >= heading.end && !l.fenced && /^#{1,2}[ \t]/.test(l.text));
    const body = content.slice(heading.end, nextHeading ? nextHeading.start : content.length);
    const tail = nextHeading ? content.slice(nextHeading.start) : '';

    const grown = body.trim() === '' ? '\n' + block + '\n' : body.trimEnd() + '\n\n' + block + '\n';
    return head + grown + (tail ? '\n' + tail : '');
}

/** Opening fence at offset 0 (optional BOM), then either an empty block or body + closing fence. */
const FRONTMATTER_BLOCK = /^(\uFEFF?)(---[ \t]*\r?\n)(?:(---[ \t]*(?:\r?\n|$))|([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$)))/;

function escapeRegExp(text: string): string {
    return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function sameYaml(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

function parseFrontmatterBody(body: string): Record<string, unknown> {
    const parsed = yaml.load(body);
    if (parsed === undefined || parsed === null) return {};
    if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('frontmatter is not a mapping');
    return parsed as Record<string, unknown>;
}

/**
 * Update specific frontmatter fields in an existing note's content.
 * The block is the one at the very top of the note; content without one is returned
 * unchanged. Keys are replaced in place or appended before the closing fence. The result
 * is re-parsed and must hold the new values with every other key untouched; otherwise
 * this throws instead of writing a note whose metadata is wrong.
 */
export function updateFrontmatterInContent(
    content: string,
    updates: Record<string, string | number>
): string {
    const match = FRONTMATTER_BLOCK.exec(content);
    if (!match) return content;

    const [whole, bom, open, closeIfEmpty, body = '', sepAndClose] = match;
    const eol = open.includes('\r\n') ? '\r\n' : '\n';
    const isEmpty = closeIfEmpty !== undefined;
    const lines = isEmpty ? [] : body.split('\n').map(l => l.replace(/\r$/, ''));

    try {
        const before = parseFrontmatterBody(lines.join('\n'));

        for (const [key, value] of Object.entries(updates)) {
            const newLine = `${key}: ${formatYamlScalar(value)}`;
            const keyLine = new RegExp(`^["']?${escapeRegExp(key)}["']?[ \\t]*:`);
            const at = lines.findIndex(l => keyLine.test(l));
            if (at === -1) {
                lines.push(newLine);
                continue;
            }
            // Continuation lines: indented lines, and blank lines that are followed by one.
            let last = at;
            for (let i = at + 1; i < lines.length; i++) {
                if (/^[ \t]+\S/.test(lines[i])) last = i;
                else if (lines[i].trim() !== '') break;
            }
            lines.splice(at, last - at + 1, newLine);
        }

        const after = parseFrontmatterBody(lines.join('\n'));
        const expected: Record<string, unknown> = { ...before, ...updates };
        for (const key of new Set([...Object.keys(expected), ...Object.keys(after)])) {
            if (!sameYaml(after[key], expected[key])) throw new Error(`key "${key}" did not survive the edit`);
        }
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Kindle note frontmatter could not be updated safely: ${reason}`);
    }

    const rebuilt = isEmpty
        ? lines.join(eol) + (lines.length > 0 ? eol : '') + closeIfEmpty
        : lines.join(eol) + sepAndClose;
    return bom + open + rebuilt + content.slice(whole.length);
}

function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}
