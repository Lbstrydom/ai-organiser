/**
 * Azure nano-triage routing (azure-capability-completion-v2, Phase 3 / plan §7 wrinkle).
 *
 * High-volume tagging should run on a cheap/fast deployment (e.g. gpt-5.4-nano)
 * instead of the main chat deployment. The naive approach — pass `modelOverride`
 * to the main `CloudLLMService` — silently FAILS on `azure-openai`
 * *deployment-based* routing: `blockOverride = (adapterType === 'azure-openai')`
 * drops `modelOverride` because the URL is deployment-pinned (the body `model`
 * field is ignored on that path).
 *
 * Resolution (plan decision (a)): route tagging through a DEDICATED triage
 * `CloudLLMService` whose endpoint/model are bound to the fast deployment. That
 * works in BOTH routing modes:
 *  - model-based      → generic `/openai/v1/...` URL, fast model in the body.
 *  - deployment-based → the URL itself targets the fast deployment.
 *  - azure-claude     → the Claude messages URL is generic (model in body) and
 *                       `blockOverride` never applies, so the body model wins.
 *
 * This module is the PURE, secret-free resolver (no Obsidian/network deps) that
 * computes the triage service's endpoint + model + adapter type. The caller
 * (`main.ts`) supplies the Azure key and constructs/caches the actual service.
 */

import { getClaudeMessagesEndpoint, getOpenAIChatEndpoint, isAzureMode } from './endpointResolver';
import { resolveAzureFastDeployment } from '../contentSizePolicy';

/** Minimal settings shape the resolver needs (a structural subset of AIOrganiserSettings). */
export interface AzureTriageSettings {
    cloudServiceType?: string;
    azureFastModel?: { openai?: string; claude?: string };
    azureAIEndpoint: string;
    azureOpenAIEndpoint: string;
    azureRoutingMode?: 'model-based' | 'deployment-based';
    azureDeployments?: { chat?: string; embeddings?: string };
    azureGPTModel?: string;
    azureApiVersionOverride?: { whisper?: string; chat?: string; embeddings?: string };
    azureCapabilities?: Partial<Record<string, { mode?: string; deployment?: string }>>;
}

/**
 * The bound endpoint/model/type for a triage `CloudLLMService` (no secret).
 *
 * `modelName` IS the user's deployment name (C11 deployment-name-keyed identity).
 * This is sound here ONLY because the triage service is used SOLELY for short
 * tagging calls (`generateTags`) — there is no token-window enforcement, thinking,
 * or multimodal capability gating on that path. `modelName` here is a ROUTING
 * identifier, NOT a capability/model-id for general inference. Do NOT reuse this
 * route for capability- or context-window-sensitive work without first resolving
 * a separate canonical model identity from the deployment name.
 */
export interface AzureTriageRoute {
    endpoint: string;
    modelName: string;
    type: 'azure-openai' | 'azure-claude';
}

/**
 * Resolve the triage route bound to the surface-matched fast deployment, or
 * `null` when triage routing should NOT apply (not Azure mode, no fast model
 * configured for the active surface, or the Azure endpoint is missing/invalid).
 *
 * Never throws — a malformed endpoint resolves to `null` (caller falls back to
 * the main service, no regression).
 */
export function resolveAzureTriageRoute(settings: AzureTriageSettings): AzureTriageRoute | null {
    if (!isAzureMode(settings)) return null;

    const surface = settings.cloudServiceType;
    const dep = resolveAzureFastDeployment(surface, settings.azureFastModel);
    if (!dep) return null;

    try {
        if (surface === 'azure-claude') {
            // Claude messages path is generic (model in body); blockOverride
            // never applies to azure-claude, so the body model is honoured.
            return { endpoint: getClaudeMessagesEndpoint(settings), modelName: dep, type: 'azure-claude' };
        }
        if (surface === 'azure-openai') {
            // Deployment-based: rebuild the URL so it targets the fast deployment
            // (the body model would be dropped). Model-based: the generic URL is
            // fine and the fast model rides in the body via `modelName`.
            const epSettings: AzureTriageSettings = settings.azureRoutingMode === 'deployment-based'
                ? { ...settings, azureDeployments: { ...settings.azureDeployments, chat: dep }, azureGPTModel: dep }
                : settings;
            return { endpoint: getOpenAIChatEndpoint(epSettings), modelName: dep, type: 'azure-openai' };
        }
    } catch {
        return null;
    }
    return null;
}
