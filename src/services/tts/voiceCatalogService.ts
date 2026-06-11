/**
 * Azure Speech voice catalog (azure-audio plan D11/H7).
 *
 * Cached fetch of the regional `voices/list` endpoint — powers the settings
 * voice picker AND validates a selected voice against what the region actually
 * serves. When the catalog is unreachable (offline / bad key) validation falls
 * back to the strict voice-name grammar in `ssmlBuilder` — degraded but never
 * fail-open to arbitrary strings.
 *
 * Cache is in-memory per region (session-scoped — Obsidian restarts clear it);
 * a TTL keeps a long-lived session from going stale.
 */

import { type Result, ok, err } from '../../core/result';
import { abortableRequestUrl } from '../../utils/abortableRequestUrl';
import { logger } from '../../utils/logger';
import { getSpeechVoicesListEndpoint } from '../azure/endpointResolver';
import { withAzureLease, buildAzureSpeechKey } from '../azure/azureRequestPacer';
import { isValidAzureVoiceName } from './ssmlBuilder';

export interface SpeechVoiceEntry {
    /** API short name, e.g. `en-US-AvaNeural` — the value sent in SSML. */
    shortName: string;
    /** Human label, e.g. `Ava` */
    displayName: string;
    locale: string;
    gender?: string;
}

interface RawVoice {
    ShortName?: string;
    DisplayName?: string;
    Locale?: string;
    Gender?: string;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 h
const FETCH_TIMEOUT_MS = 20_000;

interface CacheEntry { voices: SpeechVoiceEntry[]; fetchedAtMs: number }
const cache = new Map<string, CacheEntry>();

/** Documented neutral fallback used ONLY as a last resort (plan D11). */
export const NEUTRAL_FALLBACK_VOICE = 'en-US-AvaNeural';

/** Test hook / settings-change hygiene. */
export function clearVoiceCatalogCache(): void {
    cache.clear();
}

/**
 * Fetch (or serve cached) voices for the configured region.
 * Settings shape matches the endpoint resolver's needs.
 */
export async function listVoices(
    settings: { azureSpeechRegion?: string; azureSpeechEndpoint?: string; azureAIEndpoint: string; azureOpenAIEndpoint: string },
    key: string,
    opts: { signal?: AbortSignal; forceRefresh?: boolean } = {},
): Promise<Result<SpeechVoiceEntry[]>> {
    const endpoint = getSpeechVoicesListEndpoint(settings);
    if (!endpoint.ok) return endpoint;
    const cacheKey = endpoint.value;

    const cached = cache.get(cacheKey);
    if (!opts.forceRefresh && cached && Date.now() - cached.fetchedAtMs < CACHE_TTL_MS) {
        return ok(cached.voices);
    }

    let paceKey: string;
    try {
        paceKey = buildAzureSpeechKey(endpoint.value, 'voices');
    } catch {
        return err('bad-endpoint');
    }

    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    if (opts.signal) {
        if (opts.signal.aborted) return err('aborted');
        opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const response = await withAzureLease(paceKey, controller.signal, () => abortableRequestUrl({
            url: endpoint.value,
            method: 'GET',
            headers: { 'Ocp-Apim-Subscription-Key': key },
            throw: false,
        }, { signal: controller.signal }));
        if (response.status !== 200) {
            return err(`http-${response.status}`);
        }
        const raw = response.json as RawVoice[] | null;
        if (!Array.isArray(raw)) return err('malformed-response');
        const voices: SpeechVoiceEntry[] = raw
            .filter((v) => typeof v.ShortName === 'string' && v.ShortName)
            .map((v) => ({
                shortName: v.ShortName as string,
                displayName: v.DisplayName ?? (v.ShortName as string),
                locale: v.Locale ?? '',
                gender: v.Gender,
            }));
        if (voices.length === 0) return err('empty-catalog');
        cache.set(cacheKey, { voices, fetchedAtMs: Date.now() });
        return ok(voices);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/abort|cancell/i.test(msg)) return err('aborted');
        logger.warn('AudioNarration', `voices/list fetch failed: ${msg.slice(0, 120)}`);
        return err(`network: ${msg.slice(0, 120)}`);
    } finally {
        clearTimeout(timer);
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    }
}

/**
 * Validate a selected voice: catalog membership when a catalog is cached for
 * the region; otherwise the strict name-grammar backstop (degraded-offline,
 * never fail-open).
 */
export function isVoiceValid(
    settings: { azureSpeechRegion?: string; azureSpeechEndpoint?: string; azureAIEndpoint: string; azureOpenAIEndpoint: string },
    voice: string,
): boolean {
    if (!isValidAzureVoiceName(voice)) return false;
    const endpoint = getSpeechVoicesListEndpoint(settings);
    if (!endpoint.ok) return true; // grammar-only backstop (no region to check against)
    const cached = cache.get(endpoint.value);
    if (!cached) return true; // catalog not fetched — grammar backstop
    return cached.voices.some((v) => v.shortName === voice);
}
