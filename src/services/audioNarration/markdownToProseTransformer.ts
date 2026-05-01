/**
 * Markdown-to-spoken-prose transformer.
 *
 * Converts a markdown note into prose suitable for TTS. Does NOT shorten or
 * summarise — every word the user wrote is read (modulo formatting markers
 * and a small set of non-vocal constructs like code blocks and diagrams).
 *
 * Pre-pass (G2 fix): strips its own managed block (AIO-NARRATION:START/END)
 * BEFORE any other rule runs. Without this, re-narrating a note would feed
 * the previous narration's embed link into the transformer and the user would
 * hear "embedded image. embedded image." preamble each time.
 */

import {
    DEFAULT_PROSE_OPTIONS,
    type MarkdownToProseOptions,
    type ProseStats,
    type TransformResult,
} from './narrationTypes';

const EMBED_BLOCK_RE = /<!--\s*AIO-NARRATION:START\s*-->[\s\S]*?<!--\s*AIO-NARRATION:END\s*-->/g;
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\n---\r?\n?/;

const SPEAKING_RATE_CHARS_PER_SECOND = 14;

const ORDINALS = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth'];

export function transformToSpokenProse(
    markdown: string,
    opts: Partial<MarkdownToProseOptions> = {},
): TransformResult {
    const options: MarkdownToProseOptions = { ...DEFAULT_PROSE_OPTIONS, ...opts };
    const warnings: string[] = [];

    // Pre-pass 1 (G2): strip managed AIO-NARRATION block first
    let preprocessed = markdown.replace(EMBED_BLOCK_RE, '');

    // Pre-pass 2: strip frontmatter
    preprocessed = preprocessed.replace(FRONTMATTER_RE, '');

    // Pre-pass 3: strip Obsidian comments %% ... %%
    preprocessed = preprocessed.replace(/%%[\s\S]*?%%/g, '');

    // Pre-pass 4: strip math blocks $$ ... $$ → placeholder
    preprocessed = preprocessed.replace(/\$\$[\s\S]*?\$\$/g, () => {
        warnings.push('math-block');
        return '\n\n[math block omitted]\n\n';
    });

    const lines = preprocessed.split(/\r?\n/);
    const out: string[] = [];

    let inCodeBlock = false;
    let codeBlockBuffer: string[] = [];
    let inTable = false;
    let tableHeaders: string[] = [];
    let tableRows: string[][] = [];
    let inHtmlBlock = false;
    let sectionCount = 0;

    const flushTable = (): void => {
        if (inTable) {
            const proseTable = tableToProse(tableHeaders, tableRows, options.tableMode);
            if (proseTable) out.push(proseTable);
            inTable = false;
            tableHeaders = [];
            tableRows = [];
        }
    };

    for (const rawLine of lines) {
        const line = rawLine.trim();

        // HTML block boundaries (very simple — opens on lone <tag>, closes on lone </tag>)
        if (!inCodeBlock) {
            if (!inHtmlBlock && /^<(div|section|article|aside|header|footer|nav|main|figure|table)\b[^>]*>$/i.test(line)) {
                flushTable();
                inHtmlBlock = true;
                warnings.push('html-block');
                out.push('[html block omitted]');
                continue;
            }
            if (inHtmlBlock) {
                if (/^<\/(div|section|article|aside|header|footer|nav|main|figure|table)\s*>$/i.test(line)) {
                    inHtmlBlock = false;
                }
                continue;
            }
        }

        // Code blocks (fenced)
        if (line.startsWith('```')) {
            flushTable();
            if (inCodeBlock) {
                inCodeBlock = false;
                const isMermaid = codeBlockBuffer.length > 0 && /^mermaid\b/i.test(codeBlockBuffer[0]);
                if (isMermaid) {
                    out.push('[diagram omitted]');
                } else if (options.codeBlockMode === 'omit') {
                    // skip silently — explicit user choice
                } else if (options.codeBlockMode === 'read-inline') {
                    out.push(`Code block: ${codeBlockBuffer.join('. ')}. End code block.`);
                } else {
                    out.push('[code block omitted]');
                }
                codeBlockBuffer = [];
            } else {
                inCodeBlock = true;
                codeBlockBuffer = [line.slice(3).trim() ? [line.slice(3).trim()] : []].flat();
            }
            continue;
        }
        if (inCodeBlock) {
            codeBlockBuffer.push(line);
            continue;
        }

        // Tables
        if (line.startsWith('|') && line.endsWith('|')) {
            const cells = splitTableRow(line);
            if (isTableAlignmentRow(cells)) continue;
            if (!inTable) {
                inTable = true;
                tableHeaders = cells;
            } else {
                tableRows.push(cells);
            }
            continue;
        } else if (inTable) {
            flushTable();
        }

        // Horizontal rule
        if (/^(?:-{3,}|={3,}|\*{3,})$/.test(line)) {
            out.push(' ');
            continue;
        }

        // Headings
        const headingMatch = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
        if (headingMatch) {
            const level = headingMatch[1].length;
            const text = stripInlineFormatting(headingMatch[2], options);
            if (!text) continue;
            sectionCount++;
            if (level === 1) {
                out.push(`Note title: ${text}.`);
            } else if (level === 2) {
                out.push(`Section: ${text}.`);
            } else {
                out.push(`${text}.`);
            }
            continue;
        }

        // Callouts (Obsidian extension of blockquote): > [!type] Title
        const calloutMatch = /^>\s*\[!(\w+)\][+-]?\s*(.*)$/.exec(line);
        if (calloutMatch) {
            const type = capitalize(calloutMatch[1]);
            const title = stripInlineFormatting(calloutMatch[2], options);
            out.push(title ? `${type}: ${title}.` : `${type}.`);
            continue;
        }

        // Blockquote
        if (line.startsWith('>')) {
            const inner = stripInlineFormatting(line.replace(/^>\s?/, ''), options);
            if (inner) out.push(`Quote: ${inner} End quote.`);
            continue;
        }

        // Task list - [ ] / - [x]
        const taskMatch = /^[-*+]\s+\[([ xX])\]\s+(.+)$/.exec(line);
        if (taskMatch) {
            const done = taskMatch[1].toLowerCase() === 'x';
            const text = stripInlineFormatting(taskMatch[2], options);
            if (text) out.push(done ? `Done: ${text}.` : `Todo: ${text}.`);
            continue;
        }

        // List item (unordered or ordered)
        const listMatch = /^(?:[-*+]|\d+[.)])\s+(.+)$/.exec(line);
        if (listMatch) {
            const text = stripInlineFormatting(listMatch[1], options);
            if (text) out.push(`${text}.`);
            continue;
        }

        // Footnote definition [^1]: text
        const footnoteDef = /^\[\^([^\]]+)\]:\s*(.+)$/.exec(line);
        if (footnoteDef) {
            const text = stripInlineFormatting(footnoteDef[2], options);
            if (text) out.push(`Footnote: ${text}.`);
            continue;
        }

        // Blank line — paragraph break
        if (line.length === 0) {
            out.push(' ');
            continue;
        }

        // Plain prose
        const stripped = stripInlineFormatting(line, options);
        if (stripped) out.push(stripped);
    }

    flushTable();
    if (inCodeBlock && codeBlockBuffer.length > 0) {
        // Unterminated fence — treat buffer as a code block
        out.push('[code block omitted]');
    }

    const spoken = out
        .filter(s => s.trim().length > 0)
        .join(' ')
        .replace(/\s+/g, ' ')
        .replace(/\.\s*\./g, '.')
        .trim();

    const stats = computeStats(spoken, sectionCount);

    return { spokenText: spoken, stats, warnings: dedupe(warnings) };
}

// ── Inline transforms ───────────────────────────────────────────────────────

function stripInlineFormatting(text: string, opts: MarkdownToProseOptions): string {
    let s = text;

    // Image embeds ![[image.png]] / ![[Note]] / ![[Note^block]]
    s = s.replace(/!\[\[([^\]]+)\]\]/g, (_match, inner: string) => {
        const path = inner.split('|')[0].trim();
        const ext = (path.split('.').pop() ?? '').toLowerCase();
        const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext);
        if (isImage) return opts.imageMode === 'omit' ? '' : '[embedded image]';
        if (path.includes('^')) return '[embedded block]';
        const display = path.split('/').pop() ?? path;
        return `[embedded note: ${display}]`;
    });

    // Image markdown ![alt](url)
    s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_match, alt: string) => {
        if (opts.imageMode === 'omit') return '';
        return alt ? `[image: ${alt}]` : '';
    });

    // Markdown link [text](url)
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');

    // Wikilink [[Note]] / [[Note|Display]] / [[Note#section|Display]] / [[Note#section]]
    s = s.replace(/\[\[([^\]]+)\]\]/g, (_match, inner: string) => {
        const parts = inner.split('|');
        if (parts.length > 1) return parts[1].trim();
        const path = parts[0].trim();
        const hashIdx = path.indexOf('#');
        return hashIdx === -1 ? path : path.slice(0, hashIdx);
    });

    // Footnote refs [^1] — drop in body
    s = s.replace(/\[\^[^\]]+\]/g, '');

    // Inline code `code` → text only
    s = s.replace(/`([^`]+)`/g, '$1');

    // Bold / italic / strikethrough
    s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
    s = s.replace(/__([^_]+)__/g, '$1');
    s = s.replace(/\*([^*]+)\*/g, '$1');
    s = s.replace(/(?<![A-Za-z0-9])_([^_]+)_(?![A-Za-z0-9])/g, '$1');
    s = s.replace(/~~([^~]+)~~/g, '$1');

    // Inline math $...$ → placeholder
    s = s.replace(/\$([^$\n]+)\$/g, '[math]');

    // Inline HTML tags → strip
    s = s.replace(/<\/?[a-zA-Z][^>]*>/g, '');

    // Emoji ranges — strip
    s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '');

    return s.replace(/\s+/g, ' ').trim();
}

// ── Tables ──────────────────────────────────────────────────────────────────

function splitTableRow(line: string): string[] {
    return line.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
}

function isTableAlignmentRow(cells: string[]): boolean {
    return cells.length > 0 && cells.every(c => /^:?-+:?$/.test(c.trim()));
}

function tableToProse(headers: string[], rows: string[][], mode: 'row-prose' | 'header-summary' | 'omit'): string {
    if (mode === 'omit' || rows.length === 0) return '';
    if (mode === 'header-summary') {
        const cleanHeaders = headers.map(h => stripInlineFormattingMinimal(h)).filter(Boolean);
        return `Table with ${rows.length} ${rows.length === 1 ? 'row' : 'rows'}, columns: ${cleanHeaders.join(', ')}.`;
    }
    // row-prose
    const sentences: string[] = [];
    rows.forEach((row, idx) => {
        const ordinal = ORDINALS[idx] ?? `Row ${idx + 1}`;
        const parts: string[] = [];
        row.forEach((cell, colIdx) => {
            const header = stripInlineFormattingMinimal(headers[colIdx] ?? '');
            const cleanCell = stripInlineFormattingMinimal(cell);
            if (!cleanCell) return;
            parts.push(header ? `${header}: ${cleanCell}` : cleanCell);
        });
        if (parts.length > 0) {
            sentences.push(`${ordinal}. ${parts.join('. ')}.`);
        }
    });
    return sentences.join(' ');
}

/** Lighter inline strip used inside table cells — same idea as stripInlineFormatting but with no opts. */
function stripInlineFormattingMinimal(text: string): string {
    return text
        .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
        .replace(/\[\[([^\]]+)\]\]/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/_([^_]+)_/g, '$1')
        .trim();
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function capitalize(s: string): string {
    if (!s) return s;
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function dedupe<T>(arr: T[]): T[] {
    return Array.from(new Set(arr));
}

function computeStats(text: string, sectionCount: number): ProseStats {
    const charCount = text.length;
    const wordCount = text ? text.trim().split(/\s+/).length : 0;
    const estReadSeconds = Math.ceil(charCount / SPEAKING_RATE_CHARS_PER_SECOND);
    return { charCount, wordCount, estReadSeconds, sectionCount };
}
