/**
 * Endpoint resolver — single source of truth for all Azure URL construction.
 * All adapters and services call this module. No manual URL concatenation elsewhere.
 */

// ── Path Constants ──────────────────────────────────────────────────────────────

const CLAUDE_MESSAGES_PATH = '/anthropic/v1/messages';
const OPENAI_CHAT_PATH = '/openai/v1/chat/completions';
const OPENAI_EMBEDDINGS_PATH = '/openai/v1/embeddings';
const WHISPER_PATH_PREFIX = '/openai/deployments/';

const AZURE_API_VERSIONS = {
	whisper: '2024-10-21',
	// Legacy deployment-based chat/embeddings paths REQUIRE an api-version.
	// Model-based `/openai/v1/*` paths correctly omit it.
	chat: '2024-10-21',
	// Speech (TTS) is a separate surface — give it its own version rather than
	// inheriting chat's (H5). Bump independently if Azure changes the Speech API.
	speech: '2024-10-21',
} as const;

// ── Branded Endpoint Types (compile-time safety, zero runtime cost) ─────────

export type ClaudeMessagesEndpoint = string & { __brand: 'claude-messages' };
export type OpenAIChatEndpoint = string & { __brand: 'openai-chat' };
export type OpenAIEmbeddingsEndpoint = string & { __brand: 'openai-embeddings' };
export type WhisperEndpoint = string & { __brand: 'whisper' };
export type SpeechEndpoint = string & { __brand: 'speech' };

// ── Azure mode detection ────────────────────────────────────────────────────

/**
 * True when the main provider is ANY Azure surface (`azure-claude` or
 * `azure-openai`). Azure AI Foundry exposes both surfaces under ONE resource +
 * ONE shared key, so "Azure mode" must auto-serve ALL tasks (audio, embeddings,
 * PDF) from Azure regardless of which subtype the user picked as their MAIN
 * model. Use this everywhere instead of narrow `=== 'azure-openai'` checks.
 */
export function isAzureMode(settings: { cloudServiceType?: string }): boolean {
	return !!settings.cloudServiceType?.startsWith('azure');
}

// ── Settings Shape (minimal — only what resolver needs) ─────────────────────

interface EndpointSettings {
	azureAIEndpoint: string;
	azureOpenAIEndpoint: string;
	azureWhisperDeployment?: string;
	azureRoutingMode?: 'model-based' | 'deployment-based';
	azureDeployments?: { chat?: string; embeddings?: string };
	azureGPTModel?: string;
	azureApiVersionOverride?: { whisper?: string; chat?: string };
	/** Per-capability deployment SSOT (H1). Read first; legacy fields are the one-release fallback. */
	azureCapabilities?: Partial<Record<string, { mode?: string; deployment?: string }>>;
}

/** Per-capability deployment is the SSOT (H1); legacy field is the fallback. */
function capabilityDeployment(settings: EndpointSettings, capId: string): string | undefined {
	const dep = settings.azureCapabilities?.[capId]?.deployment;
	// Defensive: persisted JSON may be malformed (non-string) — never throw (H7).
	return typeof dep === 'string' && dep.trim() ? dep.trim() : undefined;
}

// ── URL Normalization ───────────────────────────────────────────────────────

/**
 * Normalize an endpoint URL to scheme + host only (no path, no trailing slash).
 * Validates that the URL is well-formed and uses HTTPS.
 */
export function normalizeEndpointUrl(raw: string): string {
	if (!raw) throw new Error('Endpoint URL is required');

	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`Invalid endpoint URL: '${raw}'. Must be a valid URL (e.g., https://<your-resource>.openai.azure.com)`);
	}

	if (url.protocol !== 'https:') {
		throw new Error(`Endpoint must use HTTPS: '${raw}'`);
	}

	if (url.pathname !== '/' && url.pathname !== '') {
		throw new Error(`Endpoint must be a base URL with no path: '${raw}'. Use just the host (e.g., https://<your-resource>.openai.azure.com)`);
	}

	return url.origin; // scheme + host + port, no trailing slash
}

// ── Resolver Functions ──────────────────────────────────────────────────────

export function getClaudeMessagesEndpoint(settings: EndpointSettings): ClaudeMessagesEndpoint {
	return (normalizeEndpointUrl(settings.azureAIEndpoint) + CLAUDE_MESSAGES_PATH) as ClaudeMessagesEndpoint;
}

export function getOpenAIChatEndpoint(settings: EndpointSettings): OpenAIChatEndpoint {
	if (settings.azureRoutingMode === 'deployment-based') {
		const dep = settings.azureDeployments?.chat ?? settings.azureGPTModel ?? 'gpt-5.5';
		const apiVersion = settings.azureApiVersionOverride?.chat ?? AZURE_API_VERSIONS.chat;
		return (normalizeEndpointUrl(settings.azureOpenAIEndpoint) + `/openai/deployments/${dep}/chat/completions?api-version=${apiVersion}`) as OpenAIChatEndpoint;
	}
	return (normalizeEndpointUrl(settings.azureOpenAIEndpoint) + OPENAI_CHAT_PATH) as OpenAIChatEndpoint;
}

export function getOpenAIEmbeddingsEndpoint(settings: EndpointSettings): OpenAIEmbeddingsEndpoint {
	if (settings.azureRoutingMode === 'deployment-based') {
		const dep = capabilityDeployment(settings, 'embeddings') ?? settings.azureDeployments?.embeddings ?? 'text-embedding-3-large';
		const apiVersion = settings.azureApiVersionOverride?.chat ?? AZURE_API_VERSIONS.chat;
		return (normalizeEndpointUrl(settings.azureOpenAIEndpoint) + `/openai/deployments/${dep}/embeddings?api-version=${apiVersion}`) as OpenAIEmbeddingsEndpoint;
	}
	return (normalizeEndpointUrl(settings.azureOpenAIEndpoint) + OPENAI_EMBEDDINGS_PATH) as OpenAIEmbeddingsEndpoint;
}

export function getWhisperEndpoint(settings: EndpointSettings): WhisperEndpoint {
	const deployment = capabilityDeployment(settings, 'transcription') ?? settings.azureWhisperDeployment ?? 'whisper';
	const apiVersion = settings.azureApiVersionOverride?.whisper ?? AZURE_API_VERSIONS.whisper;
	return (
		normalizeEndpointUrl(settings.azureOpenAIEndpoint) +
		WHISPER_PATH_PREFIX + deployment +
		`/audio/transcriptions?api-version=${apiVersion}`
	) as WhisperEndpoint;
}

/**
 * Azure OpenAI Speech (text-to-speech) endpoint. Model-based → `/openai/v1/audio/speech`
 * (deployment/voice in the body); deployment-based → the named-deployment path with
 * api-version. SSOT — the Azure Speech TTS engine MUST call this, no manual concat (G2).
 */
export function getSpeechEndpoint(settings: EndpointSettings): SpeechEndpoint {
	if (settings.azureRoutingMode === 'deployment-based') {
		const dep = capabilityDeployment(settings, 'tts') ?? 'tts';
		const apiVersion = AZURE_API_VERSIONS.speech;  // own surface — not chat's version (H5)
		return (normalizeEndpointUrl(settings.azureOpenAIEndpoint) + `/openai/deployments/${dep}/audio/speech?api-version=${apiVersion}`) as SpeechEndpoint;
	}
	return (normalizeEndpointUrl(settings.azureOpenAIEndpoint) + '/openai/v1/audio/speech') as SpeechEndpoint;
}
