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

export async function getAzureApiKey(
    plugin: AIOrganiserPlugin,
    provider: 'azure-claude' | 'azure-openai',
): Promise<string | null> {
    const secretStorage = plugin.secretStorageService;
    const plainTextFallback = { primaryKey: plugin.settings.azureApiKey };

    if (!secretStorage.isAvailable()) {
        return plugin.settings.azureApiKey || null;
    }

    if (provider === 'azure-claude') {
        return await secretStorage.resolveApiKey({
            primaryId: PLUGIN_SECRET_IDS.AZURE_AI_FOUNDRY,
            useMainKeyFallback: false,
            plainTextFallback,
        });
    }

    // azure-openai: dedicated key first, then shared Foundry key, then plaintext.
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
