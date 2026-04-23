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
// `latest-*` sentinels are used where a provider has the auto-tracking
// infrastructure (resolver + tiered-picker in modelCapabilities). Others
// stay on a specific id until we add tier support for them. Sentinels are
// resolved to concrete ids inside CloudLLMService at adapter-build time.
export const PROVIDER_DEFAULT_MODEL: Record<AdapterType, string> = {
  openai: 'latest-gpt',
  // Main-provider Gemini defaults to Pro (top quality). The YouTube
  // specialist path defaults to `latest-flash` separately — flash is
  // fast/cheap enough for video frame analysis, but when the user picks
  // Gemini as their MAIN LLM they expect the strongest model.
  gemini: 'latest-pro',
  deepseek: 'deepseek-v3.2',
  aliyun: 'qwen-max',
  claude: 'latest-sonnet',
  groq: 'meta-llama/llama-4-scout-17b-16e-instruct',
  // Vertex mirrors main Gemini intent — use Pro.
  vertex: 'latest-pro',
  openrouter: 'openai/gpt-5.2',
  bedrock: 'anthropic.claude-sonnet-4-6',
  requesty: 'gpt-5.2',
  cohere: 'command-r7-plus-04-2025',
  grok: 'grok-4',
  mistral: 'mistral-large-3',
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
