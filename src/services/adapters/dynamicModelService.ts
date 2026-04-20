/**
 * Dynamic Model Service
 *
 * Fetches live model catalogs from each provider's `/models` endpoint and
 * caches them per-session. Merged with the hardcoded `PROVIDER_MODELS`
 * fallback so users still see options when offline or key-less.
 *
 * Flow:
 *   1. Settings renders → `getModelsFor(provider, key)` returns cached/static
 *      list immediately.
 *   2. Same call kicks off a background refresh if cache is stale.
 *   3. `latest-*` resolver in modelCapabilities.ts uses the cached list at
 *      adapter creation so new provider releases auto-propagate.
 *
 * Error strategy: every failure falls back to the static list. The UI can
 * show a "live fetch failed — using cached/static" notice when appropriate.
 */

import { requestUrl } from 'obsidian';
import type { AdapterType } from './index';
import { logger } from '../../utils/logger';

export interface LiveModelInfo {
    id: string;
    /** Provider-supplied display name, if any. Falls back to id. */
    label?: string;
    /** Unix ms when the provider reports the model was created. */
    createdAt?: number;
    /** Provider-reported context window, if available. */
    contextWindow?: number;
    /** Raw provider response for debugging / advanced filtering. */
    raw?: unknown;
}

interface CacheEntry {
    models: LiveModelInfo[];
    fetchedAt: number;
    source: 'fresh' | 'stale' | 'static';
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const cache = new Map<AdapterType, CacheEntry>();

/** Test-only: reset the in-memory cache. */
export function __resetDynamicModelCache(): void {
    cache.clear();
}

/** Return cached entry (fresh or stale) without fetching. */
export function getCachedModels(provider: AdapterType): LiveModelInfo[] | null {
    return cache.get(provider)?.models ?? null;
}

/**
 * Fetch live models for a provider. Returns the list AND updates the cache.
 * Throws on error — callers wrap and fall back to static list.
 */
export async function fetchLiveModels(provider: AdapterType, apiKey: string): Promise<LiveModelInfo[]> {
    const fetcher = PROVIDER_FETCHERS[provider];
    if (!fetcher) {
        throw new Error(`No live-model fetcher registered for provider: ${provider}`);
    }
    const models = await fetcher(apiKey);
    cache.set(provider, { models, fetchedAt: Date.now(), source: 'fresh' });
    logger.debug('DynamicModels', `Fetched ${models.length} live models for ${provider}`);
    return models;
}

/**
 * Get models with stale-while-revalidate semantics:
 *   - Fresh cache (< TTL): return it, no fetch
 *   - Stale cache: return stale + kick off background refresh
 *   - No cache: fetch synchronously (await); fall back to [] on error
 *
 * When `apiKey` is empty, skip the fetch and return cached/empty.
 */
export async function getLiveModels(
    provider: AdapterType,
    apiKey: string,
    options?: { forceRefresh?: boolean },
): Promise<LiveModelInfo[]> {
    const existing = cache.get(provider);
    const isFresh = existing && (Date.now() - existing.fetchedAt) < CACHE_TTL_MS;

    if (existing && isFresh && !options?.forceRefresh) {
        return existing.models;
    }
    if (!apiKey) {
        // No key — cannot fetch; return whatever is cached (or empty).
        return existing?.models ?? [];
    }

    try {
        return await fetchLiveModels(provider, apiKey);
    } catch (err) {
        logger.warn('DynamicModels', `Live fetch failed for ${provider}, using static fallback`, err);
        // Return stale cache if available, else empty so caller uses static.
        return existing?.models ?? [];
    }
}

// ── Per-provider fetchers ───────────────────────────────────────────────────

type Fetcher = (apiKey: string) => Promise<LiveModelInfo[]>;

const PROVIDER_FETCHERS: Partial<Record<AdapterType, Fetcher>> = {
    claude: fetchAnthropic,
    openai: fetchOpenAICompat('https://api.openai.com/v1/models'),
    gemini: fetchGemini,
    groq: fetchOpenAICompat('https://api.groq.com/openai/v1/models'),
    deepseek: fetchOpenAICompat('https://api.deepseek.com/v1/models'),
    openrouter: fetchOpenAICompat('https://openrouter.ai/api/v1/models', { keyOptional: true }),
    // Others (xAI grok, Mistral, Cohere, Aliyun, Bedrock, SiliconFlow) are
    // OpenAI-compatible at varying endpoints — register by adding a line
    // when a user demands it. Keeping the initial set focused.
};

async function fetchAnthropic(apiKey: string): Promise<LiveModelInfo[]> {
    const response = await requestUrl({
        url: 'https://api.anthropic.com/v1/models',
        method: 'GET',
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        },
        throw: false,
    });
    if (response.status !== 200) {
        throw new Error(`Anthropic /models returned ${response.status}: ${response.text.slice(0, 200)}`);
    }
    const json = response.json as { data?: Array<{ id: string; display_name?: string; created_at?: string }> };
    if (!Array.isArray(json?.data)) return [];
    return json.data.map(m => ({
        id: m.id,
        label: m.display_name,
        createdAt: m.created_at ? Date.parse(m.created_at) : undefined,
        raw: m,
    }));
}

function fetchOpenAICompat(url: string, opts?: { keyOptional?: boolean }): Fetcher {
    return async (apiKey: string): Promise<LiveModelInfo[]> => {
        const headers: Record<string, string> = {};
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        else if (!opts?.keyOptional) throw new Error('API key required');
        const response = await requestUrl({ url, method: 'GET', headers, throw: false });
        if (response.status !== 200) {
            throw new Error(`${url} returned ${response.status}: ${response.text.slice(0, 200)}`);
        }
        const json = response.json as { data?: Array<{ id: string; created?: number }> };
        if (!Array.isArray(json?.data)) return [];
        return json.data.map(m => ({
            id: m.id,
            createdAt: typeof m.created === 'number' ? m.created * 1000 : undefined,
            raw: m,
        }));
    };
}

async function fetchGemini(apiKey: string): Promise<LiveModelInfo[]> {
    if (!apiKey) throw new Error('Gemini API key required');
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
    const response = await requestUrl({ url, method: 'GET', throw: false });
    if (response.status !== 200) {
        throw new Error(`Gemini /models returned ${response.status}: ${response.text.slice(0, 200)}`);
    }
    interface GeminiModel {
        name: string;
        displayName?: string;
        inputTokenLimit?: number;
        supportedGenerationMethods?: string[];
    }
    const json = response.json as { models?: GeminiModel[] };
    if (!Array.isArray(json?.models)) return [];
    return json.models
        .filter(m => Array.isArray(m.supportedGenerationMethods)
            && m.supportedGenerationMethods.includes('generateContent'))
        .map(m => ({
            // Google prefixes with "models/" — strip it so the ID matches
            // what request payloads expect.
            id: m.name.replace(/^models\//, ''),
            label: m.displayName,
            contextWindow: m.inputTokenLimit,
            raw: m,
        }));
}

/** Providers that support live-fetch (for UI to decide whether to show
 *  a "Refresh models" button). */
export function providerSupportsLiveFetch(provider: AdapterType): boolean {
    return provider in PROVIDER_FETCHERS;
}
