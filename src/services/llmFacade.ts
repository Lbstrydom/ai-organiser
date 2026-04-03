import { MultimodalLLMService, SummarizableLLMService, SummarizeOptions } from './types';
import { ContentPart } from './adapters/types';
import { logger } from '../utils/logger';

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

/**
 * Type guard to check if service implements MultimodalLLMService interface
 */
export function isMultimodalService(service: SummarizableLLMService): service is MultimodalLLMService {
    return 'sendMultimodal' in service && typeof (service as MultimodalLLMService).sendMultimodal === 'function'
        && 'getMultimodalCapability' in service && typeof (service as MultimodalLLMService).getMultimodalCapability === 'function';
}

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
    prompt: string,
    options?: SummarizeOptions
): Promise<LLMCallResult> {
    try {
        return await context.llmService.summarizeText(prompt, options);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return { success: false, error: errorMessage };
    }
}

/** Stream LLM response incrementally. Falls back to non-stream if provider
 *  doesn't support streaming or if streaming fails. */
export async function summarizeTextStream(
    context: LLMFacadeContext,
    prompt: string,
    onChunk: (chunk: string) => void,
    signal?: AbortSignal
): Promise<LLMCallResult> {
    const service = context.llmService;

    // Check if streaming is supported at runtime
    if ('summarizeTextStream' in service && typeof service.summarizeTextStream === 'function') {
        try {
            return await service.summarizeTextStream(prompt, onChunk, signal);
        } catch (e) {
            // If aborted, propagate — do NOT fall back to a non-stream request
            if (signal?.aborted || (e instanceof DOMException && e.name === 'AbortError')) {
                return { success: false, error: 'Aborted' };
            }
            // Streaming failed for other reasons — fall back to non-stream
            logger.warn('LLM', 'Streaming failed, falling back to non-stream:', e);
        }
    }

    // Fallback: non-stream call, deliver entire content as single chunk
    const result = await summarizeText(context, prompt);
    if (result.success && result.content) {
        onChunk(result.content);
    }
    return result;
}

export async function sendMultimodal(
    context: LLMFacadeContext,
    parts: ContentPart[],
    options?: { maxTokens?: number }
): Promise<LLMCallResult> {
    const { mode, provider } = getServiceType(context);

    if (mode !== 'cloud') {
        return { success: false, error: 'Multimodal analysis is only available for cloud providers' };
    }

    if (!isMultimodalService(context.llmService)) {
        return { success: false, error: `Multimodal analysis is not supported for provider ${provider}` };
    }

    try {
        return await context.llmService.sendMultimodal(parts, options);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return { success: false, error: errorMessage };
    }
}
