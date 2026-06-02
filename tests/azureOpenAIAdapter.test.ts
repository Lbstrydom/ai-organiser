/**
 * Azure OpenAI Adapter Tests
 * Tests request formatting, auth headers, vision, streaming, error handling.
 * Written against the public adapter interface.
 */

import { describe, it, expect } from 'vitest';
import { AzureOpenAIAdapter } from '../src/services/adapters/azureOpenAIAdapter';
import { AdapterConfig } from '../src/services/adapters/types';

function makeConfig(overrides: Partial<AdapterConfig> = {}): AdapterConfig {
	return {
		endpoint: 'https://test.openai.azure.com/openai/v1/responses',
		apiKey: 'test-azure-key',
		modelName: 'gpt-5.3-chat',
		...overrides,
	};
}

describe('AzureOpenAIAdapter', () => {
	describe('getHeaders()', () => {
		it('uses api-key header for Azure (not Authorization Bearer)', () => {
			const adapter = new AzureOpenAIAdapter(makeConfig());
			const headers = adapter.getHeaders();
			expect(headers['api-key']).toBe('test-azure-key');
			expect(headers['Content-Type']).toBe('application/json');
			expect(headers['Authorization']).toBeUndefined();
		});

		it('throws when API key is missing', () => {
			const adapter = new AzureOpenAIAdapter(makeConfig({ apiKey: '' }));
			expect(() => adapter.getHeaders()).toThrow('API key is required');
		});
	});

	describe('provider/endpoint', () => {
		it('defaults to a concrete model id', () => {
			const adapter = new AzureOpenAIAdapter(makeConfig({ modelName: undefined }));
			const body = adapter.formatMultimodalRequest([{ type: 'text', text: 'x' }]);
			expect(body.model).toBe('gpt-5.3-chat');
		});

		it('exposes the configured Azure endpoint', () => {
			const adapter = new AzureOpenAIAdapter(makeConfig());
			expect(adapter.getEndpoint()).toBe('https://test.openai.azure.com/openai/v1/responses');
		});
	});

	describe('getMultimodalCapability()', () => {
		it('reports image capability (not document)', () => {
			const adapter = new AzureOpenAIAdapter(makeConfig());
			expect(adapter.getMultimodalCapability()).toBe('image');
		});
	});

	describe('formatMultimodalRequest()', () => {
		it('formats image parts as data URLs', () => {
			const adapter = new AzureOpenAIAdapter(makeConfig());
			const body = adapter.formatMultimodalRequest([
				{ type: 'text', text: 'Describe this' },
				{ type: 'image', data: 'abc123', mediaType: 'image/png' },
			]);
			const content = (body.messages as any[])[0].content as any[];
			expect(content).toHaveLength(2);
			expect(content[1].type).toBe('image_url');
			expect(content[1].image_url.url).toBe('data:image/png;base64,abc123');
		});

		it('throws for document parts', () => {
			const adapter = new AzureOpenAIAdapter(makeConfig());
			expect(() => adapter.formatMultimodalRequest([
				{ type: 'text', text: 'Summarize' },
				{ type: 'document', data: 'pdfdata', mediaType: 'application/pdf' },
			])).toThrow('does not support document/PDF content');
		});

		it('uses max_completion_tokens for reasoning models (gpt-5.x)', () => {
			const adapter = new AzureOpenAIAdapter(makeConfig({ modelName: 'gpt-5.3-chat' }));
			const body = adapter.formatMultimodalRequest([
				{ type: 'text', text: 'Test' },
			], { maxTokens: 8192 });
			expect(body.max_completion_tokens).toBe(8192);
			expect(body.max_tokens).toBeUndefined();
		});

		it('uses max_tokens for non-reasoning models', () => {
			const adapter = new AzureOpenAIAdapter(makeConfig({ modelName: 'gpt-4o' }));
			const body = adapter.formatMultimodalRequest([
				{ type: 'text', text: 'Test' },
			], { maxTokens: 4096 });
			expect(body.max_tokens).toBe(4096);
			expect(body.max_completion_tokens).toBeUndefined();
		});
	});

	describe('streaming', () => {
		it('reports streaming support', () => {
			const adapter = new AzureOpenAIAdapter(makeConfig());
			expect(adapter.supportsStreaming!()).toBe(true);
		});

		it('parseStreamingChunk extracts text from OpenAI SSE format', () => {
			const adapter = new AzureOpenAIAdapter(makeConfig());
			const chunk = adapter.parseStreamingChunk!('data: {"choices":[{"delta":{"content":"Hello"}}]}');
			expect(chunk).toBe('Hello');
		});

		it('parseStreamingChunk returns null for [DONE]', () => {
			const adapter = new AzureOpenAIAdapter(makeConfig());
			expect(adapter.parseStreamingChunk!('data: [DONE]')).toBeNull();
		});
	});
});
