/**
 * Provider Registry Tests
 * Verifies adapter list, defaults, and option building
 */

import { ALL_ADAPTERS, PROVIDER_DEFAULT_MODEL, PROVIDER_ENDPOINT, buildProviderOptions } from '../src/services/adapters/providerRegistry';

const EXPECTED_ADAPTERS = [
  'openai', 'gemini', 'deepseek', 'aliyun', 'claude', 'groq', 'vertex',
  'openrouter', 'bedrock', 'requesty', 'cohere', 'grok', 'mistral', 'openai-compatible',
  'azure-claude', 'azure-openai',
] as const;

type AdapterTypeLiteral = typeof EXPECTED_ADAPTERS[number];

// Azure endpoints are vault-local config (empty public default) — they are
// intentionally excluded from the truthy-endpoint assertion below.
const AZURE_ADAPTERS = ['azure-claude', 'azure-openai'] as const;

describe('Provider Registry', () => {
  it('ALL_ADAPTERS includes all supported adapters', () => {
    expect(ALL_ADAPTERS.sort()).toEqual([...EXPECTED_ADAPTERS].sort());
  });

  it('has default models for each adapter', () => {
    for (const adapter of EXPECTED_ADAPTERS) {
      expect(PROVIDER_DEFAULT_MODEL[adapter as AdapterTypeLiteral]).toBeTruthy();
    }
  });

  it('has endpoints for each adapter (Azure endpoints are vault-local, empty by design)', () => {
    for (const adapter of EXPECTED_ADAPTERS) {
      if ((AZURE_ADAPTERS as readonly string[]).includes(adapter)) {
        expect(PROVIDER_ENDPOINT[adapter as AdapterTypeLiteral]).toBe('');
        continue;
      }
      expect(PROVIDER_ENDPOINT[adapter as AdapterTypeLiteral]).toBeTruthy();
    }
  });

  it('buildProviderOptions returns entries for all adapters', () => {
    const fakeDropdowns = {
      openai: 'OpenAI', gemini: 'Gemini', deepseek: 'DeepSeek', aliyun: 'Aliyun', claude: 'Claude',
      groq: 'Groq', vertex: 'Vertex AI', openrouter: 'OpenRouter', bedrock: 'Bedrock', requesty: 'Requesty',
      cohere: 'Cohere', grok: 'Grok', mistral: 'Mistral', openaiCompatible: 'OpenAI Compatible',
      azureClaude: 'Azure AI Foundry (Claude)', azureOpenAI: 'Azure OpenAI',
    };

    const options = buildProviderOptions(fakeDropdowns as any);

    for (const adapter of EXPECTED_ADAPTERS) {
      expect(options[adapter]).toBeTruthy();
    }
  });
});
