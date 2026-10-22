/**
 * Claude Adapter — Cache Usage Logging (Phase 1 instrumentation)
 *
 * Streaming responses log their cache usage from the `message_start` SSE
 * event. Non-streaming responses are logged by CloudLLMService (with the call
 * label) — see promptCachingUsageLog.test.ts.
 */

import { vi } from 'vitest';
import { ClaudeAdapter } from '../src/services/adapters/claudeAdapter';
import { logger } from '../src/utils/logger';

const makeAdapter = (modelName = 'claude-sonnet-4-7') =>
    new ClaudeAdapter({
        endpoint: 'https://api.anthropic.com/v1/messages',
        apiKey: 'test-key',
        modelName,
    });

describe('ClaudeAdapter — cache usage logging', () => {
    let debugSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        logger.setDebugMode(true);
        debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    });

    afterEach(() => {
        debugSpy.mockRestore();
        logger.setDebugMode(false);
    });

    describe('parseResponseContent', () => {
        it('no longer logs usage itself — CloudLLMService logs it with the call label (see promptCachingUsageLog.test.ts)', () => {
            const adapter = makeAdapter();
            const text = adapter.parseResponseContent({
                content: [{ type: 'text', text: 'extracted' }],
                usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 5 },
            });
            expect(text).toBe('extracted');
            expect(debugSpy).not.toHaveBeenCalled();
        });

        it('returns empty for null / undefined / contentless responses', () => {
            const adapter = makeAdapter();
            expect(adapter.parseResponseContent(null)).toBe('');
            expect(adapter.parseResponseContent(undefined)).toBe('');
            expect(adapter.parseResponseContent({})).toBe('');
        });
    });

    describe('parseStreamingChunk', () => {
        it('logs cache usage on message_start event', () => {
            const adapter = makeAdapter('claude-sonnet-4-7');
            const line =
                'data: ' +
                JSON.stringify({
                    type: 'message_start',
                    message: {
                        usage: {
                            input_tokens: 500,
                            cache_creation_input_tokens: 0,
                            cache_read_input_tokens: 2800,
                            output_tokens: 1,
                        },
                    },
                });
            const result = adapter.parseStreamingChunk(line);

            expect(result).toBeNull();
            expect(debugSpy).toHaveBeenCalledWith(
                expect.stringContaining('[Cache] stream claude model=claude-sonnet-4-7 in=500 cache_write=0 cache_read=2800 out=1'),
                '',
            );
        });

        it('does NOT log on content_block_delta events', () => {
            const adapter = makeAdapter();
            const line =
                'data: ' +
                JSON.stringify({
                    type: 'content_block_delta',
                    delta: { type: 'text_delta', text: 'hello' },
                });
            const result = adapter.parseStreamingChunk(line);

            expect(result).toBe('hello');
            expect(debugSpy).not.toHaveBeenCalled();
        });

        it('does NOT log on thinking_delta events', () => {
            const adapter = makeAdapter();
            const line =
                'data: ' +
                JSON.stringify({
                    type: 'content_block_delta',
                    delta: { type: 'thinking_delta', thinking: '...' },
                });
            const result = adapter.parseStreamingChunk(line);

            expect(result).toBeNull();
            expect(debugSpy).not.toHaveBeenCalled();
        });

        it('handles message_start without usage gracefully', () => {
            const adapter = makeAdapter();
            const line = 'data: ' + JSON.stringify({ type: 'message_start', message: {} });
            expect(() => adapter.parseStreamingChunk(line)).not.toThrow();
            expect(debugSpy).not.toHaveBeenCalled();
        });
    });
});
