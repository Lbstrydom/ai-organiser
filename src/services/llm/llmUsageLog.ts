import { logger } from '../../utils/logger';

interface UsageShape {
    // Anthropic
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
    // OpenAI-compatible
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * One debug line per LLM response with the token counts that make the prompt
 * cache hit rate visible: `in` (input tokens as the provider reports them),
 * `cache_write`, `cache_read` and `out`. Understands both the Anthropic usage
 * shape and the OpenAI-compatible one (Azure OpenAI reports a prefix hit as
 * `prompt_tokens_details.cached_tokens`).
 *
 * Numbers, the call label, the provider and the model id only — never prompt
 * or response text — and silent unless debug mode is on. A response without a
 * usage object logs nothing.
 */
export function logLlmUsage(label: string, adapterType: string, model: string | undefined, usage: unknown): void {
    if (!usage || typeof usage !== 'object') return;
    const u = usage as UsageShape;
    const anthropicShape = u.input_tokens !== undefined
        || u.cache_creation_input_tokens !== undefined
        || u.cache_read_input_tokens !== undefined;
    const input = anthropicShape ? num(u.input_tokens) : num(u.prompt_tokens);
    const write = anthropicShape ? num(u.cache_creation_input_tokens) : num(u.prompt_tokens_details?.cache_write_tokens);
    const read = anthropicShape ? num(u.cache_read_input_tokens) : num(u.prompt_tokens_details?.cached_tokens);
    const out = anthropicShape ? num(u.output_tokens) : num(u.completion_tokens);
    logger.debug(
        'Cache',
        `${label} ${adapterType} model=${model ?? '?'} in=${input} cache_write=${write} cache_read=${read} out=${out}`,
    );
}
