/**
 * HTML to Markdown Converter
 * Preserves hyperlinks and basic formatting
 */

export interface HtmlToMarkdownOptions {
    /** If true, table elements are treated like block divs (no | pipe formatting).
     *  Use for HTML emails where tables are layout containers, not data tables. */
    flattenTables?: boolean;
}

/**
 * Convert HTML to Markdown, preserving hyperlinks
 */
export function htmlToMarkdown(html: string, options?: HtmlToMarkdownOptions): string {
    // Create a temporary DOM element
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    const doc = template.content;

    // Strip hidden elements (preheader divs, tracking spans) before processing.
    // Email builders hide preview text with display:none, visibility:hidden, max-height:0, etc.
    if (options?.flattenTables) {
        stripHiddenElements(doc);
    }

    // Process the DOM tree
    return processNode(doc, options).trim();
}

/** Remove elements hidden via inline CSS (common in email HTML for preheader text). */
function stripHiddenElements(root: DocumentFragment | Element): void {
    const hidden = root.querySelectorAll('[style]');
    for (const el of Array.from(hidden)) {
        const style = el.getAttribute('style')?.toLowerCase() || '';
        if (
            /display\s*:\s*none/.test(style) ||
            /visibility\s*:\s*hidden/.test(style) ||
            (/overflow\s*:\s*hidden/.test(style) && /max-height\s*:\s*0/.test(style)) ||
            /font-size\s*:\s*0/.test(style)
        ) {
            el.remove();
        }
    }
}

function processNode(node: Node, options?: HtmlToMarkdownOptions): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
    if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        return Array.from(node.childNodes).map(c => processNode(c, options)).join('');
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const element = node as Element;
    const tagName = element.tagName?.toLowerCase() || '';
    const children = Array.from(element.childNodes).map(c => processNode(c, options)).join('');

    return processTag(tagName, element, children, options);
}

function processTag(tag: string, el: Element, children: string, options?: HtmlToMarkdownOptions): string {
    switch (tag) {
        case 'a': return processLink(el, children);
        case 'h1': return `\n# ${children.trim()}\n`;
        case 'h2': return `\n## ${children.trim()}\n`;
        case 'h3': return `\n### ${children.trim()}\n`;
        case 'h4': return `\n#### ${children.trim()}\n`;
        case 'h5': return `\n##### ${children.trim()}\n`;
        case 'h6': return `\n###### ${children.trim()}\n`;
        case 'p': return `\n${children}\n`;
        case 'br': return '\n';
        case 'hr': return '\n---\n';
        case 'ul': case 'ol': return `\n${children}\n`;
        case 'li': return processListItem(el, children);
        case 'strong': case 'b': return children.trim() ? `**${children.trim()}**` : '';
        case 'em': case 'i': return children.trim() ? `*${children.trim()}*` : '';
        case 'code': return children.trim() ? `\`${children.trim()}\`` : '';
        case 'pre': return `\n\`\`\`\n${children.trim()}\n\`\`\`\n`;
        case 'mark': return children.trim() ? `==${children.trim()}==` : '';
        case 'del': case 's': case 'strike': return children.trim() ? `~~${children.trim()}~~` : '';
        case 'blockquote': return processBlockquote(children);
        case 'img': return processImage(el);
        case 'table': return `\n${children}\n`;
        case 'thead': case 'tbody': return children;
        case 'tr': return processTableRow(children, options);
        case 'th': case 'td': return processTableCell(children, options);
        case 'script': case 'style': case 'noscript': return '';
        default: return children;
    }
}

function processLink(el: Element, children: string): string {
    const href = el.getAttribute('href');
    if (href && children.trim()) {
        return `[${children.trim().replaceAll(/\s+/g, ' ')}](${href})`;
    }
    return children;
}

function processListItem(el: Element, children: string): string {
    const isOrdered = el.parentElement?.tagName?.toLowerCase() === 'ol';
    return `${isOrdered ? '1. ' : '- '}${children.trim()}\n`;
}

function processBlockquote(children: string): string {
    return '\n' + children.trim().split('\n').map(line => `> ${line}`).join('\n') + '\n';
}

function processImage(el: Element): string {
    const src = el.getAttribute('src');
    return src ? `![${el.getAttribute('alt') ?? ''}](${src})` : '';
}

function processTableRow(children: string, options?: HtmlToMarkdownOptions): string {
    const text = children.trim();
    if (!text) return '';
    return options?.flattenTables ? `${text}\n` : `| ${text} |\n`;
}

function processTableCell(children: string, options?: HtmlToMarkdownOptions): string {
    const text = children.trim();
    if (!text) return '';
    if (options?.flattenTables) {
        // Preserve internal newlines so multi-block cells (paragraphs, headings)
        // stay on separate lines instead of merging into one mega-line.
        return `\n${text}\n`;
    }
    return `${text} | `;
}

/**
 * Clean up markdown output
 */
export function cleanMarkdown(md: string): string {
    return md
        // Remove excessive newlines (more than 2)
        .replaceAll(/\n{3,}/g, '\n\n')
        // Remove leading/trailing whitespace from lines but preserve structure
        .split('\n')
        .map(line => line.trimEnd())
        .join('\n')
        // Remove leading/trailing whitespace from entire document
        .trim();
}

// Footer trigger phrases that are ONLY reliable when the line is short (≤120 chars).
// A short line like "Unsubscribe | Manage preferences" is footer boilerplate.
// A long paragraph that mentions "unsubscribe" is editorial content.
const SHORT_LINE_TRIGGERS = [
    'unsubscribe', 'manage preferences', 'manage your preferences',
    'update your preferences', 'update preferences', 'email preferences',
    'view in browser', 'view this email in your browser',
    'privacy policy', 'terms of service', 'terms & conditions',
];

// Footer triggers that are reliable regardless of line length
const ANY_LINE_TRIGGERS = [
    'you are receiving this', 'you received this', 'you\'re receiving this',
    'copyright ©', '© 20', 'all rights reserved',
    'sent to ', 'mailing address', 'our mailing',
];

const FOOTER_SHORT_LINE_MAX = 120;

/** Minimum fraction of content that must precede a footer trigger.
 *  Prevents false positives when footer text appears early due to table flattening. */
const FOOTER_MIN_CONTENT_FRACTION = 0.3;

/**
 * Truncate newsletter markdown at the first footer marker.
 *
 * Short-line triggers (e.g. "unsubscribe") only fire on lines ≤120 chars,
 * preventing false positives when the word appears mid-paragraph in editorial content
 * (e.g. Readwise: "If this content isn't your vibe, please feel free to unsubscribe").
 *
 * Position guard: triggers only fire after 30% of the content has been seen,
 * preventing premature truncation when footer text appears early due to
 * table flattening in layout-heavy emails (e.g. Campaign Monitor).
 */
function stripEmailFooter(md: string): string {
    const lines = md.split('\n');
    const totalChars = md.length;
    let charsSoFar = 0;
    for (let i = 0; i < lines.length; i++) {
        charsSoFar += lines[i].length + 1; // +1 for newline
        // Only check for footer triggers after we've seen enough content
        if (charsSoFar < totalChars * FOOTER_MIN_CONTENT_FRACTION) continue;
        const lower = lines[i].toLowerCase();
        const isShort = lines[i].length <= FOOTER_SHORT_LINE_MAX;
        if (ANY_LINE_TRIGGERS.some(t => lower.includes(t))) {
            return lines.slice(0, i).join('\n');
        }
        if (isShort && SHORT_LINE_TRIGGERS.some(t => lower.includes(t))) {
            return lines.slice(0, i).join('\n');
        }
    }
    return md;
}

/**
 * Additional cleanup for newsletter HTML emails.
 * Removes tracking pixels, spacer table rows, zero-width chars, linked images, and email footers.
 * Apply after cleanMarkdown().
 */
export function cleanNewsletterMarkdown(md: string): string {
    // Zero-width and invisible chars used as email spacers (\u200D excluded — ZWJ can appear in emoji)
    const invisibleChars = /[\u200B\u200C\uFEFF\u00AD]/g;
    return stripEmailFooter(
        md
            .replaceAll(invisibleChars, '')
            // Remove ALL standalone image-only lines (tracking pixels, decorative headers, spacers).
            // \s* before https handles leading whitespace from flattened table cells.
            // \s* inside (URL) handles emails that emit src=" https://..." with a leading space.
            .replaceAll(/^\s*!\[[^\]]*\]\(\s*https?:\/\/[^)]+\)\s*$/gm, '')
            // Remove standalone linked-image lines: [![alt](img)](link) (social icons, ad banners)
            .replaceAll(/^\s*\[!\[[^\]]*\]\([^)]+\)\]\([^)]+\)\s*$/gm, '')
            // Remove table rows that are pure spacers (only pipes and whitespace)
            .replaceAll(/^\|\s*(\|\s*)*\|?\s*$/gm, '')
            // Remove lines that are only non-breaking spaces or whitespace after above passes
            .replaceAll(/^[\s\u00A0]+$/gm, '')
            // Collapse 3+ newlines to 2
            .replaceAll(/\n{3,}/g, '\n\n')
            .trim()
    );
}

/**
 * Extract plain prose text from newsletter markdown for LLM consumption.
 * Strips table pipes, image references, and link URLs — keeps link text and prose.
 */
export function extractNewsletterText(md: string): string {
    return md
        // Remove table rows (lines starting with |)
        .replaceAll(/^\|.*$/gm, '')
        // Remove standalone image references
        .replaceAll(/^!\[.*?\]\(.*?\)\s*$/gm, '')
        // Inline images — keep alt text if meaningful
        .replaceAll(/!\[([^\]]{6,})\]\([^)]+\)/g, '$1')
        .replaceAll(/!\[[^\]]*\]\([^)]+\)/g, '')
        // Markdown links — keep the anchor text, drop URL
        .replaceAll(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        // Strip leftover markdown heading hashes (keep text)
        .replaceAll(/^#{1,6}\s+/gm, '')
        // Collapse excessive whitespace
        .replaceAll(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Extract all links from HTML content
 */
export interface ExtractedLink {
    text: string;
    href: string;
}

export function extractLinks(html: string): ExtractedLink[] {
    const links: ExtractedLink[] = [];
    const seen = new Set<string>();

    const template = document.createElement('template');
    template.innerHTML = html;

    template.content.querySelectorAll('a[href]').forEach(a => {
        const href = a.getAttribute('href');
        const text = a.textContent?.trim();

        // Skip empty, duplicate, or anchor-only links
        if (href && text && !seen.has(href) && !href.startsWith('#')) {
            seen.add(href);
            links.push({ text, href });
        }
    });

    return links;
}
