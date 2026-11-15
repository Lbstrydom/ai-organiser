/**
 * Reads one SSE response to completion and turns it into a stream result
 * (llm-option-fidelity D5). Shared by the cloud and local services so the partial,
 * empty-stream and abort rules are written once.
 *
 * Contract:
 *  - the first body byte ends the lifecycle's first-byte deadline;
 *  - a metadata-only event updates `reportedModel` without emitting a content chunk;
 *  - a caller abort or unload throws an `AbortError` (the facade never falls back on it);
 *  - a failure BEFORE any content throws, so the facade may fall back to non-stream;
 *  - a failure AFTER content returns `{ success: false, partial: true }` with this attempt's fidelity;
 *  - a stream that ends with no content is `{ success: false, code: 'STREAM_EMPTY' }`.
 */
import { logger } from '../../utils/logger';
import { StreamProviderError } from '../adapters/anthropicStream';
import type { Fidelity, StreamSummarizeResult } from '../types';
import type { StreamLifecycle } from './streamLifecycle';
import { parseStreamReportedModel } from './streamMetadata';

export interface ConsumeSseOptions {
    response: Response;
    lifecycle: StreamLifecycle;
    parseChunk: (line: string) => string | null;
    onChunk: (chunk: string) => void;
    /** Builds the attempt's fidelity from the model the stream reported (if any). */
    fidelity: (reportedModel?: string) => Fidelity;
}

export async function consumeSseResponse(opts: ConsumeSseOptions): Promise<StreamSummarizeResult> {
    const { response, lifecycle, parseChunk, onChunk } = opts;
    const reader = response.body!.getReader();
    const cancelReader = (): void => { void reader.cancel().catch(() => undefined); };
    lifecycle.signal.addEventListener('abort', cancelReader, { once: true });
    // Abort events are not replayed: a lifecycle already aborted on entry must cancel now.
    if (lifecycle.signal.aborted) cancelReader();

    const decoder = new TextDecoder();
    let finished = false;
    let buffer = '';
    let fullContent = '';
    let reportedModel: string | undefined;
    const fidelity = (): Fidelity => opts.fidelity(reportedModel);

    const handleLine = (line: string): void => {
        const model = parseStreamReportedModel(line);
        if (model) reportedModel = model;
        const chunk = parseChunk(line);
        if (chunk) {
            fullContent += chunk;
            onChunk(chunk);
        }
    };

    try {
        // A provider `error` event inside a 200 stream is a FAILED call: report it with the
        // provider's message instead of returning the text received so far as a success.
        try {
            while (true) {
                const { done, value } = await reader.read();
                lifecycle.markFirstByte();
                if (done) { finished = true; break; }
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || ''; // keep incomplete line in buffer
                for (const line of lines) handleLine(line);
            }
            // Process any remaining buffer
            if (buffer.trim()) handleLine(buffer);
        } catch (e) {
            if (e instanceof StreamProviderError) {
                cancelReader();
                logger.warn('LLM', e.message);
                return { success: false, error: e.message, fidelity: fidelity(), ...(fullContent ? { partial: true } : {}) };
            }
            const mapped = lifecycle.classify(e);
            // Caller abort, unload, or a pre-first-chunk failure: the facade decides.
            if (!fullContent || (mapped instanceof DOMException && mapped.name === 'AbortError')) throw mapped;
            const message = e instanceof Error ? e.message : 'Unknown error';
            logger.warn('LLM', 'Streaming failed mid-stream; no fallback to avoid duplication', e);
            return { success: false, error: `Partial stream failure: ${message}`, partial: true, fidelity: fidelity() };
        }

        // The reader was cancelled by an abort: not a clean end of stream.
        if (lifecycle.signal.aborted) throw lifecycle.classify(new DOMException('Aborted', 'AbortError'));

        if (!fullContent) {
            return { success: false, error: 'The model returned an empty stream', code: 'STREAM_EMPTY', fidelity: fidelity() };
        }
        return { success: true, content: fullContent, fidelity: fidelity() };
    } finally {
        lifecycle.signal.removeEventListener('abort', cancelReader);
        // Every exit (success, error, a throwing onChunk, abort) releases the reader: cancel an
        // unfinished read, then free the lock so the body cannot be held open.
        if (!finished) cancelReader();
        try { reader.releaseLock(); } catch { /* a pending cancel may still hold it; the body is closed either way */ }
    }
}
