import { TaggingMode } from './prompts/types';
import { ContentPart } from './adapters/types';

export const MAX_CONCURRENT_REQUESTS = 3;

export type LanguageCode =
    | "default"
    | "en"
    | "ar"
    | "cs"
    | "da"
    | "de"
    | "es"
    | "fr"
    | "he"
    | "id"
    | "it"
    | "ja"
    | "ko"
    | "nl"
    | "no"
    | "pl"
    | "pt"
    | "pt-BR"
    | "ro"
    | "ru"
    | "tr"
    | "uk"
    | "zh"
    | "zh-TW";

export interface LLMResponse {
    suggestedTags?: string[];
    matchedExistingTags?: string[];
    success?: boolean;
    content?: string; // For summarization
}

export interface LLMServiceConfig {
    endpoint: string;
    modelName: string;
    apiKey?: string;
    apiSecret?: string;
    language?: LanguageCode;
}

export interface GenerateTagsResponse {
    success: boolean;
    tags?: string[];
    suggestedTitle?: string;
    suggestedFolder?: string;
    error?: string;
    rawResponse?: string; // Raw AI response for custom parsing
}

export interface LLMService {
    /**
     * @deprecated Use generateTags() instead for taxonomy-based tagging
     */
    analyzeTags(
        content: string,
        candidateTags: string[],
        mode: TaggingMode,
        maxTags: number,
        language?: LanguageCode
    ): Promise<LLMResponse>;

    /**
     * Generate tags from a pre-built prompt (taxonomy-based approach)
     * @param prompt - The complete prompt including content and taxonomy
     * @returns Promise resolving to tags generation result
     */
    generateTags(prompt: string): Promise<GenerateTagsResponse>;

    testConnection(): Promise<{ result: ConnectionTestResult; error?: ConnectionTestError }>;

    formatRequest(prompt: string, language?: string): Record<string, unknown>;

    dispose(): Promise<void>;

    setDebugMode(enabled: boolean): void;

    /**
     * Set custom summarization timeout (for power users)
     * @param seconds - Timeout in seconds (30-900)
     */
    setSummarizeTimeout(seconds: number): void;

    /**
     * Get the current model name (optional method for metadata tracking)
     */
    getModelName?(): string;
}

/** Options for per-call LLM control (token budget, thinking, timeout). */
export interface SummarizeOptions {
    timeoutMs?: number;
    /** Override max output tokens for this call. Provider default used if omitted. */
    maxTokens?: number;
    /** Disable adaptive thinking (Claude) for this call. Reduces latency for structured output tasks. */
    disableThinking?: boolean;
    /** Override the model ID for this call. Used by the presentation pipeline to route
     *  generation (Opus) and audits (Sonnet non-reasoning) to different models
     *  without creating temporary service instances. */
    modelOverride?: string;
}

export interface SummarizableLLMService extends LLMService {
    summarizeText(prompt: string, options?: SummarizeOptions): Promise<{ success: boolean; content?: string; error?: string }>;

    /** Optional streaming synthesis. Implementations that don't support streaming
     *  should NOT implement this method — the facade handles fallback. */
    summarizeTextStream?(
        prompt: string,
        onChunk: (chunk: string) => void,
        signal?: AbortSignal
    ): Promise<{ success: boolean; content?: string; error?: string }>;
}

export interface MultimodalLLMService extends SummarizableLLMService {
    /**
     * Send multimodal content (text, images, documents) to the LLM
     * @param parts - Array of content parts (text, image, or document)
     * @param options - Optional configuration including maxTokens
     * @returns Promise resolving to LLM response
     */
    sendMultimodal(
        parts: ContentPart[],
        options?: { maxTokens?: number }
    ): Promise<{ success: boolean; content?: string; error?: string }>;

    /**
     * Query the provider's multimodal capability level
     */
    getMultimodalCapability(): import('./adapters/types').MultimodalCapability;
}

export interface ConnectionTestError {
    type: "auth" | "network" | "timeout" | "unknown";
    message: string;
}

export enum ConnectionTestResult {
    Success = "success",
    Failed = "failed"
}
