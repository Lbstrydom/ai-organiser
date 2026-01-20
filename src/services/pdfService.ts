/**
 * PDF Service
 * Handles PDF files for multimodal LLM summarization
 */

import { App, TFile } from 'obsidian';

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
            console.error('Failed to download PDF:', error);
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
