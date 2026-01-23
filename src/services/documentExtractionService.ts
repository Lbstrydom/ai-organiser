/**
 * Document Extraction Service
 * Extracts text from Office documents (DOCX, XLSX, PPTX) for meeting context
 */

import { App, TFile } from 'obsidian';

export interface DocumentExtractionResult {
    success: boolean;
    text?: string;
    metadata?: {
        title?: string;
        author?: string;
    };
    error?: string;
}

export const EXTRACTABLE_EXTENSIONS = ['docx', 'xlsx', 'pptx'];

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

        // Handle PDFs separately (they use multimodal, not text extraction)
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
     * Load the officeparser library dynamically
     */
    private async loadOfficeParser(): Promise<{ parseOffice: (input: ArrayBuffer | string) => Promise<{ toText: () => string }> } | null> {
        try {
            const officeParser = await import('officeparser');
            return officeParser;
        } catch {
            // Library not installed or not available
            console.warn('[AI Organiser] officeparser not available');
            return null;
        }
    }

    /**
     * Extract text from PDF using simple text extraction
     * Note: For full PDF understanding, use multimodal LLM instead
     */
    private async extractPdfText(file: TFile): Promise<DocumentExtractionResult> {
        try {
            // For PDFs, we can read the raw bytes and try basic text extraction
            // This is a simple approach - for better results, use multimodal
            const arrayBuffer = await this.app.vault.readBinary(file);
            const text = this.extractTextFromPdfBytes(arrayBuffer);

            if (text && text.trim().length > 0) {
                return {
                    success: true,
                    text
                };
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
    private extractTextFromPdfBytes(buffer: ArrayBuffer): string {
        const bytes = new Uint8Array(buffer);
        const text: string[] = [];

        // Simple PDF text extraction - looks for text between parentheses in stream
        // This is a basic approach that works for many PDFs
        let inStream = false;
        let streamContent = '';

        const decoder = new TextDecoder('latin1');
        const content = decoder.decode(bytes);

        // Find text objects in PDF
        const textRegex = /\(([^)]+)\)/g;
        const tjRegex = /\[([^\]]+)\]\s*TJ/g;

        // Extract from Tj operators
        let match;
        while ((match = textRegex.exec(content)) !== null) {
            const extracted = match[1]
                .replace(/\\n/g, '\n')
                .replace(/\\r/g, '')
                .replace(/\\t/g, '\t')
                .replace(/\\\(/g, '(')
                .replace(/\\\)/g, ')')
                .replace(/\\\\/g, '\\');

            if (extracted.trim()) {
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
     * Get supported file extensions
     */
    getSupportedExtensions(): string[] {
        return [...EXTRACTABLE_EXTENSIONS, 'pdf'];
    }
}
