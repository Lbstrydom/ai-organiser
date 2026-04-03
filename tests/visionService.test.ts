/**
 * VisionService Tests
 */
import { vi } from 'vitest';
import { VisionService } from '../src/services/visionService';
import { TFile } from 'obsidian';
import { createTFile } from './mocks/obsidian';

// Mock dependencies
const mockApp = {
    vault: {
        readBinary: vi.fn(),
        getAbstractFileByPath: vi.fn()
    },
    metadataCache: {
        getFirstLinkpathDest: vi.fn()
    }
} as any;

const mockPlugin = {
    app: mockApp,
    settings: {
        language: 'default',
        digitiseDefaultMode: 'auto' as const,
        digitiseMaxDimension: 1536,
        digitiseImageQuality: 0.85
    },
    llmService: {
        sendMultimodal: vi.fn(),
        getMultimodalCapability: () => 'image+document'
    }
} as any;

describe('VisionService', () => {
    let service: VisionService;

    beforeEach(() => {
        vi.clearAllMocks();
        service = new VisionService(mockPlugin);
    });

    describe('parseDigitiseResponse', () => {
        it('should parse English response format', () => {
            const response = `## Extracted Text
This is some extracted text.

## Diagram
\`\`\`mermaid
graph TD
A-->B
\`\`\`

## Uncertainties
- Illegible word at line 3
- Unclear symbol`;

            const result = (service as any).parseDigitiseResponse(response);

            expect(result.extractedText).toBe('This is some extracted text.');
            expect(result.diagram).toBe('graph TD\nA-->B');
            expect(result.uncertainties).toEqual(['Illegible word at line 3', 'Unclear symbol']);
            expect(result.rawResponse).toBe(response);
        });

        it('should parse Chinese response format', () => {
            const response = `## 提取的文本
这是一些提取的文本。

## 图表
\`\`\`mermaid
graph LR
A-->B
\`\`\`

## 不确定项
- 第3行的文字难以辨认`;

            const result = (service as any).parseDigitiseResponse(response);

            expect(result.extractedText).toBe('这是一些提取的文本。');
            expect(result.diagram).toBe('graph LR\nA-->B');
            expect(result.uncertainties).toEqual(['第3行的文字难以辨认']);
        });

        it('should handle missing diagram section', () => {
            const response = `## Extracted Text
Some text here.

## Uncertainties
- None`;

            const result = (service as any).parseDigitiseResponse(response);

            expect(result.extractedText).toBe('Some text here.');
            expect(result.diagram).toBeUndefined();
            expect(result.uncertainties).toEqual(['None']);
        });

        it('should handle missing uncertainties section', () => {
            const response = `## Extracted Text
Some text here.

## Diagram
\`\`\`mermaid
graph TD
A-->B
\`\`\``;

            const result = (service as any).parseDigitiseResponse(response);

            expect(result.extractedText).toBe('Some text here.');
            expect(result.diagram).toBe('graph TD\nA-->B');
            expect(result.uncertainties).toBeUndefined();
        });

        it('should return default message when no text found', () => {
            const response = `## Diagram
\`\`\`mermaid
graph TD
A-->B
\`\`\``;

            const result = (service as any).parseDigitiseResponse(response);

            expect(result.extractedText).toBe('No text detected in image.');
            expect(result.diagram).toBe('graph TD\nA-->B');
        });

        it('should handle bullet points with different markers', () => {
            const response = `## Extracted Text
Text

## Uncertainties
- Item 1
• Item 2
* Item 3`;

            const result = (service as any).parseDigitiseResponse(response);

            expect(result.uncertainties).toEqual(['Item 1', 'Item 2', 'Item 3']);
        });

        it('should parse French response headers (language-agnostic)', () => {
            const response = `## Texte extrait
Voici du texte extrait.

## Diagramme
\`\`\`mermaid
graph TD
A-->B
\`\`\`

## Incertitudes
- Mot illisible à la ligne 3`;

            const result = (service as any).parseDigitiseResponse(response);

            expect(result.extractedText).toBe('Voici du texte extrait.');
            expect(result.diagram).toBe('graph TD\nA-->B');
            expect(result.uncertainties).toEqual(['Mot illisible à la ligne 3']);
        });

        it('should parse German response headers (language-agnostic)', () => {
            const response = `## Extrahierter Text
Hier ist ein Text.

## Diagramm
\`\`\`mermaid
graph LR
X-->Y
\`\`\`

## Unsicherheiten
- Unleserliches Wort`;

            const result = (service as any).parseDigitiseResponse(response);

            expect(result.extractedText).toBe('Hier ist ein Text.');
            expect(result.diagram).toBe('graph LR\nX-->Y');
            expect(result.uncertainties).toEqual(['Unleserliches Wort']);
        });

        it('should handle response with no sections at all', () => {
            const response = 'Just plain text without any headers.';

            const result = (service as any).parseDigitiseResponse(response);

            expect(result.extractedText).toBe('Just plain text without any headers.');
            expect(result.diagram).toBeUndefined();
            expect(result.uncertainties).toBeUndefined();
        });

        it('should handle empty response', () => {
            const response = '';

            const result = (service as any).parseDigitiseResponse(response);

            expect(result.extractedText).toBe('No text detected in image.');
        });
    });

    describe('resolveImageEmbed', () => {
        it('should resolve wiki-link syntax', () => {
            const content = 'Some text\n![[image.png]]\nMore text';
            const mockFile = { path: 'images/image.png', extension: 'png' } as TFile;

            mockApp.metadataCache.getFirstLinkpathDest.mockReturnValue(mockFile);

            const result = service.resolveImageEmbed(content, 1);

            expect(result).toBe(mockFile);
            expect(mockApp.metadataCache.getFirstLinkpathDest).toHaveBeenCalledWith('image.png', '');
        });

        it('should resolve markdown syntax', () => {
            const content = 'Some text\n![alt](images/photo.jpg)\nMore text';
            const mockFile = createTFile('images/photo.jpg');

            mockApp.vault.getAbstractFileByPath.mockReturnValue(mockFile);

            const result = service.resolveImageEmbed(content, 1);

            expect(result).toBe(mockFile);
            expect(mockApp.vault.getAbstractFileByPath).toHaveBeenCalledWith('images/photo.jpg');
        });

        it('should return null for non-image line', () => {
            const content = 'Just some text\nNo images here\nMore text';

            const result = service.resolveImageEmbed(content, 1);

            expect(result).toBeNull();
        });

        it('should handle nested folder paths', () => {
            const content = '![[folder/subfolder/image.png]]';
            const mockFile = { path: 'folder/subfolder/image.png', extension: 'png' } as TFile;

            mockApp.metadataCache.getFirstLinkpathDest.mockReturnValue(mockFile);

            const result = service.resolveImageEmbed(content, 0);

            expect(result).toBe(mockFile);
        });
    });

    describe('findNearestImage', () => {
        it('should find image on same line as cursor', () => {
            const content = 'Line 0\nLine 1 with ![[image.png]]\nLine 2';
            const mockFile = { path: 'image.png', extension: 'png' } as TFile;

            mockApp.metadataCache.getFirstLinkpathDest.mockReturnValue(mockFile);

            const result = service.findNearestImage(content, 1, 3);

            expect(result).toBeTruthy();
            expect(result?.resolvedFile).toBe(mockFile);
            expect(result?.lineNumber).toBe(1);
        });

        it('should find image within range (+1 line)', () => {
            const content = 'Line 0\nLine 1 cursor here\n![[image.png]]\nLine 3';
            const mockFile = { path: 'image.png', extension: 'png' } as TFile;

            mockApp.metadataCache.getFirstLinkpathDest.mockReturnValue(mockFile);

            const result = service.findNearestImage(content, 1, 3);

            expect(result).toBeTruthy();
            expect(result?.lineNumber).toBe(2);
        });

        it('should find image within range (-1 line)', () => {
            const content = '![[image.png]]\nLine 1 cursor here\nLine 2';
            const mockFile = { path: 'image.png', extension: 'png' } as TFile;

            mockApp.metadataCache.getFirstLinkpathDest.mockReturnValue(mockFile);

            const result = service.findNearestImage(content, 1, 3);

            expect(result).toBeTruthy();
            expect(result?.lineNumber).toBe(0);
        });

        it('should return null when no image found in range', () => {
            const content = '![[image.png]]\nLine 1\nLine 2\nLine 3\nLine 4\nLine 5 cursor here';

            const result = service.findNearestImage(content, 5, 2);

            expect(result).toBeNull();
        });

        it('should not search beyond file boundaries', () => {
            const content = 'Line 0\nLine 1';

            const result = service.findNearestImage(content, 1, 10);

            expect(result).toBeNull();
        });
    });

    describe('canDigitise', () => {
        it('should return false when service lacks sendMultimodal', () => {
            const localPlugin = {
                ...mockPlugin,
                llmService: {}
            };
            const localService = new VisionService(localPlugin);

            const result = localService.canDigitise();

            expect(result.supported).toBe(false);
            expect(result.reason).toContain('does not support image analysis');
        });

        it('should return false for text-only providers', () => {
            const textOnlyPlugin = {
                ...mockPlugin,
                llmService: {
                    sendMultimodal: vi.fn(),
                    getMultimodalCapability: () => 'text-only'
                }
            };
            const localService = new VisionService(textOnlyPlugin);

            const result = localService.canDigitise();

            expect(result.supported).toBe(false);
            expect(result.reason).toContain('does not support image analysis');
        });

        it('should return true for multimodal providers', () => {
            const multimodalPlugin = {
                ...mockPlugin,
                llmService: {
                    sendMultimodal: vi.fn(),
                    getMultimodalCapability: () => 'text-and-images'
                }
            };
            const localService = new VisionService(multimodalPlugin);

            const result = localService.canDigitise();

            expect(result.supported).toBe(true);
            expect(result.reason).toBeUndefined();
        });

        it('should return false when getMultimodalCapability method missing', () => {
            const incompletePlugin = {
                ...mockPlugin,
                llmService: {
                    sendMultimodal: vi.fn()
                    // No getMultimodalCapability — incomplete MultimodalLLMService
                }
            } as any;
            const localService = new VisionService(incompletePlugin);

            const result = localService.canDigitise();

            expect(result.supported).toBe(false);
            expect(result.reason).toContain('cloud provider');
        });
    });
});
