/**
 * Option capability table (llm-option-fidelity D2): the single source of truth
 * for which per-call options a provider can honour. The cloud service reports
 * against it, and the critic resolver routes by it, so a provider's rule is
 * written once. An unknown or missing provider fails closed ("cannot honour").
 */
import type { AdapterType } from '../adapters';

/** Providers the table covers: every cloud adapter plus the local service. */
export type CapabilityProvider = AdapterType | 'local';

/** How a per-call `modelOverride` reaches the provider. */
export type ModelOverrideRouting =
    /** The model id travels in the request body, so a per-call override works. */
    | 'per-call'
    /** The model is fixed by the service's own config (e.g. Bedrock's InvokeModel URL). */
    | 'service-config'
    /** One deployment is one model; the URL names it (azure-openai). */
    | 'deployment'
    /** Cannot be honoured at all. */
    | 'none';

export type OptionName =
    | 'modelOverride' | 'enableThinking' | 'disableThinking' | 'maxTokens'
    | 'timeoutMs' | 'stablePrefix' | 'signal';

export type DropReason =
    | 'unsupported-by-provider' | 'deployment-routed' | 'unresolved-sentinel' | 'no-model-capability';

export type AdjustReason =
    | 'clamped-to-model-limit' | 'raised-to-app-minimum' | 'overruled-by-disable-thinking' | 'sentinel-resolved';

export interface OptionCapability {
    modelOverride: ModelOverrideRouting;
    /** `model-gated`: the provider thinks, subject to the resolved model's capability. */
    thinking: 'model-gated' | 'none';
    maxTokens: boolean;
    timeoutMs: boolean;
}

const PER_CALL: OptionCapability = { modelOverride: 'per-call', thinking: 'none', maxTokens: true, timeoutMs: true };
const CLAUDE_LIKE: OptionCapability = { modelOverride: 'per-call', thinking: 'model-gated', maxTokens: true, timeoutMs: true };

/** Fail-closed row for a provider the table does not know. */
const CANNOT_HONOUR: OptionCapability = { modelOverride: 'none', thinking: 'none', maxTokens: false, timeoutMs: false };

export const OPTION_CAPABILITIES: Readonly<Record<CapabilityProvider, OptionCapability>> = {
    openai: PER_CALL,
    gemini: PER_CALL,
    deepseek: PER_CALL,
    aliyun: PER_CALL,
    claude: CLAUDE_LIKE,
    groq: PER_CALL,
    vertex: PER_CALL,
    openrouter: PER_CALL,
    // Bedrock's model is part of the InvokeModel URL, built from the service config.
    bedrock: { ...CLAUDE_LIKE, modelOverride: 'service-config' },
    requesty: PER_CALL,
    cohere: PER_CALL,
    grok: PER_CALL,
    mistral: PER_CALL,
    'openai-compatible': PER_CALL,
    'azure-claude': CLAUDE_LIKE,
    // The deployment-routed URL ignores body.model, so a per-call override cannot work.
    'azure-openai': { ...PER_CALL, modelOverride: 'deployment' },
    // The local service ignores modelOverride and the thinking flags today (Cluster B flips the first).
    local: { modelOverride: 'none', thinking: 'none', maxTokens: true, timeoutMs: true },
};

export function getOptionCapabilities(provider: string | null | undefined): OptionCapability {
    if (!provider || !Object.prototype.hasOwnProperty.call(OPTION_CAPABILITIES, provider)) return CANNOT_HONOUR;
    return OPTION_CAPABILITIES[provider as CapabilityProvider];
}

function getKnownProvider(provider: string | null | undefined): boolean {
    return !!provider && Object.prototype.hasOwnProperty.call(OPTION_CAPABILITIES, provider);
}

export function modelOverrideRouting(provider: string | null | undefined): ModelOverrideRouting {
    return getOptionCapabilities(provider).modelOverride;
}

export function canHonourModelOverride(provider: string | null | undefined): boolean {
    return modelOverrideRouting(provider) === 'per-call';
}

export type DowngradeReason = 'deployment-routed' | 'override-unsupported';

export type RoleRoute =
    | { route: 'per-call' }
    | { route: 'specialist' }
    | { route: 'downgrade'; reason: DowngradeReason };

/**
 * The critic routing matrix (D3), read from the table so no resolver branches on
 * a provider name. On the same provider the override rides the call when
 * honoured, a service built with the critic model addresses it when the config
 * owns the model, and otherwise the model cannot be reached. A critic on
 * another provider needs a service of its own, which `local` cannot build (the
 * role setting carries no endpoint).
 */
export function routeRole(provider: string | null | undefined, sameProvider: boolean): RoleRoute {
    if (!sameProvider) {
        // Fail closed: a missing or unrecognised provider cannot be built a specialist service.
        return provider === 'local' || !getKnownProvider(provider)
            
            ? { route: 'downgrade', reason: 'override-unsupported' }
            : { route: 'specialist' };
    }
    const routing = modelOverrideRouting(provider);
    if (routing === 'per-call') return { route: 'per-call' };
    if (routing === 'service-config') return { route: 'specialist' };
    return { route: 'downgrade', reason: routing === 'deployment' ? 'deployment-routed' : 'override-unsupported' };
}
