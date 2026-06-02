/**
 * Azure Claude Adapter Tests
 * Tests request formatting, auth headers, response parsing, streaming, multimodal, thinking.
 * Written against the public adapter interface (getHeaders / formatRequest /
 * parseResponseContent / getMultimodalCapability / streaming).
 */

import { describe, it, expect } from 'vitest';
import { AzureClaudeAdapter } from '../src/services/adapters/azureClaudeAdapter';
import { AdapterConfig } from '../src/services/adapters/types';

function makeConfig(overrides: Partial<AdapterConfig> = {}): AdapterConfig {
	return {
		endpoint: 'https://test.services.ai.azure.com/anthropic/v1/messages',
		apiKey: 'test-azure-key',
		modelName: 'claude-sonnet-4-6',
		thinkingMode: 'standard',
		...overrides,
	};
}

describe('AzureClaudeAdapter', () => {
	describe('getHeaders()', () => {
		it('uses Authorization Bearer for Azure (not x-api-key)', () => {
			const adapter = new AzureClaudeAdapter(makeConfig());
			const headers = adapter.getHeaders();
			expect(headers['Authorization']).toBe('Bearer test-azure-key');
			expect(headers['anthropic-version']).toBe('2023-06-01');
			expect(headers['Content-Type']).toBe('application/json');
			expect(headers['x-api-key']).toBeUndefined();
			// Azure must NOT send the direct-Anthropic browser-access header.
			expect(headers['anthropic-dangerous-direct-browser-access']).toBeUndefined();
		});

		it('throws when API key is missing', () => {
			const adapter = new AzureClaudeAdapter(makeConfig({ apiKey: '' }));
			expect(() => adapter.getHeaders()).toThrow('API key is required');
		});
	});

	describe('provider/endpoint', () => {
		it('defaults to a concrete model id (never a latest-* sentinel)', () => {
			const adapter = new AzureClaudeAdapter(makeConfig({ modelName: undefined }));
			const body = adapter.formatRequest('x');
			expect(body.model).toBe('claude-sonnet-4-6');
		});

		it('exposes the configured Azure endpoint', () => {
			const adapter = new AzureClaudeAdapter(makeConfig());
			expect(adapter.getEndpoint()).toBe('https://test.services.ai.azure.com/anthropic/v1/messages');
		});
	});

	describe('formatRequest()', () => {
		it('builds a valid Claude Messages API request', () => {
			const adapter = new AzureClaudeAdapter(makeConfig());
			const body = adapter.formatRequest('Test prompt');
			expect(body.model).toBe('claude-sonnet-4-6');
			expect(body.max_tokens).toBe(1024);
			expect((body.messages as any[])).toHaveLength(1);
			expect((body.messages as any[])[0].role).toBe('user');
			expect((body.messages as any[])[0].content).toBe('Test prompt');
			expect(body.system).toBeTruthy();
		});

		it('does not inject thinking params in standard mode', () => {
			const adapter = new AzureClaudeAdapter(makeConfig({ thinkingMode: 'standard' }));
			const body = adapter.formatRequest('Test');
			expect(body.thinking).toBeUndefined();
		});

		it('injects thinking params in adaptive mode for supported models', () => {
			const adapter = new AzureClaudeAdapter(makeConfig({ thinkingMode: 'adaptive' }));
			const body = adapter.formatRequest('Test');
			expect(body.thinking).toEqual({ type: 'adaptive' });
			expect(body.max_tokens as number).toBeGreaterThanOrEqual(64000);
		});

		it('does not inject thinking for unsupported models even in adaptive mode', () => {
			const adapter = new AzureClaudeAdapter(makeConfig({ thinkingMode: 'adaptive', modelName: 'claude-3-haiku' }));
			const body = adapter.formatRequest('Test');
			expect(body.thinking).toBeUndefined();
		});
	});

	describe('getMultimodalCapability()', () => {
		it('reports image+document capability', () => {
			const adapter = new AzureClaudeAdapter(makeConfig());
			expect(adapter.getMultimodalCapability()).toBe('image+document');
		});
	});

	describe('formatMultimodalRequest()', () => {
		it('formats image parts with base64 source', () => {
			const adapter = new AzureClaudeAdapter(makeConfig());
			const body = adapter.formatMultimodalRequest([
				{ type: 'text', text: 'Describe this' },
				{ type: 'image', data: 'abc123', mediaType: 'image/png' },
			]);
			expect((body.messages as any[])[0].content).toHaveLength(2);
			const imgPart = (body.messages as any[])[0].content[1];
			expect(imgPart.type).toBe('image');
			expect(imgPart.source.type).toBe('base64');
			expect(imgPart.source.data).toBe('abc123');
		});

		it('formats document parts with base64 source', () => {
			const adapter = new AzureClaudeAdapter(makeConfig());
			const body = adapter.formatMultimodalRequest([
				{ type: 'text', text: 'Summarize this PDF' },
				{ type: 'document', data: 'pdfdata', mediaType: 'application/pdf' },
			]);
			const docPart = (body.messages as any[])[0].content[1];
			expect(docPart.type).toBe('document');
			expect(docPart.source.media_type).toBe('application/pdf');
		});

		it('respects maxTokens option', () => {
			const adapter = new AzureClaudeAdapter(makeConfig());
			const body = adapter.formatMultimodalRequest(
				[{ type: 'text', text: 'Test' }],
				{ maxTokens: 8192 }
			);
			expect(body.max_tokens).toBe(8192);
		});
	});

	describe('parseResponseContent()', () => {
		it('extracts text from content blocks', () => {
			const adapter = new AzureClaudeAdapter(makeConfig());
			const text = adapter.parseResponseContent({
				content: [
					{ type: 'text', text: 'Hello' },
					{ type: 'text', text: 'World' },
				],
			});
			expect(text).toBe('Hello\n\nWorld');
		});

		it('skips thinking blocks', () => {
			const adapter = new AzureClaudeAdapter(makeConfig());
			const text = adapter.parseResponseContent({
				content: [
					{ type: 'thinking', thinking: 'internal reasoning...' },
					{ type: 'text', text: 'Visible answer' },
				],
			});
			expect(text).toBe('Visible answer');
		});

		it('returns empty string for missing content', () => {
			const adapter = new AzureClaudeAdapter(makeConfig());
			expect(adapter.parseResponseContent({})).toBe('');
			expect(adapter.parseResponseContent({ content: [] })).toBe('');
		});
	});

	describe('streaming', () => {
		it('reports streaming support', () => {
			const adapter = new AzureClaudeAdapter(makeConfig());
			expect(adapter.supportsStreaming!()).toBe(true);
		});

		it('formatStreamingRequest includes stream:true and Azure auth headers', () => {
			const adapter = new AzureClaudeAdapter(makeConfig());
			const req = adapter.formatStreamingRequest!('Test prompt');
			expect((req.body as any).stream).toBe(true);
			expect(req.headers['Authorization']).toBe('Bearer test-azure-key');
			expect(req.headers['anthropic-version']).toBe('2023-06-01');
		});

		it('parseStreamingChunk extracts text from content_block_delta', () => {
			const adapter = new AzureClaudeAdapter(makeConfig());
			const chunk = adapter.parseStreamingChunk!('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}');
			expect(chunk).toBe('Hello');
		});

		it('parseStreamingChunk returns null for thinking events', () => {
			const adapter = new AzureClaudeAdapter(makeConfig());
			const chunk = adapter.parseStreamingChunk!('data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"reasoning"}}');
			expect(chunk).toBeNull();
		});

		it('parseStreamingChunk returns null for non-data lines', () => {
			const adapter = new AzureClaudeAdapter(makeConfig());
			expect(adapter.parseStreamingChunk!('event: message_start')).toBeNull();
			expect(adapter.parseStreamingChunk!('')).toBeNull();
		});
	});
});
