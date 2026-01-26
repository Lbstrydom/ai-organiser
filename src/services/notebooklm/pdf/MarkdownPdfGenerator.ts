/**
 * Semantic PDF Generator for NotebookLM
 *
 * Converts markdown content to PDF using jsPDF with semantic rendering:
 * - Handles H1-H3 headings, lists, and paragraphs
 * - Strips complex blocks (HTML, Dataview, code fences) for clean AI parsing
 * - Sanitizes Obsidian-specific syntax
 * - Latin-only fonts (v1 limitation)
 *
 * Design: Pure function (no Obsidian types/dependencies)
 */

import jsPDF from 'jspdf';
import type { IPdfGenerator, PdfConfig } from '../types';

/**
 * Semantic markdown line type
 */
interface MarkdownLine {
    type: 'heading1' | 'heading2' | 'heading3' | 'paragraph' | 'bullet' | 'ordered' | 'blank';
    content: string;
    depth?: number; // For lists
}

/**
 * Markdown PDF Generator
 * Pure function-based generator (no side effects, no Obsidian dependencies)
 */
export class MarkdownPdfGenerator implements IPdfGenerator {
    /**
     * Generate a PDF from markdown content
     *
     * @param title - Note title (used as H1 if includeTitle is true)
     * @param markdownContent - Markdown text content
     * @param config - PDF configuration
     * @returns PDF as ArrayBuffer
     */
    async generate(
        title: string,
        markdownContent: string,
        config: PdfConfig
    ): Promise<ArrayBuffer> {
        // Initialize PDF document
        const doc = new jsPDF({
            orientation: 'portrait',
            unit: 'mm',
            format: config.pageSize as any,
        });

        // Set font
        doc.setFont(config.fontName);
        doc.setFontSize(config.fontSize);

        // Calculate dimensions
        const pageWidth = doc.internal.pageSize.getWidth();
        const pageHeight = doc.internal.pageSize.getHeight();
        const contentWidth = pageWidth - config.marginX * 2;
        let yPosition = config.marginY;

        // Helper to add text with word wrapping and pagination
        const addWrappedText = (text: string, isBold: boolean = false, fontSize?: number): number => {
            const currentFontSize = fontSize || config.fontSize;
            doc.setFontSize(currentFontSize);
            if (isBold) doc.setFont(config.fontName, 'bold');

            // Split text into lines and wrap
            const lines = doc.splitTextToSize(text, contentWidth);

            for (const line of lines) {
                // Check if we need a new page
                if (yPosition + currentFontSize * config.lineHeight > pageHeight - config.marginY) {
                    doc.addPage();
                    yPosition = config.marginY;
                }

                doc.text(line, config.marginX, yPosition);
                yPosition += currentFontSize * config.lineHeight;
            }

            // Reset font to normal
            if (isBold) doc.setFont(config.fontName, 'normal');

            return yPosition;
        };

        // Parse markdown into semantic lines
        const lines = this.parseMarkdown(markdownContent, config.includeFrontmatter);

        // Add title if configured
        if (config.includeTitle && title) {
            const headingSize = config.fontSize * 1.8;
            yPosition = addWrappedText(title, true, headingSize) + config.fontSize * 0.5;
        }

        // Render each line
        for (const line of lines) {
            switch (line.type) {
                case 'heading1':
                    yPosition = addWrappedText(line.content, true, config.fontSize * 1.6) + config.fontSize * 0.5;
                    break;

                case 'heading2':
                    yPosition = addWrappedText(line.content, true, config.fontSize * 1.3) + config.fontSize * 0.3;
                    break;

                case 'heading3':
                    yPosition = addWrappedText(line.content, true, config.fontSize * 1.1) + config.fontSize * 0.2;
                    break;

                case 'bullet': {
                    const indentX = config.marginX + (line.depth || 0) * 5;
                    const bulletWidth = contentWidth - (line.depth || 0) * 5;
                    const bulletLines = doc.splitTextToSize(line.content, bulletWidth - 5);

                    for (let i = 0; i < bulletLines.length; i++) {
                        if (yPosition + config.fontSize * config.lineHeight > pageHeight - config.marginY) {
                            doc.addPage();
                            yPosition = config.marginY;
                        }

                        // First line gets bullet point
                        if (i === 0) {
                            doc.text('- ', indentX, yPosition);
                            doc.text(bulletLines[i], indentX + 5, yPosition);
                        } else {
                            // Continuation lines are indented
                            doc.text(bulletLines[i], indentX + 5, yPosition);
                        }

                        yPosition += config.fontSize * config.lineHeight;
                    }
                    yPosition += config.fontSize * 0.3;
                    break;
                }

                case 'ordered': {
                    const indentX = config.marginX + (line.depth || 0) * 5;
                    const numWidth = contentWidth - (line.depth || 0) * 5;
                    // Extract number from content (e.g., "1. text" -> "1.")
                    const match = line.content.match(/^(\d+\.\s*)/);
                    const prefix = match ? match[1] : '- ';
                    const contentText = line.content.replace(/^\d+\.\s*/, '');
                    const orderedLines = doc.splitTextToSize(contentText, numWidth - 10);

                    for (let i = 0; i < orderedLines.length; i++) {
                        if (yPosition + config.fontSize * config.lineHeight > pageHeight - config.marginY) {
                            doc.addPage();
                            yPosition = config.marginY;
                        }

                        if (i === 0) {
                            doc.text(prefix, indentX, yPosition);
                            doc.text(orderedLines[i], indentX + 10, yPosition);
                        } else {
                            doc.text(orderedLines[i], indentX + 10, yPosition);
                        }

                        yPosition += config.fontSize * config.lineHeight;
                    }
                    yPosition += config.fontSize * 0.3;
                    break;
                }

                case 'paragraph':
                    if (line.content.trim()) {
                        yPosition = addWrappedText(line.content) + config.fontSize * 0.5;
                    }
                    break;

                case 'blank':
                    yPosition += config.fontSize * 0.5;
                    break;
            }
        }

        // Convert to ArrayBuffer
        const pdfBytes = doc.output('arraybuffer');
        return pdfBytes;
    }

    /**
     * Parse markdown content into semantic lines
     * Strips complex blocks and Obsidian-specific syntax
     */
    private parseMarkdown(
        markdown: string,
        includeFrontmatter: boolean
    ): MarkdownLine[] {
        const lines: MarkdownLine[] = [];
        const cleanedMarkdown = this.preprocessMarkdown(markdown);
        const rawLines = cleanedMarkdown.split('\n');

        let inFrontmatter = false;
        let inCodeBlock = false;
        let frontmatterEnd = 0;

        // Track frontmatter
        if (rawLines[0]?.trim() === '---') {
            inFrontmatter = true;
            for (let i = 1; i < rawLines.length; i++) {
                if (rawLines[i]?.trim() === '---') {
                    frontmatterEnd = i + 1;
                    inFrontmatter = false;
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
                        // Simple YAML key: value rendering
                        lines.push({
                            type: 'paragraph',
                            content: line,
                        });
                    }
                }
                continue;
            }

            const rawLine = rawLines[i];
            const trimmed = rawLine?.trim() || '';

            // Skip empty lines in processing but track them
            if (!trimmed) {
                if (lines.length > 0 && lines[lines.length - 1].type !== 'blank') {
                    lines.push({ type: 'blank', content: '' });
                }
                continue;
            }

            // Skip code blocks and other complex elements
            if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
                inCodeBlock = !inCodeBlock;
                continue;
            }

            if (inCodeBlock) {
                continue;
            }

            // Skip HTML
            if (trimmed.startsWith('<')) {
                continue;
            }

            // Skip Dataview blocks
            if (trimmed.startsWith('```dataview') || trimmed.startsWith('```query')) {
                inCodeBlock = true;
                continue;
            }

            // Skip comment blocks
            if (trimmed.startsWith('%%')) {
                continue;
            }

            // Parse heading
            const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
            if (headingMatch) {
                const level = headingMatch[1].length;
                const content = this.sanitizeText(headingMatch[2]);
                const type = (`heading${level}` as any) as MarkdownLine['type'];
                lines.push({ type, content });
                continue;
            }

            // Parse unordered list
            const bulletMatch = trimmed.match(/^(\s*)([-*+])\s+(.+)$/);
            if (bulletMatch) {
                const depth = bulletMatch[1].length / 2;
                const content = this.sanitizeText(bulletMatch[3]);
                lines.push({
                    type: 'bullet',
                    content,
                    depth: Math.max(0, depth),
                });
                continue;
            }

            // Parse ordered list
            const orderedMatch = trimmed.match(/^(\s*)(\d+)\.\s+(.+)$/);
            if (orderedMatch) {
                const depth = orderedMatch[1].length / 2;
                const content = `${orderedMatch[2]}. ${this.sanitizeText(orderedMatch[3])}`;
                lines.push({
                    type: 'ordered',
                    content,
                    depth: Math.max(0, depth),
                });
                continue;
            }

            // Regular paragraph - sanitize Obsidian syntax
            const sanitized = this.sanitizeText(trimmed);
            if (sanitized) {
                lines.push({
                    type: 'paragraph',
                    content: sanitized,
                });
            }
        }

        return lines;
    }

    /**
     * Sanitize Obsidian-specific markdown syntax
     * - Convert [[Internal Link]] to Internal Link
     * - Convert [[Link|Display Text]] to Display Text
     * - Remove bold/italic markers (keep text)
     * - Remove strikethrough markers
     * - Strip inline code backticks but keep text
     */
    private sanitizeText(text: string): string {
        let result = text;

        // Internal links: [[Link|Display]] or [[Link]]
        result = result.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2'); // [[Link|Display]] -> Display
        result = result.replace(/\[\[([^\]]+)\]\]/g, '$1'); // [[Link]] -> Link

        // External links: [Display](url)
        result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'); // [Display](url) -> Display

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
     * Preprocess markdown to remove blocks that should never reach the parser.
     * - Strips Obsidian comments (inline and multi-line)
     * - Removes image embeds (wiki-style and markdown-style)
     */
    private preprocessMarkdown(markdown: string): string {
        return markdown
            // Obsidian comments: %% ... %% (supports multi-line)
            .replace(/%%[\s\S]*?%%/g, '')
            // Obsidian wiki image embeds: ![[image.png]]
            .replace(/!\[\[.*?\]\]/g, '')
            // Markdown image embeds: ![alt](url)
            .replace(/!\[[^\]]*]\([^)]*\)/g, '');
    }

    /**
     * Stub for future image embedding (v2+)
     * v1: images are silently skipped in markdown parsing
     */
    private embedImage(doc: jsPDF, imagePath: string): void {
        // TODO: v2 - implement image embedding with base64 encoding
        // For now, this is a no-op; images are stripped by markdown parser
    }
}
