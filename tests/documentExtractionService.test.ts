import { vi } from 'vitest';

vi.mock('obsidian', async () => {
    const mod = await import('./mocks/obsidian');
    return {
        ...mod,
        requestUrl: vi.fn()
    };
});

import { DocumentExtractionService } from '../src/services/documentExtractionService';
import { App, TFile, requestUrl } from 'obsidian';

function createTestFile(path: string): TFile {
    const file = new TFile();
    const name = path.split('/').pop() || '';
    (file as any).path = path;
    (file as any).name = name;
    (file as any).basename = name.replace(/\.[^.]+$/, '');
    (file as any).extension = name.includes('.') ? name.split('.').pop() || '' : '';
    (file as any).stat = { mtime: Date.now(), ctime: Date.now(), size: 100 };
    return file;
}

describe('DocumentExtractionService (production)', () => {
    let app: App;
    let service: DocumentExtractionService;

    beforeEach(() => {
        app = new App();
        service = new DocumentExtractionService(app);
        vi.clearAllMocks();
    });

    it('can extract txt files', async () => {
        const file = createTestFile('notes/test.txt');
        app.vault.read = vi.fn().mockResolvedValue('hello txt');

        const result = await service.extractText(file);

        expect(result.success).toBe(true);
        expect(result.text).toBe('hello txt');
    });

    it('extracts rtf files when readable', async () => {
        const file = createTestFile('notes/test.rtf');
        app.vault.read = vi.fn().mockResolvedValue('{\\rtf1\\ansi\\par Hello world from rtf}');

        const result = await service.extractText(file);

        expect(result.success).toBe(true);
        expect(result.text).toContain('Hello world');
    });

    it('returns error for unreadable rtf content', async () => {
        const file = createTestFile('notes/bad.rtf');
        app.vault.read = vi.fn().mockResolvedValue('{\\rtf1\\ansi\\par Hi}');

        const result = await service.extractText(file);

        expect(result.success).toBe(false);
        expect(result.error).toContain('Complex RTF formatting not supported');
    });

    it('extracts text from pdf when text exists', async () => {
        const file = createTestFile('docs/file.pdf');
        const bytes = new TextEncoder().encode('BT (Hello PDF) ET');
        app.vault.readBinary = vi.fn().mockResolvedValue(bytes.buffer);

        const result = await service.extractText(file);

        expect(result.success).toBe(true);
        expect(result.text).toContain('Hello PDF');
    });

    it('returns error for image-based pdfs', async () => {
        const file = createTestFile('docs/image.pdf');
        const bytes = new TextEncoder().encode('no text objects here');
        app.vault.readBinary = vi.fn().mockResolvedValue(bytes.buffer);

        const result = await service.extractText(file);

        expect(result.success).toBe(false);
        expect(result.error).toContain('image-based');
    });

    it('returns error when office parser is unavailable', async () => {
        const file = createTestFile('docs/report.docx');
        app.vault.readBinary = vi.fn().mockResolvedValue(new ArrayBuffer(8));
        vi.spyOn(service as any, 'loadOfficeParser').mockResolvedValue(null);

        const result = await service.extractText(file);

        expect(result.success).toBe(false);
        expect(result.error).toContain('Office document parsing not available');
    });

    it('extractFromUrl requires HTTPS', async () => {
        const result = await service.extractFromUrl('http://example.com/test.docx');

        expect(result.success).toBe(false);
        expect(result.error).toContain('HTTPS');
    });

    it('extractFromUrl handles txt content', async () => {
        (requestUrl as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
            arrayBuffer: new TextEncoder().encode('external text').buffer,
            headers: { 'content-length': '12' }
        });

        const result = await service.extractFromUrl('https://example.com/file.txt');

        expect(result.success).toBe(true);
        expect(result.text).toBe('external text');
    });

    it('extractFromUrl reports content-length progress', async () => {
        const onProgress = vi.fn();
        (requestUrl as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
            arrayBuffer: new TextEncoder().encode('data').buffer,
            headers: { 'content-length': '1048576' }
        });

        await service.extractFromUrl('https://example.com/file.txt', onProgress);

        expect(onProgress).toHaveBeenCalled();
        expect(onProgress.mock.calls.some(call => String(call[0]).includes('MB'))).toBe(true);
    });

    it('extractFromUrl returns error when office parser is unavailable', async () => {
        (requestUrl as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
            arrayBuffer: new ArrayBuffer(8),
            headers: {}
        });
        vi.spyOn(service as any, 'loadOfficeParser').mockResolvedValue(null);

        const result = await service.extractFromUrl('https://example.com/file.docx');

        expect(result.success).toBe(false);
        expect(result.error).toContain('Office document parsing not available');
    });

    it('extractFromUrl handles RTF files', async () => {
        (requestUrl as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
            arrayBuffer: new TextEncoder().encode('{\\rtf1\\ansi\\par Hello from URL}').buffer,
            headers: {}
        });

        const result = await service.extractFromUrl('https://example.com/file.rtf');

        expect(result.success).toBe(true);
        expect(result.text).toContain('Hello from URL');
    });

    it('extractFromUrl returns error for unreadable RTF', async () => {
        (requestUrl as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
            arrayBuffer: new TextEncoder().encode('{\\rtf1\\ansi\\par Hi}').buffer,
            headers: {}
        });

        const result = await service.extractFromUrl('https://example.com/file.rtf');

        expect(result.success).toBe(false);
        expect(result.error).toContain('Complex RTF formatting not supported');
    });

    it('extractFromUrl handles download errors', async () => {
        (requestUrl as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));

        const result = await service.extractFromUrl('https://example.com/file.txt');

        expect(result.success).toBe(false);
        expect(result.error).toBe('Network error');
    });

    it('canExtract returns true for supported extensions', () => {
        expect(service.canExtract(createTestFile('file.docx'))).toBe(true);
        expect(service.canExtract(createTestFile('file.xlsx'))).toBe(true);
        expect(service.canExtract(createTestFile('file.pptx'))).toBe(true);
        expect(service.canExtract(createTestFile('file.txt'))).toBe(true);
        expect(service.canExtract(createTestFile('file.rtf'))).toBe(true);
        expect(service.canExtract(createTestFile('file.pdf'))).toBe(true);
    });

    it('canExtract returns false for unsupported extensions', () => {
        expect(service.canExtract(createTestFile('file.doc'))).toBe(false);
        expect(service.canExtract(createTestFile('file.xls'))).toBe(false);
        expect(service.canExtract(createTestFile('file.jpg'))).toBe(false);
        expect(service.canExtract(createTestFile('file.mp3'))).toBe(false);
    });

    it('getSupportedExtensions includes all extractable types', () => {
        const extensions = service.getSupportedExtensions();

        expect(extensions).toContain('docx');
        expect(extensions).toContain('xlsx');
        expect(extensions).toContain('pptx');
        expect(extensions).toContain('txt');
        expect(extensions).toContain('rtf');
        expect(extensions).toContain('pdf');
    });

    it('returns error for unsupported file types', async () => {
        const file = createTestFile('image.jpg');

        const result = await service.extractText(file);

        expect(result.success).toBe(false);
        expect(result.error).toContain('Unsupported file type');
    });

    it('handles office parser errors gracefully', async () => {
        const file = createTestFile('corrupt.docx');
        app.vault.readBinary = vi.fn().mockResolvedValue(new ArrayBuffer(8));
        vi.spyOn(service as any, 'loadOfficeParser').mockResolvedValue({
            parseOffice: vi.fn().mockRejectedValue(new Error('Corrupt file'))
        });

        const result = await service.extractText(file);

        expect(result.success).toBe(false);
        expect(result.error).toBe('Corrupt file');
    });
});
