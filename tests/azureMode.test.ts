// @vitest-environment happy-dom
/**
 * Azure mode auto-routing + no-silent-fallback + live-connection-test redaction.
 *
 * Covers:
 *  - isAzureMode helper
 *  - getAudioTranscriptionApiKey returns null in Azure mode when key/endpoint missing
 *    (no silent openai/groq fallback)
 *  - createEmbeddingServiceFromSettings returns null in Azure mode when key/endpoint
 *    missing (no silent local-onnx / personal-OpenAI fallback)
 *  - getPdfProviderConfig routes to azure-claude in Azure mode (no personal-key fallback)
 *  - testAzureConnection redacts endpoint/key/header content + maps statuses
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRequestUrl = vi.fn();
vi.mock('obsidian', async () => {
	const actual = await vi.importActual('./mocks/obsidian');
	return {
		...(actual as Record<string, unknown>),
		requestUrl: (...args: unknown[]) => mockRequestUrl(...args),
	};
});

import { isAzureMode } from '../src/services/azure/endpointResolver';
import { getAudioTranscriptionApiKey, resolveEndpoint } from '../src/services/apiKeyHelpers';
import { getPdfProviderConfig } from '../src/services/pdfTranslationService';
import { createEmbeddingServiceFromSettings } from '../src/services/embeddings/embeddingServiceFactory';
import { testAzureConnection } from '../src/services/azure/azureConnectionTest';
import { resolveProviderProfile } from '../src/services/providerProfile';
import { NullLLMService } from '../src/services/llm/nullLLMService';

const AI_ENDPOINT = 'https://my-resource.services.ai.azure.com';
const OAI_ENDPOINT = 'https://my-resource.openai.azure.com';

/** Minimal plugin stub. SecretStorage unavailable → plain-text key chain. */
function makePlugin(settingsOverrides: Record<string, unknown> = {}): any {
	const settings: Record<string, unknown> = {
		cloudServiceType: 'azure-claude',
		azureApiKey: 'azure-key-123',
		azureAIEndpoint: AI_ENDPOINT,
		azureOpenAIEndpoint: OAI_ENDPOINT,
		azureRoutingMode: 'model-based',
		azureDeployments: {},
		azureApiVersionOverride: {},
		azureGPTModel: 'gpt-5.3-chat',
		cloudModel: 'claude-sonnet-4-6',
		embeddingModel: 'text-embedding-3-large',
		embeddingProvider: 'openai',
		enableSemanticSearch: true,
		audioTranscriptionProvider: 'openai',
		taskModels: {},
		providerSettings: {},
		...settingsOverrides,
	};
	return {
		settings,
		secretStorageService: { isAvailable: () => false },
	};
}

describe('isAzureMode', () => {
	it('true for any azure-* cloudServiceType', () => {
		expect(isAzureMode({ cloudServiceType: 'azure-claude' })).toBe(true);
		expect(isAzureMode({ cloudServiceType: 'azure-openai' })).toBe(true);
	});
	it('false for non-azure providers and undefined', () => {
		expect(isAzureMode({ cloudServiceType: 'claude' })).toBe(false);
		expect(isAzureMode({ cloudServiceType: 'openai' })).toBe(false);
		expect(isAzureMode({})).toBe(false);
	});
});

describe('getAudioTranscriptionApiKey — Azure no-silent-fallback', () => {
	it('routes Whisper to Azure even when main is azure-claude', async () => {
		const plugin = makePlugin({ cloudServiceType: 'azure-claude' });
		const r = await getAudioTranscriptionApiKey(plugin);
		expect(r).not.toBeNull();
		expect(r!.provider).toBe('azure');
		expect(r!.key).toBe('azure-key-123');
		expect(r!.azureEndpoint).toContain('audio/transcriptions');
	});

	it('returns null in Azure mode when the Azure key is missing (no openai/groq fallback)', async () => {
		const plugin = makePlugin({
			azureApiKey: '',
			// even with a personal openai key present, Azure mode must NOT fall back
			providerSettings: { openai: { apiKey: 'sk-personal' } },
		});
		const r = await getAudioTranscriptionApiKey(plugin);
		expect(r).toBeNull();
	});

	it('returns null in Azure mode when the Azure OpenAI endpoint is invalid', async () => {
		const plugin = makePlugin({ azureOpenAIEndpoint: 'not-a-url' });
		const r = await getAudioTranscriptionApiKey(plugin);
		expect(r).toBeNull();
	});

	it('non-azure mode still uses the direct provider key', async () => {
		const plugin = makePlugin({
			cloudServiceType: 'openai',
			cloudApiKey: 'sk-openai',
			providerSettings: { openai: { apiKey: 'sk-openai' } },
		});
		const r = await getAudioTranscriptionApiKey(plugin);
		expect(r).not.toBeNull();
		expect(r!.provider).toBe('openai');
	});
});

describe('createEmbeddingServiceFromSettings — Azure no-silent-fallback', () => {
	it('returns null in Azure mode when the Azure key is missing (no local-onnx / personal key)', async () => {
		const plugin = makePlugin({ azureApiKey: '', cloudApiKey: 'sk-personal' });
		const { service, unavailableReason } = await createEmbeddingServiceFromSettings(plugin.settings, undefined);
		expect(service).toBeNull();
		// Azure mode never falls back to local-onnx — this must be
		// 'credentials-missing', not 'local-onnx-not-consented'.
		expect(unavailableReason).toBe('credentials-missing');
	});

	it('returns null in Azure mode when the Azure OpenAI endpoint is invalid', async () => {
		const plugin = makePlugin({ azureOpenAIEndpoint: '' });
		const { service, unavailableReason } = await createEmbeddingServiceFromSettings(plugin.settings, 'azure-key-123');
		expect(service).toBeNull();
		expect(unavailableReason).toBe('credentials-missing');
	});

	it('builds an Azure embedding service when key + endpoint present', async () => {
		const plugin = makePlugin();
		const { service } = await createEmbeddingServiceFromSettings(plugin.settings, 'azure-key-123');
		expect(service).not.toBeNull();
	});
});

describe('getPdfProviderConfig — Azure routing', () => {
	it('routes to azure-claude with resolved endpoint in Azure mode', async () => {
		const plugin = makePlugin({ cloudServiceType: 'azure-openai' }); // even when main is openai surface
		const cfg = await getPdfProviderConfig(plugin);
		expect(cfg).not.toBeNull();
		expect(cfg!.provider).toBe('azure-claude');
		expect(cfg!.apiKey).toBe('azure-key-123');
		expect(cfg!.endpoint).toContain('/anthropic/v1/messages');
	});

	it('returns null in Azure mode when the Azure key is missing (no personal Claude key)', async () => {
		const plugin = makePlugin({
			azureApiKey: '',
			providerSettings: { claude: { apiKey: 'sk-ant-personal' } },
		});
		const cfg = await getPdfProviderConfig(plugin);
		expect(cfg).toBeNull();
	});
});

describe('testAzureConnection — redaction + status mapping', () => {
	beforeEach(() => {
		mockRequestUrl.mockReset();
	});

	it('reports preflight errors without making network calls when config invalid', async () => {
		const plugin = makePlugin({ azureAIEndpoint: 'http://insecure.services.ai.azure.com' });
		const report = await testAzureConnection(plugin);
		expect(report.preflightOk).toBe(false);
		expect(report.preflightErrors.length).toBeGreaterThan(0);
		expect(mockRequestUrl).not.toHaveBeenCalled();
	});

	it('maps 200 to connected and never leaks endpoint/key/header content', async () => {
		mockRequestUrl.mockImplementation((opts: { url: string }) => {
			if (opts.url.includes('/anthropic/')) {
				return Promise.resolve({ status: 200, json: { content: [{ type: 'text', text: 'pong' }] } });
			}
			if (opts.url.includes('/embeddings')) {
				return Promise.resolve({ status: 200, json: { data: [{ embedding: [0.1, 0.2] }] } });
			}
			return Promise.resolve({ status: 200, json: { choices: [{ message: { content: 'pong' } }] } });
		});
		const plugin = makePlugin();
		const report = await testAzureConnection(plugin);
		expect(report.preflightOk).toBe(true);
		const claude = report.surfaces.find(s => s.surface === 'azure-claude')!;
		expect(claude.ok).toBe(true);
		expect(claude.message).toBe('connected');
		// Redaction: no message contains the endpoint host, key, or header tokens.
		for (const s of report.surfaces) {
			expect(s.message).not.toContain(AI_ENDPOINT);
			expect(s.message).not.toContain(OAI_ENDPOINT);
			expect(s.message).not.toContain('azure-key-123');
			expect(s.message.toLowerCase()).not.toContain('bearer');
			expect(s.message.toLowerCase()).not.toContain('api-key');
		}
	});

	it('maps 401 to a redacted unauthorized message', async () => {
		mockRequestUrl.mockResolvedValue({ status: 401, json: { error: { message: 'secret-leak' } } });
		const plugin = makePlugin();
		const report = await testAzureConnection(plugin);
		const claude = report.surfaces.find(s => s.surface === 'azure-claude')!;
		expect(claude.ok).toBe(false);
		expect(claude.message).toBe('unauthorized — check key');
		expect(claude.message).not.toContain('secret-leak');
	});

	it('maps 404 to deployment/endpoint not found', async () => {
		mockRequestUrl.mockResolvedValue({ status: 404, json: {} });
		const plugin = makePlugin();
		const report = await testAzureConnection(plugin);
		const claude = report.surfaces.find(s => s.surface === 'azure-claude')!;
		expect(claude.message).toBe('deployment/endpoint not found');
	});

	it('maps a thrown/network rejection to could not reach endpoint', async () => {
		mockRequestUrl.mockRejectedValue(new Error('ENOTFOUND'));
		const plugin = makePlugin();
		const report = await testAzureConnection(plugin);
		const claude = report.surfaces.find(s => s.surface === 'azure-claude')!;
		expect(claude.ok).toBe(false);
		expect(claude.message).toBe('could not reach endpoint');
	});

	it('skips OpenAI surfaces when the OpenAI endpoint is unset', async () => {
		mockRequestUrl.mockResolvedValue({ status: 200, json: { content: [{ type: 'text', text: 'pong' }] } });
		const plugin = makePlugin({ azureOpenAIEndpoint: '' });
		const report = await testAzureConnection(plugin);
		expect(report.surfaces.find(s => s.surface === 'azure-openai-chat')).toBeUndefined();
		expect(report.surfaces.find(s => s.surface === 'azure-openai-embeddings')).toBeUndefined();
		expect(report.surfaces.find(s => s.surface === 'azure-claude')).toBeDefined();
	});
});

describe('fail-closed Azure — no personal-Anthropic call (keystone negative test)', () => {
	beforeEach(() => {
		mockRequestUrl.mockReset();
		mockRequestUrl.mockResolvedValue({ status: 200, json: {} });
	});

	// Mirrors initializeLLMService's decision: a misconfigured Azure profile
	// installs a NullLLMService (never CloudLLMService) → no HTTP path exists.
	it('missing key+endpoint → invalid profile → NullLLMService returns error, zero Anthropic calls', async () => {
		const plugin = makePlugin({ azureApiKey: '', azureAIEndpoint: '', azureOpenAIEndpoint: '' });
		const profile = await resolveProviderProfile(plugin);
		expect(profile.mode).toBe('azure');
		expect(profile.valid).toBe(false);
		expect(profile.error).toBeTruthy();

		const service = new NullLLMService(profile.error!);
		const r = await service.summarizeText('hello');
		expect(r.success).toBe(false);
		expect(r.error).toBe(profile.error);

		// The HTTP boundary: no requestUrl ever hit an Anthropic host.
		const anthropicCalls = mockRequestUrl.mock.calls.filter((call) => {
			const opts = call[0] as { url?: string } | undefined;
			return typeof opts?.url === 'string' && opts.url.includes('anthropic.com');
		});
		expect(anthropicCalls.length).toBe(0);
		expect(mockRequestUrl).not.toHaveBeenCalled();
	});

	it('missing key only → invalid profile (key present check)', async () => {
		const plugin = makePlugin({ azureApiKey: '' });
		const profile = await resolveProviderProfile(plugin);
		expect(profile.valid).toBe(false);
	});

	it('valid Azure → valid profile with the Azure host', async () => {
		const plugin = makePlugin();
		const profile = await resolveProviderProfile(plugin);
		expect(profile.valid).toBe(true);
		expect(profile.endpointHost).toBe('my-resource.services.ai.azure.com');
	});

	it('NullLLMService streaming + multimodal also fail closed with no network', async () => {
		const service = new NullLLMService('boom');
		const stream = await service.summarizeTextStream('p', () => { /* no chunks */ });
		expect(stream.success).toBe(false);
		const mm = await service.sendMultimodal([{ type: 'text', text: 'p' }]);
		expect(mm.success).toBe(false);
		expect(mockRequestUrl).not.toHaveBeenCalled();
	});
});

describe('resolveEndpoint — single Azure-aware endpoint SSOT', () => {
	const mkPlugin = (settings: Record<string, unknown>) => ({ settings }) as unknown as Parameters<typeof resolveEndpoint>[1];

	it('azure-claude resolves the Foundry messages URL from azureAIEndpoint', () => {
		const p = mkPlugin({ azureAIEndpoint: AI_ENDPOINT, azureOpenAIEndpoint: OAI_ENDPOINT });
		expect(resolveEndpoint('azure-claude', p)).toBe(`${AI_ENDPOINT}/anthropic/v1/messages`);
	});

	it('azure-openai resolves the OpenAI chat URL from azureOpenAIEndpoint', () => {
		const p = mkPlugin({ azureOpenAIEndpoint: OAI_ENDPOINT, azureRoutingMode: 'model-based' });
		expect(resolveEndpoint('azure-openai', p)).toContain(OAI_ENDPOINT);
		expect(resolveEndpoint('azure-openai', p)).toContain('/openai/v1/');
	});

	it('returns empty string for an Azure provider with no endpoint configured (no fabricated URL)', () => {
		const p = mkPlugin({ azureAIEndpoint: '', azureOpenAIEndpoint: '' });
		expect(resolveEndpoint('azure-claude', p)).toBe('');
		expect(resolveEndpoint('azure-openai', p)).toBe('');
	});

	it('non-Azure providers keep their static public endpoint (regression guard)', () => {
		const p = mkPlugin({});
		expect(resolveEndpoint('claude', p)).toMatch(/^https?:\/\//);
		expect(resolveEndpoint('openai', p)).toMatch(/^https?:\/\//);
	});
});

describe('testAzureConnection — Azure AI Speech probes (azure-audio follow-up)', () => {
	beforeEach(() => {
		mockRequestUrl.mockReset();
	});

	it('skips speech surfaces when no Speech region/endpoint configured', async () => {
		mockRequestUrl.mockResolvedValue({ status: 200, json: { content: [{ type: 'text', text: 'pong' }], choices: [{ message: { content: 'p' } }], data: [{ embedding: [0.1] }] } });
		const plugin = makePlugin();
		const report = await testAzureConnection(plugin);
		expect(report.surfaces.find(s => s.surface === 'azure-speech-tts')).toBeUndefined();
		expect(report.surfaces.find(s => s.surface === 'azure-speech-stt')).toBeUndefined();
	});

	it('probes voices/list when a region is set but no voice yet (shared Foundry key)', async () => {
		mockRequestUrl.mockImplementation((opts: { url: string }) => {
			if (opts.url.includes('voices/list')) return Promise.resolve({ status: 200, json: [] });
			if (opts.url.includes('/anthropic/')) return Promise.resolve({ status: 200, json: { content: [{ type: 'text', text: 'pong' }] } });
			if (opts.url.includes('/embeddings')) return Promise.resolve({ status: 200, json: { data: [{ embedding: [0.1] }] } });
			return Promise.resolve({ status: 200, json: { choices: [{ message: { content: 'p' } }], text: '' } });
		});
		const plugin = makePlugin({ azureSpeechRegion: 'swedencentral' });
		const report = await testAzureConnection(plugin);
		const tts = report.surfaces.find(s => s.surface === 'azure-speech-tts')!;
		expect(tts.ok).toBe(true);
		expect(tts.message).toContain('pick a voice');
		const voicesCall = mockRequestUrl.mock.calls.find(c => (c[0] as { url: string }).url.includes('voices/list'))!;
		// Speech auth header (NOT the OpenAI api-key header), via the shared Foundry key.
		expect((voicesCall[0] as { headers: Record<string, string> }).headers['Ocp-Apim-Subscription-Key']).toBe('azure-key-123');
	});

	it('synthesizes SSML when a voice is configured', async () => {
		mockRequestUrl.mockImplementation((opts: { url: string }) => {
			if (opts.url.includes('tts.speech.microsoft.com/cognitiveservices/v1')) {
				return Promise.resolve({ status: 200, json: null, arrayBuffer: new ArrayBuffer(64), text: '' });
			}
			if (opts.url.includes('/anthropic/')) return Promise.resolve({ status: 200, json: { content: [{ type: 'text', text: 'pong' }] } });
			if (opts.url.includes('/embeddings')) return Promise.resolve({ status: 200, json: { data: [{ embedding: [0.1] }] } });
			return Promise.resolve({ status: 200, json: { choices: [{ message: { content: 'p' } }], text: '' } });
		});
		const plugin = makePlugin({ azureSpeechRegion: 'swedencentral', azureSpeechVoice: 'en-US-AvaNeural' });
		const report = await testAzureConnection(plugin);
		const tts = report.surfaces.find(s => s.surface === 'azure-speech-tts')!;
		expect(tts.ok).toBe(true);
		expect(tts.message).toContain('voice synthesized');
		const synthCall = mockRequestUrl.mock.calls.find(c => (c[0] as { url: string }).url.includes('/cognitiveservices/v1'))!;
		expect((synthCall[0] as { body: string }).body).toContain('<voice name="en-US-AvaNeural">');
	});

	it('probes Fast Transcription with the silent WAV when the Speech endpoint is set', async () => {
		mockRequestUrl.mockImplementation((opts: { url: string }) => {
			if (opts.url.includes(':transcribe')) {
				return Promise.resolve({ status: 200, json: { durationMilliseconds: 200, combinedPhrases: [{ text: '' }], phrases: [] }, headers: {} });
			}
			if (opts.url.includes('/anthropic/')) return Promise.resolve({ status: 200, json: { content: [{ type: 'text', text: 'pong' }] } });
			if (opts.url.includes('/embeddings')) return Promise.resolve({ status: 200, json: { data: [{ embedding: [0.1] }] } });
			return Promise.resolve({ status: 200, json: { choices: [{ message: { content: 'p' } }], text: '' } });
		});
		const plugin = makePlugin({ azureSpeechEndpoint: 'https://res.cognitiveservices.azure.com' });
		const report = await testAzureConnection(plugin);
		const stt = report.surfaces.find(s => s.surface === 'azure-speech-stt')!;
		expect(stt.ok).toBe(true);
		expect(stt.message).toBe('connected');
	});
});

describe('testAzureConnection — legacy TTS probe vs Azure AI Speech (follow-up)', () => {
	beforeEach(() => {
		mockRequestUrl.mockReset();
	});

	it('skips the legacy azure-openai TTS probe when Azure AI Speech is configured', async () => {
		mockRequestUrl.mockImplementation((opts: { url: string }) => {
			if (opts.url.includes('voices/list')) return Promise.resolve({ status: 200, json: [] });
			if (opts.url.includes('/anthropic/')) return Promise.resolve({ status: 200, json: { content: [{ type: 'text', text: 'pong' }] } });
			if (opts.url.includes('/embeddings')) return Promise.resolve({ status: 200, json: { data: [{ embedding: [0.1] }] } });
			return Promise.resolve({ status: 200, json: { choices: [{ message: { content: 'p' } }], text: '' } });
		});
		const plugin = makePlugin({
			azureSpeechRegion: 'swedencentral',
			azureCapabilities: { tts: { mode: 'azure' } },
		});
		const report = await testAzureConnection(plugin);
		expect(report.surfaces.find(s => s.surface === 'azure-tts')).toBeUndefined();
		expect(report.surfaces.find(s => s.surface === 'azure-speech-tts')).toBeDefined();
	});

	it('legacy TTS 404 points the user at the Azure AI Speech setup', async () => {
		mockRequestUrl.mockImplementation((opts: { url: string }) => {
			if (opts.url.includes('/audio/speech')) return Promise.resolve({ status: 404, json: {} });
			if (opts.url.includes('/anthropic/')) return Promise.resolve({ status: 200, json: { content: [{ type: 'text', text: 'pong' }] } });
			if (opts.url.includes('/embeddings')) return Promise.resolve({ status: 200, json: { data: [{ embedding: [0.1] }] } });
			return Promise.resolve({ status: 200, json: { choices: [{ message: { content: 'p' } }], text: '' } });
		});
		const plugin = makePlugin({ azureCapabilities: { tts: { mode: 'azure' } } });
		const report = await testAzureConnection(plugin);
		const tts = report.surfaces.find(s => s.surface === 'azure-tts')!;
		expect(tts.ok).toBe(false);
		expect(tts.message).toContain('set up Azure AI Speech');
	});
});
