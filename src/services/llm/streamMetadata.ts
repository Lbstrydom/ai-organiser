/**
 * Response identity on a streaming wire (llm-option-fidelity D5, S2).
 *
 * Content and identity are separate channels: `parseStreamingChunk` returns visible
 * text only, and a metadata-only event (Anthropic `message_start`) must still update
 * the attempt's `reportedModel` without emitting a content chunk.
 *
 *  - Anthropic-format (Claude, Azure Claude): `message_start` carries `message.model`.
 *  - OpenAI-shaped: each chunk carries a top-level `model`.
 *
 * Returns undefined when the line carries no comparable identity.
 */
export function parseStreamReportedModel(line: string): string | undefined {
    if (!line.startsWith('data:') || !line.includes('"model"')) return undefined;
    try {
        const parsed = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
        const top = parsed?.model;
        if (typeof top === 'string' && top.trim()) return top;
        const nested = (parsed?.message as Record<string, unknown> | undefined)?.model;
        if (typeof nested === 'string' && nested.trim()) return nested;
    } catch {
        // not JSON (e.g. [DONE]) - no identity
    }
    return undefined;
}
