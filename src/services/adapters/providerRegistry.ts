import type { AdapterType } from './index';
import * as endpoints from './cloudEndpoints.json';

// Complete list of supported adapters (keep in sync with AdapterType and createAdapter)
export const ALL_ADAPTERS: AdapterType[] = [
  'openai',
  'gemini',
  'deepseek',
  'aliyun',
  'claude',
  'groq',
  'vertex',
  'openrouter',
  'bedrock',
  'requesty',
  'cohere',
  'grok',
  'mistral',
  'openai-compatible',
];

// Default models per provider
export const PROVIDER_DEFAULT_MODEL: Record<AdapterType, string> = {
  openai: 'gpt-5.2',
  gemini: 'gemini-3-flash',
  deepseek: 'deepseek-chat',
  aliyun: 'qwen-max',
  claude: 'claude-sonnet-4-5-20250929',
  groq: 'llama-3.3-70b-versatile',
  vertex: 'gemini-3-flash',
  openrouter: 'openai/gpt-5.2',
  bedrock: 'us.anthropic.claude-sonnet-4-5-v1:0',
  requesty: 'gpt-5.2',
  cohere: 'command-r-plus',
  grok: 'grok-3',
  mistral: 'mistral-large-latest',
  'openai-compatible': 'your-model',
};

// Default endpoints per provider
export const PROVIDER_ENDPOINT: Record<AdapterType, string> = {
  openai: endpoints.openai,
  gemini: endpoints.gemini,
  deepseek: endpoints.deepseek,
  aliyun: endpoints.aliyun,
  claude: endpoints.claude,
  groq: endpoints.groq,
  vertex: endpoints.vertex,
  openrouter: endpoints.openrouter,
  bedrock: endpoints.bedrock,
  requesty: endpoints.requesty,
  cohere: endpoints.cohere,
  grok: endpoints.grok,
  mistral: endpoints.mistral,
  'openai-compatible': 'http://your-api-endpoint/v1/chat/completions',
};

// Helper to build provider dropdown options using translations
export function buildProviderOptions(t: AIOrganiserTranslations['dropdowns']): Record<string, string> {
  return {
    openai: t.openai,
    gemini: t.gemini,
    deepseek: t.deepseek,
    aliyun: t.aliyun,
    claude: t.claude,
    groq: t.groq,
    vertex: t.vertex,
    openrouter: t.openrouter,
    bedrock: t.bedrock,
    requesty: t.requesty,
    cohere: t.cohere,
    grok: t.grok,
    mistral: t.mistral,
    'openai-compatible': t.openaiCompatible,
  };
}

// Local type for translations to avoid heavy UI imports
export interface AIOrganiserTranslations {
  dropdowns: Record<string, string> & {
    openai: string;
    gemini: string;
    deepseek: string;
    aliyun: string;
    claude: string;
    groq: string;
    vertex: string;
    openrouter: string;
    bedrock: string;
    requesty: string;
    cohere: string;
    grok: string;
    mistral: string;
    openaiCompatible: string;
  };
}
