/**
 * HTML to Markdown Converter
 * Preserves hyperlinks and basic formatting
 */

/**
 * Convert HTML to Markdown, preserving hyperlinks
 */
export function htmlToMarkdown(html: string): string {
    // Create a temporary DOM element
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    const doc = template.content;

    // Process the DOM tree
    return processNode(doc).trim();
}

function processNode(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent || '';
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
        return '';
    }

    const element = node as Element;
    const tagName = element.tagName?.toLowerCase() || '';
    const children = Array.from(element.childNodes)
        .map(child => processNode(child))
        .join('');

    switch (tagName) {
        // Links - preserve href
        case 'a': {
            const href = element.getAttribute('href');
            if (href && children.trim()) {
                // Clean up the link text
                const cleanText = children.trim().replace(/\s+/g, ' ');
                return `[${cleanText}](${href})`;
            }
            return children;
        }

        // Headers
        case 'h1': return `\n# ${children.trim()}\n`;
        case 'h2': return `\n## ${children.trim()}\n`;
        case 'h3': return `\n### ${children.trim()}\n`;
        case 'h4': return `\n#### ${children.trim()}\n`;
        case 'h5': return `\n##### ${children.trim()}\n`;
        case 'h6': return `\n###### ${children.trim()}\n`;

        // Paragraphs and line breaks
        case 'p': return `\n${children}\n`;
        case 'br': return '\n';
        case 'hr': return '\n---\n';

        // Lists
        case 'ul':
        case 'ol':
            return `\n${children}\n`;
        case 'li': {
            const parent = element.parentElement;
            const isOrdered = parent?.tagName?.toLowerCase() === 'ol';
            const prefix = isOrdered ? '1. ' : '- ';
            return `${prefix}${children.trim()}\n`;
        }

        // Formatting
        case 'strong':
        case 'b':
            return children.trim() ? `**${children.trim()}**` : '';
        case 'em':
        case 'i':
            return children.trim() ? `*${children.trim()}*` : '';
        case 'code':
            return children.trim() ? `\`${children.trim()}\`` : '';
        case 'pre':
            return `\n\`\`\`\n${children.trim()}\n\`\`\`\n`;
        case 'mark':
            return children.trim() ? `==${children.trim()}==` : '';
        case 'del':
        case 's':
        case 'strike':
            return children.trim() ? `~~${children.trim()}~~` : '';

        // Block quotes
        case 'blockquote': {
            const lines = children.trim().split('\n');
            return '\n' + lines.map(line => `> ${line}`).join('\n') + '\n';
        }

        // Images - preserve as markdown
        case 'img': {
            const src = element.getAttribute('src');
            const alt = element.getAttribute('alt') || '';
            return src ? `![${alt}](${src})` : '';
        }

        // Tables (basic support)
        case 'table':
            return `\n${children}\n`;
        case 'thead':
        case 'tbody':
            return children;
        case 'tr': {
            const cells = children.trim();
            if (cells) {
                return `| ${cells} |\n`;
            }
            return '';
        }
        case 'th':
        case 'td':
            return `${children.trim()} | `;

        // Skip these elements
        case 'script':
        case 'style':
        case 'noscript':
            return '';

        // Divs, spans, sections, articles, etc. - just return children
        case 'div':
        case 'span':
        case 'section':
        case 'article':
        case 'main':
        case 'aside':
        case 'header':
        case 'footer':
        case 'nav':
        case 'figure':
        case 'figcaption':
        default:
            return children;
    }
}

/**
 * Clean up markdown output
 */
export function cleanMarkdown(md: string): string {
    return md
        // Remove excessive newlines (more than 2)
        .replace(/\n{3,}/g, '\n\n')
        // Remove leading/trailing whitespace from lines but preserve structure
        .split('\n')
        .map(line => line.trimEnd())
        .join('\n')
        // Remove leading/trailing whitespace from entire document
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
