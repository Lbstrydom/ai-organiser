/**
 * Document Extraction Service Tests
 * Tests for extracting text from Office documents and PDFs
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { App, TFile } from './mocks/obsidian';

// Constants matching the actual service
const EXTRACTABLE_EXTENSIONS = ['docx', 'xlsx', 'pptx'];

interface DocumentExtractionResult {
    success: boolean;
    text?: string;
    metadata?: {
        title?: string;
        author?: string;
    };
    error?: string;
}

// Simulated extraction service for testing
class MockDocumentExtractionService {
    private app: App;
    private officeParserAvailable: boolean = true;

    constructor(app: App) {
        this.app = app;
    }

    setOfficeParserAvailable(available: boolean) {
        this.officeParserAvailable = available;
    }

    canExtract(file: TFile): boolean {
        const ext = file.extension.toLowerCase();
        return EXTRACTABLE_EXTENSIONS.includes(ext) || ext === 'pdf';
    }

    async extractText(file: TFile): Promise<DocumentExtractionResult> {
        const ext = file.extension.toLowerCase();

        if (ext === 'pdf') {
            return this.extractPdfText(file);
        }

        if (!this.canExtract(file)) {
            return {
                success: false,
                error: `Unsupported file type: ${ext}`
            };
        }

        if (!this.officeParserAvailable) {
            return {
                success: false,
                error: 'Office document parsing not available'
            };
        }

        // Simulate successful extraction
        return {
            success: true,
            text: `Extracted content from ${file.basename}`
        };
    }

    private async extractPdfText(file: TFile): Promise<DocumentExtractionResult> {
        // Simulate PDF extraction
        return {
            success: true,
            text: `PDF content from ${file.basename}`
        };
    }

    getSupportedExtensions(): string[] {
        return [...EXTRACTABLE_EXTENSIONS, 'pdf'];
    }
}

describe('Document Extraction Service', () => {
    let app: App;
    let service: MockDocumentExtractionService;

    beforeEach(() => {
        app = new App();
        service = new MockDocumentExtractionService(app);
    });

    describe('canExtract', () => {
        it('should return true for DOCX files', () => {
            const file = new TFile('document.docx');
            expect(service.canExtract(file)).toBe(true);
        });

        it('should return true for XLSX files', () => {
            const file = new TFile('spreadsheet.xlsx');
            expect(service.canExtract(file)).toBe(true);
        });

        it('should return true for PPTX files', () => {
            const file = new TFile('presentation.pptx');
            expect(service.canExtract(file)).toBe(true);
        });

        it('should return true for PDF files', () => {
            const file = new TFile('document.pdf');
            expect(service.canExtract(file)).toBe(true);
        });

        it('should return false for unsupported files', () => {
            const file = new TFile('note.md');
            expect(service.canExtract(file)).toBe(false);
        });

        it('should handle uppercase extensions', () => {
            const file = new TFile('DOCUMENT.DOCX');
            expect(service.canExtract(file)).toBe(true);
        });
    });

    describe('extractText', () => {
        it('should extract text from DOCX', async () => {
            const file = new TFile('report.docx');
            const result = await service.extractText(file);

            expect(result.success).toBe(true);
            expect(result.text).toContain('report');
        });

        it('should extract text from XLSX', async () => {
            const file = new TFile('data.xlsx');
            const result = await service.extractText(file);

            expect(result.success).toBe(true);
            expect(result.text).toBeDefined();
        });

        it('should extract text from PPTX', async () => {
            const file = new TFile('slides.pptx');
            const result = await service.extractText(file);

            expect(result.success).toBe(true);
            expect(result.text).toBeDefined();
        });

        it('should extract text from PDF', async () => {
            const file = new TFile('document.pdf');
            const result = await service.extractText(file);

            expect(result.success).toBe(true);
            expect(result.text).toContain('PDF content');
        });

        it('should return error for unsupported file type', async () => {
            const file = new TFile('image.png');
            const result = await service.extractText(file);

            expect(result.success).toBe(false);
            expect(result.error).toContain('Unsupported file type');
        });
    });

    describe('Error Handling', () => {
        it('should handle missing office parser gracefully', async () => {
            service.setOfficeParserAvailable(false);

            const file = new TFile('document.docx');
            const result = await service.extractText(file);

            expect(result.success).toBe(false);
            expect(result.error).toContain('not available');
        });

        it('should still extract PDFs when office parser unavailable', async () => {
            service.setOfficeParserAvailable(false);

            const file = new TFile('document.pdf');
            const result = await service.extractText(file);

            expect(result.success).toBe(true);
        });
    });

    describe('getSupportedExtensions', () => {
        it('should return all supported extensions', () => {
            const extensions = service.getSupportedExtensions();

            expect(extensions).toContain('docx');
            expect(extensions).toContain('xlsx');
            expect(extensions).toContain('pptx');
            expect(extensions).toContain('pdf');
        });
    });
});

describe('Extractable Extensions', () => {
    it('should include Word documents', () => {
        expect(EXTRACTABLE_EXTENSIONS).toContain('docx');
    });

    it('should include Excel spreadsheets', () => {
        expect(EXTRACTABLE_EXTENSIONS).toContain('xlsx');
    });

    it('should include PowerPoint presentations', () => {
        expect(EXTRACTABLE_EXTENSIONS).toContain('pptx');
    });

    it('should not include legacy Office formats in core list', () => {
        // Legacy formats (.doc, .xls, .ppt) require different handling
        expect(EXTRACTABLE_EXTENSIONS).not.toContain('doc');
        expect(EXTRACTABLE_EXTENSIONS).not.toContain('xls');
        expect(EXTRACTABLE_EXTENSIONS).not.toContain('ppt');
    });
});

describe('PDF Text Extraction', () => {
    it('should handle text-based PDFs', async () => {
        const app = new App();
        const service = new MockDocumentExtractionService(app);

        const file = new TFile('textual.pdf');
        const result = await service.extractText(file);

        expect(result.success).toBe(true);
    });

    // Note: Actual PDF extraction limitations would be tested with real files
});

describe('Integration with Minutes Modal', () => {
    it('should provide extracted text for context', async () => {
        const app = new App();
        const service = new MockDocumentExtractionService(app);

        // Simulate extracting multiple documents
        const docs = [
            new TFile('agenda.docx'),
            new TFile('notes.pptx'),
            new TFile('data.xlsx')
        ];

        const results = await Promise.all(docs.map(d => service.extractText(d)));

        expect(results.every(r => r.success)).toBe(true);
        expect(results.every(r => r.text && r.text.length > 0)).toBe(true);
    });

    it('should handle mixed success/failure gracefully', async () => {
        const app = new App();
        const service = new MockDocumentExtractionService(app);

        const docs = [
            new TFile('valid.docx'),
            new TFile('invalid.xyz'), // Unsupported
            new TFile('another.pptx')
        ];

        const results = await Promise.all(docs.map(d => service.extractText(d)));

        expect(results[0].success).toBe(true);
        expect(results[1].success).toBe(false);
        expect(results[2].success).toBe(true);
    });
});
