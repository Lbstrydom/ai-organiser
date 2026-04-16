/**
 * Text Preprocessor for NotebookLM Export
 *
 * Pure function — no Obsidian types, fully testable.
 * Converts Obsidian markdown to clean text for NotebookLM.
 *
 * Line-state tokenizer with explicit precedence (evaluated top-down per line):
 *   1. YAML frontmatter — kept or stripped per options
 *   2. Fenced blocks — strip dataview/dataviewjs, keep all others verbatim
 *   3. Obsidian comments (%%) — strip inline and block forms
 *   4. HTML blocks — strip entirely
 *   5. Image embeds — replace with [Image: name]
 *   6. Everything else — emit verbatim
 */

/** Increment whenever preprocessing behaviour changes — triggers full re-export for incremental packs */
export const PREPROCESSOR_VERSION = 1;

export interface PreprocessorOptions {
    includeFrontmatter: boolean;
    includeTitle: boolean;
    title: string;
}

type ProcessorState = 'NORMAL' | 'IN_FRONTMATTER' | 'IN_FENCE' | 'IN_COMMENT' | 'IN_HTML';

/** Self-closing HTML tags that never have a closing counterpart */
const SELF_CLOSING_HTML_BLOCK_TAGS = new Set(['hr']);

const IMAGE_EXTENSIONS = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tiff', 'avif', 'heic'
]);

/** Block-level HTML tags that open an HTML block (stripped entirely) */
const HTML_BLOCK_TAGS = new Set([
    'div', 'p', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
    'ul', 'ol', 'li', 'blockquote', 'pre', 'form', 'nav',
    'header', 'footer', 'section', 'article', 'aside', 'main',
    'figure', 'figcaption', 'details', 'summary', 'hr',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6'
]);

/** Match inline Obsidian comments: %%content%% on a single line */
const INLINE_COMMENT_RE = /%%[^%\n]*%%/g;

function isImageExtension(ext: string): boolean {
    return IMAGE_EXTENSIONS.has(ext.toLowerCase());
}

function getExtension(nameOrPath: string): string {
    const clean = nameOrPath.split('?')[0];
    const lastDot = clean.lastIndexOf('.');
    return lastDot >= 0 ? clean.slice(lastDot + 1) : '';
}

/** Replace image embed syntax with [Image: name] placeholder */
function replaceImageEmbeds(line: string): string {
    // ![[filename.ext]] or ![[path/to/file.ext|alias]]
    line = line.replace(/!\[\[([^\]]+)\]\]/g, (match, inner: string) => {
        const name = inner.split('|')[0].trim();
        const ext = getExtension(name);
        if (!isImageExtension(ext)) return match; // not an image — preserve
        const basename = name.split('/').pop()?.replace(/\.[^.]+$/, '') ?? name;
        return `[Image: ${basename}]`;
    });

    // ![alt](url)
    line = line.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt: string, url: string) => {
        const ext = getExtension(url);
        if (!isImageExtension(ext)) return match; // not an image — preserve
        const label = alt.trim() || (url.split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'image');
        return `[Image: ${label}]`;
    });

    return line;
}

/** Parse an opening fence line: returns char, length, language — or null if not a fence */
function parseFence(line: string): { char: string; length: number; language: string } | null {
    const trimmed = line.trimStart();
    const char = trimmed[0];
    if (char !== '`' && char !== '~') return null;
    let len = 0;
    while (len < trimmed.length && trimmed[len] === char) len++;
    if (len < 3) return null;
    const language = trimmed.slice(len).trim().toLowerCase().split(/\s+/)[0] ?? '';
    return { char, length: len, language };
}

/** Return the block-level HTML tag name for the line, or null */
function htmlBlockTag(line: string): string | null {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('<')) return null;
    const m = trimmed.match(/^<\/?([a-zA-Z][a-zA-Z0-9-]*)/);
    if (!m) return null;
    const tag = m[1].toLowerCase();
    return HTML_BLOCK_TAGS.has(tag) ? tag : null;
}

/**
 * Preprocess an Obsidian note for NotebookLM text export.
 *
 * Returns a UTF-8 string suitable for encoding as a .txt source file.
 */
export function preprocessNoteForNotebookLM(
    content: string,
    options: PreprocessorOptions
): string {
    const rawLines = content.split('\n');
    const output: string[] = [];

    let state: ProcessorState = 'NORMAL';
    let fenceChar = '';
    let fenceLength = 0;
    let stripCurrentFence = false;
    let frontmatterBuffer: string[] = [];
    let htmlOpenTag = '';

    // Prepend title if requested
    if (options.includeTitle && options.title) {
        output.push(`# ${options.title}`, '');
    }

    for (let i = 0; i < rawLines.length; i++) {
        const line = rawLines[i];

        // ── 1. YAML FRONTMATTER ───────────────────────────────────────────────
        if (i === 0 && line.trim() === '---') {
            state = 'IN_FRONTMATTER';
            if (options.includeFrontmatter) frontmatterBuffer.push(line);
            continue;
        }

        if (state === 'IN_FRONTMATTER') {
            if (line.trim() === '---') {
                state = 'NORMAL';
                if (options.includeFrontmatter) {
                    frontmatterBuffer.push(line);
                    output.push(...frontmatterBuffer, '');
                }
                frontmatterBuffer = [];
            } else {
                if (options.includeFrontmatter) frontmatterBuffer.push(line);
            }
            continue;
        }

        // ── 2. FENCED BLOCKS ─────────────────────────────────────────────────
        if (state === 'IN_FENCE') {
            const trimmed = line.trimStart();
            // Count leading fence chars
            let closeLen = 0;
            while (closeLen < trimmed.length && trimmed[closeLen] === fenceChar) closeLen++;
            const isClosingFence = closeLen >= fenceLength && trimmed.slice(closeLen).trim() === '';

            if (isClosingFence) {
                state = 'NORMAL';
                if (!stripCurrentFence) output.push(line);
            } else {
                if (!stripCurrentFence) output.push(line);
            }
            continue;
        }

        if (state === 'NORMAL') {
            const fence = parseFence(line);
            if (fence) {
                fenceChar = fence.char;
                fenceLength = fence.length;
                stripCurrentFence = fence.language === 'dataview' || fence.language === 'dataviewjs';
                state = 'IN_FENCE';
                if (!stripCurrentFence) output.push(line);
                continue;
            }
        }

        // ── 3. OBSIDIAN BLOCK COMMENTS (%%) ──────────────────────────────────
        if (state === 'IN_COMMENT') {
            if (line.includes('%%')) state = 'NORMAL';
            continue; // strip all comment content
        }

        if (state === 'NORMAL' && line.trim() === '%%') {
            state = 'IN_COMMENT';
            continue;
        }

        // ── 4. HTML BLOCKS ───────────────────────────────────────────────────
        if (state === 'IN_HTML') {
            const trimmedHtml = line.trim();
            if (trimmedHtml === '') {
                // Blank line always terminates an HTML block
                state = 'NORMAL';
            } else if (htmlOpenTag && trimmedHtml === `</${htmlOpenTag}>`) {
                // Matching closing tag — exit block state (strip the closing tag too)
                state = 'NORMAL';
            }
            continue;
        }

        if (state === 'NORMAL') {
            const tag = htmlBlockTag(line);
            if (tag) {
                if (SELF_CLOSING_HTML_BLOCK_TAGS.has(tag)) {
                    // Single-line self-closing element — strip just this line
                    continue;
                }
                htmlOpenTag = tag;
                state = 'IN_HTML';
                continue;
            }
        }

        // ── 5 & 6. NORMAL LINE PROCESSING ────────────────────────────────────
        let processed = line;
        // Strip complete inline Obsidian comments first: %%text%%
        processed = processed.replace(INLINE_COMMENT_RE, '');
        // Detect unclosed %% — remainder of line is a block comment opener
        const openCommentIdx = processed.indexOf('%%');
        if (openCommentIdx >= 0) {
            // Emit everything before the unclosed %%, enter block comment state
            processed = processed.slice(0, openCommentIdx);
            state = 'IN_COMMENT';
            processed = replaceImageEmbeds(processed);
            output.push(processed);
            continue;
        }
        // Replace image embeds with placeholders
        processed = replaceImageEmbeds(processed);
        output.push(processed);
    }

    return output.join('\n');
}
