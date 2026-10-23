import { logLlmUsage } from '../llm/llmUsageLog';

/**
 * An error the provider reported INSIDE an otherwise-successful (HTTP 200) SSE
 * stream, e.g. Anthropic's
 *
 *   event: error
 *   data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}
 *
 * The stream decoders used to drop these lines as "unknown event", so a stream
 * that died mid-way was reported as a successful, merely short, answer.
 * Adapters throw this from `parseStreamingChunk`; `CloudLLMService` turns it
 * into a failed call with the provider's message.
 */
export class StreamProviderError extends Error {
    constructor(
        /** Adapter label for the message, e.g. `claude`, `azure-claude`. */
        public readonly provider: string,
        /** Provider error type when present, e.g. `overloaded_error`. */
        public readonly errorType: string | undefined,
        providerMessage: string,
    ) {
        super(`${provider} stream error${errorType ? ` (${errorType})` : ''}: ${providerMessage}`);
        this.name = 'StreamProviderError';
    }
}

/**
 * Decode one Anthropic-format SSE line (direct Claude and Azure Foundry Claude
 * share the wire format). Returns the visible text delta, or null for lines that
 * carry none (event names, thinking deltas, pings, `message_start`, blank lines).
 *
 * - `message_start` is logged (cache counters are final there).
 * - A provider `error` event THROWS a {@link StreamProviderError}; it must never
 *   be dropped as an unknown event, or a stream that died mid-way reads as a
 *   successful short answer.
 * - A `data:` payload that is not JSON is skipped, as before.
 */
export function parseAnthropicSseLine(line: string, provider: string, modelName: string | undefined): string | null {
    if (!line.startsWith('data: ')) return null;
    let parsed: { type?: string; message?: { usage?: unknown }; delta?: { type?: string; text?: string } } | null;
    try {
        parsed = JSON.parse(line.slice(6).trim());
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;

    const failure = anthropicStreamError(provider, parsed);
    if (failure) throw failure;

    if (parsed.type === 'message_start') {
        logLlmUsage('stream-start', provider, modelName, parsed.message?.usage);
        return null;
    }
    if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
        return parsed.delta.text ?? null;
    }
    // thinking_delta and every other event: nothing visible
    return null;
}

/**
 * The error carried by a parsed Anthropic SSE `data:` payload, or null when the
 * payload is not an error event. Recognises the documented `{type:"error",error:{...}}`
 * shape and an untyped `{error:{...}}` envelope (some gateways re-wrap).
 */
export function anthropicStreamError(provider: string, parsed: unknown): StreamProviderError | null {
    if (!parsed || typeof parsed !== 'object') return null;
    const p = parsed as { type?: unknown; error?: unknown };
    const isErrorEvent = p.type === 'error' || (p.type === undefined && !!p.error && typeof p.error === 'object');
    if (!isErrorEvent) return null;
    const e = (p.error && typeof p.error === 'object' ? p.error : {}) as { type?: unknown; message?: unknown };
    const message = typeof e.message === 'string' && e.message.trim() ? e.message.trim() : 'the provider ended the stream with an error';
    const errorType = typeof e.type === 'string' ? e.type : undefined;
    return new StreamProviderError(provider, errorType, message);
}
