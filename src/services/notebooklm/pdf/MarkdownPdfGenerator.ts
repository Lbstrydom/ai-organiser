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
import { parseMarkdown, extractTables } from '../../../utils/markdownParser';

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
    generate(
        title: string,
        markdownContent: string,
        config: PdfConfig
    ): Promise<ArrayBuffer> {
        // Initialize PDF document
        const doc = new jsPDF({
            orientation: 'portrait',
            unit: 'mm',
            format: config.pageSize as string | number[],
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

        // Parse markdown into semantic lines (using shared parser)
        const lines = parseMarkdown(markdownContent, config.includeFrontmatter);
        const tables = extractTables(lines);

        // Build table range lookup
        const tableRanges: { start: number; end: number; headers: string[]; rows: string[][] }[] = [];
        for (const t of tables) {
            const end = t.startIndex + 2 + t.table.rows.length;
            tableRanges.push({ start: t.startIndex, end, headers: t.table.headers, rows: t.table.rows });
        }

        // Helper: render a table as a grid
        const renderTable = (headers: string[], rows: string[][]): void => {
            const colCount = headers.length;
            if (colCount === 0) return;

            const tableFontSize = Math.max(config.fontSize * 0.75, 7);
            const cellPadding = 2;
            const rowHeight = tableFontSize * config.lineHeight + cellPadding * 2;
            const colWidth = contentWidth / colCount;

            doc.setFontSize(tableFontSize);

            // Draw header row
            if (yPosition + rowHeight > pageHeight - config.marginY) {
                doc.addPage();
                yPosition = config.marginY;
            }

            // Header background
            doc.setFillColor(232, 232, 232);
            doc.rect(config.marginX, yPosition - tableFontSize * 0.3, contentWidth, rowHeight, 'F');

            doc.setFont(config.fontName, 'bold');
            for (let c = 0; c < colCount; c++) {
                const cellX = config.marginX + c * colWidth + cellPadding;
                const cellText = doc.splitTextToSize(headers[c] || '', colWidth - cellPadding * 2);
                doc.text(cellText[0] || '', cellX, yPosition + cellPadding);
            }
            yPosition += rowHeight;

            // Draw data rows
            doc.setFont(config.fontName, 'normal');
            for (const row of rows) {
                if (yPosition + rowHeight > pageHeight - config.marginY) {
                    doc.addPage();
                    yPosition = config.marginY;
                }

                // Light row border
                doc.setDrawColor(200, 200, 200);
                doc.line(config.marginX, yPosition - tableFontSize * 0.3, config.marginX + contentWidth, yPosition - tableFontSize * 0.3);

                for (let c = 0; c < colCount; c++) {
                    const cellX = config.marginX + c * colWidth + cellPadding;
                    const cellText = doc.splitTextToSize(row[c] || '', colWidth - cellPadding * 2);
                    doc.text(cellText[0] || '', cellX, yPosition + cellPadding);
                }
                yPosition += rowHeight;
            }

            // Bottom border
            doc.setDrawColor(200, 200, 200);
            doc.line(config.marginX, yPosition - tableFontSize * 0.3, config.marginX + contentWidth, yPosition - tableFontSize * 0.3);

            yPosition += config.fontSize * 0.5;
            doc.setFontSize(config.fontSize);
        };

        // Add title if configured
        if (config.includeTitle && title) {
            const headingSize = config.fontSize * 1.8;
            yPosition = addWrappedText(title, true, headingSize) + config.fontSize * 0.5;
        }

        // Render each line
        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
            // Check if this line starts a table
            const tableEntry = tableRanges.find(r => r.start === lineIdx);
            if (tableEntry) {
                renderTable(tableEntry.headers, tableEntry.rows);
                lineIdx = tableEntry.end - 1; // skip to end of table
                continue;
            }

            // Skip lines that are part of a table
            if (tableRanges.some(r => lineIdx >= r.start && lineIdx < r.end)) continue;

            const line = lines[lineIdx];
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

                default:
                    break;
            }
        }

        // Convert to ArrayBuffer
        const pdfBytes = doc.output('arraybuffer');
        return Promise.resolve(pdfBytes);
    }
}
