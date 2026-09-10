/**
 * Azure Foundry API-key resolution. Extracted from apiKeyHelpers so the Azure
 * capability resolver can depend on it without a module cycle
 * (apiKeyHelpers → resolveAzureCapability → azureKey; no back-edge).
 *
 * `useMainKeyFallback: false` EVERYWHERE — an Azure provider must never silently
 * borrow the user's personal Claude/OpenAI key (AD-8 / Deepgram lesson).
 */

import type AIOrganiserPlugin from '../../main';
import { PLUGIN_SECRET_IDS } from '../../core/secretIds';

/**
 * The raw, native Azure AI Foundry key — ALWAYS, regardless of
 * `azureClaudeViaOpenAIGateway`. Use this when a caller wants "the shared
 * Foundry credential" as a resource property (e.g. Azure AI Speech, which is
 * co-located with the Foundry resource and always needs its native key), NOT
 * "whichever key Claude itself is currently routed to use". Calling
 * `getAzureApiKey(plugin, 'azure-claude')` for that purpose is the bug this
 * function exists to avoid — in gateway mode it silently returns the
 * dedicated OpenAI/APIM key instead, which a native Cognitive Services
 * surface like Speech rejects outright (regression found 2026-09-10: Speech
 * went from connected to "unauthorized" the moment gateway mode was enabled,
 * with no change to the Speech config itself).
 */
export async function getFoundryApiKey(plugin: AIOrganiserPlugin): Promise<string | null> {
    const secretStorage = plugin.secretStorageService;
    const plainTextFallback = { primaryKey: plugin.settings.azureApiKey };

    if (!secretStorage.isAvailable()) {
        return plugin.settings.azureApiKey || null;
    }

    return await secretStorage.resolveApiKey({
        primaryId: PLUGIN_SECRET_IDS.AZURE_AI_FOUNDRY,
        useMainKeyFallback: false,
        plainTextFallback,
    });
}

export async function getAzureApiKey(
    plugin: AIOrganiserPlugin,
    provider: 'azure-claude' | 'azure-openai',
): Promise<string | null> {
    const secretStorage = plugin.secretStorageService;
    const plainTextFallback = { primaryKey: plugin.settings.azureApiKey };

    if (!secretStorage.isAvailable()) {
        return plugin.settings.azureApiKey || null;
    }

    // Claude-via-gateway mode (settings.ts: azureClaudeViaOpenAIGateway) sends
    // Claude requests through the same host/auth as the OpenAI surface — some
    // API-management front-ends only recognize the OpenAI-style key there, not
    // native Foundry Bearer auth. Resolve the same key OpenAI would in that case.
    const claudeUsesOpenAIKey = provider === 'azure-claude' && plugin.settings.azureClaudeViaOpenAIGateway;

    if (provider === 'azure-claude' && !claudeUsesOpenAIKey) {
        return await secretStorage.resolveApiKey({
            primaryId: PLUGIN_SECRET_IDS.AZURE_AI_FOUNDRY,
            useMainKeyFallback: false,
            plainTextFallback,
        });
    }

    // azure-openai (and azure-claude in gateway mode): dedicated key first,
    // then shared Foundry key, then plaintext.
    const dedicated = await secretStorage.resolveApiKey({
        primaryId: PLUGIN_SECRET_IDS.AZURE_OPENAI,
        useMainKeyFallback: false,
    });
    if (dedicated) return dedicated;
    return await secretStorage.resolveApiKey({
        primaryId: PLUGIN_SECRET_IDS.AZURE_AI_FOUNDRY,
        useMainKeyFallback: false,
        plainTextFallback,
    });
}
