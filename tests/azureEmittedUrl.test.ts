/**
 * Azure OpenAI EMITTED-URL contract.
 *
 * Why this file exists, separately from `endpointResolver.test.ts`:
 *
 * The upstream claude-engineering-skills Azure routing bug (commit 8b284ec9)
 * survived a green test suite for its entire life because the tests asserted on
 * the CONSTRUCTED config (`client.baseURL`, `buildURL()`) rather than on the URL
 * a request actually goes to. Those are different strings — the OpenAI SDK adds
 * the `/deployments/<dep>/` segment later, inside `buildRequest`.
 *
 * This repo builds its URLs by hand rather than via the SDK, so the same class of
 * drift is possible in the other direction: an adapter or service could ignore the
 * resolver and concatenate its own path. So these tests inject a fake transport
 * (the mocked `requestUrl`) and assert FULL STRING EQUALITY on the URL the
 * transport was actually handed, end-to-end from settings.
 *
 * Both routing modes are covered because both must keep working:
 *   model-based      → the v1 surface (current default; deployment in the body)
 *   deployment-based → the deployment-qualified surface (APIM / standard API)
 */

vi.mock('obsidian', async () => {
	const mod = await import('./mocks/obsidian');
	return { ...mod, requestUrl: vi.fn() };
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { requestUrl, App } from 'obsidian';
import { CloudLLMService } from '../src/services/cloudService';
import type { AdapterType } from '../src/services/adapters';
import { resolveEndpoint } from '../src/services/apiKeyHelpers';
import { getOpenAIEmbeddingsEndpoint } from '../src/services/azure/endpointResolver';
import { OpenAIEmbeddingService } from '../src/services/embeddings/openaiEmbeddingService';
import { disposeAzurePacers } from '../src/services/azure/azureRequestPacer';

const mockRequestUrl = requestUrl as unknown as ReturnType<typeof vi.fn>;
const app = {} as App;

const OAI = 'https://my-resource.openai.azure.com';

/** Minimal plugin shape `resolveEndpoint` reads (settings only). */
function settingsWith(overrides: Record<string, unknown>): Record<string, unknown> {
	return { azureAIEndpoint: 'https://my-resource.services.ai.azure.com', azureOpenAIEndpoint: OAI, ...overrides };
}
/** `resolveEndpoint` only touches `plugin.settings`; cast at the seam, not in the fixture. */
function pluginWith(settings: Record<string, unknown>) {
	return { settings } as unknown as Parameters<typeof resolveEndpoint>[1];
}
/** Typed shape the endpoint resolver expects. */
function epSettings(overrides: Record<string, unknown>) {
	return settingsWith(overrides) as unknown as Parameters<typeof getOpenAIEmbeddingsEndpoint>[0];
}

/** The URL the fake transport was actually handed. */
function emittedUrl(): string {
	expect(mockRequestUrl).toHaveBeenCalled();
	return (mockRequestUrl.mock.calls[0][0] as { url: string }).url;
}

beforeEach(() => {
	vi.clearAllMocks();
	disposeAzurePacers();
});

describe('azure-openai CHAT — URL actually sent by CloudLLMService', () => {
	async function sendChat(settings: Record<string, unknown>) {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			headers: {},
			json: { choices: [{ message: { content: 'ok' } }] },
			text: '',
		});
		const endpoint = resolveEndpoint('azure-openai' as AdapterType, pluginWith(settingsWith(settings)));
		const svc = new CloudLLMService(
			{ type: 'azure-openai' as AdapterType, endpoint, apiKey: 'k', modelName: 'gpt-5.5', language: 'en' },
			app,
		);
		await svc.summarizeText('hello');
		return endpoint;
	}

	it('model-based emits the v1 chat path with NO api-version', async () => {
		await sendChat({ azureRoutingMode: 'model-based' });
		expect(emittedUrl()).toBe(`${OAI}/openai/v1/chat/completions`);
	});

	it('deployment-based emits the deployment-qualified path with a DATED api-version', async () => {
		await sendChat({
			azureRoutingMode: 'deployment-based',
			azureDeployments: { chat: 'my-gpt-dep' },
		});
		expect(emittedUrl()).toBe(
			`${OAI}/openai/deployments/my-gpt-dep/chat/completions?api-version=2025-03-01-preview`,
		);
	});

	it('the emitted URL equals the resolved endpoint — no adapter-side path concat', async () => {
		const endpoint = await sendChat({
			azureRoutingMode: 'deployment-based',
			azureDeployments: { chat: 'my-gpt-dep' },
		});
		// Guards the upstream failure mode: a green construction-time assertion
		// while the transport is handed a different (longer) URL.
		expect(emittedUrl()).toBe(endpoint);
	});

	it('an api-version pin is honoured on the deployment-qualified path', async () => {
		await sendChat({
			azureRoutingMode: 'deployment-based',
			azureDeployments: { chat: 'my-gpt-dep' },
			azureApiVersionOverride: { chat: '2024-10-21' },
		});
		expect(emittedUrl()).toBe(
			`${OAI}/openai/deployments/my-gpt-dep/chat/completions?api-version=2024-10-21`,
		);
	});
});

describe('azure-openai EMBEDDINGS — URL actually sent by OpenAIEmbeddingService', () => {
	async function embed(settings: Record<string, unknown>) {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			headers: {},
			json: { data: [{ embedding: [0.1, 0.2] }] },
			text: '',
		});
		const endpoint = getOpenAIEmbeddingsEndpoint(epSettings(settings));
		const svc = new OpenAIEmbeddingService({
			apiKey: 'k',
			model: 'text-embedding-3-large',
			endpoint,
			authHeaderType: 'api-key',
		});
		await svc.generateEmbedding('hello');
		return endpoint;
	}

	it('model-based emits the v1 embeddings path with NO api-version', async () => {
		await embed({ azureRoutingMode: 'model-based' });
		expect(emittedUrl()).toBe(`${OAI}/openai/v1/embeddings`);
	});

	it('deployment-based emits the deployment-qualified path with a DATED api-version', async () => {
		await embed({
			azureRoutingMode: 'deployment-based',
			azureDeployments: { embeddings: 'embed-large-dep' },
		});
		expect(emittedUrl()).toBe(
			`${OAI}/openai/deployments/embed-large-dep/embeddings?api-version=2025-03-01-preview`,
		);
	});

	it('chat and embeddings route to DIFFERENT deployments from one settings object', async () => {
		// The upstream defect made one cached client serve both purposes, so an
		// embedding call silently hit the GPT deployment. Here the two URLs are
		// resolved independently and must not collide.
		const settings = settingsWith({
			azureRoutingMode: 'deployment-based',
			azureDeployments: { chat: 'my-gpt-dep', embeddings: 'embed-large-dep' },
		});
		const chat = resolveEndpoint('azure-openai' as AdapterType, pluginWith(settings));
		const emb = getOpenAIEmbeddingsEndpoint(epSettings(settings));
		expect(chat).toBe(`${OAI}/openai/deployments/my-gpt-dep/chat/completions?api-version=2025-03-01-preview`);
		expect(emb).toBe(`${OAI}/openai/deployments/embed-large-dep/embeddings?api-version=2025-03-01-preview`);
		expect(chat).not.toBe(emb);
	});

	it('embeddings honours its OWN api-version pin, independent of chat', async () => {
		await embed({
			azureRoutingMode: 'deployment-based',
			azureDeployments: { embeddings: 'embed-large-dep' },
			azureApiVersionOverride: { chat: '2099-01-01', embeddings: '2024-10-21' },
		});
		expect(emittedUrl()).toBe(
			`${OAI}/openai/deployments/embed-large-dep/embeddings?api-version=2024-10-21`,
		);
	});

	it('a lone chat pin still repins embeddings (back-compat with the old coupled field)', async () => {
		await embed({
			azureRoutingMode: 'deployment-based',
			azureDeployments: { embeddings: 'embed-large-dep' },
			azureApiVersionOverride: { chat: '2024-10-21' },
		});
		expect(emittedUrl()).toBe(
			`${OAI}/openai/deployments/embed-large-dep/embeddings?api-version=2024-10-21`,
		);
	});
});

describe('azure-claude is a SEPARATE surface — deliberately untouched', () => {
	it('emits native Anthropic messages, never a /deployments/ or api-version path', async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			headers: {},
			json: { content: [{ type: 'text', text: 'ok' }] },
			text: '',
		});
		const endpoint = resolveEndpoint('azure-claude' as AdapterType, pluginWith(settingsWith({})));
		const svc = new CloudLLMService(
			{ type: 'azure-claude' as AdapterType, endpoint, apiKey: 'k', modelName: 'claude-sonnet-4-6', language: 'en' },
			app,
		);
		await svc.summarizeText('hello');
		expect(emittedUrl()).toBe('https://my-resource.services.ai.azure.com/anthropic/v1/messages');
	});
});
