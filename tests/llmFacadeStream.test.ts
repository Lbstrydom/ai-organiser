/**
 * Direct unit tests for summarizeTextStream facade function.
 * No module-level mock on llmFacade — tests the real implementation.
 */

vi.mock('obsidian', async () => {
    return await vi.importActual('./mocks/obsidian');
});

import { summarizeTextStream } from '../src/services/llmFacade';
import type { LLMFacadeContext } from '../src/services/llmFacade';

function makeContext(service: any): LLMFacadeContext {
    return {
        llmService: service,
        settings: { serviceType: 'cloud', cloudServiceType: 'openai' },
    } as any;
}

describe('summarizeTextStream facade', () => {
    it('calls service.summarizeTextStream when available', async () => {
        const service = {
            summarizeTextStream: vi.fn().mockResolvedValue({ success: true, content: 'streamed' }),
            summarizeText: vi.fn(),
        };

        const chunks: string[] = [];
        const result = await summarizeTextStream(makeContext(service), 'prompt', (c) => chunks.push(c));

        expect(service.summarizeTextStream).toHaveBeenCalledWith('prompt', expect.any(Function), undefined);
        expect(result).toEqual({ success: true, content: 'streamed' });
    });

    it('passes AbortSignal through to service', async () => {
        const controller = new AbortController();
        const service = {
            summarizeTextStream: vi.fn().mockResolvedValue({ success: true, content: 'ok' }),
            summarizeText: vi.fn(),
        };

        await summarizeTextStream(makeContext(service), 'prompt', () => {}, controller.signal);

        expect(service.summarizeTextStream).toHaveBeenCalledWith('prompt', expect.any(Function), controller.signal);
    });

    it('falls back to summarizeText when service lacks summarizeTextStream', async () => {
        const service = {
            summarizeText: vi.fn().mockResolvedValue({ success: true, content: 'non-stream' }),
        };

        const chunks: string[] = [];
        const result = await summarizeTextStream(makeContext(service), 'prompt', (c) => chunks.push(c));

        expect(service.summarizeText).toHaveBeenCalledWith('prompt', undefined);
        expect(result).toEqual({ success: true, content: 'non-stream' });
        expect(chunks).toEqual(['non-stream']);
    });

    it('falls back when streaming throws an error', async () => {
        const service = {
            summarizeTextStream: vi.fn().mockRejectedValue(new Error('stream error')),
            summarizeText: vi.fn().mockResolvedValue({ success: true, content: 'fallback' }),
        };

        const chunks: string[] = [];
        const result = await summarizeTextStream(makeContext(service), 'prompt', (c) => chunks.push(c));

        expect(result).toEqual({ success: true, content: 'fallback' });
        expect(chunks).toEqual(['fallback']);
    });

    it('does not fall back to summarizeText when stream is aborted', async () => {
        const controller = new AbortController();
        controller.abort(); // pre-abort
        const service = {
            summarizeTextStream: vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError')),
            summarizeText: vi.fn().mockResolvedValue({ success: true, content: 'should not reach' }),
        };

        const chunks: string[] = [];
        const result = await summarizeTextStream(makeContext(service), 'prompt', (c) => chunks.push(c), controller.signal);

        expect(result.success).toBe(false);
        expect(result.error).toBe('Aborted');
        expect(service.summarizeText).not.toHaveBeenCalled(); // must NOT fall back
        expect(chunks).toEqual([]);
    });

    it('does not call onChunk in fallback when summarizeText fails', async () => {
        const service = {
            summarizeText: vi.fn().mockResolvedValue({ success: false, error: 'API error' }),
        };

        const chunks: string[] = [];
        const result = await summarizeTextStream(makeContext(service), 'prompt', (c) => chunks.push(c));

        expect(result.success).toBe(false);
        expect(chunks).toEqual([]); // no chunks delivered on failure
    });
});
