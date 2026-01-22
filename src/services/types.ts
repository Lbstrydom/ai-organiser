import { TaggingMode } from './prompts/types';

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

    formatRequest(prompt: string, language?: string): any;

    dispose(): Promise<void>;

    setDebugMode(enabled: boolean): void;

    /**
     * Get the current model name (optional method for metadata tracking)
     */
    getModelName?(): string;
}

export interface ConnectionTestError {
    type: "auth" | "network" | "timeout" | "unknown";
    message: string;
}

export enum ConnectionTestResult {
    Success = "success",
    Failed = "failed"
}
