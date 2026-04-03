import type AIOrganiserPlugin from '../main';
import { PLUGIN_SECRET_IDS } from '../core/secretIds';
import { PdfContent } from './pdfService';

/**
 * Get the PDF provider configuration
 * Returns the provider and API key to use for PDF processing
 * Priority: 1) main provider if PDF-capable, 2) dedicated PDF provider, 3) auto-detect from available keys
 */
export async function getPdfProviderConfig(plugin: AIOrganiserPlugin): Promise<{ provider: 'claude' | 'gemini'; apiKey: string; model: string } | null> {
    const mainProvider = plugin.settings.cloudServiceType;
    const secretStorage = plugin.secretStorageService;

    const resolveProviderKey = async (
        provider: 'claude' | 'gemini',
        options: { primaryId?: string; primaryPlain?: string; useMainKeyFallback?: boolean } = {}
    ): Promise<string | null> => {
        const { primaryId, primaryPlain, useMainKeyFallback = false } = options;
        if (secretStorage.isAvailable()) {
            return await secretStorage.resolveApiKey({
                primaryId,
                providerFallback: provider,
                useMainKeyFallback,
                plainTextFallback: {
                    primaryKey: primaryPlain,
                    providerKey: plugin.settings.providerSettings?.[provider]?.apiKey,
                    mainCloudKey: useMainKeyFallback ? plugin.settings.cloudApiKey : undefined
                }
            });
        }

        if (primaryPlain) return primaryPlain;
        if (plugin.settings.providerSettings?.[provider]?.apiKey) {
            return plugin.settings.providerSettings[provider]?.apiKey || null;
        }
        if (useMainKeyFallback && plugin.settings.cloudServiceType === provider && plugin.settings.cloudApiKey) {
            return plugin.settings.cloudApiKey;
        }
        return null;
    };

    // If main provider supports PDFs and has a key, use it
    if (mainProvider === 'claude' || mainProvider === 'gemini') {
        const mainKey = await resolveProviderKey(mainProvider, { useMainKeyFallback: true });
        if (mainKey) {
            return {
                provider: mainProvider,
                apiKey: mainKey,
                model: plugin.settings.cloudModel || ''
            };
        }
    }

    // Check if dedicated PDF provider is configured
    const pdfProvider = plugin.settings.pdfProvider;
    const pdfApiKey = plugin.settings.pdfApiKey;

    // If specific PDF provider is selected (not auto)
    if (pdfProvider !== 'auto') {
        // First try dedicated PDF API key
        const dedicatedKey = await resolveProviderKey(pdfProvider, {
            primaryId: PLUGIN_SECRET_IDS.PDF,
            primaryPlain: pdfApiKey,
            useMainKeyFallback: mainProvider === pdfProvider
        });
        if (dedicatedKey) {
            return {
                provider: pdfProvider,
                apiKey: dedicatedKey,
                model: plugin.settings.pdfModel || plugin.settings.providerSettings?.[pdfProvider]?.model || ''
            };
        }
    }

    // Auto mode: try to find any available PDF-capable provider
    // Check Claude provider settings
    const claudeKey = await resolveProviderKey('claude');
    if (claudeKey) {
        return {
            provider: 'claude',
            apiKey: claudeKey,
            model: plugin.settings.providerSettings?.claude?.model || ''
        };
    }

    const geminiKey = await resolveProviderKey('gemini');
    if (geminiKey) {
        return {
            provider: 'gemini',
            apiKey: geminiKey,
            model: plugin.settings.providerSettings?.gemini?.model || ''
        };
    }

    return null;
}

/**
 * Translate PDF using multimodal capabilities of available LLMs (Claude/Gemini)
 * @param plugin Plugin instance
 * @param pdfContent PDF content content
 * @param prompt Translation prompt
 */
export async function translatePdfWithLLM(
    plugin: AIOrganiserPlugin,
    pdfContent: PdfContent,
    prompt: string
): Promise<{ success: boolean; content?: string; error?: string }> {
    try {
        const pdfConfig = await getPdfProviderConfig(plugin);

        if (!pdfConfig) {
            return {
                success: false,
                error: 'No valid PDF translation provider available (Claude/Gemini required)'
            };
        }

        // Create a cloud service with the PDF provider config
        const { CloudLLMService } = await import('./cloudService');

        // If main provider matches PDF provider, use existing service
        if (plugin.settings.serviceType === 'cloud' &&
            plugin.settings.cloudServiceType === pdfConfig.provider) {
            const cloudService = plugin.llmService as InstanceType<typeof CloudLLMService>;
            const parts = [
                { type: 'document' as const, data: pdfContent.base64Data, mediaType: 'application/pdf' },
                { type: 'text' as const, text: prompt }
            ];
            const response = await cloudService.sendMultimodal(parts, { maxTokens: 4096 });
            return response;
        }

        // Create temporary service with PDF provider config
        const pdfCloudService = new CloudLLMService({
            type: pdfConfig.provider,
            endpoint: pdfConfig.provider === 'claude'
                ? 'https://api.anthropic.com/v1/messages'
                : 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
            apiKey: pdfConfig.apiKey,
            modelName: pdfConfig.model || (pdfConfig.provider === 'claude' ? 'claude-sonnet-4-6' : 'gemini-3-flash-preview')
        }, plugin.app);

        const parts = [
            { type: 'document' as const, data: pdfContent.base64Data, mediaType: 'application/pdf' },
            { type: 'text' as const, text: prompt }
        ];
        const response = await pdfCloudService.sendMultimodal(parts, { maxTokens: 4096 });
        return response;
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return { success: false, error: errorMessage };
    }
}
