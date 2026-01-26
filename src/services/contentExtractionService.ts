/**
 * Content Extraction Service
 * Extracts and combines content from multiple sources (PDFs, images, web links, YouTube)
 */

import { App, TFile } from 'obsidian';
import { DetectedContent } from '../utils/embeddedContentDetector';
import { fetchArticle } from './webContentService';
import { PdfService, PdfServiceResult } from './pdfService';
import {
    fetchYouTubeTranscript,
    transcribeYouTubeWithGemini,
    YouTubeGeminiConfig,
    YouTubeGeminiResult
} from './youtubeService';
import { DocumentExtractionService } from './documentExtractionService';

export interface ExtractedContent {
    source: DetectedContent;
    content: string;
    base64?: string;
    mimeType?: string;
    success: boolean;
    error?: string;
}

export interface ExtractionResult {
    items: ExtractedContent[];
    textContent: ExtractedContent[];
    binaryContent: ExtractedContent[];
    errors: string[];
}

export class ContentExtractionService {
    private app: App;
    private pdfService: PdfService;
    private documentService: DocumentExtractionService;
    private youtubeGeminiConfig?: Omit<YouTubeGeminiConfig, 'url'>;

    constructor(app: App, youtubeGeminiConfig?: Omit<YouTubeGeminiConfig, 'url'>) {
        this.app = app;
        this.pdfService = new PdfService(app);
        this.documentService = new DocumentExtractionService(app);
        this.youtubeGeminiConfig = youtubeGeminiConfig;
    }

    /**
     * Set YouTube Gemini config for better transcription
     */
    setYouTubeGeminiConfig(config: Omit<YouTubeGeminiConfig, 'url'> | undefined): void {
        this.youtubeGeminiConfig = config;
    }

    /**
     * Extract content from multiple detected items
     */
    async extractContent(
        items: DetectedContent[],
        onProgress?: (current: number, total: number, item: string) => void
    ): Promise<ExtractionResult> {
        const result: ExtractionResult = {
            items: [],
            textContent: [],
            binaryContent: [],
            errors: []
        };

        const total = items.length;

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            onProgress?.(i + 1, total, item.displayName);

            try {
                const extracted = await this.extractSingleItem(item);
                result.items.push(extracted);

                if (extracted.success) {
                    if (extracted.base64) {
                        result.binaryContent.push(extracted);
                    } else {
                        result.textContent.push(extracted);
                    }
                } else if (extracted.error) {
                    result.errors.push(`${item.displayName}: ${extracted.error}`);
                }
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                result.errors.push(`${item.displayName}: ${errorMessage}`);
                result.items.push({
                    source: item,
                    content: '',
                    success: false,
                    error: errorMessage
                });
            }
        }

        return result;
    }

    /**
     * Extract content from a single item
     */
    private async extractSingleItem(item: DetectedContent): Promise<ExtractedContent> {
        switch (item.type) {
            case 'web-link':
                return this.extractWebContent(item);

            case 'youtube':
                return this.extractYouTubeContent(item);

            case 'pdf':
                return this.extractPdfContent(item);

            case 'image':
                return this.extractImageContent(item);

            case 'internal-link':
                return this.extractInternalLinkContent(item);

            case 'document':
                return this.extractDocumentContent(item);

            default:
                return {
                    source: item,
                    content: '',
                    success: false,
                    error: `Unknown content type: ${item.type}`
                };
        }
    }

    /**
     * Extract content from a web link
     */
    private async extractWebContent(item: DetectedContent): Promise<ExtractedContent> {
        try {
            const result = await fetchArticle(item.url);

            if (!result.success || !result.content) {
                return {
                    source: item,
                    content: '',
                    success: false,
                    error: result.error || 'Failed to fetch web content'
                };
            }

            return {
                source: item,
                content: result.content.content,
                success: true
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return {
                source: item,
                content: '',
                success: false,
                error: errorMessage
            };
        }
    }

    /**
     * Extract content from YouTube video
     * Uses Gemini transcription if config is available, otherwise falls back to caption scraping
     */
    private async extractYouTubeContent(item: DetectedContent): Promise<ExtractedContent> {
        try {
            let result: YouTubeGeminiResult;

            // Use Gemini transcription if API key is available (more reliable)
            if (this.youtubeGeminiConfig?.apiKey) {
                console.log('[AI Organiser] Using Gemini for YouTube transcription');
                result = await transcribeYouTubeWithGemini(
                    item.url,
                    this.youtubeGeminiConfig.apiKey,
                    this.youtubeGeminiConfig.model,
                    this.youtubeGeminiConfig.timeoutMs
                );
            } else {
                // Fall back to legacy caption scraping (deprecated but works without API key)
                console.log('[AI Organiser] Using legacy caption scraping for YouTube');
                result = await fetchYouTubeTranscript(item.url);
            }

            if (!result.success || !result.transcript) {
                return {
                    source: item,
                    content: '',
                    success: false,
                    error: result.error || 'Failed to fetch YouTube transcript'
                };
            }

            // Format with video info
            let content = '';
            if (result.videoInfo) {
                content += `## ${result.videoInfo.title}\n`;
                content += `**Channel:** ${result.videoInfo.channelName}\n`;
                content += `**URL:** ${item.url}\n\n`;
            }
            content += result.transcript;

            return {
                source: item,
                content,
                success: true
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return {
                source: item,
                content: '',
                success: false,
                error: errorMessage
            };
        }
    }

    /**
     * Extract content from PDF (returns base64 for multimodal processing)
     */
    private async extractPdfContent(item: DetectedContent): Promise<ExtractedContent> {
        try {
            let pdfResult: PdfServiceResult | null = null;

            if (item.isExternal) {
                // External PDF - need to download first
                // Generate a filename from the URL
                const urlParts = item.url.split('/');
                let fileName = urlParts[urlParts.length - 1] || 'downloaded.pdf';
                if (!fileName.endsWith('.pdf')) {
                    fileName += '.pdf';
                }
                const savedFile = await this.pdfService.downloadPdfToVault(item.url, fileName);
                if (savedFile) {
                    pdfResult = await this.pdfService.readPdfAsBase64(savedFile);
                }
            } else if (item.resolvedFile) {
                // Internal PDF
                pdfResult = await this.pdfService.readPdfAsBase64(item.resolvedFile);
            } else {
                // Try to find the file by path
                const file = this.app.vault.getAbstractFileByPath(item.url);
                if (file instanceof TFile) {
                    pdfResult = await this.pdfService.readPdfAsBase64(file);
                }
            }

            if (!pdfResult || !pdfResult.success || !pdfResult.content) {
                return {
                    source: item,
                    content: '',
                    success: false,
                    error: pdfResult?.error || 'Failed to read PDF file'
                };
            }

            return {
                source: item,
                content: `[PDF: ${item.displayName}]`,
                base64: pdfResult.content.base64Data,
                mimeType: 'application/pdf',
                success: true
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return {
                source: item,
                content: '',
                success: false,
                error: errorMessage
            };
        }
    }

    /**
     * Extract content from image (returns base64 for multimodal processing)
     */
    private async extractImageContent(item: DetectedContent): Promise<ExtractedContent> {
        try {
            let base64: string | null = null;
            let mimeType = 'image/png';

            if (item.isExternal) {
                // External image - fetch it
                const response = await fetch(item.url);
                if (!response.ok) {
                    throw new Error(`Failed to fetch image: ${response.statusText}`);
                }
                const blob = await response.blob();
                mimeType = blob.type || this.getMimeTypeFromUrl(item.url);
                const arrayBuffer = await blob.arrayBuffer();
                base64 = this.arrayBufferToBase64(arrayBuffer);
            } else {
                // Internal image
                let file: TFile | null = null;

                if (item.resolvedFile) {
                    file = item.resolvedFile;
                } else {
                    const abstractFile = this.app.vault.getAbstractFileByPath(item.url);
                    if (abstractFile instanceof TFile) {
                        file = abstractFile;
                    }
                }

                if (file) {
                    const arrayBuffer = await this.app.vault.readBinary(file);
                    base64 = this.arrayBufferToBase64(arrayBuffer);
                    mimeType = this.getMimeTypeFromExtension(file.extension);
                }
            }

            if (!base64) {
                return {
                    source: item,
                    content: '',
                    success: false,
                    error: 'Failed to read image file'
                };
            }

            return {
                source: item,
                content: `[Image: ${item.displayName}]`,
                base64,
                mimeType,
                success: true
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return {
                source: item,
                content: '',
                success: false,
                error: errorMessage
            };
        }
    }

    /**
     * Extract content from a document (docx/xlsx/pptx/txt/rtf)
     */
    private async extractDocumentContent(item: DetectedContent): Promise<ExtractedContent> {
        try {
            if (item.isExternal) {
                const result = await this.documentService.extractFromUrl(item.url);
                if (!result.success || !result.text) {
                    return {
                        source: item,
                        content: '',
                        success: false,
                        error: result.error || 'Failed to extract document from URL'
                    };
                }
                return {
                    source: item,
                    content: result.text,
                    success: true
                };
            }

            if (!item.resolvedFile) {
                return {
                    source: item,
                    content: '',
                    success: false,
                    error: 'Document file not found in vault'
                };
            }

            const result = await this.documentService.extractText(item.resolvedFile);
            if (!result.success || !result.text) {
                return {
                    source: item,
                    content: '',
                    success: false,
                    error: result.error || 'Failed to extract document text'
                };
            }

            return {
                source: item,
                content: result.text,
                success: true
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return {
                source: item,
                content: '',
                success: false,
                error: errorMessage
            };
        }
    }

    /**
     * Extract content from internal markdown link
     */
    private async extractInternalLinkContent(item: DetectedContent): Promise<ExtractedContent> {
        try {
            let file: TFile | null = null;

            if (item.resolvedFile) {
                file = item.resolvedFile;
            } else {
                const abstractFile = this.app.vault.getAbstractFileByPath(item.url);
                if (abstractFile instanceof TFile) {
                    file = abstractFile;
                }
            }

            if (!file) {
                return {
                    source: item,
                    content: '',
                    success: false,
                    error: 'File not found'
                };
            }

            // Only read markdown files
            if (file.extension !== 'md') {
                return {
                    source: item,
                    content: '',
                    success: false,
                    error: 'Only markdown files can be extracted as text'
                };
            }

            const content = await this.app.vault.read(file);

            return {
                source: item,
                content: `## ${file.basename}\n\n${content}`,
                success: true
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return {
                source: item,
                content: '',
                success: false,
                error: errorMessage
            };
        }
    }

    /**
     * Convert ArrayBuffer to base64 string
     */
    private arrayBufferToBase64(buffer: ArrayBuffer): string {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    /**
     * Get MIME type from URL
     */
    private getMimeTypeFromUrl(url: string): string {
        const lowerUrl = url.toLowerCase();
        if (lowerUrl.endsWith('.png')) return 'image/png';
        if (lowerUrl.endsWith('.jpg') || lowerUrl.endsWith('.jpeg')) return 'image/jpeg';
        if (lowerUrl.endsWith('.gif')) return 'image/gif';
        if (lowerUrl.endsWith('.webp')) return 'image/webp';
        if (lowerUrl.endsWith('.bmp')) return 'image/bmp';
        if (lowerUrl.endsWith('.svg')) return 'image/svg+xml';
        return 'image/png';
    }

    /**
     * Get MIME type from file extension
     */
    private getMimeTypeFromExtension(extension: string): string {
        switch (extension.toLowerCase()) {
            case 'png': return 'image/png';
            case 'jpg':
            case 'jpeg': return 'image/jpeg';
            case 'gif': return 'image/gif';
            case 'webp': return 'image/webp';
            case 'bmp': return 'image/bmp';
            case 'svg': return 'image/svg+xml';
            default: return 'image/png';
        }
    }

    /**
     * Build a combined prompt from extracted content
     */
    buildCombinedPrompt(
        extractedItems: ExtractedContent[],
        existingNoteText: string | null,
        personaPrompt: string
    ): string {
        let combinedText = '';

        // Add existing note text if provided
        if (existingNoteText && existingNoteText.trim()) {
            combinedText += '## Existing Note Content\n\n';
            combinedText += existingNoteText + '\n\n';
        }

        // Add text-based extracted content
        const textItems = extractedItems.filter(e => e.success && !e.base64 && e.content);
        for (const item of textItems) {
            combinedText += `## Source: ${item.source.displayName}\n\n`;
            combinedText += item.content + '\n\n';
        }

        // Build the final prompt
        return `${personaPrompt}

<content_to_summarize>
${combinedText}
</content_to_summarize>

Please synthesize the information from all sources above into a comprehensive, well-organized note. Identify key themes, important details, and connections between the different sources.`;
    }

    /**
     * Get binary items for multimodal processing
     */
    getBinaryItems(extractedItems: ExtractedContent[]): Array<{ base64: string; mimeType: string }> {
        return extractedItems
            .filter(e => e.success && e.base64 && e.mimeType)
            .map(e => ({
                base64: e.base64!,
                mimeType: e.mimeType!
            }));
    }
}

/**
 * Check if a cloud service supports multimodal content
 */
export function serviceSupportsMultimodal(serviceType: string): boolean {
    const multimodalServices = ['claude', 'gemini'];
    return multimodalServices.includes(serviceType.toLowerCase());
}
