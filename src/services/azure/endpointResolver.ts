/**
 * Endpoint resolver — single source of truth for all Azure URL construction.
 * All adapters and services call this module. No manual URL concatenation elsewhere.
 */

import { type Result, ok, err } from '../../core/result';

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
	// Foundry Models inference routes (`/models/*` on the services.ai.azure.com
	// resource) — used by the Cohere embed-v-4-0 visual lane (Phase 5).
	foundryModels: '2024-05-01-preview',
	// Azure AI Speech Fast Transcription (`:transcribe` synchronous REST) —
	// live-verified 2026-06-08 (2024-11-15 also works).
	speechFastTranscription: '2025-10-15',
} as const;

// ── Branded Endpoint Types (compile-time safety, zero runtime cost) ─────────

export type ClaudeMessagesEndpoint = string & { __brand: 'claude-messages' };
export type OpenAIChatEndpoint = string & { __brand: 'openai-chat' };
export type OpenAIEmbeddingsEndpoint = string & { __brand: 'openai-embeddings' };
export type WhisperEndpoint = string & { __brand: 'whisper' };
export type SpeechEndpoint = string & { __brand: 'speech' };
export type FoundryImageEmbeddingsEndpoint = string & { __brand: 'foundry-image-embeddings' };
export type FoundryTextEmbeddingsEndpoint = string & { __brand: 'foundry-text-embeddings' };

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
	/** Azure AI Speech custom domain (`<resource>.cognitiveservices.azure.com`) — REQUIRED for Fast Transcription (plan D10). */
	azureSpeechEndpoint?: string;
	/** Azure AI Speech region (e.g. `swedencentral`) — builds the `{region}.tts.speech.microsoft.com` TTS host. */
	azureSpeechRegion?: string;
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
 * Foundry Models IMAGE-embeddings route (Cohere embed-v-4-0 visual lane, Phase 5).
 * Lives on the Foundry resource (`azureAIEndpoint`, services.ai.azure.com) — the SAME
 * resource + key as the Claude surface, NOT the openai endpoint. Model name goes in the
 * BODY (no deployment in the path), so this is routing-mode-independent.
 * Request shape is the Azure AI inference schema (`{model, input:[{image}], input_type}`),
 * NOT Cohere's native v2 shape — the embedder branches its serializer per backend.
 */
export function getFoundryImageEmbeddingsEndpoint(settings: EndpointSettings): FoundryImageEmbeddingsEndpoint {
	return (normalizeEndpointUrl(settings.azureAIEndpoint) +
		`/models/images/embeddings?api-version=${AZURE_API_VERSIONS.foundryModels}`) as FoundryImageEmbeddingsEndpoint;
}

/** Foundry Models TEXT-embeddings route — the visual lane's QUERY side (C1: same
 *  space/model as the image side, so text queries retrieve page-image vectors). */
export function getFoundryTextEmbeddingsEndpoint(settings: EndpointSettings): FoundryTextEmbeddingsEndpoint {
	return (normalizeEndpointUrl(settings.azureAIEndpoint) +
		`/models/embeddings?api-version=${AZURE_API_VERSIONS.foundryModels}`) as FoundryTextEmbeddingsEndpoint;
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

// ── Azure AI Speech (Cognitive Services) — the in-region `azure-speech` surface ──
//
// Distinct hosts + auth from Azure OpenAI (plan D1):
//   STT (Fast Transcription) → `<resource>.cognitiveservices.azure.com` custom domain
//     (the `{region}.stt.speech.microsoft.com` host 404s for `:transcribe` — §A).
//   TTS (real-time)          → `{region}.tts.speech.microsoft.com`.
// Builders return typed `Result` — NEVER a guessed string (plan D10): the STT
// endpoint is an explicit setting (no prefix derivation from azureOpenAIEndpoint,
// which is unsafe when the Speech resource differs), and hosts are anchored
// (R2-M2: suffix match on the parsed hostname, so
// `…cognitiveservices.azure.com.attacker.com` is rejected).

const SPEECH_COGNITIVE_DOMAIN_SUFFIX = '.cognitiveservices.azure.com';
const SPEECH_TTS_HOST_SUFFIX = '.tts.speech.microsoft.com';
/** Azure region names are lowercase alphanumerics (e.g. `swedencentral`). */
const SPEECH_REGION_RE = /^[a-z0-9]+$/;

export type SpeechEndpointError = 'no-endpoint' | 'bad-endpoint' | 'no-region' | 'bad-region';

function normalizeSpeechHost(raw: string, suffix: string): Result<string> {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return err('bad-endpoint');
	}
	if (url.protocol !== 'https:') return err('bad-endpoint');
	if (!url.hostname.endsWith(suffix)) return err('bad-endpoint');
	if (url.pathname !== '/' && url.pathname !== '') return err('bad-endpoint');
	return ok(url.origin);
}

/**
 * Fast Transcription synchronous REST endpoint (STT + inline diarization).
 * Requires the explicit `azureSpeechEndpoint` custom domain (plan D10).
 */
export function getSpeechFastTranscriptionEndpoint(settings: EndpointSettings): Result<string> {
	const raw = settings.azureSpeechEndpoint?.trim();
	if (!raw) return err('no-endpoint');
	const host = normalizeSpeechHost(raw, SPEECH_COGNITIVE_DOMAIN_SUFFIX);
	if (!host.ok) return host;
	return ok(`${host.value}/speechtotext/transcriptions:transcribe?api-version=${AZURE_API_VERSIONS.speechFastTranscription}`);
}

function speechTtsHost(settings: EndpointSettings): Result<string> {
	const region = settings.azureSpeechRegion?.trim().toLowerCase();
	if (!region) return err('no-region');
	if (!SPEECH_REGION_RE.test(region)) return err('bad-region');
	return ok(`https://${region}${SPEECH_TTS_HOST_SUFFIX}`);
}

/** Real-time TTS endpoint (SSML in, audio out) on the regional TTS host. */
export function getSpeechRealtimeTtsEndpoint(settings: EndpointSettings): Result<string> {
	const host = speechTtsHost(settings);
	if (!host.ok) return host;
	return ok(`${host.value}/cognitiveservices/v1`);
}

/** `voices/list` catalog endpoint (powers the voice picker + validation, plan D11). */
export function getSpeechVoicesListEndpoint(settings: EndpointSettings): Result<string> {
	const host = speechTtsHost(settings);
	if (!host.ok) return host;
	return ok(`${host.value}/cognitiveservices/voices/list`);
}
