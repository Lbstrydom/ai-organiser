/**
 * Multimodal Architecture Tests — Phase 1.5
 * Tests for sendMultimodal capability gating, adapter formatting, and token handling
 */
import { BaseAdapter } from '../src/services/adapters/baseAdapter';
import { ClaudeAdapter } from '../src/services/adapters/claudeAdapter';
import { GeminiAdapter } from '../src/services/adapters/geminiAdapter';
import { OpenAIAdapter } from '../src/services/adapters/openaiAdapter';
import { ContentPart } from '../src/services/adapters/types';
import { extractTextFromParts } from '../src/utils/adapterUtils';

// Test fixtures
const textPart: ContentPart = { type: 'text', text: 'Describe this image' };
const imagePart: ContentPart = { type: 'image', data: 'iVBORw0KGgoAAAANSUhEUg==', mediaType: 'image/png' };
const documentPart: ContentPart = { type: 'document', data: 'JVBERi0xLjQK', mediaType: 'application/pdf' };

describe('Multimodal Architecture', () => {

    describe('MultimodalCapability declarations', () => {
        it('BaseAdapter returns text-only by default', () => {
            // Create a concrete test adapter that extends BaseAdapter
            class TestAdapter extends BaseAdapter {
                formatRequest(prompt: string): any { return { prompt }; }
                parseResponseContent(response: any): string { return response.text || ''; }
                getHeaders(): Record<string, string> { return {}; }
            }
            const adapter = new TestAdapter({ endpoint: 'http://test', apiKey: 'key', modelName: 'test' });
            expect(adapter.getMultimodalCapability()).toBe('text-only');
        });

        it('ClaudeAdapter returns image+document', () => {
            const adapter = new ClaudeAdapter({ endpoint: 'http://test', apiKey: 'key', modelName: 'claude-3' });
            expect(adapter.getMultimodalCapability()).toBe('image+document');
        });

        it('GeminiAdapter returns image+document', () => {
            const adapter = new GeminiAdapter({ endpoint: 'http://test', apiKey: 'key', modelName: 'gemini-pro' });
            expect(adapter.getMultimodalCapability()).toBe('image+document');
        });

        it('OpenAIAdapter returns image (not document)', () => {
            const adapter = new OpenAIAdapter({ endpoint: 'http://test', apiKey: 'key', modelName: 'gpt-4o' });
            expect(adapter.getMultimodalCapability()).toBe('image');
        });
    });

    describe('ClaudeAdapter formatMultimodalRequest', () => {
        const adapter = new ClaudeAdapter({ endpoint: 'http://test', apiKey: 'key', modelName: 'claude-3-sonnet' });

        it('formats text parts correctly', () => {
            const request = adapter.formatMultimodalRequest([textPart]);
            expect(request.messages[0].content).toContainEqual({ type: 'text', text: 'Describe this image' });
        });

        it('formats image parts as base64 source', () => {
            const request = adapter.formatMultimodalRequest([imagePart, textPart]);
            const imageContent = request.messages[0].content.find((c: any) => c.type === 'image');
            expect(imageContent).toBeDefined();
            expect(imageContent.source.type).toBe('base64');
            expect(imageContent.source.media_type).toBe('image/png');
            expect(imageContent.source.data).toBe('iVBORw0KGgoAAAANSUhEUg==');
        });

        it('formats document parts as base64 source', () => {
            const request = adapter.formatMultimodalRequest([documentPart, textPart]);
            const docContent = request.messages[0].content.find((c: any) => c.type === 'document');
            expect(docContent).toBeDefined();
            expect(docContent.source.type).toBe('base64');
            expect(docContent.source.media_type).toBe('application/pdf');
        });

        it('includes max_tokens when provided', () => {
            const request = adapter.formatMultimodalRequest([textPart], { maxTokens: 2048 });
            expect(request.max_tokens).toBe(2048);
        });
    });

    describe('GeminiAdapter formatMultimodalRequest', () => {
        const adapter = new GeminiAdapter({ endpoint: 'http://test', apiKey: 'key', modelName: 'gemini-pro-vision' });

        it('formats text parts as OpenAI content items', () => {
            const request = adapter.formatMultimodalRequest([textPart]);
            expect(request.messages[0].content).toContainEqual({ type: 'text', text: 'Describe this image' });
        });

        it('formats image parts as image_url with data URI', () => {
            const request = adapter.formatMultimodalRequest([imagePart, textPart]);
            const imageContent = request.messages[0].content.find((c: any) => c.type === 'image_url');
            expect(imageContent).toBeDefined();
            expect(imageContent.image_url.url).toBe('data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==');
        });

        it('formats document parts as image_url with data URI', () => {
            const request = adapter.formatMultimodalRequest([documentPart, textPart]);
            const docContent = request.messages[0].content.find((c: any) =>
                c.type === 'image_url' && c.image_url?.url?.startsWith('data:application/pdf')
            );
            expect(docContent).toBeDefined();
        });

        it('includes model name and max_tokens', () => {
            const request = adapter.formatMultimodalRequest([textPart], { maxTokens: 2048 });
            expect(request.model).toBe('gemini-pro-vision');
            expect(request.max_tokens).toBe(2048);
        });
    });

    describe('OpenAIAdapter formatMultimodalRequest', () => {
        const adapter = new OpenAIAdapter({ endpoint: 'http://test', apiKey: 'key', modelName: 'gpt-4o' });

        it('formats text parts correctly', () => {
            const request = adapter.formatMultimodalRequest([textPart]);
            expect(request.messages[0].content).toContainEqual({ type: 'text', text: 'Describe this image' });
        });

        it('formats image parts as image_url with data URI', () => {
            const request = adapter.formatMultimodalRequest([imagePart, textPart]);
            const imageContent = request.messages[0].content.find((c: any) => c.type === 'image_url');
            expect(imageContent).toBeDefined();
            expect(imageContent.image_url.url).toBe('data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==');
        });

        it('throws error for document parts', () => {
            expect(() => {
                adapter.formatMultimodalRequest([documentPart, textPart]);
            }).toThrow('OpenAI does not support document/PDF content');
        });

        it('uses max_tokens for standard models', () => {
            const request = adapter.formatMultimodalRequest([textPart], { maxTokens: 2048 });
            expect(request.max_tokens).toBe(2048);
            expect(request.max_completion_tokens).toBeUndefined();
        });

        it('uses max_completion_tokens for o1 reasoning models', () => {
            const o1Adapter = new OpenAIAdapter({ endpoint: 'http://test', apiKey: 'key', modelName: 'o1-preview' });
            const request = o1Adapter.formatMultimodalRequest([textPart], { maxTokens: 4096 });
            expect(request.max_completion_tokens).toBe(4096);
            expect(request.max_tokens).toBeUndefined();
        });

        it('uses max_completion_tokens for o3 reasoning models', () => {
            const o3Adapter = new OpenAIAdapter({ endpoint: 'http://test', apiKey: 'key', modelName: 'o3-mini' });
            const request = o3Adapter.formatMultimodalRequest([textPart], { maxTokens: 8192 });
            expect(request.max_completion_tokens).toBe(8192);
            expect(request.max_tokens).toBeUndefined();
        });

        it('uses max_completion_tokens for gpt-5 reasoning models', () => {
            const gpt5Adapter = new OpenAIAdapter({ endpoint: 'http://test', apiKey: 'key', modelName: 'gpt-5' });
            const request = gpt5Adapter.formatMultimodalRequest([textPart], { maxTokens: 4096 });
            expect(request.max_completion_tokens).toBe(4096);
            expect(request.max_tokens).toBeUndefined();
        });

        it('defaults to 16384 tokens for reasoning models when maxTokens not specified', () => {
            const o1Adapter = new OpenAIAdapter({ endpoint: 'http://test', apiKey: 'key', modelName: 'o1-mini' });
            const request = o1Adapter.formatMultimodalRequest([textPart]);
            expect(request.max_completion_tokens).toBe(16384);
        });
    });

    describe('BaseAdapter text extraction fallback', () => {
        class TextOnlyAdapter extends BaseAdapter {
            formatRequest(prompt: string): any { return { prompt }; }
            parseResponseContent(response: any): string { return response.text || ''; }
            getHeaders(): Record<string, string> { return {}; }
        }
        const adapter = new TextOnlyAdapter({ endpoint: 'http://test', apiKey: 'key', modelName: 'test' });

        it('extracts only text parts for text-only providers', () => {
            const request = adapter.formatMultimodalRequest([imagePart, textPart, documentPart]);
            // Should call formatRequest with just the text content
            expect(request.prompt).toBe('Describe this image');
        });

        it('joins multiple text parts with newlines', () => {
            const parts: ContentPart[] = [
                { type: 'text', text: 'First paragraph' },
                imagePart,
                { type: 'text', text: 'Second paragraph' }
            ];
            const request = adapter.formatMultimodalRequest(parts);
            expect(request.prompt).toBe('First paragraph\nSecond paragraph');
        });
    });

    describe('extractTextFromParts utility', () => {
        it('returns string input unchanged', () => {
            expect(extractTextFromParts('Hello world')).toBe('Hello world');
        });

        it('extracts text from ContentPart array', () => {
            const parts: ContentPart[] = [textPart, imagePart];
            expect(extractTextFromParts(parts)).toBe('Describe this image');
        });

        it('joins multiple text parts with newlines', () => {
            const parts: ContentPart[] = [
                { type: 'text', text: 'Line 1' },
                { type: 'text', text: 'Line 2' }
            ];
            expect(extractTextFromParts(parts)).toBe('Line 1\nLine 2');
        });

        it('ignores non-text parts', () => {
            const parts: ContentPart[] = [imagePart, documentPart];
            expect(extractTextFromParts(parts)).toBe('');
        });

        it('handles empty array', () => {
            expect(extractTextFromParts([])).toBe('');
        });
    });

});
