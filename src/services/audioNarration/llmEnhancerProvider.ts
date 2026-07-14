/**
 * LLM enhancement provider abstraction (plan §1.5).
 *
 * Single seam swappable per Open/Closed (#3). v1 ships Gemini Flash +
 * Claude Haiku; future providers register here.
 *
 * Returns `EnhancerCallOutcome` (NOT generic `Result<T>`) so success
 * and failure variants both carry per-call metadata. Provider instances
 * are stateless — safe to share across the 4 parallel chunks
 * `llmMarkdownEnhancer` spawns (Gemini G2-H1 — no race-prone instance state).
 *
 * All outbound HTTP goes through `abortableRequestUrl` (Gemini G-H5 lesson).
 * Models resolve via Google's `gemini-flash-latest` alias and Anthropic's
 * `/v1/models` endpoint queried per session — never hardcode versions
 * (memory: feedback-always-use-latest-model-sentinels).
 */

import type { App, RequestUrlParam } from 'obsidian';
import { abortableRequestUrl } from '../../utils/abortableRequestUrl';
import { logger } from '../../utils/logger';
import { buildEnhancerPrompt, type EnhancementContext } from './llmEnhancerPrompts';

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 16384;
/** Hard cap on Anthropic /v1/models discovery — first-run-per-account would
 *  otherwise hang the entire 4-parallel enhance pipeline indefinitely (live
 *  persona spot-check 2026-05-24). On timeout we fall through to the sentinel,
 *  which then surfaces as a visible http-4xx via /v1/messages instead of a
 *  silent forever-hang. */
const DISCOVERY_TIMEOUT_MS = 10_000;

// ── Per-call result envelope ────────────────────────────────────────────────

export interface EnhancementResult {
    /** Replacement markdown for this chunk; mermaid/tables/code already collapsed to prose */
    enhancedMarkdown: string;
    /** Per-block trace — debug visibility only (NOT user-visible) */
    decisions: EnhancementDecision[];
    /** USD cost computed from provider usage metadata; never from model-claimed cost */
    actualCostUsd: number;
}

export interface EnhancementDecision {
    blockType: 'mermaid' | 'table' | 'code' | 'acronym' | 'callout' | 'other';
    action: 'summarise' | 'transform' | 'skip' | 'verbatim';
    reason: string;
}

export type LlmEnhancerErrorCode =
    | 'no-api-key'
    | `http-${number}`
    | 'malformed-response'
    | 'no-enhancement'
    | 'aborted'
    | 'timeout'
    | `network-${string}`;

export interface LlmEnhancerErrorMetadata {
    httpStatus?: number;
    retryable: boolean;
    /** From `Retry-After` header (ms); retry uses this in preference to its own schedule */
    retryAfterMs?: number;
}

/** Returned from `enhance()` — discriminated union, NOT generic Result<T>,
 *  so metadata travels with the variant (no race-prone instance state). */
export type EnhancerCallOutcome =
    | { ok: true; value: EnhancementResult; metadata: { httpStatus: number; retryable: false } }
    | { ok: false; code: LlmEnhancerErrorCode; metadata: LlmEnhancerErrorMetadata };

// ── Provider interface ──────────────────────────────────────────────────────

export interface LlmEnhancementProvider {
    readonly id: 'gemini' | 'haiku';
    readonly displayName: string;
    readonly modelSentinel: string;
    readonly costPerMTokensInput: number;
    readonly costPerMTokensOutput: number;

    enhance(
        app: App,
        sectionMarkdown: string,
        apiKey: string,
        ctx: EnhancementContext,
        signal?: AbortSignal,
    ): Promise<EnhancerCallOutcome>;
}

// ── Gemini Flash impl ───────────────────────────────────────────────────────

// Gemini 2.5/3.x Flash pricing (Jan 2026 — bump these alongside any audit-on-release).
const GEMINI_FLASH_INPUT_PER_M = 0.075;
const GEMINI_FLASH_OUTPUT_PER_M = 0.30;

interface GeminiUsageMetadata {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
}

interface GeminiResponse {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: GeminiUsageMetadata;
}

class GeminiEnhancementProvider implements LlmEnhancementProvider {
    readonly id = 'gemini' as const;
    readonly displayName = 'Google Gemini Flash';
    readonly modelSentinel = 'latest-flash';
    readonly costPerMTokensInput = GEMINI_FLASH_INPUT_PER_M;
    readonly costPerMTokensOutput = GEMINI_FLASH_OUTPUT_PER_M;

    async enhance(
        _app: App,
        sectionMarkdown: string,
        apiKey: string,
        ctx: EnhancementContext,
        signal?: AbortSignal,
    ): Promise<EnhancerCallOutcome> {
        if (!apiKey) return errOutcome('no-api-key', { retryable: false });
        const prompt = buildEnhancerPrompt(sectionMarkdown, ctx);
        // Google's rotating alias — auto-tracks newest Flash. Never hardcode versions.
        // Audit-code H10: pass API key in the `x-goog-api-key` header, NOT the URL
        // query string. Header-based secrets aren't captured in URL logs, error
        // telemetry, or proxy access logs. Google's official auth-via-header path.
        const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent';
        const body = JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0.2,
                responseMimeType: 'application/json',
                maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
            },
        });
        const params: RequestUrlParam = {
            url,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey,
            },
            body,
            throw: false,
        };
        return callWithTimeout(params, ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal, (resp) => {
            const status = resp.status;
            if (status !== 200) {
                return errOutcome(`http-${status}` as LlmEnhancerErrorCode, {
                    httpStatus: status,
                    retryable: status === 429 || status === 503,
                    retryAfterMs: parseRetryAfter(resp.headers),
                });
            }
            let data: GeminiResponse;
            try { data = JSON.parse(resp.text); } catch { return errOutcome('malformed-response', { retryable: false }); }
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
            const parsed = parseEnhancerJson(text);
            if (!parsed) return errOutcome('no-enhancement', { retryable: false });
            const inTok = data.usageMetadata?.promptTokenCount ?? 0;
            const outTok = data.usageMetadata?.candidatesTokenCount ?? 0;
            const cost = (inTok * GEMINI_FLASH_INPUT_PER_M + outTok * GEMINI_FLASH_OUTPUT_PER_M) / 1_000_000;
            return {
                ok: true as const,
                value: { enhancedMarkdown: parsed.enhancedMarkdown, decisions: parsed.decisions, actualCostUsd: cost },
                metadata: { httpStatus: 200, retryable: false as const },
            };
        });
    }
}

// ── Haiku impl ──────────────────────────────────────────────────────────────

// Claude Haiku pricing (Jan 2026).
const HAIKU_INPUT_PER_M = 0.80;
const HAIKU_OUTPUT_PER_M = 4.00;

interface AnthropicUsage {
    input_tokens?: number;
    output_tokens?: number;
}

interface AnthropicResponse {
    content?: Array<{ type?: string; text?: string }>;
    usage?: AnthropicUsage;
}

/** Per-account cache of the resolved Haiku model id (e.g. `claude-haiku-4-5-20251001`).
 *  Audit-code M15: keyed by API key prefix so users on multiple accounts don't
 *  cross-contaminate. First 16 chars is enough to distinguish keys without
 *  retaining the full secret in memory. */
const cachedHaikuModelByKey = new Map<string, string>();

function haikuCacheKey(apiKey: string): string {
    return apiKey.slice(0, 16);
}

async function resolveLatestHaiku(apiKey: string, signal?: AbortSignal): Promise<string> {
    const cacheKey = haikuCacheKey(apiKey);
    const cached = cachedHaikuModelByKey.get(cacheKey);
    if (cached) return cached;
    // Audit-code H8/H12: outbound HTTP must go through abortableRequestUrl
    // (cancellable, consistent with the per-call enhance() path).
    // Live-spot-check 2026-05-24: discovery must time out — without a bounded
    // race the GET can hang indefinitely (observed >10 min on first-run), which
    // blocks all 4 parallel enhance chunks awaiting this resolver. Compose the
    // caller's signal with a discovery-scoped timeout; on either abort, fall
    // through to the sentinel + log a warning. The sentinel then surfaces as
    // http-4xx via /v1/messages (visible warning) instead of a silent hang.
    const discoveryAbort = new AbortController();
    const timeoutHandle = window.setTimeout(() => discoveryAbort.abort(), DISCOVERY_TIMEOUT_MS);
    if (signal) {
        if (signal.aborted) {
            window.clearTimeout(timeoutHandle);
            throw new DOMException('cancelled', 'AbortError');
        }
        signal.addEventListener('abort', () => discoveryAbort.abort(), { once: true });
    }
    let resp;
    try {
        resp = await abortableRequestUrl(
            {
                url: 'https://api.anthropic.com/v1/models',
                method: 'GET',
                headers: {
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                },
                throw: false,
            },
            { signal: discoveryAbort.signal },
        );
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (signal?.aborted) throw e;  // caller cancelled — propagate
        if (/cancelled|aborted|AbortError/i.test(msg)) {
            logger.warn('LlmEnhancer', `Anthropic /v1/models discovery timed out after ${DISCOVERY_TIMEOUT_MS / 1000}s — using sentinel`);
        } else {
            logger.warn('LlmEnhancer', `Anthropic /v1/models discovery failed (${msg}); using sentinel`);
        }
        return 'latest-haiku';
    } finally {
        window.clearTimeout(timeoutHandle);
    }
    if (resp.status !== 200) {
        // Fallback: pass through the sentinel; the messages endpoint may resolve it,
        // and the upstream registry resolver covers a more robust strategy in v2.
        logger.warn('LlmEnhancer', `Anthropic /v1/models returned ${resp.status}; using sentinel`);
        return 'latest-haiku';
    }
    let data: { data?: Array<{ id?: string }> };
    try { data = JSON.parse(resp.text); } catch { return 'latest-haiku'; }
    const ids: string[] = (data.data ?? [])
        .map((m) => m.id ?? '')
        .filter((id) => id !== '' && /haiku/i.test(id));
    const parse = (id: string): { major: number; minor: number } | null => {
        let m = /^claude-haiku-(\d+)-(\d+)/.exec(id);
        if (m) return { major: +m[1], minor: +m[2] };
        m = /^claude-(\d+)-(\d+)-haiku/.exec(id);
        if (m) return { major: +m[1], minor: +m[2] };
        m = /^claude-(\d+)-haiku/.exec(id);
        if (m) return { major: +m[1], minor: 0 };
        return null;
    };
    const sorted = ids
        .map((id: string) => ({ id, parts: parse(id) }))
        .filter((x: { parts: ReturnType<typeof parse> }) => x.parts !== null)
        .sort((a: { id: string; parts: { major: number; minor: number } | null }, b: { id: string; parts: { major: number; minor: number } | null }) => {
            const pa = a.parts!; const pb = b.parts!;
            if (pa.major !== pb.major) return pb.major - pa.major;
            if (pa.minor !== pb.minor) return pb.minor - pa.minor;
            return b.id.localeCompare(a.id);
        });
    const resolved = sorted[0]?.id ?? 'latest-haiku';
    cachedHaikuModelByKey.set(cacheKey, resolved);
    return resolved;
}

class HaikuEnhancementProvider implements LlmEnhancementProvider {
    readonly id = 'haiku' as const;
    readonly displayName = 'Claude Haiku';
    readonly modelSentinel = 'latest-haiku';
    readonly costPerMTokensInput = HAIKU_INPUT_PER_M;
    readonly costPerMTokensOutput = HAIKU_OUTPUT_PER_M;

    async enhance(
        _app: App,
        sectionMarkdown: string,
        apiKey: string,
        ctx: EnhancementContext,
        signal?: AbortSignal,
    ): Promise<EnhancerCallOutcome> {
        if (!apiKey) return errOutcome('no-api-key', { retryable: false });
        const model = await resolveLatestHaiku(apiKey, signal).catch(() => 'latest-haiku');
        const prompt = buildEnhancerPrompt(sectionMarkdown, ctx);
        const body = JSON.stringify({
            model,
            max_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
            temperature: 0.2,
            messages: [{ role: 'user', content: prompt }],
        });
        const params: RequestUrlParam = {
            url: 'https://api.anthropic.com/v1/messages',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
            },
            body,
            throw: false,
        };
        return callWithTimeout(params, ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal, (resp) => {
            const status = resp.status;
            if (status !== 200) {
                return errOutcome(`http-${status}` as LlmEnhancerErrorCode, {
                    httpStatus: status,
                    retryable: status === 429 || status === 503,
                    retryAfterMs: parseRetryAfter(resp.headers),
                });
            }
            let data: AnthropicResponse;
            try { data = JSON.parse(resp.text); } catch { return errOutcome('malformed-response', { retryable: false }); }
            const text = (data.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('');
            const parsed = parseEnhancerJson(text);
            if (!parsed) return errOutcome('no-enhancement', { retryable: false });
            const inTok = data.usage?.input_tokens ?? 0;
            const outTok = data.usage?.output_tokens ?? 0;
            const cost = (inTok * HAIKU_INPUT_PER_M + outTok * HAIKU_OUTPUT_PER_M) / 1_000_000;
            return {
                ok: true as const,
                value: { enhancedMarkdown: parsed.enhancedMarkdown, decisions: parsed.decisions, actualCostUsd: cost },
                metadata: { httpStatus: 200, retryable: false as const },
            };
        });
    }
}

// ── Registry ────────────────────────────────────────────────────────────────

export const LLM_ENHANCEMENT_PROVIDERS: Readonly<Record<'gemini' | 'haiku', LlmEnhancementProvider>> = {
    gemini: new GeminiEnhancementProvider(),
    haiku: new HaikuEnhancementProvider(),
};

export function getLlmEnhancementProvider(id: 'gemini' | 'haiku'): LlmEnhancementProvider {
    return LLM_ENHANCEMENT_PROVIDERS[id];
}

// ── Shared HTTP helpers ─────────────────────────────────────────────────────

interface RequestUrlResponseLike {
    status: number;
    text: string;
    headers: Record<string, string>;
}

async function callWithTimeout(
    params: RequestUrlParam,
    timeoutMs: number,
    callerSignal: AbortSignal | undefined,
    onSuccess: (resp: RequestUrlResponseLike) => EnhancerCallOutcome,
): Promise<EnhancerCallOutcome> {
    const composed = new AbortController();
    let timedOut = false;
    const timeoutHandle = window.setTimeout(() => { timedOut = true; composed.abort(); }, timeoutMs);
    if (callerSignal) {
        if (callerSignal.aborted) {
            window.clearTimeout(timeoutHandle);
            return errOutcome('aborted', { retryable: false });
        }
        callerSignal.addEventListener('abort', () => composed.abort(), { once: true });
    }
    try {
        const resp = await abortableRequestUrl(params, { signal: composed.signal });
        return onSuccess(resp);
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (timedOut) return errOutcome('timeout', { retryable: false });
        if (/cancelled|aborted|AbortError/i.test(message)) return errOutcome('aborted', { retryable: false });
        return errOutcome(classifyTransportError(message), { retryable: false });
    } finally {
        window.clearTimeout(timeoutHandle);
    }
}

function classifyTransportError(message: string): LlmEnhancerErrorCode {
    const lower = message.toLowerCase();
    if (lower.includes('enotfound') || lower.includes('eai_again') || lower.includes('net::')) return 'network-dns';
    if (lower.includes('cert') || lower.includes('tls') || lower.includes('ssl')) return 'network-tls';
    if (lower.includes('csp')) return 'network-csp';
    if (lower.includes('enetunreach') || lower.includes('offline')) return 'network-offline';
    return `network-other:${message.slice(0, 120)}` as LlmEnhancerErrorCode;
}

function parseRetryAfter(headers: Record<string, string> | undefined): number | undefined {
    if (!headers) return undefined;
    const raw = headers['Retry-After'] ?? headers['retry-after'];
    if (!raw) return undefined;
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    // HTTP-date form not handled; uncommon for these providers
    return undefined;
}

function errOutcome(code: LlmEnhancerErrorCode, metadata: LlmEnhancerErrorMetadata): EnhancerCallOutcome {
    return { ok: false, code, metadata };
}

/** Parse the LLM's JSON output. Some providers wrap in code fences;
 *  strip those defensively. Returns null on shape miss. */
function parseEnhancerJson(text: string): { enhancedMarkdown: string; decisions: EnhancementDecision[] } | null {
    const trimmed = text.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
    const raw = fenced ? fenced[1] : trimmed;
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed?.enhancedMarkdown !== 'string') return null;
        const decisions = Array.isArray(parsed.decisions) ? parsed.decisions : [];
        return { enhancedMarkdown: parsed.enhancedMarkdown, decisions };
    } catch {
        return null;
    }
}

/** Test-only — clears the cached Haiku model ids between test runs. */
export function __resetHaikuModelCacheForTests(): void {
    cachedHaikuModelByKey.clear();
}
