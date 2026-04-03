/**
 * PDF Service
 * Handles PDF files for multimodal LLM summarization
 */

import { App, TFile } from 'obsidian';
import { promises as fs } from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

export interface PdfContent {
    fileName: string;
    filePath: string;
    base64Data: string;
    mimeType: 'application/pdf';
    sizeBytes: number;
}

export interface PdfServiceResult {
    success: boolean;
    content?: PdfContent;
    error?: string;
}

// Max PDF size (20MB) - most multimodal APIs have limits
const MAX_PDF_SIZE_BYTES = 20 * 1024 * 1024;

export class PdfService {
    constructor(private app: App) {}

    /**
     * Read PDF file and convert to base64 for multimodal LLM
     */
    async readPdfAsBase64(file: TFile): Promise<PdfServiceResult> {
        try {
            // Check file size
            if (file.stat.size > MAX_PDF_SIZE_BYTES) {
                return {
                    success: false,
                    error: `PDF file is too large (${Math.round(file.stat.size / 1024 / 1024)}MB). Maximum size is 20MB.`,
                };
            }

            const arrayBuffer = await this.app.vault.readBinary(file);
            const base64 = this.arrayBufferToBase64(arrayBuffer);

            return {
                success: true,
                content: {
                    fileName: file.name,
                    filePath: file.path,
                    base64Data: base64,
                    mimeType: 'application/pdf',
                    sizeBytes: file.stat.size,
                },
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return {
                success: false,
                error: `Failed to read PDF: ${errorMessage}`,
            };
        }
    }

    /**
     * Read external PDF file (outside vault) or download from URL and convert to base64
     * Supports both local file paths and HTTP(S) URLs
     */
    async readExternalPdfAsBase64(filePathOrUrl: string): Promise<PdfServiceResult> {
        // If it's a URL, download and convert to base64
        if (filePathOrUrl.startsWith('http://') || filePathOrUrl.startsWith('https://')) {
            return this.downloadPdfAsBase64(filePathOrUrl);
        }

        // Local file path
        try {
            const normalizedPath = this.normalizeExternalPath(filePathOrUrl);
            const stats = await fs.stat(normalizedPath);

            if (!stats.isFile()) {
                return { success: false, error: 'File not found locally. Please ensure it is synced to your device.' };
            }

            if (stats.size > MAX_PDF_SIZE_BYTES) {
                return {
                    success: false,
                    error: `PDF file is too large (${Math.round(stats.size / 1024 / 1024)}MB). Maximum size is 20MB.`,
                };
            }

            const data = await fs.readFile(normalizedPath);
            const base64 = Buffer.from(data).toString('base64');

            return {
                success: true,
                content: {
                    fileName: path.basename(normalizedPath),
                    filePath: normalizedPath,
                    base64Data: base64,
                    mimeType: 'application/pdf',
                    sizeBytes: stats.size,
                },
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            if (message.includes('ENOENT')) {
                return { success: false, error: 'File not found locally. Please ensure it is synced to your device.' };
            }
            return { success: false, error: `Failed to read PDF: ${message}` };
        }
    }

    /**
     * Download PDF from URL and convert to base64 (without saving to vault)
     * Enforces HTTPS and size limits
     */
    private async downloadPdfAsBase64(url: string): Promise<PdfServiceResult> {
        try {
            // Enforce HTTPS
            if (!url.startsWith('https://')) {
                return { success: false, error: 'PDF download requires HTTPS. Insecure HTTP URLs are not supported.' };
            }

            const { requestUrl } = await import('obsidian');
            const response = await requestUrl({ url, method: 'GET' });

            if (!response.arrayBuffer) {
                return { success: false, error: 'Failed to download PDF: empty response.' };
            }

            const sizeBytes = response.arrayBuffer.byteLength;
            if (sizeBytes > MAX_PDF_SIZE_BYTES) {
                return {
                    success: false,
                    error: `Downloaded PDF is too large (${Math.round(sizeBytes / 1024 / 1024)}MB). Maximum size is 20MB.`,
                };
            }

            // Extract filename from URL
            let fileName = 'downloaded.pdf';
            try {
                const parsed = new URL(url);
                const pathParts = parsed.pathname.split('/');
                const lastPart = pathParts.at(-1);
                if (lastPart?.toLowerCase().endsWith('.pdf')) {
                    fileName = decodeURIComponent(lastPart);
                }
            } catch {
                // Use default filename
            }

            const base64 = this.arrayBufferToBase64(response.arrayBuffer);

            return {
                success: true,
                content: {
                    fileName,
                    filePath: url,
                    base64Data: base64,
                    mimeType: 'application/pdf',
                    sizeBytes,
                },
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            return { success: false, error: `Failed to download PDF from URL: ${message}` };
        }
    }

    /**
     * Get list of PDF files in attachments folder
     */
    async getPdfsInAttachments(): Promise<TFile[]> {
        const attachmentsFolder = this.getAttachmentsFolder();
        const files = this.app.vault.getFiles();

        return files
            .filter(f =>
                f.extension === 'pdf' &&
                (attachmentsFolder === '' || f.path.startsWith(attachmentsFolder))
            )
            .sort((a, b) => b.stat.mtime - a.stat.mtime); // Most recent first
    }

    /**
     * Get all PDF files in the vault
     */
    getAllPdfs(): TFile[] {
        return this.app.vault.getFiles()
            .filter(f => f.extension === 'pdf')
            .sort((a, b) => b.stat.mtime - a.stat.mtime);
    }

    /**
     * Get most recently added PDF (for auto-detection)
     */
    async getMostRecentPdf(sinceTimestamp: number): Promise<TFile | null> {
        const pdfs = await this.getPdfsInAttachments();
        const recent = pdfs.find(f => f.stat.mtime > sinceTimestamp);
        return recent || null;
    }

    /**
     * Get configured attachments folder path
     */
    private getAttachmentsFolder(): string {
        // Access Obsidian's internal config for attachments folder
        // This is a best-effort approach as the API isn't fully typed
        try {
            // @ts-ignore - accessing internal Obsidian config
            const config = this.app.vault.config;
            return config?.attachmentFolderPath || '';
        } catch {
            return '';
        }
    }

    /**
     * Convert ArrayBuffer to base64 string
     */
    private arrayBufferToBase64(buffer: ArrayBuffer): string {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    private normalizeExternalPath(filePath: string): string {
        if (filePath.startsWith('file://')) {
            try {
                const url = new URL(filePath);
                let pathname = decodeURIComponent(url.pathname);
                if (process.platform === 'win32' && pathname.startsWith('/')) {
                    pathname = pathname.slice(1);
                }
                return path.normalize(pathname);
            } catch {
                return filePath;
            }
        }
        return path.normalize(filePath);
    }

    /**
     * Download PDF from URL and save to vault
     */
    async downloadPdfToVault(url: string, fileName: string): Promise<TFile | null> {
        try {
            const { requestUrl } = await import('obsidian');
            const response = await requestUrl({
                url,
                method: 'GET',
            });

            if (response.arrayBuffer) {
                const attachmentsFolder = this.getAttachmentsFolder();
                const filePath = attachmentsFolder
                    ? `${attachmentsFolder}/${fileName}`
                    : fileName;

                // Ensure the folder exists
                if (attachmentsFolder) {
                    const folderExists = this.app.vault.getAbstractFileByPath(attachmentsFolder);
                    if (!folderExists) {
                        await this.app.vault.createFolder(attachmentsFolder);
                    }
                }

                // Create the file
                const file = await this.app.vault.createBinary(filePath, response.arrayBuffer);
                return file;
            }
        } catch (error) {
            logger.error('Core', 'Failed to download PDF:', error);
        }
        return null;
    }
}

/**
 * Check if a service supports PDF summarization
 */
export function serviceCanSummarizePdf(serviceType: string): boolean {
    const pdfCapableServices = ['claude', 'gemini'];
    return pdfCapableServices.includes(serviceType.toLowerCase());
}
