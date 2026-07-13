import type { AdapterType } from './index';
import * as endpoints from './cloudEndpoints.json';

// Complete list of supported adapters (keep in sync with AdapterType and createAdapter).
// A literal tuple (`as const`), not `AdapterType[]` — see the compile-time
// exhaustiveness assertion below, which depends on the narrow literal type.
export const ALL_ADAPTERS = [
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
  'azure-claude',
  'azure-openai',
] as const satisfies readonly AdapterType[];

// Compile-time guard: every AdapterType union member must appear in
// ALL_ADAPTERS. If a new member is added to the union without being added
// here, `_MissingAdapterTypes` becomes a non-`never` type and this line
// fails to typecheck (caught by `tsc`, which `npm run test:all`/`build:quick`
// already run — not a runtime assertion).
//
// The array MUST stay a literal tuple for this to be meaningful: with the
// wide `AdapterType[]` annotation, `(typeof ALL_ADAPTERS)[number]` collapses
// back to `AdapterType` and this assertion becomes vacuously true regardless
// of the array's actual contents (a mistake made and caught during review —
// don't reintroduce it).
type _MissingAdapterTypes = Exclude<AdapterType, (typeof ALL_ADAPTERS)[number]>;
const _allAdaptersCovered: [_MissingAdapterTypes] extends [never] ? true : never = true;
void _allAdaptersCovered;

// Default models per provider
// `latest-*` sentinels are used where a provider has the auto-tracking
// infrastructure (resolver + tiered-picker in modelCapabilities). Others
// stay on a specific id until we add tier support for them. Sentinels are
// resolved to concrete ids inside CloudLLMService at adapter-build time.
//
// ⚠ AUDIT-ON-RELEASE — providers without `latest-*` sentinel support below
// (deepseek, groq, openrouter, bedrock, requesty, cohere, grok, mistral)
// must be reviewed manually each time the vendor ships a new generation.
// Long-term fix: extend `resolveLatestModel` in modelCapabilities.ts to
// parse those vendor-specific ID formats. See memory entry
// `feedback-always-use-latest-model-sentinels`.
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
  // Azure: concrete catalog ids only — `latest-*` sentinels never reach the
  // Azure path (plan AD-5). Endpoints are resolved from vault-local settings.
  'azure-claude': 'claude-sonnet-4-6',
  'azure-openai': 'gpt-5.3-chat',
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
  // Azure endpoints are vault-local config (empty public default) — resolved
  // from settings at adapter-build time, never shipped in DEFAULT_SETTINGS.
  'azure-claude': '',
  'azure-openai': '',
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
    'azure-claude': t.azureClaude,
    'azure-openai': t.azureOpenAI,
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
    azureClaude: string;
    azureOpenAI: string;
  };
}
