/**
 * Vision Service — Smart Digitisation (Phase 3)
 * Converts analog inputs (whiteboard photos, handwritten notes, sketches) to structured Markdown + Mermaid
 */
import { TFile, Notice } from 'obsidian';
import AIOrganiserPlugin from '../main';
import type { DetectedContent } from '../utils/embeddedContentDetector';
import { buildDigitisePrompt } from './prompts/digitisePrompts';
import { ImageProcessorService, type ProcessedImage } from './imageProcessorService';
import { sendMultimodal, isMultimodalService } from './llmFacade';
import type { ContentPart } from './adapters/types';

export type DigitiseMode = 'auto' | 'handwriting' | 'diagram' | 'whiteboard' | 'mixed';

export interface DigitiseResult {
    extractedText: string;       // Markdown content
    diagram?: string;            // Mermaid code block
    uncertainties?: string[];    // Illegible items
    rawResponse: string;         // Full LLM response
}

export interface DigitiseOptions {
    mode?: DigitiseMode;
    maxDimension?: number;
    quality?: number;
}

export interface DigitiseResultWithImage {
    result: DigitiseResult;
    processedImage: ProcessedImage;
}

export class VisionService {
    private imageProcessor: ImageProcessorService;

    constructor(private plugin: AIOrganiserPlugin) {
        this.imageProcessor = new ImageProcessorService(plugin.app);
    }

    /**
     * Main digitisation function - convert image to structured Markdown + Mermaid
     * @param file - Image file to digitise
     * @param options - Digitisation options
     * @returns Digitised content
     */
    async digitise(file: TFile, options?: DigitiseOptions): Promise<DigitiseResult> {
        const mode = options?.mode ?? this.plugin.settings.digitiseDefaultMode;
        const maxDimension = options?.maxDimension ?? this.plugin.settings.digitiseMaxDimension;
        const quality = options?.quality ?? this.plugin.settings.digitiseImageQuality;

        // Process image (Phase 2 pipeline)
        const processedImage = await this.imageProcessor.processImage(file, {
            maxDimension,
            quality
        });

        // Build multimodal content parts (Phase 1 types)
        const parts: ContentPart[] = [
            { type: 'text', text: buildDigitisePrompt(mode, this.plugin.settings.language || 'default') },
            { type: 'image', data: processedImage.base64, mediaType: processedImage.mediaType }
        ];

        // Call LLM via unified multimodal pipeline (using facade)
        const result = await sendMultimodal(
            { llmService: this.plugin.llmService, settings: this.plugin.settings },
            parts,
            { maxTokens: 4000 }
        );

        if (!result.success || !result.content) {
            throw new Error(result.error || 'Failed to digitise image');
        }

        // Parse response
        return this.parseDigitiseResponse(result.content);
    }

    /**
     * Digitise with image data — returns both the digitisation result AND the processed image
     * (including optional replacementBlob for vault compression offer).
     */
    async digitiseWithImage(file: TFile, options?: DigitiseOptions): Promise<DigitiseResultWithImage> {
        const mode = options?.mode ?? this.plugin.settings.digitiseDefaultMode;
        const maxDimension = options?.maxDimension ?? this.plugin.settings.digitiseMaxDimension;
        const quality = options?.quality ?? this.plugin.settings.digitiseImageQuality;

        // Process image with blob capture for potential vault replacement
        const processedImage = await this.imageProcessor.processImage(file, {
            maxDimension, quality, includeBlob: true
        });

        // Build multimodal content parts
        const parts: ContentPart[] = [
            { type: 'text', text: buildDigitisePrompt(mode, this.plugin.settings.language || 'default') },
            { type: 'image', data: processedImage.base64, mediaType: processedImage.mediaType }
        ];

        const llmResult = await sendMultimodal(
            { llmService: this.plugin.llmService, settings: this.plugin.settings },
            parts, { maxTokens: 4000 }
        );

        if (!llmResult.success || !llmResult.content) {
            throw new Error(llmResult.error || 'Failed to digitise image');
        }

        return {
            result: this.parseDigitiseResponse(llmResult.content),
            processedImage
        };
    }

    /**
     * Parse digitisation response from LLM.
     *
     * Strategy: positional extraction based on the 3-section output format
     * specified in the prompt (Extracted Text / Diagram / Uncertainties).
     *
     * The VLM may translate the section headers into any language, so we
     * cannot match specific header text. Instead we:
     *   1. Split on every `## ` header line to get ordered sections.
     *   2. Identify the "diagram" section by the presence of a ```mermaid block.
     *   3. Identify the "uncertainties" section by the presence of bullet lists
     *      AND it being the last section.
     *   4. Everything else is treated as extracted text.
     *
     * This handles English, Chinese, French, German, etc. without any
     * hardcoded header strings.
     */
    private parseDigitiseResponse(response: string): DigitiseResult {
        const sections = this.splitIntoSections(response);

        let extractedTextParts: string[] = [];
        let diagram: string | undefined;
        let uncertainties: string[] | undefined;

        for (let i = 0; i < sections.length; i++) {
            const section = sections[i];

            // Detect diagram section by mermaid code fence
            const mermaidMatch = section.body.match(/```mermaid\s+([\s\S]+?)```/);
            if (mermaidMatch) {
                diagram = mermaidMatch[1].trim();
                continue;
            }

            // Detect uncertainties section: last section containing bullet list
            if (i === sections.length - 1 && this.looksLikeUncertainties(section.body)) {
                const lines = section.body
                    .split('\n')
                    .map(line => line.trim())
                    .filter(line => /^[-•*]\s/.test(line))
                    .map(line => line.replace(/^[-•*]\s*/, ''))
                    .filter(line => line.length > 0);
                if (lines.length > 0) {
                    uncertainties = lines;
                }
                continue;
            }

            // Everything else is extracted text
            if (section.body.trim()) {
                extractedTextParts.push(section.body.trim());
            }
        }

        return {
            extractedText: extractedTextParts.join('\n\n') || 'No text detected in image.',
            diagram,
            uncertainties,
            rawResponse: response
        };
    }

    /**
     * Split response into ordered sections delimited by `## ` headers.
     * Content before the first header (if any) becomes section index 0.
     */
    private splitIntoSections(content: string): Array<{ header: string; body: string }> {
        const lines = content.split('\n');
        const sections: Array<{ header: string; body: string }> = [];
        let currentHeader = '';
        let currentLines: string[] = [];

        for (const line of lines) {
            if (/^##\s/.test(line)) {
                // Flush previous section
                if (currentLines.length > 0 || currentHeader) {
                    sections.push({ header: currentHeader, body: currentLines.join('\n').trim() });
                }
                currentHeader = line;
                currentLines = [];
            } else {
                currentLines.push(line);
            }
        }

        // Flush final section
        if (currentLines.length > 0 || currentHeader) {
            sections.push({ header: currentHeader, body: currentLines.join('\n').trim() });
        }

        return sections;
    }

    /**
     * Heuristic: a section looks like uncertainties if it is primarily
     * a bullet list (≥50% of non-empty lines are bullets).
     */
    private looksLikeUncertainties(body: string): boolean {
        const nonEmpty = body.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        if (nonEmpty.length === 0) return false;
        const bullets = nonEmpty.filter(l => /^[-•*]\s/.test(l));
        return bullets.length / nonEmpty.length >= 0.5;
    }

    /**
     * Resolve image file from embed syntax
     * Handles: ![[image.png]], ![[folder/image.jpg]], ![](path/image.png)
     */
    resolveImageEmbed(content: string, lineNumber: number): TFile | null {
        const lines = content.split('\n');
        if (lineNumber < 0 || lineNumber >= lines.length) return null;

        const line = lines[lineNumber];
        
        // Match wiki-link image: ![[image.png]]
        const wikiMatch = line.match(/!\[\[([^\]]+?)\]\]/);
        if (wikiMatch) {
            const linkpath = wikiMatch[1];
            const file = this.plugin.app.metadataCache.getFirstLinkpathDest(linkpath, '');
            if (file && this.isImageFile(file)) {
                return file;
            }
        }

        // Match markdown image: ![](path/image.png)
        const mdMatch = line.match(/!\[.*?\]\(([^)]+)\)/);
        if (mdMatch) {
            const path = mdMatch[1];
            const file = this.plugin.app.vault.getAbstractFileByPath(path);
            if (file instanceof TFile && this.isImageFile(file)) {
                return file;
            }
        }

        return null;
    }

    /**
     * Find nearest image embed to cursor position
     * Searches ±range lines from cursor
     */
    findNearestImage(content: string, cursorLine: number, range: number = 3): DetectedContent | null {
        const lines = content.split('\n');
        
        // Search in expanding circles from cursor
        for (let offset = 0; offset <= range; offset++) {
            // Check current line ± offset
            for (const line of [cursorLine - offset, cursorLine + offset]) {
                if (line < 0 || line >= lines.length) continue;
                
                const file = this.resolveImageEmbed(content, line);
                if (file) {
                    return {
                        type: 'image',
                        originalText: lines[line] || '',
                        url: '',
                        displayName: file.basename,
                        isEmbedded: true,
                        isExternal: false,
                        resolvedFile: file,
                        lineNumber: line
                    } as DetectedContent;
                }
            }
        }

        return null;
    }

    /**
     * Check if file is an image
     */
    private isImageFile(file: TFile): boolean {
        const ext = file.extension.toLowerCase();
        return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'heif', 'tiff', 'tif', 'avif'].includes(ext);
    }

    /**
     * Check if current LLM provider supports vision
     * Returns { supported: true } if OK, { supported: false, reason: '...' } if not
     */
    canDigitise(): { supported: boolean; reason?: string } {
        const service = this.plugin.llmService;

        // Check if service implements MultimodalLLMService interface
        if (!isMultimodalService(service)) {
            return {
                supported: false,
                reason: 'Your LLM service does not support image analysis. Please configure a cloud provider.'
            };
        }

        // Check if provider supports images (not just text-only)
        const capability = service.getMultimodalCapability();
        if (capability === 'text-only') {
            return {
                supported: false,
                reason: 'Your current provider does not support image analysis. Switch to Claude, Gemini, or OpenAI in settings.'
            };
        }

        return { supported: true };
    }
}
