/**
 * DOCX Generator
 *
 * Converts markdown content to Word (.docx) format using the `docx` library.
 * Uses shared markdown parser for consistent rendering across export formats.
 *
 * Design: Pure function (no Obsidian dependencies), lazy-loads `docx` library.
 */

import { parseMarkdown, extractTables } from '../../utils/markdownParser';
import type { MarkdownTable } from '../../utils/markdownParser';

export interface DocxOptions {
    title?: string;
    includeTitle?: boolean;
    includeToc?: boolean;
    fontFace?: string;   // default: 'Calibri'
    fontSize?: number;   // body font size in points (default: 11); headings scale proportionally
}

export async function generateDocx(
    markdownContent: string,
    options: DocxOptions = {}
): Promise<ArrayBuffer> {
    const { Document, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
        WidthType, AlignmentType, TableOfContents, Packer, BorderStyle, ShadingType } = await import('docx');

    const docFont = options.fontFace ?? 'Calibri';
    const bodyHalfPt = (options.fontSize ?? 11) * 2;  // docx uses half-points

    const lines = parseMarkdown(markdownContent, false);
    const tables = extractTables(lines);
    const _tableStartIndices = new Set(tables.map(t => t.startIndex));

    const children: any[] = [];

    // Title
    if (options.includeTitle && options.title) {
        children.push(new Paragraph({
            children: [new TextRun({ text: options.title, bold: true, size: 36, font: docFont })],
            heading: HeadingLevel.TITLE,
            spacing: { after: 200 },
        }));
    }

    // Table of contents
    if (options.includeToc) {
        children.push(new TableOfContents('Table of Contents', {
            hyperlink: true,
            headingStyleRange: '1-3',
        }));
        children.push(new Paragraph({ children: [], spacing: { after: 200 } }));
    }

    // Build table lookup for quick index range checks
    const tableRanges: { start: number; end: number; table: MarkdownTable }[] = [];
    for (const t of tables) {
        // header row + separator row + data rows
        const end = t.startIndex + 2 + t.table.rows.length;
        tableRanges.push({ start: t.startIndex, end, table: t.table });
    }

    function isInTableRange(index: number): boolean {
        return tableRanges.some(r => index >= r.start && index < r.end);
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // If this index is the start of a table, render the table and skip its lines
        const tableEntry = tableRanges.find(r => r.start === i);
        if (tableEntry) {
            children.push(buildDocxTable(tableEntry.table, { Table, TableRow, TableCell, Paragraph, TextRun, WidthType, BorderStyle, ShadingType }, docFont));
            children.push(new Paragraph({ children: [], spacing: { after: 100 } }));
            i = tableEntry.end - 1; // skip to end of table
            continue;
        }

        // Skip lines that are part of a table (shouldn't happen if table entry was found, but safety check)
        if (isInTableRange(i)) continue;

        switch (line.type) {
            case 'heading1':
                children.push(new Paragraph({
                    children: [new TextRun({ text: line.content, bold: true, size: 32, font: docFont })],
                    heading: HeadingLevel.HEADING_1,
                    spacing: { before: 240, after: 120 },
                }));
                break;

            case 'heading2':
                children.push(new Paragraph({
                    children: [new TextRun({ text: line.content, bold: true, size: 26, font: docFont })],
                    heading: HeadingLevel.HEADING_2,
                    spacing: { before: 200, after: 80 },
                }));
                break;

            case 'heading3':
                children.push(new Paragraph({
                    children: [new TextRun({ text: line.content, bold: true, size: 24, font: docFont })],
                    heading: HeadingLevel.HEADING_3,
                    spacing: { before: 160, after: 60 },
                }));
                break;

            case 'bullet':
                children.push(new Paragraph({
                    children: [new TextRun({ text: line.content, size: bodyHalfPt, font: docFont })],
                    bullet: { level: Math.min(line.depth || 0, 3) },
                    spacing: { after: 40 },
                }));
                break;

            case 'ordered':
                children.push(new Paragraph({
                    children: [new TextRun({ text: line.content, size: bodyHalfPt, font: docFont })],
                    numbering: { reference: 'default-numbering', level: Math.min(line.depth || 0, 3) },
                    spacing: { after: 40 },
                }));
                break;

            case 'paragraph':
                if (line.content.trim()) {
                    children.push(new Paragraph({
                        children: [new TextRun({ text: line.content, size: bodyHalfPt, font: docFont })],
                        spacing: { after: 120 },
                    }));
                }
                break;

            case 'blank':
                children.push(new Paragraph({ children: [], spacing: { after: 60 } }));
                break;

            default:
                break;
        }
    }

    const doc = new Document({
        numbering: {
            config: [{
                reference: 'default-numbering',
                levels: [
                    { level: 0, format: 'decimal' as any, text: '%1.', alignment: AlignmentType.START },
                    { level: 1, format: 'lowerLetter' as any, text: '%2)', alignment: AlignmentType.START },
                    { level: 2, format: 'lowerRoman' as any, text: '%3.', alignment: AlignmentType.START },
                    { level: 3, format: 'decimal' as any, text: '%4.', alignment: AlignmentType.START },
                ],
            }],
        },
        sections: [{
            properties: {},
            children,
        }],
        ...(options.includeToc ? { features: { updateFields: true } } : {}),
    });

    const buffer = await Packer.toBuffer(doc);
    // Packer.toBuffer returns a Node Buffer; convert to ArrayBuffer
    const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    return ab as ArrayBuffer;
}

function buildDocxTable(
    table: MarkdownTable,
    docx: any,
    docFont: string
): any {
    const { Table, TableRow, TableCell, Paragraph, TextRun, WidthType, ShadingType } = docx;

    const headerRow = new TableRow({
        tableHeader: true,
        children: table.headers.map((header: string) => new TableCell({
            children: [new Paragraph({
                children: [new TextRun({ text: header, bold: true, size: 20, font: docFont })],
            })],
            shading: { type: ShadingType.SOLID, color: 'E8E8E8', fill: 'E8E8E8' },
        })),
    });

    const dataRows = table.rows.map((row: string[]) => new TableRow({
        children: row.map((cell: string) => new TableCell({
            children: [new Paragraph({
                children: [new TextRun({ text: cell, size: 20, font: docFont })],
            })],
        })),
    }));

    return new Table({
        rows: [headerRow, ...dataRows],
        width: { size: 100, type: WidthType.PERCENTAGE },
    });
}
