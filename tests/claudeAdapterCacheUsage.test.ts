/**
 * Claude Adapter — Cache Usage Logging (Phase 1 instrumentation)
 *
 * Verifies the logCacheUsage hook fires on both non-streaming responses
 * and on the `message_start` SSE event. Cache fields are not present
 * until cache_control markers are added in Phase 2 / 3, but we want the
 * pipe live now so the very first cached call produces measurable output.
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
        it('logs cache usage with all fields when present', () => {
            const adapter = makeAdapter('claude-sonnet-4-7');
            adapter.parseResponseContent({
                content: [{ type: 'text', text: 'hello' }],
                usage: {
                    input_tokens: 100,
                    cache_creation_input_tokens: 3000,
                    cache_read_input_tokens: 0,
                    output_tokens: 50,
                },
            });

            expect(debugSpy).toHaveBeenCalledWith(
                expect.stringContaining('[Cache] claude response model=claude-sonnet-4-7 in=100 cache_write=3000 cache_read=0 out=50'),
                '',
            );
        });

        it('logs zeros for missing cache fields (today\'s baseline state)', () => {
            const adapter = makeAdapter('claude-haiku-4-5');
            adapter.parseResponseContent({
                content: [{ type: 'text', text: 'x' }],
                usage: { input_tokens: 4096, output_tokens: 200 },
            });

            expect(debugSpy).toHaveBeenCalledWith(
                expect.stringContaining('[Cache] claude response model=claude-haiku-4-5 in=4096 cache_write=0 cache_read=0 out=200'),
                '',
            );
        });

        it('skips logging when response has no usage field', () => {
            const adapter = makeAdapter();
            adapter.parseResponseContent({ content: [{ type: 'text', text: 'x' }] });
            expect(debugSpy).not.toHaveBeenCalled();
        });

        it('skips logging on null / undefined response', () => {
            const adapter = makeAdapter();
            adapter.parseResponseContent(null);
            adapter.parseResponseContent(undefined);
            expect(debugSpy).not.toHaveBeenCalled();
        });

        it('still returns text content after logging', () => {
            const adapter = makeAdapter();
            const text = adapter.parseResponseContent({
                content: [{ type: 'text', text: 'extracted' }],
                usage: { input_tokens: 10, output_tokens: 5 },
            });
            expect(text).toBe('extracted');
        });

        it('is silent when debugMode is off (production default)', () => {
            logger.setDebugMode(false);
            const adapter = makeAdapter();
            adapter.parseResponseContent({
                content: [{ type: 'text', text: 'x' }],
                usage: { input_tokens: 100, cache_read_input_tokens: 80, output_tokens: 50 },
            });
            expect(debugSpy).not.toHaveBeenCalled();
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
                expect.stringContaining('[Cache] claude stream-start model=claude-sonnet-4-7 in=500 cache_write=0 cache_read=2800 out=1'),
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
