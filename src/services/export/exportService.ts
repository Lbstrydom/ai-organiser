/**
 * Export Service
 *
 * Orchestrates single-note and multi-note export to PDF, DOCX and PPTX formats.
 * Handles frontmatter stripping, content concatenation, and vault file creation.
 */

import { TFile, Vault } from 'obsidian';
import { generateDocx } from './markdownDocxGenerator';
import type { DocxOptions } from './markdownDocxGenerator';
import { generatePptx } from './markdownPptxGenerator';
import type { PptxOptions, ExportTheme } from './markdownPptxGenerator';
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
