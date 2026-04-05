vi.mock('obsidian', async () => {
    const mod = await import('./mocks/obsidian');
    return {
        ...mod,
        requestUrl: vi.fn()
    };
});

vi.mock('fs', () => ({
    promises: {
        stat: vi.fn(),
        readFile: vi.fn()
    }
}));


import { PdfService } from '../src/services/pdfService';
import { App, requestUrl } from 'obsidian';
import { promises as fs } from 'fs';

const mockRequestUrl = requestUrl as unknown as ReturnType<typeof vi.fn>;
const mockStat = fs.stat as unknown as ReturnType<typeof vi.fn>;
const mockReadFile = fs.readFile as unknown as ReturnType<typeof vi.fn>;

// Mock globalThis.require so pdfService's desktopRequire() returns the same mocked fs
(globalThis as unknown as { require: (mod: string) => unknown }).require = (mod: string) => {
    if (mod === 'fs') return { promises: { stat: mockStat, readFile: mockReadFile } };
    if (mod === 'path') return { basename: (p: string) => p.split('/').pop() ?? p, extname: (p: string) => { const i = p.lastIndexOf('.'); return i >= 0 ? p.slice(i) : ''; }, normalize: (p: string) => p, resolve: (...parts: string[]) => parts.join('/') };
    throw new Error(`Unexpected require: ${mod}`);
};

function createMockApp(): App {
    return {
        vault: {
            config: { attachmentFolderPath: '' },
            getFiles: () => [],
            getAbstractFileByPath: () => null,
        }
    } as unknown as App;
}

function createArrayBuffer(sizeBytes: number): ArrayBuffer {
    return new ArrayBuffer(sizeBytes);
}

describe('PdfService', () => {
    let pdfService: PdfService;

    beforeEach(() => {
        vi.clearAllMocks();
        pdfService = new PdfService(createMockApp());
    });

    describe('readExternalPdfAsBase64 - URL download', () => {
        it('should download PDF from HTTPS URL', async () => {
            const pdfBuffer = createArrayBuffer(1024);
            mockRequestUrl.mockResolvedValue({ arrayBuffer: pdfBuffer });

            const result = await pdfService.readExternalPdfAsBase64('https://example.com/report.pdf');

            expect(result.success).toBe(true);
            expect(result.content).toBeDefined();
            expect(result.content!.fileName).toBe('report.pdf');
            expect(result.content!.filePath).toBe('https://example.com/report.pdf');
            expect(result.content!.mimeType).toBe('application/pdf');
            expect(result.content!.sizeBytes).toBe(1024);
            expect(mockRequestUrl).toHaveBeenCalledWith({ url: 'https://example.com/report.pdf', method: 'GET' });
        });

        it('should reject HTTP URLs (HTTPS only)', async () => {
            const result = await pdfService.readExternalPdfAsBase64('http://example.com/report.pdf');

            expect(result.success).toBe(false);
            expect(result.error).toContain('HTTPS');
            expect(mockRequestUrl).not.toHaveBeenCalled();
        });

        it('should reject PDFs exceeding 20MB size limit', async () => {
            const largeBuffer = createArrayBuffer(21 * 1024 * 1024);
            mockRequestUrl.mockResolvedValue({ arrayBuffer: largeBuffer });

            const result = await pdfService.readExternalPdfAsBase64('https://example.com/huge.pdf');

            expect(result.success).toBe(false);
            expect(result.error).toContain('too large');
            expect(result.error).toContain('20MB');
        });

        it('should handle empty response', async () => {
            mockRequestUrl.mockResolvedValue({ arrayBuffer: null });

            const result = await pdfService.readExternalPdfAsBase64('https://example.com/missing.pdf');

            expect(result.success).toBe(false);
            expect(result.error).toContain('empty response');
        });

        it('should handle network errors', async () => {
            mockRequestUrl.mockRejectedValue(new Error('Network timeout'));

            const result = await pdfService.readExternalPdfAsBase64('https://example.com/timeout.pdf');

            expect(result.success).toBe(false);
            expect(result.error).toContain('Network timeout');
        });

        it('should extract filename from URL path', async () => {
            const pdfBuffer = createArrayBuffer(512);
            mockRequestUrl.mockResolvedValue({ arrayBuffer: pdfBuffer });

            const result = await pdfService.readExternalPdfAsBase64('https://example.com/docs/my-report.pdf');

            expect(result.success).toBe(true);
            expect(result.content!.fileName).toBe('my-report.pdf');
        });

        it('should decode URL-encoded filename', async () => {
            const pdfBuffer = createArrayBuffer(512);
            mockRequestUrl.mockResolvedValue({ arrayBuffer: pdfBuffer });

            const result = await pdfService.readExternalPdfAsBase64('https://example.com/docs/my%20report.pdf');

            expect(result.success).toBe(true);
            expect(result.content!.fileName).toBe('my report.pdf');
        });

        it('should use default filename when URL has no .pdf in path', async () => {
            const pdfBuffer = createArrayBuffer(512);
            mockRequestUrl.mockResolvedValue({ arrayBuffer: pdfBuffer });

            const result = await pdfService.readExternalPdfAsBase64('https://example.com/api/download?id=123');

            expect(result.success).toBe(true);
            expect(result.content!.fileName).toBe('downloaded.pdf');
        });

        it('should handle URL with query parameters', async () => {
            const pdfBuffer = createArrayBuffer(512);
            mockRequestUrl.mockResolvedValue({ arrayBuffer: pdfBuffer });

            const result = await pdfService.readExternalPdfAsBase64('https://example.com/report.pdf?token=abc123');

            expect(result.success).toBe(true);
            expect(result.content!.fileName).toBe('report.pdf');
        });
    });

    describe('readExternalPdfAsBase64 - local file path', () => {
        it('should still handle local file paths', async () => {
            mockStat.mockResolvedValue({ isFile: () => true, size: 2048 });
            mockReadFile.mockResolvedValue(Buffer.from('fake-pdf-data'));

            const result = await pdfService.readExternalPdfAsBase64('/home/user/docs/local.pdf');

            expect(result.success).toBe(true);
            expect(result.content!.fileName).toBe('local.pdf');
            expect(mockRequestUrl).not.toHaveBeenCalled();
        });

        it('should return error for missing local file', async () => {
            mockStat.mockRejectedValue(new Error('ENOENT: no such file'));

            const result = await pdfService.readExternalPdfAsBase64('/home/user/missing.pdf');

            expect(result.success).toBe(false);
            expect(result.error).toContain('not found locally');
        });
    });
});
