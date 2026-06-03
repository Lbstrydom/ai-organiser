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
import { safeHex } from '../presentationIr/themeSafe';

export interface DocxOptions {
    title?: string;
    includeTitle?: boolean;
    includeToc?: boolean;
    fontFace?: string;   // default: 'Calibri'
    fontSize?: number;   // body font size in points (default: 11); headings scale proportionally
    /** Heading + title colour (6-hex, no `#`). Brand exports pass the brand
     *  primary colour for §5 H1 font+colour parity; absent → docx default
     *  (theme-coloured headings), byte-identical to today. */
    headingColor?: string;
    /** Brand table-font floor (points). When a brand min-font is present, table
     *  cell text is sized at `max(fontSize, tableMinFont)`; absent → table uses
     *  `fontSize` (or the legacy 10pt default). (audit M3) */
    tableMinFont?: number;
}

export async function generateDocx(
    markdownContent: string,
    options: DocxOptions = {}
): Promise<ArrayBuffer> {
    const { Document, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
        WidthType, AlignmentType, TableOfContents, Packer, ShadingType } = await import('docx');

    const docFont = options.fontFace ?? 'Calibri';
    // Validate untrusted brand options before they enter half-point arithmetic
    // (audit M7): a non-finite fontSize/tableMinFont would otherwise poison the
    // `* 2` math with NaN, and a malformed headingColor would reach the docx
    // colour field unchecked. fontSize/tableMinFont fall back to their defaults;
    // headingColor degrades to undefined (docx's own theme heading colour).
    const fontSize = Number.isFinite(options.fontSize) ? (options.fontSize as number) : 11;
    const tableMinFont = Number.isFinite(options.tableMinFont) ? (options.tableMinFont as number) : 0;
    const bodyHalfPt = fontSize * 2;  // docx uses half-points
    // Table cell font (audit M3): apply the body fontSize, floored by the brand
    // table min-font when present. Default (no options) → 10pt, byte-identical.
    const tablePt = Math.max(Number.isFinite(options.fontSize) ? (options.fontSize as number) : 10, tableMinFont);
    const tableHalfPt = tablePt * 2;
    // Brand heading colour (§5 H1). `undefined` → docx default heading style
    // (unchanged). A malformed hex degrades to undefined rather than reaching the
    // docx colour field (audit M7); a valid hex normalises to bare 6-hex.
    const headingColor = options.headingColor
        ? (safeHex(options.headingColor, '').ok ? safeHex(options.headingColor, '').hex : undefined)
        : undefined;
    const headingColorOpt = headingColor ? { color: headingColor } : {};

    const lines = parseMarkdown(markdownContent, false);
    const tables = extractTables(lines);

    const children: Array<import('docx').Paragraph | import('docx').Table | import('docx').TableOfContents> = [];

    // Title
    if (options.includeTitle && options.title) {
        children.push(new Paragraph({
            children: [new TextRun({ text: options.title, bold: true, size: 36, font: docFont, ...headingColorOpt })],
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
            children.push(buildDocxTable(tableEntry.table, { Table, TableRow, TableCell, Paragraph, TextRun, WidthType, ShadingType }, docFont, tableHalfPt));
            children.push(new Paragraph({ children: [], spacing: { after: 100 } }));
            i = tableEntry.end - 1; // skip to end of table
            continue;
        }

        // Skip lines that are part of a table (shouldn't happen if table entry was found, but safety check)
        if (isInTableRange(i)) continue;

        switch (line.type) {
            case 'heading1':
                children.push(new Paragraph({
                    children: [new TextRun({ text: line.content, bold: true, size: 32, font: docFont, ...headingColorOpt })],
                    heading: HeadingLevel.HEADING_1,
                    spacing: { before: 240, after: 120 },
                }));
                break;

            case 'heading2':
                children.push(new Paragraph({
                    children: [new TextRun({ text: line.content, bold: true, size: 26, font: docFont, ...headingColorOpt })],
                    heading: HeadingLevel.HEADING_2,
                    spacing: { before: 200, after: 80 },
                }));
                break;

            case 'heading3':
                children.push(new Paragraph({
                    children: [new TextRun({ text: line.content, bold: true, size: 24, font: docFont, ...headingColorOpt })],
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
                    { level: 0, format: 'decimal' as (typeof import('docx').LevelFormat)[keyof typeof import('docx').LevelFormat], text: '%1.', alignment: AlignmentType.START },
                    { level: 1, format: 'lowerLetter' as (typeof import('docx').LevelFormat)[keyof typeof import('docx').LevelFormat], text: '%2)', alignment: AlignmentType.START },
                    { level: 2, format: 'lowerRoman' as (typeof import('docx').LevelFormat)[keyof typeof import('docx').LevelFormat], text: '%3.', alignment: AlignmentType.START },
                    { level: 3, format: 'decimal' as (typeof import('docx').LevelFormat)[keyof typeof import('docx').LevelFormat], text: '%4.', alignment: AlignmentType.START },
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
    docx: Pick<typeof import('docx'), 'Table' | 'TableRow' | 'TableCell' | 'Paragraph' | 'TextRun' | 'WidthType' | 'ShadingType'>,
    docFont: string,
    cellHalfPt: number
): import('docx').Table {
    const { Table, TableRow, TableCell, Paragraph, TextRun, WidthType, ShadingType } = docx;

    const headerRow = new TableRow({
        tableHeader: true,
        children: table.headers.map((header: string) => new TableCell({
            children: [new Paragraph({
                children: [new TextRun({ text: header, bold: true, size: cellHalfPt, font: docFont })],
            })],
            shading: { type: ShadingType.SOLID, color: 'E8E8E8', fill: 'E8E8E8' },
        })),
    });

    const dataRows = table.rows.map((row: string[]) => new TableRow({
        children: row.map((cell: string) => new TableCell({
            children: [new Paragraph({
                children: [new TextRun({ text: cell, size: cellHalfPt, font: docFont })],
            })],
        })),
    }));

    return new Table({
        rows: [headerRow, ...dataRows],
        width: { size: 100, type: WidthType.PERCENTAGE },
    });
}
