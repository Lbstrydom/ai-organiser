/**
 * Provider Registry Tests
 * Verifies adapter list, defaults, and option building
 */

import { ALL_ADAPTERS, PROVIDER_DEFAULT_MODEL, PROVIDER_ENDPOINT, buildProviderOptions } from '../src/services/adapters/providerRegistry';

const EXPECTED_ADAPTERS = [
  'openai', 'gemini', 'deepseek', 'aliyun', 'claude', 'groq', 'vertex',
  'openrouter', 'bedrock', 'requesty', 'cohere', 'grok', 'mistral', 'openai-compatible',
] as const;

type AdapterTypeLiteral = typeof EXPECTED_ADAPTERS[number];

describe('Provider Registry', () => {
  it('ALL_ADAPTERS includes all supported adapters', () => {
    expect(ALL_ADAPTERS.sort()).toEqual([...EXPECTED_ADAPTERS].sort());
  });

  it('has default models for each adapter', () => {
    for (const adapter of EXPECTED_ADAPTERS) {
      expect(PROVIDER_DEFAULT_MODEL[adapter as AdapterTypeLiteral]).toBeTruthy();
    }
  });

  it('has endpoints for each adapter', () => {
    for (const adapter of EXPECTED_ADAPTERS) {
      expect(PROVIDER_ENDPOINT[adapter as AdapterTypeLiteral]).toBeTruthy();
    }
  });

  it('buildProviderOptions returns entries for all adapters', () => {
    const fakeDropdowns = {
      openai: 'OpenAI', gemini: 'Gemini', deepseek: 'DeepSeek', aliyun: 'Aliyun', claude: 'Claude',
      groq: 'Groq', vertex: 'Vertex AI', openrouter: 'OpenRouter', bedrock: 'Bedrock', requesty: 'Requesty',
      cohere: 'Cohere', grok: 'Grok', mistral: 'Mistral', openaiCompatible: 'OpenAI Compatible',
    };

    const options = buildProviderOptions(fakeDropdowns as any);

    for (const adapter of EXPECTED_ADAPTERS) {
      expect(options[adapter]).toBeTruthy();
    }
  });
});
