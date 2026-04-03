/**
 * Claude Adapter Thinking Mode Tests
 * Tests adaptive thinking support for Claude Opus 4.6 and Sonnet 4.6
 */

import { ClaudeAdapter, supportsAdaptiveThinking } from '../src/services/adapters/claudeAdapter';
import { CloudLLMService } from '../src/services/cloudService';
import { AdapterType } from '../src/services/adapters';
import { App } from 'obsidian';

const mockApp = {} as App;

// ============================================================================
// supportsAdaptiveThinking HELPER
// ============================================================================

describe('supportsAdaptiveThinking', () => {
    it('should return true for claude-opus-4-6', () => {
        expect(supportsAdaptiveThinking('claude-opus-4-6')).toBe(true);
    });

    it('should return true for date-suffixed opus 4.6 model IDs', () => {
        expect(supportsAdaptiveThinking('claude-opus-4-6-20260201')).toBe(true);
    });

    it('should return true for claude-sonnet-4-6', () => {
        expect(supportsAdaptiveThinking('claude-sonnet-4-6')).toBe(true);
    });

    it('should return true for date-suffixed sonnet 4.6 model IDs', () => {
        expect(supportsAdaptiveThinking('claude-sonnet-4-6-20260301')).toBe(true);
    });

    it('should return false for Opus 4.5', () => {
        expect(supportsAdaptiveThinking('claude-opus-4-5-20251101')).toBe(false);
    });

    it('should return false for Sonnet 4.5', () => {
        expect(supportsAdaptiveThinking('claude-sonnet-4-5-20250929')).toBe(false);
    });

    it('should return false for undefined', () => {
        expect(supportsAdaptiveThinking(undefined)).toBe(false);
    });

    it('should return false for empty string', () => {
        expect(supportsAdaptiveThinking('')).toBe(false);
    });
});

// ============================================================================
// ADAPTER — formatRequest WITH THINKING
// ============================================================================

describe('ClaudeAdapter - Adaptive Thinking', () => {
    it('should add thinking params when model is opus-4-6 and mode is adaptive', () => {
        const adapter = new ClaudeAdapter({
            endpoint: 'https://api.anthropic.com/v1/messages',
            apiKey: 'test-key',
            modelName: 'claude-opus-4-6',
            thinkingMode: 'adaptive',
        });

        const body = adapter.formatRequest('test prompt');

        expect(body.thinking).toEqual({ type: 'adaptive' });
        expect(body.max_tokens).toBeGreaterThanOrEqual(16000);
        expect(body.temperature).toBeUndefined();
    });

    it('should add thinking params when model is sonnet-4-6 and mode is adaptive', () => {
        const adapter = new ClaudeAdapter({
            endpoint: 'https://api.anthropic.com/v1/messages',
            apiKey: 'test-key',
            modelName: 'claude-sonnet-4-6',
            thinkingMode: 'adaptive',
        });

        const body = adapter.formatRequest('test prompt');

        expect(body.thinking).toEqual({ type: 'adaptive' });
        expect(body.max_tokens).toBeGreaterThanOrEqual(16000);
        expect(body.temperature).toBeUndefined();
    });

    it('should NOT add thinking params when mode is standard', () => {
        const adapter = new ClaudeAdapter({
            endpoint: 'https://api.anthropic.com/v1/messages',
            apiKey: 'test-key',
            modelName: 'claude-opus-4-6',
            thinkingMode: 'standard',
        });

        const body = adapter.formatRequest('test prompt');

        expect(body.thinking).toBeUndefined();
        expect(body.max_tokens).toBe(1024);
    });

    it('should NOT add thinking params for unsupported models even with adaptive mode', () => {
        const adapter = new ClaudeAdapter({
            endpoint: 'https://api.anthropic.com/v1/messages',
            apiKey: 'test-key',
            modelName: 'claude-sonnet-4-5-20250929',
            thinkingMode: 'adaptive',
        });

        const body = adapter.formatRequest('test prompt');

        expect(body.thinking).toBeUndefined();
        expect(body.max_tokens).toBe(1024);
    });

    it('should NOT add thinking params when thinkingMode is not set', () => {
        const adapter = new ClaudeAdapter({
            endpoint: 'https://api.anthropic.com/v1/messages',
            apiKey: 'test-key',
            modelName: 'claude-opus-4-6',
        });

        const body = adapter.formatRequest('test prompt');

        expect(body.thinking).toBeUndefined();
    });
});

// ============================================================================
// ADAPTER — formatMultimodalRequest WITH THINKING
// ============================================================================

describe('ClaudeAdapter - Multimodal with Thinking', () => {
    it('should add thinking params to multimodal request', () => {
        const adapter = new ClaudeAdapter({
            endpoint: 'https://api.anthropic.com/v1/messages',
            apiKey: 'test-key',
            modelName: 'claude-opus-4-6',
            thinkingMode: 'adaptive',
        });

        const body = adapter.formatMultimodalRequest([
            { type: 'text', text: 'Describe this image' },
        ]);

        expect(body.thinking).toEqual({ type: 'adaptive' });
        expect(body.max_tokens).toBeGreaterThanOrEqual(64000);
    });

    it('should add thinking params to Sonnet 4.6 multimodal request', () => {
        const adapter = new ClaudeAdapter({
            endpoint: 'https://api.anthropic.com/v1/messages',
            apiKey: 'test-key',
            modelName: 'claude-sonnet-4-6',
            thinkingMode: 'adaptive',
        });

        const body = adapter.formatMultimodalRequest([
            { type: 'text', text: 'Describe this image' },
        ]);

        expect(body.thinking).toEqual({ type: 'adaptive' });
        expect(body.max_tokens).toBeGreaterThanOrEqual(64000);
    });
});

// ============================================================================
// ADAPTER — formatStreamingRequest WITH THINKING
// ============================================================================

describe('ClaudeAdapter - Streaming with Thinking', () => {
    it('should add thinking params to streaming request', () => {
        const adapter = new ClaudeAdapter({
            endpoint: 'https://api.anthropic.com/v1/messages',
            apiKey: 'test-key',
            modelName: 'claude-opus-4-6',
            thinkingMode: 'adaptive',
        });

        const req = adapter.formatStreamingRequest!('test prompt');

        expect(req.body).toHaveProperty('thinking', { type: 'adaptive' });
        expect((req.body as any).max_tokens).toBeGreaterThanOrEqual(64000);
        expect((req.body as any).stream).toBe(true);
    });

    it('should NOT add thinking to streaming when mode is standard', () => {
        const adapter = new ClaudeAdapter({
            endpoint: 'https://api.anthropic.com/v1/messages',
            apiKey: 'test-key',
            modelName: 'claude-opus-4-6',
            thinkingMode: 'standard',
        });

        const req = adapter.formatStreamingRequest!('test prompt');

        expect((req.body as any).thinking).toBeUndefined();
    });
});

// ============================================================================
// ADAPTER — parseResponseContent WITH THINKING BLOCKS
// ============================================================================

describe('ClaudeAdapter - Response Parsing', () => {
    const adapter = new ClaudeAdapter({
        endpoint: 'https://api.anthropic.com/v1/messages',
        apiKey: 'test-key',
        modelName: 'claude-opus-4-6',
        thinkingMode: 'adaptive',
    });

    it('should extract text from standard response (no thinking blocks)', () => {
        const response = {
            content: [
                { type: 'text', text: 'Hello world' }
            ]
        };

        expect(adapter.parseResponseContent(response)).toBe('Hello world');
    });

    it('should skip thinking blocks and extract text blocks', () => {
        const response = {
            content: [
                { type: 'thinking', thinking: 'Let me think about this...', signature: 'sig123' },
                { type: 'text', text: 'The answer is 42.' }
            ]
        };

        expect(adapter.parseResponseContent(response)).toBe('The answer is 42.');
    });

    it('should concatenate multiple text blocks', () => {
        const response = {
            content: [
                { type: 'thinking', thinking: 'First thought' },
                { type: 'text', text: 'Part 1' },
                { type: 'thinking', thinking: 'Second thought' },
                { type: 'text', text: 'Part 2' }
            ]
        };

        expect(adapter.parseResponseContent(response)).toBe('Part 1\n\nPart 2');
    });

    it('should return empty string for response without content array', () => {
        expect(adapter.parseResponseContent({})).toBe('');
        expect(adapter.parseResponseContent(null)).toBe('');
        expect(adapter.parseResponseContent({ content: 'not an array' })).toBe('');
    });

    it('should return empty string when only thinking blocks exist', () => {
        const response = {
            content: [
                { type: 'thinking', thinking: 'Deep thoughts...' }
            ]
        };

        expect(adapter.parseResponseContent(response)).toBe('');
    });
});

// ============================================================================
// ADAPTER — parseStreamingChunk
// ============================================================================

describe('ClaudeAdapter - Streaming Chunk Parsing', () => {
    const adapter = new ClaudeAdapter({
        endpoint: 'https://api.anthropic.com/v1/messages',
        apiKey: 'test-key',
        modelName: 'claude-opus-4-6',
        thinkingMode: 'adaptive',
    });

    it('should extract text_delta content', () => {
        const line = 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}';
        expect(adapter.parseStreamingChunk!(line)).toBe('Hello');
    });

    it('should skip thinking_delta events', () => {
        const line = 'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hmm..."}}';
        expect(adapter.parseStreamingChunk!(line)).toBeNull();
    });

    it('should return null for non-data lines', () => {
        expect(adapter.parseStreamingChunk!('event: message_start')).toBeNull();
        expect(adapter.parseStreamingChunk!('')).toBeNull();
    });

    it('should return null for malformed JSON', () => {
        expect(adapter.parseStreamingChunk!('data: {invalid')).toBeNull();
    });
});

// ============================================================================
// CLOUD SERVICE — buildSummarizeRequestBody WITH THINKING
// ============================================================================

describe('CloudService - Claude Thinking in Summarize', () => {
    it('should add thinking params for Opus 4.6 with adaptive mode', () => {
        const service = new CloudLLMService({
            type: 'claude' as AdapterType,
            endpoint: 'https://api.anthropic.com/v1/messages',
            apiKey: 'test-key',
            modelName: 'claude-opus-4-6',
            thinkingMode: 'adaptive',
        }, mockApp);

        const body = (service as any).buildSummarizeRequestBody('test prompt');

        expect(body.model).toBe('claude-opus-4-6');
        expect(body.thinking).toEqual({ type: 'adaptive' });
        expect(body.max_tokens).toBe(64000);
    });

    it('should add thinking params for Sonnet 4.6 with adaptive mode', () => {
        const service = new CloudLLMService({
            type: 'claude' as AdapterType,
            endpoint: 'https://api.anthropic.com/v1/messages',
            apiKey: 'test-key',
            modelName: 'claude-sonnet-4-6',
            thinkingMode: 'adaptive',
        }, mockApp);

        const body = (service as any).buildSummarizeRequestBody('test prompt');

        expect(body.model).toBe('claude-sonnet-4-6');
        expect(body.thinking).toEqual({ type: 'adaptive' });
        expect(body.max_tokens).toBe(64000);
    });

    it('should NOT add thinking for Opus 4.6 with standard mode', () => {
        const service = new CloudLLMService({
            type: 'claude' as AdapterType,
            endpoint: 'https://api.anthropic.com/v1/messages',
            apiKey: 'test-key',
            modelName: 'claude-opus-4-6',
            thinkingMode: 'standard',
        }, mockApp);

        const body = (service as any).buildSummarizeRequestBody('test prompt');

        expect(body.model).toBe('claude-opus-4-6');
        expect(body.thinking).toBeUndefined();
        expect(body.max_tokens).toBe(8192);
    });

    it('should NOT add thinking for Sonnet 4.5 even with adaptive mode', () => {
        const service = new CloudLLMService({
            type: 'claude' as AdapterType,
            endpoint: 'https://api.anthropic.com/v1/messages',
            apiKey: 'test-key',
            modelName: 'claude-sonnet-4-5-20250929',
            thinkingMode: 'adaptive',
        }, mockApp);

        const body = (service as any).buildSummarizeRequestBody('test prompt');

        expect(body.thinking).toBeUndefined();
        expect(body.max_tokens).toBe(8192);
    });

    it('should NOT add thinking when thinkingMode is omitted', () => {
        const service = new CloudLLMService({
            type: 'claude' as AdapterType,
            endpoint: 'https://api.anthropic.com/v1/messages',
            apiKey: 'test-key',
            modelName: 'claude-opus-4-6',
        }, mockApp);

        const body = (service as any).buildSummarizeRequestBody('test prompt');

        expect(body.thinking).toBeUndefined();
    });
});
