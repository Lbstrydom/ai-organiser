import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('obsidian', async () => {
    const mod = await import('./mocks/obsidian');
    return {
        ...mod,
        requestUrl: vi.fn()
    };
});

import { DocumentExtractionService } from '../src/services/documentExtractionService';
import { App, TFile, requestUrl } from 'obsidian';

describe('DocumentExtractionService (production)', () => {
    let app: App;
    let service: DocumentExtractionService;

    beforeEach(() => {
        app = new App();
        service = new DocumentExtractionService(app);
        vi.clearAllMocks();
    });

    it('can extract txt files', async () => {
        const file = new TFile('notes/test.txt');
        app.vault.read = vi.fn().mockResolvedValue('hello txt');

        const result = await service.extractText(file);

        expect(result.success).toBe(true);
        expect(result.text).toBe('hello txt');
    });

    it('extracts rtf files when readable', async () => {
        const file = new TFile('notes/test.rtf');
        app.vault.read = vi.fn().mockResolvedValue('{\\rtf1\\ansi\\par Hello world from rtf}');

        const result = await service.extractText(file);

        expect(result.success).toBe(true);
        expect(result.text).toContain('Hello world');
    });

    it('returns error for unreadable rtf content', async () => {
        const file = new TFile('notes/bad.rtf');
        app.vault.read = vi.fn().mockResolvedValue('{\\rtf1\\ansi\\par Hi}');

        const result = await service.extractText(file);

        expect(result.success).toBe(false);
        expect(result.error).toContain('Complex RTF formatting not supported');
    });

    it('extracts text from pdf when text exists', async () => {
        const file = new TFile('docs/file.pdf');
        const bytes = new TextEncoder().encode('BT (Hello PDF) ET');
        app.vault.readBinary = vi.fn().mockResolvedValue(bytes.buffer);

        const result = await service.extractText(file);

        expect(result.success).toBe(true);
        expect(result.text).toContain('Hello PDF');
    });

    it('returns error for image-based pdfs', async () => {
        const file = new TFile('docs/image.pdf');
        const bytes = new TextEncoder().encode('no text objects here');
        app.vault.readBinary = vi.fn().mockResolvedValue(bytes.buffer);

        const result = await service.extractText(file);

        expect(result.success).toBe(false);
        expect(result.error).toContain('image-based');
    });

    it('returns error when office parser is unavailable', async () => {
        const file = new TFile('docs/report.docx');
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
});
