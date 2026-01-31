/**
 * Highlight Extractor
 * Block-aware parser for note content and highlight detection.
 */

type ContentBlockType = 'paragraph' | 'code' | 'callout' | 'list' | 'table' | 'heading';

export interface ContentBlock {
    text: string;
    displayText: string;
    lineStart: number;
    lineEnd: number;
    type: ContentBlockType;
    hasHighlight: boolean;
}

const MARK_DETECT = /<mark\b[^>]*>[\s\S]*?<\/mark>/i;
const EQUAL_DETECT = /==[^=][\s\S]*?==/;
const MARK_EXTRACT = /<mark\b[^>]*>([\s\S]*?)<\/mark>/gi;
const EQUAL_EXTRACT = /==([^=][\s\S]*?)==/g;

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'tiff'];

export function stripHighlightMarkup(text: string): string {
    return text
        .replace(MARK_EXTRACT, '$1')
        .replace(EQUAL_EXTRACT, '$1');
}

export function splitIntoBlocks(content: string): ContentBlock[] {
    const cleaned = stripFrontmatter(content);
    const lines = cleaned.split('\n');
    const blocks: ContentBlock[] = [];

    let i = 0;
    while (i < lines.length) {
        const line = lines[i];

        if (line.trim() === '') {
            i += 1;
            continue;
        }

        if (isHeading(line)) {
            pushBlock(blocks, lines, 'heading', i, i);
            i += 1;
            continue;
        }

        if (isCodeFence(line)) {
            const start = i;
            i += 1;
            while (i < lines.length && !isCodeFence(lines[i])) {
                i += 1;
            }
            if (i < lines.length) {
                i += 1; // include closing fence
            }
            pushBlock(blocks, lines, 'code', start, i - 1);
            continue;
        }

        if (isCalloutStart(line)) {
            const start = i;
            i += 1;
            while (i < lines.length && isCalloutLine(lines[i])) {
                i += 1;
            }
            pushBlock(blocks, lines, 'callout', start, i - 1);
            continue;
        }

        if (isListLine(line)) {
            const start = i;
            i += 1;
            while (i < lines.length && isListContinuation(lines[i])) {
                i += 1;
            }
            pushBlock(blocks, lines, 'list', start, i - 1);
            continue;
        }

        if (isTableLine(line)) {
            const start = i;
            i += 1;
            while (i < lines.length && isTableLine(lines[i])) {
                i += 1;
            }
            pushBlock(blocks, lines, 'table', start, i - 1);
            continue;
        }

        const start = i;
        i += 1;
        while (
            i < lines.length &&
            lines[i].trim() !== '' &&
            !isHeading(lines[i]) &&
            !isCodeFence(lines[i]) &&
            !isCalloutStart(lines[i]) &&
            !isListLine(lines[i]) &&
            !isTableLine(lines[i])
        ) {
            i += 1;
        }
        pushBlock(blocks, lines, 'paragraph', start, i - 1);
    }

    return blocks;
}

function pushBlock(
    blocks: ContentBlock[],
    lines: string[],
    type: ContentBlockType,
    start: number,
    end: number
): void {
    const text = lines.slice(start, end + 1).join('\n');
    if (!text.trim()) return;

    const hasHighlight = type !== 'code' && (MARK_DETECT.test(text) || EQUAL_DETECT.test(text));
    const displayText = buildDisplayText(text, type);

    blocks.push({
        text,
        displayText,
        lineStart: start + 1,
        lineEnd: end + 1,
        type,
        hasHighlight
    });
}

function buildDisplayText(text: string, type: ContentBlockType): string {
    if (type === 'table') {
        const rows = text.split('\n').filter(line => line.trim().startsWith('|')).length;
        return `[Table: ${rows} rows]`;
    }

    if (type === 'code') {
        const stripped = text
            .replace(/^```[^\n]*\n?/i, '')
            .replace(/\n?```\s*$/i, '');
        const lines = stripped.split('\n');
        const snippet = lines.slice(0, 3).join('\n');
        return lines.length > 3 ? `${snippet}\n…` : snippet;
    }

    const placeholderText = replaceNonTextElements(text);
    const clean = stripHighlightMarkup(placeholderText).replace(/\s+/g, ' ').trim();
    return truncate(clean, 220);
}

function replaceNonTextElements(text: string): string {
    return text.replace(/!\[\[(.+?)\]\]/g, (_match, inner: string) => {
        const lower = inner.toLowerCase();
        const extension = lower.split('.').pop() ?? '';
        if (IMAGE_EXTENSIONS.includes(extension)) {
            return `[Image: ${inner}]`;
        }
        return `[Embed: ${inner}]`;
    });
}

function truncate(text: string, limit: number): string {
    if (text.length <= limit) return text;
    return `${text.slice(0, limit - 1)}…`;
}

function stripFrontmatter(content: string): string {
    const lines = content.split('\n');
    if (lines[0]?.trim() !== '---') return content;

    for (let i = 1; i < lines.length; i += 1) {
        if (lines[i].trim() === '---') {
            return lines.slice(i + 1).join('\n');
        }
    }

    return content;
}

function isHeading(line: string): boolean {
    return /^\s*#{1,6}\s+/.test(line);
}

function isCodeFence(line: string): boolean {
    return /^\s*```/.test(line);
}

function isCalloutStart(line: string): boolean {
    return /^\s*>\s*\[!/.test(line);
}

function isCalloutLine(line: string): boolean {
    return /^\s*>/.test(line);
}

function isListLine(line: string): boolean {
    return /^\s*(?:[-*+]|\d+\.)\s+/.test(line);
}

function isListContinuation(line: string): boolean {
    if (isListLine(line)) return true;
    if (line.trim() === '') return false;
    // Indented continuation or nested content under a list item
    return /^\s{2,}/.test(line);
}

function isTableLine(line: string): boolean {
    return /^\s*\|/.test(line);
}
