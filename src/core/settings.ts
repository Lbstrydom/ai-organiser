import { LanguageCode } from '../services/types';
import { AdapterType } from '../services/adapters';
import { SupportedLanguage, DEFAULT_LANGUAGE } from '../i18n';

// Per-provider settings storage - API keys and models persist when switching providers
export interface ProviderSettings {
    apiKey?: string;
    model?: string;
}

export interface ProviderSettingsMap {
    openai?: ProviderSettings;
    gemini?: ProviderSettings;
    deepseek?: ProviderSettings;
    aliyun?: ProviderSettings;
    claude?: ProviderSettings;
    groq?: ProviderSettings;
    vertex?: ProviderSettings;
    openrouter?: ProviderSettings;
    bedrock?: ProviderSettings;
    requesty?: ProviderSettings;
    cohere?: ProviderSettings;
    grok?: ProviderSettings;
    mistral?: ProviderSettings;
    'openai-compatible'?: ProviderSettings;
}

// Legacy interface kept for backward compatibility during migration
export interface ProviderApiKeys {
    openai?: string;
    gemini?: string;
    deepseek?: string;
    aliyun?: string;
    claude?: string;
    groq?: string;
    vertex?: string;
    openrouter?: string;
    bedrock?: string;
    requesty?: string;
    cohere?: string;
    grok?: string;
    mistral?: string;
    'openai-compatible'?: string;
}

export interface AIOrganiserSettings {
    serviceType: 'local' | 'cloud';
    localEndpoint: string;
    localModel: string;
    localServiceType?: 'ollama' | 'lm_studio' | 'localai' | 'openai_compatible';
    cloudEndpoint: string;
    cloudApiKey: string;
    cloudModel: string;
    cloudServiceType: AdapterType;
    // Per-provider settings storage - keys and models persist when switching providers
    providerSettings: ProviderSettingsMap;
    // Legacy field - kept for backward compatibility during migration
    providerApiKeys?: ProviderApiKeys;
    excludedFolders: string[];
    language: LanguageCode;
    interfaceLanguage: SupportedLanguage;
    replaceTags: boolean;
    maxTags: number;                     // Maximum number of tags to generate
    debugMode: boolean;
    // Web Summarization Settings
    enableWebSummarization: boolean;
    summaryLength: 'brief' | 'detailed' | 'comprehensive';
    summaryLanguage: string;
    includeSummaryMetadata: boolean;
    defaultSummaryPersona: string;       // Default persona ID for summarization
    // Configuration Folder Settings
    configFolderPath: string;  // Folder containing taxonomy, prompts, etc.
}

export const DEFAULT_SETTINGS: AIOrganiserSettings = {
    serviceType: 'cloud',
    localEndpoint: 'http://localhost:11434/v1/chat/completions',
    localModel: 'mistral',
    cloudEndpoint: 'https://api.openai.com/v1/chat/completions',
    cloudApiKey: '',
    cloudModel: 'gpt-5.2',
    cloudServiceType: 'openai',
    providerSettings: {},
    excludedFolders: [],
    language: 'default',
    interfaceLanguage: DEFAULT_LANGUAGE,
    replaceTags: true,
    maxTags: 5,
    debugMode: false,
    enableWebSummarization: true,
    summaryLength: 'detailed',
    summaryLanguage: '',
    includeSummaryMetadata: true,
    defaultSummaryPersona: 'student',
    configFolderPath: 'AI-Organiser-Config',
};
