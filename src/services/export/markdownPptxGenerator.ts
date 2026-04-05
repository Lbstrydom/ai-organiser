/**
 * PPTX Generator
 *
 * Converts markdown content to PowerPoint (.pptx) format using pptxgenjs.
 * Each H1/H2 heading starts a new slide. Content below becomes slide body.
 *
 * Also exports `generatePptxFromDeck()` for structured DeckModel input —
 * preserves slide types (title/section/content/closing) and speaker notes.
 *
 * Design: Pure function (no Obsidian dependencies), lazy-loads pptxgenjs.
 */

import { parseMarkdown, extractTables } from '../../utils/markdownParser';
import type { MarkdownTable } from '../../utils/markdownParser';

// ── Export Theme ─────────────────────────────────────────────────────────────

export interface ExportTheme {
    primaryColor: string;  // Heading / title text + title slide bg (hex, no #)
    accentColor: string;   // Accent bar + table header fill
    sectionBg: string;     // Section-divider slide background
    bodyColor: string;     // Body text color
    fontFace: string;
    fontSize: number;      // Body font size in points
}

export const COLOR_SCHEMES: Record<string, Omit<ExportTheme, 'fontFace' | 'fontSize'>> = {
    'navy-gold':          { primaryColor: '1A3A5C', accentColor: 'F5C842', sectionBg: '1D6B4A', bodyColor: '2D4A5A' },
    'forest-amber':       { primaryColor: '1B4F2A', accentColor: 'E8921A', sectionBg: '1A4A2F', bodyColor: '2D4B3A' },
    'slate-coral':        { primaryColor: '2D3748', accentColor: 'E05252', sectionBg: '374151', bodyColor: '4A5568' },
    'burgundy-champagne': { primaryColor: '6B1A2A', accentColor: 'F0D9A0', sectionBg: '4A1A22', bodyColor: '5C2C35' },
    'charcoal-sky':       { primaryColor: '1F2937', accentColor: '38BDF8', sectionBg: '111827', bodyColor: '374151' },
};

function hexToRgb(hex: string): [number, number, number] {
    const h = hex.replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function rgbToHex(r: number, g: number, b: number): string {
    return [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
function darkenHex(hex: string, amt: number): string {
    const [r, g, b] = hexToRgb(hex);
    return rgbToHex(r * (1 - amt), g * (1 - amt), b * (1 - amt));
}
function lightenHex(hex: string, amt: number): string {
    const [r, g, b] = hexToRgb(hex);
    return rgbToHex(r + (255 - r) * amt, g + (255 - g) * amt, b + (255 - b) * amt);
}

/** Resolve settings into a full ExportTheme. Falls back to navy-gold if scheme unknown. */
export function resolveTheme(
    scheme: string,
    primaryColor: string,
    accentColor: string,
    fontFace: string,
    fontSize: number
): ExportTheme {
    if (scheme === 'custom') {
        const p = primaryColor || '1A3A5C';
        return {
            primaryColor: p,
            accentColor: accentColor || 'F5C842',
            sectionBg: darkenHex(p, 0.10),
            bodyColor: lightenHex(p, 0.20),
            fontFace,
            fontSize,
        };
    }
    const preset = COLOR_SCHEMES[scheme] ?? COLOR_SCHEMES['navy-gold'];
    return { ...preset, fontFace, fontSize };
}

/** Minimal deck model for structured PPTX generation. */
export interface DeckModel {
    title?: string;
    slides: Array<{
        id: string;
        title: string;
        subtitle?: string;
        bullets: string[];
        type?: 'title' | 'section' | 'content' | 'closing';
        notes?: string;
    }>;
}

export interface PptxOptions {
    title?: string;
    includeTitle?: boolean;
    layout?: 'title-content' | 'blank';
    theme?: ExportTheme;
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

    // Resolve theme from options, falling back to navy-gold default
    const theme = options.theme ?? resolveTheme('navy-gold', '1A3A5C', 'F5C842', 'Noto Sans', 14);
    const headingColor = theme.primaryColor;
    const bodyColor    = theme.bodyColor;
    const accentColor  = theme.accentColor;
    const fontFace     = theme.fontFace;
    // Title slide
    if (options.includeTitle && options.title) {
        const titleSlide = pptx.addSlide();
        titleSlide.addText(options.title, {
            x: 0.5, y: 1.5, w: '90%', h: 2,
            fontSize: 36, bold: true, color: headingColor,
            align: 'center', valign: 'middle', fontFace,
        });
    }

    // Content slides
    for (const slideData of slides) {
        const slide = pptx.addSlide();

        // Slide title
        slide.addText(slideData.title, {
            x: 0.5, y: 0.3, w: '90%', h: 0.8,
            fontSize: 24, bold: true, color: headingColor,
            fontFace,
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
                fontSize: theme.fontSize, color: bodyColor,
                valign: 'top', wrap: true,
                fontFace,
            });

            bodyY += textHeight + 0.2;
        }

        // Tables
        for (const table of slideData.tables) {
            const remainingH = bodyMaxH - (bodyY - 1.2) + 1;
            if (remainingH < 1) break; // Not enough room

            const tableData: Array<Array<{ text: string; options: Record<string, unknown> }>> = [];

            // Header row
            tableData.push(table.headers.map(h => ({
                text: h, options: { bold: true, fontSize: 10, color: 'FFFFFF', fill: { color: accentColor } }
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

// ── DeckModel-based PPTX generator ────────────────────────────────────────────

/**
 * Generate a PPTX from a structured DeckModel.
 * Preserves slide types (title/section/content/closing), subtitles, and speaker notes.
 * Section slides render as full Midnight Blue divider pages.
 */
export async function generatePptxFromDeck(
    deck: DeckModel,
    options: PptxOptions = {}
): Promise<ArrayBuffer> {
    const PptxGenJS = (await import('pptxgenjs')).default;
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_WIDE';

    // Resolve theme from options, falling back to navy-gold default
    const theme = options.theme ?? resolveTheme('navy-gold', '1A3A5C', 'F5C842', 'Noto Sans', 14);
    const headingColor = theme.primaryColor;
    const bodyColor    = theme.bodyColor;
    const accentColor  = theme.accentColor;
    const sectionBg    = theme.sectionBg;
    const fontFace     = theme.fontFace;

    for (const slideModel of deck.slides) {
        const slideType = slideModel.type ?? 'content';

        if (slideType === 'section') {
            // ── Section divider: full background + centred white heading ──
            const slide = pptx.addSlide();
            slide.background = { color: sectionBg };
            slide.addText(slideModel.title, {
                x: 0.5, y: 2.0, w: '90%', h: 2.5,
                fontSize: 36, bold: true, color: 'FFFFFF',
                align: 'center', valign: 'middle',
                fontFace,
            });
            if (slideModel.notes) slide.addNotes(slideModel.notes);
            continue;
        }

        if (slideType === 'title') {
            // ── Title slide: navy background, white text ──
            const slide = pptx.addSlide();
            slide.background = { color: headingColor };
            slide.addText(slideModel.title, {
                x: 0.5, y: 1.5, w: '90%', h: 2,
                fontSize: 40, bold: true, color: 'FFFFFF',
                align: 'center', valign: 'middle', fontFace,
            });
            if (slideModel.subtitle) {
                slide.addText(slideModel.subtitle, {
                    x: 0.5, y: 3.6, w: '90%', h: 0.8,
                    fontSize: 18, color: 'CCDDEE',
                    align: 'center', valign: 'middle', fontFace,
                });
            }
            if (slideModel.notes) slide.addNotes(slideModel.notes);
            continue;
        }

        if (slideType === 'closing') {
            // ── Closing slide: green background, white text ──
            const slide = pptx.addSlide();
            slide.background = { color: sectionBg };
            slide.addText(slideModel.title, {
                x: 0.5, y: 2.0, w: '90%', h: 2,
                fontSize: 32, bold: true, color: 'FFFFFF',
                align: 'center', valign: 'middle', fontFace,
            });
            if (slideModel.subtitle) {
                slide.addText(slideModel.subtitle, {
                    x: 0.5, y: 4.1, w: '90%', h: 0.7,
                    fontSize: 16, color: 'CCEECC',
                    align: 'center', fontFace,
                });
            }
            if (slideModel.notes) slide.addNotes(slideModel.notes);
            continue;
        }

        // ── Default content slide ──────────────────────────────────────────
        const slide = pptx.addSlide();

        // Yellow accent bar at top
        slide.addShape('rect', {
            x: 0, y: 0, w: '100%', h: 0.08,
            fill: { color: accentColor },
            line: { width: 0 },
        });

        // Title
        slide.addText(slideModel.title, {
            x: 0.5, y: 0.3, w: '90%', h: 0.8,
            fontSize: 24, bold: true, color: headingColor, fontFace,
        });

        // Subtitle (shown below title on content slides that have one)
        let bodyY = 1.2;
        if (slideModel.subtitle) {
            slide.addText(slideModel.subtitle, {
                x: 0.5, y: 1.1, w: '90%', h: 0.5,
                fontSize: 16, color: bodyColor, italic: true,
                fontFace,
            });
            bodyY = 1.7;
        }

        // Bullet body
        if (slideModel.bullets.length > 0) {
            const bulletObjects = slideModel.bullets.map((b: string) => ({
                text: b,
                options: {
                    bullet: true,
                    fontSize: theme.fontSize,
                    color: bodyColor,
                    fontFace,
                },
            }));
            const textHeight = Math.min(5.5 - (bodyY - 1.2), slideModel.bullets.length * 0.35 + 0.3);
            slide.addText(bulletObjects, {
                x: 0.5, y: bodyY, w: '90%', h: textHeight,
                valign: 'top',
            });
        }

        if (slideModel.notes) slide.addNotes(slideModel.notes);
    }

    const output = await pptx.write({ outputType: 'arraybuffer' });
    return output as ArrayBuffer;
}
