/**
 * Shared Markdown Parser
 *
 * Extracts semantic line structures from markdown content.
 * Used by PDF, DOCX, and PPTX generators for consistent parsing.
 *
 * Design: Pure functions (no Obsidian dependencies)
 */

/**
 * Semantic markdown line type
 */
export interface MarkdownLine {
    type: 'heading1' | 'heading2' | 'heading3' | 'paragraph' | 'bullet' | 'ordered' | 'blank' | 'table_row' | 'table_separator';
    content: string;
    depth?: number;
    /** For table rows: parsed cell values */
    cells?: string[];
}

/**
 * A parsed markdown table (consecutive table rows)
 */
export interface MarkdownTable {
    headers: string[];
    rows: string[][];
}

/**
 * Preprocess markdown to remove blocks that should never reach the parser.
 * - Strips Obsidian comments (inline and multi-line)
 * - Removes image embeds (wiki-style and markdown-style)
 * - Removes HTML comments (e.g., AIO JSON comments)
 */
export function preprocessMarkdown(markdown: string): string {
    return markdown
        // Obsidian comments: %% ... %% (supports multi-line)
        .replace(/%%[\s\S]*?%%/g, '')
        // HTML comments: <!-- ... -->
        .replace(/<!--[\s\S]*?-->/g, '')
        // Obsidian wiki image embeds: ![[image.png]]
        .replace(/!\[\[.*?\]\]/g, '')
        // Markdown image embeds: ![alt](url)
        .replace(/!\[[^\]]*]\([^)]*\)/g, '')
        // Blockquote / Obsidian callout prefixes: strip "> " from line starts
        // so tables, headings, and lists inside callouts are parsed correctly
        .replace(/^> ?/gm, '');
}

/**
 * Sanitize Obsidian-specific markdown syntax to plain text.
 * - Convert [[Internal Link]] to plain text
 * - Convert [[Link|Display Text]] to Display Text
 * - Remove bold/italic markers (keep text)
 * - Remove strikethrough markers
 * - Strip inline code backticks but keep text
 */
export function sanitizeText(text: string): string {
    let result = text;

    // Internal links: [[Link|Display]] or [[Link]]
    result = result.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2');
    result = result.replace(/\[\[([^\]]+)\]\]/g, '$1');

    // External links: [Display](url)
    result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

    // Bold: **text** or __text__
    result = result.replace(/\*\*([^\*]+)\*\*/g, '$1');
    result = result.replace(/__([^_]+)__/g, '$1');

    // Italic: *text* or _text_
    result = result.replace(/\*([^\*]+)\*/g, '$1');
    result = result.replace(/_([^_]+)_/g, '$1');

    // Strikethrough: ~~text~~
    result = result.replace(/~~([^~]+)~~/g, '$1');

    // Inline code: `text` -> text
    result = result.replace(/`([^`]+)`/g, '$1');

    // Highlight: ==text== -> text
    result = result.replace(/==([^=]+)==/g, '$1');

    // Subscript/Superscript: ~text~ or ^text^
    result = result.replace(/~([^~]+)~/g, '$1');
    result = result.replace(/\^([^^]+)\^/g, '$1');

    return result.trim();
}

/**
 * Parse markdown content into semantic lines.
 * Strips complex blocks and Obsidian-specific syntax.
 */
export function parseMarkdown(
    markdown: string,
    includeFrontmatter: boolean = false
): MarkdownLine[] {
    const lines: MarkdownLine[] = [];
    const cleanedMarkdown = preprocessMarkdown(markdown);
    const rawLines = cleanedMarkdown.split('\n');

    let inCodeBlock = false;
    let frontmatterEnd = 0;

    // Track frontmatter
    if (rawLines[0]?.trim() === '---') {
        for (let i = 1; i < rawLines.length; i++) {
            if (rawLines[i]?.trim() === '---') {
                frontmatterEnd = i + 1;
                break;
            }
        }
    }

    // Parse lines
    for (let i = 0; i < rawLines.length; i++) {
        // Skip frontmatter unless requested
        if (i < frontmatterEnd) {
            if (includeFrontmatter && i > 0 && i < frontmatterEnd - 1) {
                const line = rawLines[i].trim();
                if (line && !line.startsWith('---')) {
                    lines.push({ type: 'paragraph', content: line });
                }
            }
            continue;
        }

        const rawLine = rawLines[i];
        const trimmed = rawLine?.trim() || '';

        // Skip empty lines but track them
        if (!trimmed) {
            if (lines.length > 0 && lines[lines.length - 1].type !== 'blank') {
                lines.push({ type: 'blank', content: '' });
            }
            continue;
        }

        // Skip code blocks
        if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
            inCodeBlock = !inCodeBlock;
            continue;
        }

        if (inCodeBlock) continue;

        // Skip HTML tags
        if (trimmed.startsWith('<')) continue;

        // Skip Dataview blocks
        if (trimmed.startsWith('```dataview') || trimmed.startsWith('```query')) {
            inCodeBlock = true;
            continue;
        }

        // Skip comment blocks
        if (trimmed.startsWith('%%')) continue;

        // Parse table separator row (e.g., |---|---|)
        if (/^\|[\s\-:]+(\|[\s\-:]+)+\|?\s*$/.test(trimmed)) {
            lines.push({ type: 'table_separator', content: trimmed });
            continue;
        }

        // Parse table row (e.g., | Cell | Cell |)
        if (trimmed.startsWith('|') && trimmed.includes('|', 1)) {
            const cells = trimmed
                .split('|')
                .slice(1) // remove leading empty from first |
                .map(c => c.trim())
                .filter((_, idx, arr) => idx < arr.length - (trimmed.endsWith('|') ? 1 : 0));
            // Filter out if last element is empty (trailing pipe)
            const cleanCells = cells.filter((c, idx) => idx < cells.length || c !== '');
            lines.push({
                type: 'table_row',
                content: trimmed,
                cells: cleanCells.map(c => sanitizeText(c))
            });
            continue;
        }

        // Parse heading
        const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
        if (headingMatch) {
            const level = headingMatch[1].length;
            const content = sanitizeText(headingMatch[2]);
            const type = (`heading${level}`) as MarkdownLine['type'];
            lines.push({ type, content });
            continue;
        }

        // Parse unordered list
        const bulletMatch = trimmed.match(/^(\s*)([-*+])\s+(.+)$/);
        if (bulletMatch) {
            const depth = bulletMatch[1].length / 2;
            const content = sanitizeText(bulletMatch[3]);
            lines.push({ type: 'bullet', content, depth: Math.max(0, depth) });
            continue;
        }

        // Parse ordered list
        const orderedMatch = trimmed.match(/^(\s*)(\d+)\.\s+(.+)$/);
        if (orderedMatch) {
            const depth = orderedMatch[1].length / 2;
            const content = `${orderedMatch[2]}. ${sanitizeText(orderedMatch[3])}`;
            lines.push({ type: 'ordered', content, depth: Math.max(0, depth) });
            continue;
        }

        // Regular paragraph
        const sanitized = sanitizeText(trimmed);
        if (sanitized) {
            lines.push({ type: 'paragraph', content: sanitized });
        }
    }

    return lines;
}

/**
 * Extract consecutive table lines into structured tables.
 * Returns groups of tables found in the parsed lines.
 */
export function extractTables(lines: MarkdownLine[]): { startIndex: number; table: MarkdownTable }[] {
    const tables: { startIndex: number; table: MarkdownTable }[] = [];
    let i = 0;

    while (i < lines.length) {
        // Look for table_row followed by table_separator
        if (lines[i].type === 'table_row' && i + 1 < lines.length && lines[i + 1].type === 'table_separator') {
            const startIndex = i;
            const headers = lines[i].cells || [];
            i += 2; // skip header + separator

            const rows: string[][] = [];
            while (i < lines.length && lines[i].type === 'table_row') {
                rows.push(lines[i].cells || []);
                i++;
            }

            tables.push({ startIndex, table: { headers, rows } });
        } else {
            i++;
        }
    }

    return tables;
}
