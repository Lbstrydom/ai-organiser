import { MultimodalLLMService, SummarizableLLMService } from './types';

export type LLMCallResult = { success: boolean; content?: string; error?: string };

export type ServiceTypeInfo = {
    mode: 'cloud' | 'local';
    provider: string;
};

export type LLMFacadeContext = {
    llmService: SummarizableLLMService;
    settings: {
        serviceType: 'cloud' | 'local';
        cloudServiceType: string;
    };
};

export function getServiceType(context: LLMFacadeContext): ServiceTypeInfo {
    if (context.settings.serviceType === 'cloud') {
        return {
            mode: 'cloud',
            provider: context.settings.cloudServiceType
        };
    }

    return {
        mode: 'local',
        provider: 'local'
    };
}

/**
 * Create an LLMFacadeContext from a plugin instance.
 * DRY helper replacing 14+ repeated `{ llmService: plugin.llmService, settings: plugin.settings }` constructions.
 */
export function pluginContext(plugin: { llmService: SummarizableLLMService; settings: { serviceType: 'cloud' | 'local'; cloudServiceType: string } }): LLMFacadeContext {
    return { llmService: plugin.llmService, settings: plugin.settings };
}

export async function summarizeText(
    context: LLMFacadeContext,
    prompt: string
): Promise<LLMCallResult> {
    try {
        return await context.llmService.summarizeText(prompt);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return { success: false, error: errorMessage };
    }
}

export async function analyzeMultipleContent(
    context: LLMFacadeContext,
    items: Array<{ base64: string; mimeType: string }>,
    prompt: string
): Promise<LLMCallResult> {
    const { mode, provider } = getServiceType(context);

    if (mode !== 'cloud') {
        return { success: false, error: 'Multimodal analysis is only available for cloud providers' };
    }

    const multimodalService = context.llmService as MultimodalLLMService;

    if (typeof multimodalService.analyzeMultipleContent !== 'function') {
        return { success: false, error: `Multimodal analysis is not supported for provider ${provider}` };
    }

    try {
        return await multimodalService.analyzeMultipleContent(items, prompt);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return { success: false, error: errorMessage };
    }
}
