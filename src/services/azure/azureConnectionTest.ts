/**
 * Live Azure connection test.
 *
 * Runs `validateSettings` as a pre-flight, then makes REAL minimal round-trips
 * against each configured Azure surface (Claude messages, OpenAI chat, OpenAI
 * embeddings) using Obsidian's `requestUrl`. Each surface is independent —
 * one failure never aborts the others.
 *
 * Result messages are REDACTED: never echo endpoint URLs, keys, or header
 * contents. HTTP statuses map to fixed user-facing strings.
 */

import { requestUrl } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { getAzureApiKey } from '../apiKeyHelpers';
import { validateSettings } from './settingsValidator';
import { capabilityChoice } from './resolveAzureCapability';
import { resolveAzureSpeechCredential } from './azureSpeechCredential';
import { buildSsml } from '../tts/ssmlBuilder';
import {
	getClaudeMessagesEndpoint,
	getOpenAIChatEndpoint,
	getOpenAIEmbeddingsEndpoint,
	getWhisperEndpoint,
	getSpeechEndpoint,
	getSpeechRealtimeTtsEndpoint,
	getSpeechVoicesListEndpoint,
	getSpeechFastTranscriptionEndpoint,
} from './endpointResolver';

export type AzureTestSurface =
	| 'azure-claude'
	| 'azure-openai-chat'
	| 'azure-openai-embeddings'
	| 'azure-openai-whisper'
	| 'azure-tts'
	| 'azure-websearch'
	| 'azure-speech-tts'
	| 'azure-speech-stt';

export interface AzureSurfaceResult {
	surface: AzureTestSurface;
	ok: boolean;
	/** HTTP status when a round-trip happened; 0 when skipped or network error. */
	status: number;
	/** REDACTED user-facing message (no endpoint / key / header content). */
	message: string;
}

export interface AzureTestReport {
	/** True only when pre-flight validation passed. */
	preflightOk: boolean;
	/** Validation errors (shown verbatim — these are about the user's own config). */
	preflightErrors: string[];
	/** Per-surface live-test results (empty when pre-flight failed). */
	surfaces: AzureSurfaceResult[];
}

const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';
const DEFAULT_GPT_MODEL = 'gpt-5.5';
const DEFAULT_EMBED_MODEL = 'text-embedding-3-large';

/**
 * Map an HTTP status / failure mode to a fixed, redacted message. Never includes
 * the endpoint, key, or any response body that could leak config.
 */
function redactedMessage(status: number): string {
	if (status === 200) return 'connected';
	if (status === 401 || status === 403) return 'unauthorized — check key';
	if (status === 404) return 'deployment/endpoint not found';
	if (status === 0) return 'could not reach endpoint';
	if (status >= 500) return 'server error — try again';
	return `unexpected response (status ${status})`;
}

/** Shared minimal POST. Returns the HTTP status, or 0 on transport failure. */
async function probe(
	url: string,
	headers: Record<string, string>,
	body: unknown,
	signal?: AbortSignal,
): Promise<{ status: number; bodyOk: boolean; raw?: unknown }> {
	if (signal?.aborted) return { status: 0, bodyOk: false };
	try {
		const res = await requestUrl({
			url,
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			throw: false,
		});
		let parsed: unknown;
		try {
			parsed = res.json;
		} catch {
			parsed = undefined;
		}
		return { status: res.status, bodyOk: res.status === 200, raw: parsed };
	} catch {
		// Network / DNS / TLS / CSP rejection — surfaced as status 0.
		return { status: 0, bodyOk: false };
	}
}

async function testClaudeSurface(
	plugin: AIOrganiserPlugin,
	signal?: AbortSignal,
): Promise<AzureSurfaceResult> {
	const surface: AzureTestSurface = 'azure-claude';
	let endpoint: string;
	try {
		endpoint = getClaudeMessagesEndpoint(plugin.settings);
	} catch {
		return { surface, ok: false, status: 0, message: 'endpoint not configured' };
	}
	const key = await getAzureApiKey(plugin, 'azure-claude');
	if (!key) return { surface, ok: false, status: 0, message: 'no key configured' };

	// Use a CONCRETE Azure Claude model for the probe — never the main-provider's
	// `cloudModel`, which becomes a non-Azure value (e.g. the `latest-sonnet`
	// sentinel) the moment the user selects a different main provider, causing a
	// 404 on the Foundry endpoint even though Azure is configured correctly.
	const model =
		(plugin.settings.cloudServiceType === 'azure-claude' && plugin.settings.cloudModel)
			? plugin.settings.cloudModel
			: (plugin.settings.taskModels?.chat || DEFAULT_CLAUDE_MODEL);
	const { status, raw } = await probe(
		endpoint,
		{
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${key}`,
			'anthropic-version': '2023-06-01',
		},
		{ model, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] },
		signal,
	);
	// Success = HTTP 200 + a content block in the response.
	const hasContent =
		status === 200 &&
		!!raw &&
		typeof raw === 'object' &&
		Array.isArray((raw as { content?: unknown }).content) &&
		(raw as { content: unknown[] }).content.length > 0;
	const ok = hasContent;
	return { surface, ok, status, message: ok ? 'connected' : redactedMessage(status) };
}

async function testOpenAIChatSurface(
	plugin: AIOrganiserPlugin,
	signal?: AbortSignal,
): Promise<AzureSurfaceResult | null> {
	// Only run when the Azure OpenAI endpoint is configured.
	if (!plugin.settings.azureOpenAIEndpoint) return null;
	const surface: AzureTestSurface = 'azure-openai-chat';
	let endpoint: string;
	try {
		endpoint = getOpenAIChatEndpoint(plugin.settings);
	} catch {
		return { surface, ok: false, status: 0, message: 'endpoint not configured' };
	}
	const key = await getAzureApiKey(plugin, 'azure-openai');
	if (!key) return { surface, ok: false, status: 0, message: 'no key configured' };

	const model = plugin.settings.azureGPTModel || DEFAULT_GPT_MODEL;
	// Mirror AzureOpenAIAdapter: gpt-5 / o1 / o3 are reasoning models — Azure rejects
	// `max_tokens` and `temperature` for them, requiring `max_completion_tokens`.
	const isReasoning = model.startsWith('gpt-5') || model.startsWith('o1') || model.startsWith('o3');
	const tokenParam = isReasoning ? { max_completion_tokens: 16 } : { max_tokens: 8 };
	const { status, raw } = await probe(
		endpoint,
		{ 'Content-Type': 'application/json', 'api-key': key },
		{ model, messages: [{ role: 'user', content: 'ping' }], ...tokenParam },
		signal,
	);
	const hasChoice =
		status === 200 &&
		!!raw &&
		typeof raw === 'object' &&
		Array.isArray((raw as { choices?: unknown }).choices) &&
		(raw as { choices: unknown[] }).choices.length > 0;
	const ok = hasChoice;
	return { surface, ok, status, message: ok ? 'connected' : redactedMessage(status) };
}

async function testEmbeddingsSurface(
	plugin: AIOrganiserPlugin,
	signal?: AbortSignal,
): Promise<AzureSurfaceResult | null> {
	if (!plugin.settings.azureOpenAIEndpoint) return null;
	const surface: AzureTestSurface = 'azure-openai-embeddings';
	let endpoint: string;
	try {
		endpoint = getOpenAIEmbeddingsEndpoint(plugin.settings);
	} catch {
		return { surface, ok: false, status: 0, message: 'endpoint not configured' };
	}
	const key = await getAzureApiKey(plugin, 'azure-openai');
	if (!key) return { surface, ok: false, status: 0, message: 'no key configured' };

	const model = plugin.settings.embeddingModel || DEFAULT_EMBED_MODEL;
	const { status, raw } = await probe(
		endpoint,
		{ 'Content-Type': 'application/json', 'api-key': key },
		{ model, input: 'ping' },
		signal,
	);
	// Success = a non-empty embedding vector in the response.
	const data = (raw as { data?: Array<{ embedding?: unknown }> } | undefined)?.data;
	const hasVector =
		status === 200 &&
		Array.isArray(data) &&
		data.length > 0 &&
		Array.isArray(data[0]?.embedding) &&
		(data[0].embedding as unknown[]).length > 0;
	const ok = hasVector;
	return { surface, ok, status, message: ok ? 'connected' : redactedMessage(status) };
}

/** Build a tiny valid silent WAV (8 kHz mono 16-bit, ~0.2 s) for the Whisper probe. */
function buildSilentWavBytes(): Uint8Array {
	const sampleRate = 8000;
	const numSamples = 1600; // 0.2 s
	const dataSize = numSamples * 2;
	const buf = new ArrayBuffer(44 + dataSize);
	const dv = new DataView(buf);
	let p = 0;
	const wstr = (s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(p++, s.charCodeAt(i)); };
	wstr('RIFF'); dv.setUint32(p, 36 + dataSize, true); p += 4;
	wstr('WAVE'); wstr('fmt '); dv.setUint32(p, 16, true); p += 4;
	dv.setUint16(p, 1, true); p += 2;            // PCM
	dv.setUint16(p, 1, true); p += 2;            // mono
	dv.setUint32(p, sampleRate, true); p += 4;
	dv.setUint32(p, sampleRate * 2, true); p += 4; // byte rate
	dv.setUint16(p, 2, true); p += 2;            // block align
	dv.setUint16(p, 16, true); p += 2;           // bits per sample
	wstr('data'); dv.setUint32(p, dataSize, true); // p += 4; data stays zero (silence)
	return new Uint8Array(buf);
}

/** Assemble a multipart/form-data body (single `file` part) for the Whisper probe. */
function buildWhisperMultipart(wav: Uint8Array): { body: ArrayBuffer; contentType: string } {
	const boundary = '----AzureWhisperConnTest7f3a';
	const enc = new TextEncoder();
	const pre = enc.encode(
		`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="ping.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
	);
	const post = enc.encode(`\r\n--${boundary}--\r\n`);
	const out = new Uint8Array(pre.length + wav.length + post.length);
	out.set(pre, 0);
	out.set(wav, pre.length);
	out.set(post, pre.length + wav.length);
	return { body: out.buffer, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function testWhisperSurface(
	plugin: AIOrganiserPlugin,
	signal?: AbortSignal,
): Promise<AzureSurfaceResult | null> {
	// Only run when the Azure OpenAI endpoint is configured (Whisper rides the OpenAI surface).
	if (!plugin.settings.azureOpenAIEndpoint) return null;
	const surface: AzureTestSurface = 'azure-openai-whisper';
	let endpoint: string;
	try {
		endpoint = getWhisperEndpoint(plugin.settings);
	} catch {
		return { surface, ok: false, status: 0, message: 'endpoint not configured' };
	}
	const key = await getAzureApiKey(plugin, 'azure-openai');
	if (!key) return { surface, ok: false, status: 0, message: 'no key configured' };
	if (signal?.aborted) return { surface, ok: false, status: 0, message: 'could not reach endpoint' };

	const { body, contentType } = buildWhisperMultipart(buildSilentWavBytes());
	let status = 0;
	try {
		const res = await requestUrl({
			url: endpoint,
			method: 'POST',
			headers: { 'api-key': key, 'Content-Type': contentType },
			body,
			throw: false,
		});
		status = res.status;
	} catch {
		status = 0;
	}
	// 200 = transcribed. 400 = the request reached + authenticated + routed to the deployment
	// but the tiny silent clip was rejected — which still proves endpoint + deployment + key
	// are valid (the point of a connectivity test). 401/403/404/5xx/0 = genuine failure.
	const ok = status === 200 || status === 400;
	const message =
		status === 200 ? 'connected'
			: status === 400 ? 'connected — endpoint, deployment + key valid'
				: redactedMessage(status);
	return { surface, ok, status, message };
}

/**
 * TTS (Azure OpenAI Speech) — only when the `tts` capability is set to Azure.
 * A tiny synthesis round-trip proves the speech deployment exists + key valid.
 * 200 = synthesized; 400 = reached + authenticated + routed (the tiny input was
 * rejected) which still proves endpoint + deployment + key (like the Whisper probe).
 */
async function testTtsSurface(
	plugin: AIOrganiserPlugin,
	signal?: AbortSignal,
): Promise<AzureSurfaceResult | null> {
	if (!plugin.settings.azureOpenAIEndpoint) return null;
	if (capabilityChoice(plugin, 'tts').mode !== 'azure') return null;
	const surface: AzureTestSurface = 'azure-tts';
	let endpoint: string;
	try {
		endpoint = getSpeechEndpoint(plugin.settings);
	} catch {
		return { surface, ok: false, status: 0, message: 'endpoint not configured' };
	}
	const key = await getAzureApiKey(plugin, 'azure-openai');
	if (!key) return { surface, ok: false, status: 0, message: 'no key configured' };

	const model = plugin.settings.azureCapabilities?.tts?.deployment || 'tts-1';
	const { status } = await probe(
		endpoint,
		{ 'Content-Type': 'application/json', 'api-key': key },
		{ model, input: 'ping', voice: 'alloy', response_format: 'pcm' },
		signal,
	);
	const ok = status === 200 || status === 400;
	const message =
		status === 200 ? 'connected'
			: status === 400 ? 'connected — endpoint, deployment + key valid'
				: redactedMessage(status);
	return { surface, ok, status, message };
}

/**
 * Azure AI Speech TTS (the in-region azure-speech surface, azure-audio plan).
 * Probed whenever a Speech region is configured — the surface shares the main
 * Foundry key by default, so it is testable as soon as Azure is set up.
 * With a voice selected → a tiny SSML synthesis proves region + key + voice;
 * without one → `voices/list` proves region + key and tells the user the
 * remaining step.
 */
async function testSpeechTtsSurface(
	plugin: AIOrganiserPlugin,
	signal?: AbortSignal,
): Promise<AzureSurfaceResult | null> {
	const s = plugin.settings;
	if (typeof s.azureSpeechRegion !== 'string' || !s.azureSpeechRegion.trim()) return null;
	const surface: AzureTestSurface = 'azure-speech-tts';
	const cred = await resolveAzureSpeechCredential(plugin);
	if (!cred.ok) return { surface, ok: false, status: 0, message: 'no key configured' };
	if (signal?.aborted) return { surface, ok: false, status: 0, message: 'could not reach endpoint' };

	const voice = typeof s.azureSpeechVoice === 'string' ? s.azureSpeechVoice.trim() : '';
	if (voice) {
		const ep = getSpeechRealtimeTtsEndpoint(s);
		if (!ep.ok) return { surface, ok: false, status: 0, message: 'endpoint not configured' };
		const ssml = buildSsml('Ping.', voice);
		if (!ssml.ok) return { surface, ok: false, status: 0, message: 'invalid voice — pick one from the catalog' };
		let status = 0;
		try {
			const res = await requestUrl({
				url: ep.value,
				method: 'POST',
				headers: {
					'Ocp-Apim-Subscription-Key': cred.value.key,
					'Content-Type': 'application/ssml+xml',
					'X-Microsoft-OutputFormat': 'raw-24khz-16bit-mono-pcm',
				},
				body: ssml.value,
				throw: false,
			});
			status = res.status;
		} catch {
			status = 0;
		}
		const ok = status === 200;
		return { surface, ok, status, message: ok ? 'connected — voice synthesized' : redactedMessage(status) };
	}

	// No voice yet → the catalog round-trip still proves region + key.
	const ep = getSpeechVoicesListEndpoint(s);
	if (!ep.ok) return { surface, ok: false, status: 0, message: 'endpoint not configured' };
	let status = 0;
	try {
		const res = await requestUrl({
			url: ep.value,
			method: 'GET',
			headers: { 'Ocp-Apim-Subscription-Key': cred.value.key },
			throw: false,
		});
		status = res.status;
	} catch {
		status = 0;
	}
	const ok = status === 200;
	return { surface, ok, status, message: ok ? 'connected — pick a voice to finish setup' : redactedMessage(status) };
}

/**
 * Azure AI Speech Fast Transcription (`:transcribe`) — probed whenever the
 * Speech endpoint (custom domain) is configured. Reuses the PRODUCTION
 * `fastTranscribeRequest` client (multipart with the inline-JSON definition,
 * pacing, abort) with the same tiny silent WAV the Whisper probe uses — so a
 * green result proves the exact code path Minutes/transcription will take.
 */
async function testSpeechSttSurface(
	plugin: AIOrganiserPlugin,
	signal?: AbortSignal,
): Promise<AzureSurfaceResult | null> {
	const s = plugin.settings;
	if (typeof s.azureSpeechEndpoint !== 'string' || !s.azureSpeechEndpoint.trim()) return null;
	const surface: AzureTestSurface = 'azure-speech-stt';
	const ep = getSpeechFastTranscriptionEndpoint(s);
	if (!ep.ok) return { surface, ok: false, status: 0, message: 'endpoint not configured' };
	const cred = await resolveAzureSpeechCredential(plugin);
	if (!cred.ok) return { surface, ok: false, status: 0, message: 'no key configured' };

	// Lazy import keeps the audio service out of the settings-tab load path.
	const { fastTranscribeRequest } = await import('../audioTranscriptionService');
	const wav = buildSilentWavBytes();
	const r = await fastTranscribeRequest({
		endpoint: ep.value,
		key: cred.value.key,
		audioBytes: wav.buffer.slice(0) as ArrayBuffer,
		filename: 'ping.wav',
		timeoutMs: 30_000,
		signal,
	});
	if (r.ok) return { surface, ok: true, status: 200, message: 'connected' };
	const m = /http-(\d+)/.exec(r.error);
	const status = m ? Number(m[1]) : 0;
	// 400 = reached + authenticated + routed; the silent clip was rejected —
	// still proves endpoint + key (same convention as the Whisper probe).
	const ok = status === 400;
	return { surface, ok, status, message: ok ? 'connected — endpoint + key valid' : redactedMessage(status) };
}

/**
 * Web search — only when the `websearch` capability is set to Azure. Runs on the
 * azure-claude surface; the deployment is the main Claude model (azure-claude
 * main) or the websearch capability deployment (azure-openai main). A minimal
 * messages round-trip proves that deployment is reachable + valid (the web_search
 * server tool itself is available on any real Claude deployment).
 */
async function testWebSearchSurface(
	plugin: AIOrganiserPlugin,
	signal?: AbortSignal,
): Promise<AzureSurfaceResult | null> {
	if (capabilityChoice(plugin, 'websearch').mode !== 'azure') return null;
	const surface: AzureTestSurface = 'azure-websearch';
	let endpoint: string;
	try {
		endpoint = getClaudeMessagesEndpoint(plugin.settings);
	} catch {
		return { surface, ok: false, status: 0, message: 'endpoint not configured' };
	}
	const key = await getAzureApiKey(plugin, 'azure-claude');
	if (!key) return { surface, ok: false, status: 0, message: 'no key configured' };

	const model =
		plugin.settings.cloudServiceType === 'azure-claude'
			? (plugin.settings.cloudModel || DEFAULT_CLAUDE_MODEL)
			: (plugin.settings.azureCapabilities?.websearch?.deployment || DEFAULT_CLAUDE_MODEL);
	const { status, raw } = await probe(
		endpoint,
		{
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${key}`,
			'anthropic-version': '2023-06-01',
		},
		{ model, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] },
		signal,
	);
	const hasContent =
		status === 200 &&
		!!raw &&
		typeof raw === 'object' &&
		Array.isArray((raw as { content?: unknown }).content) &&
		(raw as { content: unknown[] }).content.length > 0;
	return { surface, ok: hasContent, status, message: hasContent ? 'connected' : redactedMessage(status) };
}

/**
 * Run the full Azure live connection test. Pre-flight validation gates the live
 * probes — if config is invalid, we short-circuit and report the validation
 * errors (no network calls). Otherwise each surface is probed independently.
 */
export async function testAzureConnection(
	plugin: AIOrganiserPlugin,
	signal?: AbortSignal,
): Promise<AzureTestReport> {
	const validation = validateSettings(plugin.settings);
	if (!validation.valid) {
		return { preflightOk: false, preflightErrors: validation.errors, surfaces: [] };
	}

	const surfaces: AzureSurfaceResult[] = [];

	// Claude messages (always probed in Azure mode — primary surface).
	surfaces.push(await testClaudeSurface(plugin, signal));

	// OpenAI chat + embeddings — only when the OpenAI endpoint is set.
	const chat = await testOpenAIChatSurface(plugin, signal);
	if (chat) surfaces.push(chat);
	const embeddings = await testEmbeddingsSurface(plugin, signal);
	if (embeddings) surfaces.push(embeddings);
	const whisper = await testWhisperSurface(plugin, signal);
	if (whisper) surfaces.push(whisper);

	// Per-capability probes (only when the capability is set to Azure) — a green
	// main chat doesn't prove the speech / web-search deployments exist.
	const tts = await testTtsSurface(plugin, signal);
	if (tts) surfaces.push(tts);
	const websearch = await testWebSearchSurface(plugin, signal);
	if (websearch) surfaces.push(websearch);

	// Azure AI Speech (in-region surface) — probed whenever its region/endpoint
	// is configured (it shares the main Foundry key by default, azure-audio D9).
	const speechTts = await testSpeechTtsSurface(plugin, signal);
	if (speechTts) surfaces.push(speechTts);
	const speechStt = await testSpeechSttSurface(plugin, signal);
	if (speechStt) surfaces.push(speechStt);

	return { preflightOk: true, preflightErrors: validation.errors, surfaces };
}
