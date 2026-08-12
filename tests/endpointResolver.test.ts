import { describe, it, expect } from 'vitest';
import {
	normalizeEndpointUrl,
	getClaudeMessagesEndpoint,
	getOpenAIChatEndpoint,
	getOpenAIEmbeddingsEndpoint,
	getWhisperEndpoint,
	getSpeechFastTranscriptionEndpoint,
	getSpeechRealtimeTtsEndpoint,
	getSpeechVoicesListEndpoint,
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

	// A base path is PRESERVED (APIM fronts the Azure surfaces under a prefix);
	// only a pasted API route is rejected, which is what the old blanket
	// no-path rule was actually guarding against.
	it('preserves an APIM base path and strips the trailing slash', () => {
		expect(normalizeEndpointUrl('https://gd-ai-dev-apim.azure-api.net/foundry'))
			.toBe('https://gd-ai-dev-apim.azure-api.net/foundry');
		expect(normalizeEndpointUrl('https://gd-ai-dev-apim.azure-api.net/foundry/'))
			.toBe('https://gd-ai-dev-apim.azure-api.net/foundry');
	});

	it('rejects an endpoint that already contains the API path', () => {
		expect(() => normalizeEndpointUrl('https://x.openai.azure.com/openai/v1')).toThrow(/must not include the API path/i);
		expect(() => normalizeEndpointUrl('https://x.services.ai.azure.com/anthropic/v1/messages')).toThrow(/must not include the API path/i);
	});

	it('rejects a query string or fragment (would corrupt ?api-version=)', () => {
		expect(() => normalizeEndpointUrl('https://x.openai.azure.com/foundry?a=1')).toThrow(/query string or fragment/i);
		expect(() => normalizeEndpointUrl('https://x.openai.azure.com/foundry#f')).toThrow(/query string or fragment/i);
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

	// FULL string equality, not toContain: a substring assertion stays green when
	// the prefix or the query string is wrong, which is how the upstream routing
	// bug hid behind a passing suite.
	it('deployment-based path is the deployment-qualified URL with a dated api-version', () => {
		const url = getOpenAIChatEndpoint(base({
			azureRoutingMode: 'deployment-based',
			azureDeployments: { chat: 'my-gpt' },
		}));
		expect(url).toBe(`${OAI}/openai/deployments/my-gpt/chat/completions?api-version=2025-03-01-preview`);
	});

	it('deployment-based path honours a chat api-version override', () => {
		const url = getOpenAIChatEndpoint(base({
			azureRoutingMode: 'deployment-based',
			azureDeployments: { chat: 'my-gpt' },
			azureApiVersionOverride: { chat: '2099-01-01' },
		}));
		expect(url).toBe(`${OAI}/openai/deployments/my-gpt/chat/completions?api-version=2099-01-01`);
	});

	it('APIM base path is carried into the deployment-qualified chat route', () => {
		const url = getOpenAIChatEndpoint(base({
			azureOpenAIEndpoint: 'https://gd-ai-dev-apim.azure-api.net/foundry',
			azureRoutingMode: 'deployment-based',
			azureDeployments: { chat: 'gpt-5.5' },
		}));
		expect(url).toBe('https://gd-ai-dev-apim.azure-api.net/foundry/openai/deployments/gpt-5.5/chat/completions?api-version=2025-03-01-preview');
	});

	it('deployment-based falls back to azureGPTModel as the deployment name', () => {
		const url = getOpenAIChatEndpoint(base({
			azureRoutingMode: 'deployment-based',
			azureGPTModel: 'gpt-5-5-dep',
		}));
		expect(url).toBe(`${OAI}/openai/deployments/gpt-5-5-dep/chat/completions?api-version=2025-03-01-preview`);
	});
});

describe('embeddings endpoint', () => {
	it('model-based path omits api-version', () => {
		const url = getOpenAIEmbeddingsEndpoint(base({ azureRoutingMode: 'model-based' }));
		expect(url).toBe(`${OAI}/openai/v1/embeddings`);
		expect(url).not.toContain('api-version');
	});

	it('deployment-based path is the deployment-qualified URL with a dated api-version', () => {
		const url = getOpenAIEmbeddingsEndpoint(base({
			azureRoutingMode: 'deployment-based',
			azureDeployments: { embeddings: 'embed-large' },
		}));
		expect(url).toBe(`${OAI}/openai/deployments/embed-large/embeddings?api-version=2025-03-01-preview`);
	});

	it('APIM base path is carried into the deployment-qualified embeddings route', () => {
		const url = getOpenAIEmbeddingsEndpoint(base({
			azureOpenAIEndpoint: 'https://gd-ai-dev-apim.azure-api.net/foundry',
			azureRoutingMode: 'deployment-based',
			azureDeployments: { embeddings: 'text-embedding-3-large' },
		}));
		expect(url).toBe('https://gd-ai-dev-apim.azure-api.net/foundry/openai/deployments/text-embedding-3-large/embeddings?api-version=2025-03-01-preview');
	});

	it('embeddings api-version is independent of the chat pin', () => {
		const url = getOpenAIEmbeddingsEndpoint(base({
			azureRoutingMode: 'deployment-based',
			azureDeployments: { embeddings: 'embed-large' },
			azureApiVersionOverride: { chat: '2099-01-01', embeddings: '2024-10-21' },
		}));
		expect(url).toBe(`${OAI}/openai/deployments/embed-large/embeddings?api-version=2024-10-21`);
	});

	it('a lone chat pin still repins embeddings (back-compat)', () => {
		const url = getOpenAIEmbeddingsEndpoint(base({
			azureRoutingMode: 'deployment-based',
			azureDeployments: { embeddings: 'embed-large' },
			azureApiVersionOverride: { chat: '2024-10-21' },
		}));
		expect(url).toBe(`${OAI}/openai/deployments/embed-large/embeddings?api-version=2024-10-21`);
	});

	it('the per-capability deployment SSOT wins over the legacy field', () => {
		const url = getOpenAIEmbeddingsEndpoint(base({
			azureRoutingMode: 'deployment-based',
			azureDeployments: { embeddings: 'legacy-dep' },
			azureCapabilities: { embeddings: { mode: 'azure', deployment: 'ssot-dep' } },
		}));
		expect(url).toBe(`${OAI}/openai/deployments/ssot-dep/embeddings?api-version=2025-03-01-preview`);
	});
});

describe('whisper endpoint', () => {
	it('is always deployment-qualified with its OWN api-version', () => {
		const url = getWhisperEndpoint(base({ azureWhisperDeployment: 'whisper' }));
		// Whisper stays on 2024-10-21 — a separate operation on a separate cadence
		// from chat/embeddings, deliberately not bumped with them.
		expect(url).toBe(`${OAI}/openai/deployments/whisper/audio/transcriptions?api-version=2024-10-21`);
	});

	it('honours a whisper api-version override', () => {
		const url = getWhisperEndpoint(base({
			azureWhisperDeployment: 'whisper',
			azureApiVersionOverride: { whisper: '2030-05-05' },
		}));
		expect(url).toBe(`${OAI}/openai/deployments/whisper/audio/transcriptions?api-version=2030-05-05`);
	});
});

// ── Azure AI Speech builders (azure-audio-adapters plan D10 / R2-M2) ────────

const SPEECH_EP = 'https://my-resource.cognitiveservices.azure.com';

describe('speech fast-transcription endpoint', () => {
	it('builds the :transcribe URL on the custom domain with the speech api-version', () => {
		const r = getSpeechFastTranscriptionEndpoint(base({ azureSpeechEndpoint: SPEECH_EP }));
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.value).toBe(`${SPEECH_EP}/speechtotext/transcriptions:transcribe?api-version=2025-10-15`);
	});

	it('missing endpoint → typed err(no-endpoint), never a guessed string (D10)', () => {
		// Even with azureOpenAIEndpoint present — no prefix derivation.
		const r = getSpeechFastTranscriptionEndpoint(base());
		expect(r).toEqual({ ok: false, error: 'no-endpoint' });
	});

	it('host-anchored: cognitiveservices.azure.com.attacker.com rejected (R2-M2 SSRF)', () => {
		const r = getSpeechFastTranscriptionEndpoint(base({
			azureSpeechEndpoint: 'https://my-resource.cognitiveservices.azure.com.attacker.com',
		}));
		expect(r).toEqual({ ok: false, error: 'bad-endpoint' });
	});

	it('http rejected', () => {
		const r = getSpeechFastTranscriptionEndpoint(base({ azureSpeechEndpoint: 'http://res.cognitiveservices.azure.com' }));
		expect(r).toEqual({ ok: false, error: 'bad-endpoint' });
	});

	it('endpoint with a path rejected', () => {
		const r = getSpeechFastTranscriptionEndpoint(base({ azureSpeechEndpoint: `${SPEECH_EP}/speechtotext` }));
		expect(r).toEqual({ ok: false, error: 'bad-endpoint' });
	});

	it('wrong-domain host (openai.azure.com) rejected', () => {
		const r = getSpeechFastTranscriptionEndpoint(base({ azureSpeechEndpoint: OAI }));
		expect(r).toEqual({ ok: false, error: 'bad-endpoint' });
	});
});

describe('speech realtime TTS + voices-list endpoints', () => {
	it('builds the regional tts host from azureSpeechRegion', () => {
		const r = getSpeechRealtimeTtsEndpoint(base({ azureSpeechRegion: 'swedencentral' }));
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.value).toBe('https://swedencentral.tts.speech.microsoft.com/cognitiveservices/v1');
	});

	it('voices/list shares the same regional host', () => {
		const r = getSpeechVoicesListEndpoint(base({ azureSpeechRegion: 'swedencentral' }));
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.value).toBe('https://swedencentral.tts.speech.microsoft.com/cognitiveservices/voices/list');
	});

	it('missing region → err(no-region)', () => {
		expect(getSpeechRealtimeTtsEndpoint(base())).toEqual({ ok: false, error: 'no-region' });
		expect(getSpeechVoicesListEndpoint(base())).toEqual({ ok: false, error: 'no-region' });
	});

	it('region is charset-validated — host injection rejected (bad-region)', () => {
		for (const evil of ['sweden central', 'evil.attacker.com/', 'region.attacker.com', 'a/b', 'x?y']) {
			expect(getSpeechRealtimeTtsEndpoint(base({ azureSpeechRegion: evil }))).toEqual({ ok: false, error: 'bad-region' });
		}
	});

	it('region is case-normalized', () => {
		const r = getSpeechRealtimeTtsEndpoint(base({ azureSpeechRegion: 'SwedenCentral' }));
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.value).toContain('https://swedencentral.tts.speech');
	});
});
