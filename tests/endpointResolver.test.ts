import { describe, it, expect } from 'vitest';
import {
	normalizeEndpointUrl,
	getClaudeMessagesEndpoint,
	getOpenAIChatEndpoint,
	getOpenAIEmbeddingsEndpoint,
	getWhisperEndpoint,
} from '../src/services/azure/endpointResolver';

const AI = 'https://my-resource.services.ai.azure.com';
const OAI = 'https://my-resource.openai.azure.com';

function base(overrides: Record<string, unknown> = {}) {
	return {
		azureAIEndpoint: AI,
		azureOpenAIEndpoint: OAI,
		...overrides,
	} as Parameters<typeof getOpenAIChatEndpoint>[0];
}

describe('normalizeEndpointUrl', () => {
	it('returns scheme + host origin with no trailing slash', () => {
		expect(normalizeEndpointUrl('https://x.openai.azure.com/')).toBe('https://x.openai.azure.com');
		expect(normalizeEndpointUrl('https://x.openai.azure.com')).toBe('https://x.openai.azure.com');
	});

	it('rejects non-https URLs', () => {
		expect(() => normalizeEndpointUrl('http://x.openai.azure.com')).toThrow(/HTTPS/i);
	});

	it('rejects URLs that carry a path', () => {
		expect(() => normalizeEndpointUrl('https://x.openai.azure.com/openai/v1')).toThrow(/no path/i);
	});

	it('rejects malformed URLs', () => {
		expect(() => normalizeEndpointUrl('not a url')).toThrow(/Invalid endpoint URL/i);
	});

	it('rejects empty input', () => {
		expect(() => normalizeEndpointUrl('')).toThrow(/required/i);
	});
});

describe('claude messages endpoint', () => {
	it('builds the anthropic messages path with no api-version', () => {
		const url = getClaudeMessagesEndpoint(base());
		expect(url).toBe(`${AI}/anthropic/v1/messages`);
		expect(url).not.toContain('api-version');
	});
});

describe('chat endpoint', () => {
	it('model-based path omits api-version', () => {
		const url = getOpenAIChatEndpoint(base({ azureRoutingMode: 'model-based' }));
		expect(url).toBe(`${OAI}/openai/v1/chat/completions`);
		expect(url).not.toContain('api-version');
	});

	it('deployment-based path includes a default api-version', () => {
		const url = getOpenAIChatEndpoint(base({
			azureRoutingMode: 'deployment-based',
			azureDeployments: { chat: 'my-gpt' },
		}));
		expect(url).toContain('/openai/deployments/my-gpt/chat/completions');
		expect(url).toContain('?api-version=2024-10-21');
	});

	it('deployment-based path honours a chat api-version override', () => {
		const url = getOpenAIChatEndpoint(base({
			azureRoutingMode: 'deployment-based',
			azureDeployments: { chat: 'my-gpt' },
			azureApiVersionOverride: { chat: '2099-01-01' },
		}));
		expect(url).toContain('?api-version=2099-01-01');
	});
});

describe('embeddings endpoint', () => {
	it('model-based path omits api-version', () => {
		const url = getOpenAIEmbeddingsEndpoint(base({ azureRoutingMode: 'model-based' }));
		expect(url).toBe(`${OAI}/openai/v1/embeddings`);
		expect(url).not.toContain('api-version');
	});

	it('deployment-based path includes a default api-version', () => {
		const url = getOpenAIEmbeddingsEndpoint(base({
			azureRoutingMode: 'deployment-based',
			azureDeployments: { embeddings: 'embed-large' },
		}));
		expect(url).toContain('/openai/deployments/embed-large/embeddings');
		expect(url).toContain('?api-version=2024-10-21');
	});
});

describe('whisper endpoint', () => {
	it('always includes an api-version', () => {
		const url = getWhisperEndpoint(base({ azureWhisperDeployment: 'whisper' }));
		expect(url).toContain('/openai/deployments/whisper/audio/transcriptions');
		expect(url).toContain('?api-version=2024-10-21');
	});

	it('honours a whisper api-version override', () => {
		const url = getWhisperEndpoint(base({
			azureWhisperDeployment: 'whisper',
			azureApiVersionOverride: { whisper: '2030-05-05' },
		}));
		expect(url).toContain('?api-version=2030-05-05');
	});
});
