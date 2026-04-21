/**
 * Document Extraction Service
 * Extracts text from Office documents (DOCX, XLSX, PPTX) for meeting context
 */

import { App, TFile, requestUrl } from 'obsidian';
import { EXTRACTABLE_DOCUMENT_EXTENSIONS, SPREADSHEET_EXTENSIONS } from '../core/constants';
import { logger } from '../utils/logger';
import { extractSpreadsheet } from './spreadsheetService';

export interface DocumentExtractionResult {
    success: boolean;
    text?: string;
    metadata?: {
        title?: string;
        author?: string;
    };
    error?: string;
}

export const EXTRACTABLE_EXTENSIONS: string[] = [...EXTRACTABLE_DOCUMENT_EXTENSIONS];

export class DocumentExtractionService {
    private app: App;

    constructor(app: App) {
        this.app = app;
    }

    /**
     * Extract text from a document file
     */
    async extractText(file: TFile): Promise<DocumentExtractionResult> {
        const ext = file.extension.toLowerCase();

        // Handle PDFs separately (basic text extraction only)
        if (ext === 'pdf') {
            return this.extractPdfText(file);
        }

        // Check if we can extract from this file type
        if (!this.canExtract(file)) {
            return {
                success: false,
                error: `Unsupported file type: ${ext}`
            };
        }

        try {
            if (ext === 'txt') {
                return await this.extractTextFile(file);
            }

            if (ext === 'rtf') {
                return await this.extractRtfFile(file);
            }

            // Phase 3 (sister-backport): route xlsx/csv/xls through the
            // structured spreadsheet extractor so the LLM gets markdown
            // tables with row/col counts instead of officeparser's flat
            // text dump that loses column boundaries.
            if ((SPREADSHEET_EXTENSIONS as readonly string[]).includes(ext)) {
                return await this.extractSpreadsheetFile(file);
            }

            const arrayBuffer = await this.app.vault.readBinary(file);

            // Dynamic import for tree-shaking
            const officeParser = await this.loadOfficeParser();
            if (!officeParser) {
                return {
                    success: false,
                    error: 'Office document parsing not available'
                };
            }

            const result = await officeParser.parseOffice(arrayBuffer);
            const text = result.toText();

            return {
                success: true,
                text
            };

        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to extract text'
            };
        }
    }

    /**
     * Check if a file can be extracted
     */
    canExtract(file: TFile): boolean {
        const ext = file.extension.toLowerCase();
        return EXTRACTABLE_EXTENSIONS.includes(ext) || ext === 'pdf';
    }

    /**
     * Extract text from a plain text file
     */
    private async extractTextFile(file: TFile): Promise<DocumentExtractionResult> {
        const content = await this.app.vault.read(file);
        return { success: true, text: content };
    }

    /**
     * Extract text from an RTF file (basic support)
     */
    private async extractRtfFile(file: TFile): Promise<DocumentExtractionResult> {
        const content = await this.app.vault.read(file);
        const text = this.parseRtf(content);

        if (!this.isReadableText(text)) {
            return {
                success: false,
                error: 'Complex RTF formatting not supported. Try saving as .docx or .txt.'
            };
        }

        return { success: true, text };
    }

    /**
     * Extract structured markdown tables from xlsx/csv/xls files.
     * Delegates to spreadsheetService which enforces OOM-safety limits.
     */
    private async extractSpreadsheetFile(file: TFile): Promise<DocumentExtractionResult> {
        const arrayBuffer = await this.app.vault.readBinary(file);
        const result = extractSpreadsheet(arrayBuffer, file.name);
        if (!result.success) {
            return { success: false, error: result.error ?? 'Failed to parse spreadsheet' };
        }
        return { success: true, text: result.markdown };
    }

    /**
     * Load the officeparser library dynamically
     */
    private async loadOfficeParser(): Promise<{ parseOffice: (input: ArrayBuffer | string) => Promise<{ toText: () => string }> } | null> {
        try {
            const officeParser = await import('officeparser');
            return officeParser;
        } catch {
            // Library not installed or not available
            logger.warn('Core', 'officeparser not available');
            return null;
        }
    }

    /**
     * Extract text from PDF
     * Tries officeparser first (proper PDF parsing), falls back to basic byte extraction
     */
    private async extractPdfText(file: TFile): Promise<DocumentExtractionResult> {
        try {
            const arrayBuffer = await this.app.vault.readBinary(file);

            // Try officeparser first — proper PDF text extraction
            const officeParser = await this.loadOfficeParser();
            if (officeParser) {
                try {
                    const result = await officeParser.parseOffice(arrayBuffer);
                    const text = result.toText();
                    if (text && text.trim().length > 0) {
                        logger.debug('Core', `PDF extracted via officeparser: ${text.length} chars`);
                        return { success: true, text };
                    }
                    logger.debug('Core', 'officeparser returned empty text for PDF');
                } catch (e) {
                    logger.warn('Core', 'officeparser PDF extraction failed:', e instanceof Error ? e.message : e);
                }
            }

            // Fallback: basic byte-level extraction (filters PDF structural terms)
            const text = this.extractTextFromPdfBytes(arrayBuffer);

            if (text && text.trim().length > 0) {
                logger.debug('Core', `PDF extracted via byte fallback: ${text.length} chars`);
                return { success: true, text };
            } else {
                return {
                    success: false,
                    error: 'PDF appears to be image-based or encrypted. Use multimodal summarization instead.'
                };
            }
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to extract PDF text'
            };
        }
    }

    /**
     * Basic PDF text extraction from raw bytes
     * This is a simple approach that works for text-based PDFs
     */
    /**
     * PDF structural keywords to filter out from byte-level extraction.
     * These are PDF operators/dictionary keys, not readable content.
     */
    private static readonly PDF_STRUCTURAL_TERMS = new Set([
        'XObject', 'SMask', 'FlateDecode', 'DeviceRGB', 'DeviceGray', 'DeviceCMYK',
        'ColorSpace', 'BitsPerComponent', 'Interpolate', 'PatternType', 'Shading',
        'ShadingType', 'Coords', 'Extend', 'Function', 'FunctionType', 'Size',
        'Decode', 'Range', 'BitsPerSample', 'Domain', 'Encode', 'Order',
        'MediaBox', 'Contents', 'Group', 'Transparency', 'StructParents',
        'ExtGState', 'Font', 'ProcSet', 'Identity', 'Resources', 'Tabs',
        'Type', 'Subtype', 'Filter', 'Length', 'Width', 'Height',
        'ICCBased', 'Catalog', 'Pages', 'Page', 'Outlines', 'Metadata',
        'TrimBox', 'BleedBox', 'CropBox', 'ArtBox', 'Annots', 'MarkInfo',
        'StructTreeRoot', 'ViewerPreferences', 'PageLayout', 'PageMode',
        'DCTDecode', 'ASCIIHexDecode', 'ASCII85Decode', 'LZWDecode',
        'RunLengthDecode', 'CCITTFaxDecode', 'JBIG2Decode', 'JPXDecode'
    ]);

    private extractTextFromPdfBytes(buffer: ArrayBuffer): string {
        const bytes = new Uint8Array(buffer);
        const text: string[] = [];

        const decoder = new TextDecoder('latin1');
        const content = decoder.decode(bytes);

        // Extract text from parenthesized strings (PDF text operators)
        const textRegex = /\(([^)]+)\)/g;

        let match;
        while ((match = textRegex.exec(content)) !== null) {
            const extracted = match[1]
                .replace(/\\n/g, '\n')
                .replace(/\\r/g, '')
                .replace(/\\t/g, '\t')
                .replace(/\\\(/g, '(')
                .replace(/\\\)/g, ')')
                .replace(/\\\\/g, '\\');

            const trimmed = extracted.trim();
            // Filter out PDF structural terms and very short tokens
            if (trimmed && trimmed.length > 1 && !DocumentExtractionService.PDF_STRUCTURAL_TERMS.has(trimmed)) {
                text.push(extracted);
            }
        }

        // Clean up and join
        const result = text.join(' ')
            .replace(/\s+/g, ' ')
            .trim();

        return result;
    }

    /**
     * Parse RTF into plain text (basic support)
     */
    private parseRtf(rtf: string): string {
        let text = rtf;

        // Decode hex escapes (\'hh -> character)
        text = text.replace(/\\'([0-9a-f]{2})/gi, (_match, hex) =>
            String.fromCharCode(parseInt(hex, 16))
        );

        // Handle unicode escapes (\uN)
        text = text.replace(/\\u(-?\d+)\s?\??/g, (_match, code) =>
            String.fromCharCode(parseInt(code, 10) & 0xFFFF)
        );

        // Preserve paragraph structure
        text = text.replace(/\\par\b/g, '\n\n');
        text = text.replace(/\\line\b/g, '\n');
        text = text.replace(/\\tab\b/g, '\t');

        // Remove header/font tables (greedy match to first \pard)
        text = text.replace(/^\{\\rtf[\s\S]*?\\pard/m, '');

        // Remove remaining control words
        text = text.replace(/\\[a-z]+(-?\d+)?\s?/gi, '');

        // Remove braces and unescape
        text = text.replace(/[{}]/g, '');
        text = text.replace(/\\\\/g, '\\');
        text = text.replace(/\\\{/g, '{');
        text = text.replace(/\\\}/g, '}');

        // Clean whitespace
        text = text.replace(/\n{3,}/g, '\n\n');
        return text.trim();
    }

    /**
     * Validate extracted text is readable (not garbled)
     */
    private isReadableText(text: string): boolean {
        if (text.length < 10) return false;
        const printable = text.replace(/[^\x20-\x7E\n\t\u00A0-\uFFFF]/g, '');
        return printable.length / text.length > 0.8;
    }

    /**
     * Extract text from an external document URL
     */
    async extractFromUrl(
        url: string,
        onProgress?: (status: string) => void
    ): Promise<DocumentExtractionResult> {
        try {
            if (!url.startsWith('https://')) {
                return { success: false, error: 'Secure HTTPS required for external documents.' };
            }

            onProgress?.('Downloading...');
            const response = await requestUrl({ url, throw: true });
            const contentLength = response.headers
                ? Object.entries(response.headers).find(([k]) => k.toLowerCase() === 'content-length')?.[1]
                : undefined;
            if (contentLength) {
                const bytes = parseInt(contentLength, 10);
                if (!isNaN(bytes)) {
                    const mb = (bytes / (1024 * 1024)).toFixed(1);
                    onProgress?.(`Downloading... (${mb} MB)`);
                }
            }

            const ext = this.getExtensionFromUrl(url);
            onProgress?.('Extracting text...');

            if (ext === 'txt') {
                const decoder = new TextDecoder('utf-8');
                return { success: true, text: decoder.decode(response.arrayBuffer) };
            }

            if (ext === 'rtf') {
                const decoder = new TextDecoder('utf-8');
                const content = decoder.decode(response.arrayBuffer);
                const text = this.parseRtf(content);
                if (!this.isReadableText(text)) {
                    return { success: false, error: 'Complex RTF formatting not supported. Try saving as .docx or .txt.' };
                }
                return { success: true, text };
            }

            const officeParser = await this.loadOfficeParser();
            if (!officeParser) {
                return { success: false, error: 'Office document parsing not available' };
            }

            const result = await officeParser.parseOffice(response.arrayBuffer);
            return { success: true, text: result.toText() };
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Download failed';
            return { success: false, error: message };
        }
    }

    private getExtensionFromUrl(url: string): string {
        try {
            const pathname = new URL(url).pathname;
            const parts = pathname.split('.');
            return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
        } catch {
            return '';
        }
    }

    /**
     * Get supported file extensions
     */
    getSupportedExtensions(): string[] {
        return [...EXTRACTABLE_EXTENSIONS, 'pdf'];
    }
}
