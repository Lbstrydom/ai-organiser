/**
 * PPTX Generator
 *
 * Converts markdown content to PowerPoint (.pptx) format using pptxgenjs.
 * Each H1/H2 heading starts a new slide. Content below becomes slide body.
 *
 * Design: Pure function (no Obsidian dependencies), lazy-loads pptxgenjs.
 */

import { parseMarkdown, extractTables } from '../../utils/markdownParser';
import type { MarkdownLine, MarkdownTable } from '../../utils/markdownParser';

export interface PptxOptions {
    title?: string;
    includeTitle?: boolean;
    layout?: 'title-content' | 'blank';
}

interface SlideData {
    title: string;
    bodyLines: string[];
    tables: MarkdownTable[];
}

export async function generatePptx(
    markdownContent: string,
    options: PptxOptions = {}
): Promise<ArrayBuffer> {
    const PptxGenJS = (await import('pptxgenjs')).default;

    const lines = parseMarkdown(markdownContent, false);
    const tables = extractTables(lines);

    // Build slide data by splitting on H1/H2 headings
    const slides: SlideData[] = [];
    let currentSlide: SlideData | null = null;

    // Track which line indices are part of tables
    const tableRanges: { start: number; end: number; table: MarkdownTable }[] = [];
    for (const t of tables) {
        const end = t.startIndex + 2 + t.table.rows.length;
        tableRanges.push({ start: t.startIndex, end, table: t.table });
    }

    function isInTableRange(index: number): { inTable: boolean; tableStart?: number } {
        for (const r of tableRanges) {
            if (index >= r.start && index < r.end) return { inTable: true, tableStart: r.start };
        }
        return { inTable: false };
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // H1 or H2 starts a new slide
        if (line.type === 'heading1' || line.type === 'heading2') {
            if (currentSlide) slides.push(currentSlide);
            currentSlide = { title: line.content, bodyLines: [], tables: [] };
            continue;
        }

        // If no heading yet, create a default slide
        if (!currentSlide) {
            currentSlide = { title: options.title || 'Untitled', bodyLines: [], tables: [] };
        }

        // Check if this is the start of a table
        const tableEntry = tableRanges.find(r => r.start === i);
        if (tableEntry) {
            currentSlide.tables.push(tableEntry.table);
            i = tableEntry.end - 1;
            continue;
        }

        // Skip table interior lines
        const { inTable } = isInTableRange(i);
        if (inTable) continue;

        switch (line.type) {
            case 'heading3':
                currentSlide.bodyLines.push(`**${line.content}**`);
                break;
            case 'bullet':
                currentSlide.bodyLines.push(`${'  '.repeat(line.depth || 0)}- ${line.content}`);
                break;
            case 'ordered':
                currentSlide.bodyLines.push(`${'  '.repeat(line.depth || 0)}${line.content}`);
                break;
            case 'paragraph':
                if (line.content.trim()) {
                    currentSlide.bodyLines.push(line.content);
                }
                break;
            case 'blank':
                if (currentSlide.bodyLines.length > 0) {
                    currentSlide.bodyLines.push('');
                }
                break;
            default:
                break;
        }
    }

    if (currentSlide) slides.push(currentSlide);

    // If no slides were created, make one with all content
    if (slides.length === 0) {
        slides.push({
            title: options.title || 'Untitled',
            bodyLines: lines.filter(l => l.type === 'paragraph' || l.type === 'bullet').map(l => l.content),
            tables: tables.map(t => t.table),
        });
    }

    // Generate PPTX
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_WIDE';

    // Title slide
    if (options.includeTitle && options.title) {
        const titleSlide = pptx.addSlide();
        titleSlide.addText(options.title, {
            x: 0.5, y: 1.5, w: '90%', h: 2,
            fontSize: 36, bold: true, color: '333333',
            align: 'center', valign: 'middle',
        });
    }

    // Content slides
    for (const slideData of slides) {
        const slide = pptx.addSlide();

        // Slide title
        slide.addText(slideData.title, {
            x: 0.5, y: 0.3, w: '90%', h: 0.8,
            fontSize: 24, bold: true, color: '333333',
        });

        // Calculate available body area
        let bodyY = 1.2;
        const bodyMaxH = 5.5;

        // Body text
        if (slideData.bodyLines.length > 0) {
            const bodyText = slideData.bodyLines.join('\n');
            const textHeight = Math.min(
                bodyMaxH - (slideData.tables.length > 0 ? 2.5 : 0),
                slideData.bodyLines.length * 0.3 + 0.5
            );

            slide.addText(bodyText, {
                x: 0.5, y: bodyY, w: '90%', h: textHeight,
                fontSize: 14, color: '555555',
                valign: 'top', wrap: true,
            });

            bodyY += textHeight + 0.2;
        }

        // Tables
        for (const table of slideData.tables) {
            const remainingH = bodyMaxH - (bodyY - 1.2) + 1;
            if (remainingH < 1) break; // Not enough room

            const tableData: any[][] = [];

            // Header row
            tableData.push(table.headers.map(h => ({
                text: h, options: { bold: true, fontSize: 10, color: 'FFFFFF', fill: { color: '4472C4' } }
            })));

            // Data rows
            for (const row of table.rows) {
                tableData.push(row.map(cell => ({
                    text: cell, options: { fontSize: 10, color: '333333' }
                })));
            }

            const rowH = Math.min(0.35, remainingH / (tableData.length + 1));

            slide.addTable(tableData, {
                x: 0.5, y: bodyY, w: 12,
                rowH,
                border: { type: 'solid', pt: 0.5, color: 'CCCCCC' },
                colW: table.headers.map(() => 12 / table.headers.length),
                autoPage: false,
            });

            bodyY += tableData.length * rowH + 0.3;
        }
    }

    // Generate ArrayBuffer
    const output = await pptx.write({ outputType: 'arraybuffer' });
    return output as ArrayBuffer;
}
