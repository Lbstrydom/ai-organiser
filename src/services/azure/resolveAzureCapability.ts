/**
 * Azure capability resolution — the SINGLE decision owner for "in Azure mode,
 * where does specialist capability X get served": the configured Azure surface,
 * an explicit bring-your-own (BYO) provider, or unavailable (with a reason).
 *
 * Pure DECISION helper: returns a typed discriminated union, NEVER throws,
 * NEVER shows a Notice (the calling feature entry does that), NEVER constructs
 * a client. `isByoConfigured` uses LOW-LEVEL SecretStorage/settings primitives —
 * it never calls the resolver-aware key helpers, so there is no recursion (G1),
 * and the reason lives on the caller's stack frame, so there is no shared
 * mutable state / race (G3).
 *
 * Plan: docs/plans/azure-capability-flexibility.md
 */

import type AIOrganiserPlugin from '../../main';
import type { AdapterType } from '../adapters';
import { PLUGIN_SECRET_IDS, STANDARD_SECRET_IDS } from '../../core/secretIds';
import {
    getCapability,
    defaultModeFor,
    type AzureCapabilityId,
    type AzureCapabilityChoice,
    type ByoConfigKind,
    type AzureSurface,
} from './azureCapabilities';
import {
    isAzureMode,
    getWhisperEndpoint,
    getOpenAIEmbeddingsEndpoint,
    getClaudeMessagesEndpoint,
    getSpeechEndpoint,
} from './endpointResolver';
import { getAzureApiKey } from './azureKey';

export type AzureUnavailableReason = 'off' | 'no-deployment' | 'no-endpoint' | 'no-key' | 'no-byo-key' | 'no-azure-path';

export type AzureCapabilityResolution =
    | { kind: 'azure'; surface: AzureSurface; deployment: string; key: string; endpoint: string }
    | { kind: 'byo'; byoConfigKind: ByoConfigKind }
    | { kind: 'unavailable'; reason: AzureUnavailableReason };

/** The stored choice for a capability, falling back to the shared default rule (H5). */
export function capabilityChoice(plugin: AIOrganiserPlugin, capId: AzureCapabilityId): AzureCapabilityChoice {
    const stored = plugin.settings.azureCapabilities?.[capId];
    if (stored && (stored.mode === 'azure' || stored.mode === 'byo' || stored.mode === 'off')) return stored;
    return { mode: defaultModeFor(getCapability(capId)) };
}

/** Low-level "is the BYO provider configured?" — primitives only (no resolver-aware helpers → no recursion). */
export async function isByoConfigured(plugin: AIOrganiserPlugin, kind: ByoConfigKind): Promise<boolean> {
    const s = plugin.secretStorageService;
    const settings = plugin.settings;
    const has = async (secretId: string): Promise<boolean> => {
        try { return !!(s.isAvailable() && await s.getSecret(secretId)); } catch { return false; }
    };
    const provKey = (p: AdapterType): boolean => !!settings.providerSettings?.[p]?.apiKey;
    const providerKey = async (p: AdapterType): Promise<boolean> => {
        try { return !!(s.isAvailable() && await s.getProviderKey(p)); } catch { return false; }
    };
    const geminiConfigured = async (): Promise<boolean> => provKey('gemini') || await providerKey('gemini');

    switch (kind) {
        case 'embedding': {
            const prov = settings.embeddingProvider;
            if (prov === 'local-onnx' || prov === 'ollama') return true; // no API key required
            if (settings.embeddingApiKey) return true;
            if (await has(PLUGIN_SECRET_IDS.EMBEDDING)) return true;
            // Full inheritance chain: dedicated key → provider key (SecretStorage + settings) → openai secret.
            if (provKey(prov as AdapterType) || await providerKey(prov as AdapterType)) return true;
            return prov === 'openai' && await has(STANDARD_SECRET_IDS.OPENAI);
        }
        case 'transcription': {
            if (settings.audioTranscriptionApiKey) return true;
            if (await has(PLUGIN_SECRET_IDS.AUDIO)) return true;
            // Check the SELECTED provider's key, not "any of openai/groq" (G4) —
            // selecting groq with only an openai key must NOT read as configured.
            const p: AdapterType = settings.audioTranscriptionProvider === 'groq' ? 'groq' : 'openai';
            if (provKey(p) || await providerKey(p)) return true;
            return await has(p === 'groq' ? STANDARD_SECRET_IDS.GROQ : STANDARD_SECRET_IDS.OPENAI);
        }
        case 'tts':
            // Narration TTS provider is Gemini (NOT the optional llm-enhancement key — G3).
            return geminiConfigured();
        case 'research': {
            const p = settings.researchProvider;
            if (p === 'tavily') return has(PLUGIN_SECRET_IDS.RESEARCH_TAVILY_API_KEY);
            if (p === 'brightdata-serp') return has(PLUGIN_SECRET_IDS.BRIGHT_DATA_SERP_KEY);
            return false;
        }
        case 'youtube':
            return await has(PLUGIN_SECRET_IDS.YOUTUBE) || await geminiConfigured();
        default:
            return false;
    }
}

/** Does this capability's azure resolution genuinely require a deployment name to be set? */
function azureNeedsDeployment(capId: AzureCapabilityId, settings: AIOrganiserPlugin['settings']): boolean {
    if (capId === 'websearch') return true; // the Claude deployment is always required
    // OpenAI-surface capabilities only need a named deployment in deployment-based routing.
    return settings.azureRoutingMode === 'deployment-based';
}

/** Resolve the azure deployment string for a capability (SSOT + sensible fallbacks). */
function azureDeploymentFor(capId: AzureCapabilityId, plugin: AIOrganiserPlugin): string {
    const settings = plugin.settings;
    // Defensive: persisted JSON may be malformed (non-string) — never throw (H7).
    const rawDep = settings.azureCapabilities?.[capId]?.deployment;
    const cap = typeof rawDep === 'string' ? rawDep.trim() : '';

    // Web search FIRST (G3): on azure-claude main the MAIN Claude deployment
    // (cloudModel) IS the surface deployment and takes precedence over any stray
    // capability deployment. On azure-openai main, the explicit capability
    // deployment is required.
    if (capId === 'websearch') {
        return settings.cloudServiceType === 'azure-claude' ? (settings.cloudModel || '') : cap;
    }

    if (cap) return cap;
    // No fabrication (H6): return the explicitly-configured deployment or ''.
    // The endpoint builders apply their own conventional default for direct callers.
    if (capId === 'transcription') return settings.azureWhisperDeployment || '';
    if (capId === 'embeddings') return settings.azureDeployments?.embeddings || '';
    return '';
}

function azureEndpointFor(capId: AzureCapabilityId, plugin: AIOrganiserPlugin): string {
    const settings = plugin.settings;
    switch (capId) {
        case 'transcription': return getWhisperEndpoint(settings);
        case 'embeddings': return getOpenAIEmbeddingsEndpoint(settings);
        case 'websearch': return getClaudeMessagesEndpoint(settings);
        case 'tts': return getSpeechEndpoint(settings);
        default: throw new Error(`no azure endpoint for ${capId}`);
    }
}

/**
 * Resolve where capability `capId` should be served. Call this at the feature/
 * resolution entry (never inside the BYO primitives). Returns immediately for
 * non-Azure mode callers should not invoke it; guarded anyway.
 */
export async function resolveAzureCapability(
    plugin: AIOrganiserPlugin,
    capId: AzureCapabilityId,
): Promise<AzureCapabilityResolution> {
    // Fail-closed off-Azure (H3): even if a stale `azureCapabilities` map exists,
    // a non-Azure main provider must NEVER get azure routing. Callers should also
    // gate with shouldUseAzureCapabilityRouting, but this is the hard guard.
    if (!isAzureMode(plugin.settings)) return { kind: 'unavailable', reason: 'no-azure-path' };

    const def = getCapability(capId);
    const choice = capabilityChoice(plugin, capId);

    if (choice.mode === 'off') return { kind: 'unavailable', reason: 'off' };

    // No-Azure-path capability (youtube) can never be 'azure' — coerce to byo intent.
    if (choice.mode === 'azure' && def.support !== 'none' && def.surface) {
        const surface = def.surface;
        const deployment = azureDeploymentFor(capId, plugin);
        if (azureNeedsDeployment(capId, plugin.settings) && !deployment) {
            return { kind: 'unavailable', reason: 'no-deployment' };
        }
        const key = await getAzureApiKey(plugin, surface).catch(() => null);
        if (!key) return { kind: 'unavailable', reason: 'no-key' };
        let endpoint: string;
        try {
            endpoint = azureEndpointFor(capId, plugin); // SSOT helpers throw on missing/bad base URL
        } catch {
            return { kind: 'unavailable', reason: 'no-endpoint' }; // never-throws contract (G4)
        }
        return { kind: 'azure', surface, deployment, key, endpoint };
    }

    // BYO (explicit alternative). Configured → defer to the existing specialist path; else unavailable.
    if (def.support === 'none' || choice.mode === 'byo') {
        const ok = await isByoConfigured(plugin, def.byoConfigKind);
        return ok ? { kind: 'byo', byoConfigKind: def.byoConfigKind } : { kind: 'unavailable', reason: 'no-byo-key' };
    }

    return { kind: 'unavailable', reason: 'no-azure-path' };
}

/** Convenience guard for callers: only consult the resolver in Azure mode. */
export function shouldUseAzureCapabilityRouting(plugin: AIOrganiserPlugin): boolean {
    return isAzureMode(plugin.settings);
}
