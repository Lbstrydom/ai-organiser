/**
 * Export Service
 *
 * Orchestrates single-note and multi-note export to PDF, DOCX and PPTX formats.
 * Handles frontmatter stripping, content concatenation, and vault file creation.
 */

import { TFile, Vault } from 'obsidian';
import { generateDocx } from './markdownDocxGenerator';
import type { DocxOptions } from './markdownDocxGenerator';
import { generatePptx, generatePptxFromHtml, resolveTheme } from './markdownPptxGenerator';
import type { PptxOptions, ExportTheme } from './markdownPptxGenerator';

/** Minimal theme used when a caller invokes presentation-HTML export
 *  without an explicit theme. Matches the default navy-gold palette the
 *  Export modal resolves from settings. */
function defaultTheme(): ExportTheme {
    return resolveTheme('navy-gold', '1A3A5C', 'F5C842', 'Noto Sans', 14);
}
import { MarkdownPdfGenerator } from '../notebooklm/pdf/MarkdownPdfGenerator';
import { DEFAULT_PDF_CONFIG } from '../notebooklm/types';
import { preprocessMarkdown } from '../../utils/markdownParser';
import { ensureFolderExists, getAvailableFilePath, sanitizeFileName } from '../../utils/minutesUtils';

export type ExportFormat = 'pdf' | 'docx' | 'pptx';

export interface ExportConfig {
    format: ExportFormat;
    outputFolder: string;
    notes: TFile[];
    includeToc?: boolean;
    slideLayout?: 'title-content' | 'blank';
    theme?: ExportTheme;
    /** Pre-rendered presentation HTML (from the presentation chat pipeline).
     *  When present + format === 'pptx', exportNotes routes through the rich
     *  parser + renderer (`generatePptxFromHtml`) which preserves layout
     *  intent — two-column, stats-grid, tables, speaker notes — instead of
     *  the lossy markdown-to-bullets fallback. Required by Phase 2E of
     *  sister-backport-impl; Gemini gate G2 (2026-04-21). */
    presentationHtml?: string;
    /** Optional deck title used when exporting presentation HTML. Falls
     *  back to the combined note title if omitted. */
    presentationTitle?: string;
}

export interface ExportResult {
    filePath: string;
    format: ExportFormat;
    noteCount: number;
}

export class ExportService {
    private vault: Vault;

    constructor(vault: Vault) {
        this.vault = vault;
    }

    async exportNotes(config: ExportConfig): Promise<ExportResult> {
        const { format, outputFolder, notes } = config;

        // Read and prepare content
        const contents: { title: string; content: string }[] = [];
        for (const note of notes) {
            const raw = await this.vault.cachedRead(note);
            const stripped = this.stripFrontmatter(raw);
            const cleaned = preprocessMarkdown(stripped);
            contents.push({ title: note.basename, content: cleaned });
        }

        // Build combined markdown for multi-note export
        let combinedTitle: string;
        let combinedMarkdown: string;

        if (contents.length === 1) {
            combinedTitle = contents[0].title;
            combinedMarkdown = contents[0].content;
        } else {
            combinedTitle = `Export - ${contents.length} notes`;
            const sections = contents.map(c =>
                `# ${c.title}\n\n${c.content}`
            );
            combinedMarkdown = sections.join('\n\n---\n\n');
        }

        // Generate the document
        let buffer: ArrayBuffer;

        if (format === 'pdf') {
            const pdfGenerator = new MarkdownPdfGenerator();
            const pdfConfig = {
                ...DEFAULT_PDF_CONFIG,
                includeTitle: contents.length > 1,
            };
            buffer = await pdfGenerator.generate(combinedTitle, combinedMarkdown, pdfConfig);
        } else if (format === 'docx') {
            const docxOptions: DocxOptions = {
                title: contents.length > 1 ? combinedTitle : undefined,
                includeTitle: contents.length > 1,
                includeToc: config.includeToc ?? false,
                fontFace: config.theme?.fontFace,
                fontSize: config.theme?.fontSize,
            };
            buffer = await generateDocx(combinedMarkdown, docxOptions);
        } else if (config.presentationHtml) {
            // Phase 2E route: presentation deck HTML → rich PPTX with real
            // text boxes, tables, stat cards, speaker notes. Fallback to the
            // markdown path if the parser yields zero slides (unusual HTML
            // shape) so we still ship a usable file. Gemini gate G2.
            const richBuffer = await generatePptxFromHtml(
                config.presentationHtml,
                config.theme ?? defaultTheme(),
                config.presentationTitle ?? combinedTitle,
            );
            if (richBuffer) {
                buffer = richBuffer;
            } else {
                const pptxOptions: PptxOptions = {
                    title: combinedTitle,
                    includeTitle: true,
                    layout: config.slideLayout ?? 'title-content',
                    theme: config.theme,
                };
                buffer = await generatePptx(combinedMarkdown, pptxOptions);
            }
        } else {
            const pptxOptions: PptxOptions = {
                title: combinedTitle,
                includeTitle: true,
                layout: config.slideLayout ?? 'title-content',
                theme: config.theme,
            };
            buffer = await generatePptx(combinedMarkdown, pptxOptions);
        }

        // Save to vault
        const extensionMap: Record<ExportFormat, string> = { pdf: '.pdf', docx: '.docx', pptx: '.pptx' };
        const extension = extensionMap[format];
        const safeTitle = sanitizeFileName(
            contents.length === 1 ? contents[0].title : combinedTitle
        );
        const fileName = `${safeTitle}${extension}`;

        await ensureFolderExists(this.vault, outputFolder);
        const targetPath = await getAvailableFilePath(this.vault, outputFolder, fileName);
        await this.vault.createBinary(targetPath, buffer);

        return {
            filePath: targetPath,
            format,
            noteCount: notes.length,
        };
    }

    private stripFrontmatter(content: string): string {
        const lines = content.split('\n');
        if (lines[0]?.trim() !== '---') return content;

        for (let i = 1; i < lines.length; i++) {
            if (lines[i]?.trim() === '---') {
                return lines.slice(i + 1).join('\n');
            }
        }
        return content;
    }
}
