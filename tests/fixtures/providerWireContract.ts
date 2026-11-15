/**
 * Independent provider-contract fixtures for `tests/adapterOptionFidelity.test.ts`
 * (llm-option-fidelity D8).
 *
 * These are written from each provider's public request contract, NOT derived from
 * `OPTION_CAPABILITIES`, so the capability table is not its own oracle: a table row that
 * wrongly says "unsupported" is caught because this file says the provider supports the
 * option, and the drop is then rejected.
 *
 * Floors (a 4096 `max_tokens` floor on always-thinking Claude models, a 64000 floor in
 * adaptive mode) are APPLICATION policy of this repo, not provider rules, and are not
 * listed here as provider constraints.
 */
import type { AdapterType } from '../../src/services/adapters';

export type WireFamily = 'anthropic-messages' | 'openai-chat' | 'bedrock-invoke';

export interface ProviderWireContract {
    family: WireFamily;
    /** The request body names the model (so a per-call override can address it). */
    modelInBody: boolean;
    /** Why a per-call model override cannot work, when `modelInBody` is false. */
    overrideBlockedBy?: 'deployment-url' | 'model-in-url';
    /** Accepted names for the output-token cap. */
    maxTokensFields: string[];
    /** The provider has an extended-thinking request parameter (still gated by model). */
    thinkingParam: boolean;
    /** The wire supports `stream: true` on this endpoint. */
    streams: boolean;
}

const OPENAI_CHAT = { family: 'openai-chat', modelInBody: true, maxTokensFields: ['max_tokens', 'max_completion_tokens'], thinkingParam: false } as const;

export const PROVIDER_WIRE_CONTRACT: Record<AdapterType, ProviderWireContract> = {
    openai: { ...OPENAI_CHAT, streams: true },
    gemini: { ...OPENAI_CHAT, streams: true }, // OpenAI-compatible endpoint
    deepseek: { ...OPENAI_CHAT, streams: true },
    aliyun: { ...OPENAI_CHAT, streams: true },
    groq: { ...OPENAI_CHAT, streams: true },
    openrouter: { ...OPENAI_CHAT, streams: true },
    requesty: { ...OPENAI_CHAT, streams: true },
    grok: { ...OPENAI_CHAT, streams: true },
    mistral: { ...OPENAI_CHAT, streams: true },
    'openai-compatible': { ...OPENAI_CHAT, streams: true },
    vertex: { ...OPENAI_CHAT, streams: false },
    cohere: { ...OPENAI_CHAT, streams: false },
    claude: { family: 'anthropic-messages', modelInBody: true, maxTokensFields: ['max_tokens'], thinkingParam: true, streams: true },
    'azure-claude': { family: 'anthropic-messages', modelInBody: true, maxTokensFields: ['max_tokens'], thinkingParam: true, streams: true },
    // The deployment is named in the URL; body.model is ignored (plan AD-4).
    'azure-openai': { ...OPENAI_CHAT, modelInBody: false, overrideBlockedBy: 'deployment-url', streams: true },
    // InvokeModel puts the model id in the URL.
    bedrock: { family: 'bedrock-invoke', modelInBody: false, overrideBlockedBy: 'model-in-url', maxTokensFields: ['max_tokens'], thinkingParam: true, streams: false },
};
