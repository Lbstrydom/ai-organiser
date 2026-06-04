import type AIOrganiserPlugin from '../main';
import type { AdapterType } from './adapters';
import { isAzureMode } from './azure/endpointResolver';
import { getAzureApiKey, resolveEndpoint } from './apiKeyHelpers';

/**
 * Provider profile — the single source of truth (D1) for "which provider is
 * active, is it actually usable, and what should the trust badge show".
 *
 * Resolved ONCE per `initializeLLMService` (which re-runs on `saveSettings`),
 * cached on `plugin.providerProfile`. The badge, per-call attribution, and the
 * fail-closed `NullLLMService` swap all read this — no per-call resolution
 * (the LLM service is long-lived).
 */
export type ProviderMode = 'azure' | 'personal' | 'local';

export interface ProviderProfile {
    /**
     * Usable right now. Cloud: a non-blank key. Azure additionally requires a
     * well-formed HTTPS endpoint (a malformed/insecure endpoint is invalid).
     * Local: a non-blank endpoint.
     */
    valid: boolean;
    mode: ProviderMode;
    /** Adapter type for cloud, or `'local'`. */
    provider: AdapterType | 'local';
    /** Human label for the badge, e.g. `Claude`, `OpenAI`, `Local`. */
    providerLabel: string;
    /** Host of the resolved endpoint, for the badge tooltip. `''` if none/invalid. */
    endpointHost: string;
    model: string;
    keySource: 'azure-foundry' | 'provider' | 'none';
    /** Present only when `valid === false` — a user-facing, actionable reason. */
    error?: string;
}

const PROVIDER_LABELS: Partial<Record<string, string>> = {
    claude: 'Claude',
    'azure-claude': 'Claude',
    openai: 'OpenAI',
    'azure-openai': 'OpenAI',
    gemini: 'Gemini',
    groq: 'Groq',
    deepseek: 'DeepSeek',
    mistral: 'Mistral',
    openrouter: 'OpenRouter',
    siliconflow: 'SiliconFlow',
    together: 'Together',
    perplexity: 'Perplexity',
    xai: 'xAI',
};

function providerLabel(provider: string): string {
    return PROVIDER_LABELS[provider] ?? (provider.charAt(0).toUpperCase() + provider.slice(1));
}

/**
 * Extract the host (incl. port) from a URL for the badge tooltip.
 * Returns `''` on a malformed URL (R1-L1) — the caller treats an empty host
 * on a cloud profile as "no usable endpoint".
 */
export function extractHost(url: string): string {
    if (!url) return '';
    try {
        return new URL(url).host;
    } catch {
        return '';
    }
}

/** True only for a well-formed `https:` URL — Azure endpoints must be HTTPS
 *  (H7: don't mark an `http://`/malformed Azure endpoint as valid). */
function isSecureUrl(url: string): boolean {
    if (!url) return false;
    try {
        return new URL(url).protocol === 'https:';
    } catch {
        return false;
    }
}

/** Resolve a key, swallowing any SecretStorage error so the resolver never
 *  throws (H4/M21) — a thrown lookup degrades to "no key" (fail closed). */
async function safeResolveKey(resolve: () => Promise<string | null>): Promise<string> {
    try {
        return (await resolve()) ?? '';
    } catch {
        return '';
    }
}

/**
 * Resolve the active provider into a validated profile (D1).
 *
 * Composes the existing SSOTs — `isAzureMode`, `resolveEndpoint`,
 * `getAzureApiKey` / `secretStorage.getProviderKey` — into one value object.
 * Only awaits SecretStorage; otherwise pure. Never throws.
 */
export async function resolveProviderProfile(plugin: AIOrganiserPlugin): Promise<ProviderProfile> {
    const settings = plugin.settings;

    // ── Local ──────────────────────────────────────────────────────────────
    // Local is the user's own server — we never fail-close it. Validity tracks
    // endpoint presence purely for completeness; the NullLLMService swap only
    // triggers on `mode === 'azure' && !valid`.
    if (settings.serviceType === 'local') {
        const endpoint = settings.localEndpoint || '';
        return {
            valid: !!endpoint.trim(),
            mode: 'local',
            provider: 'local',
            providerLabel: 'Local',
            endpointHost: extractHost(endpoint),
            model: settings.localModel || '',
            keySource: 'none',
            error: endpoint.trim() ? undefined : 'No local LLM endpoint configured. Open Settings → AI provider to add one.',
        };
    }

    const provider: AdapterType = settings.cloudServiceType;

    // ── Azure ──────────────────────────────────────────────────────────────
    if (isAzureMode(settings)) {
        // Only the two Azure surfaces reach here (isAzureMode is `azure-*`); the
        // ternary fails closed rather than asserting on the union (M11).
        const azureProvider: 'azure-claude' | 'azure-openai' =
            provider === 'azure-openai' ? 'azure-openai' : 'azure-claude';
        const endpoint = resolveEndpoint(azureProvider, plugin);
        const endpointHost = extractHost(endpoint);
        const key = await safeResolveKey(() => getAzureApiKey(plugin, azureProvider));
        // H7: require a well-formed HTTPS endpoint — host-extraction alone would
        // pass an insecure `http://` or otherwise-malformed Azure endpoint.
        const hasEndpoint = !!endpointHost && isSecureUrl(endpoint);
        const hasKey = !!key.trim();
        const valid = hasEndpoint && hasKey;

        let error: string | undefined;
        if (!valid) {
            if (!hasEndpoint && !hasKey) {
                error = 'Azure is selected but not configured — set the Azure endpoint and key in AI provider settings.';
            } else if (!hasEndpoint) {
                error = 'Azure is selected but its endpoint is not configured — set the Azure endpoint in AI provider settings.';
            } else {
                error = 'Azure is selected but its key is not configured — set the Azure key in AI provider settings.';
            }
        }

        return {
            valid,
            mode: 'azure',
            provider: azureProvider,
            providerLabel: providerLabel(azureProvider),
            endpointHost,
            model: settings.cloudModel || '',
            keySource: 'azure-foundry',
            error,
        };
    }

    // ── Personal (non-Azure cloud) ─────────────────────────────────────────
    const secretStorage = plugin.secretStorageService;
    const key = (secretStorage.isAvailable()
        ? await safeResolveKey(() => secretStorage.getProviderKey(provider))
        : '')
        || settings.providerSettings?.[provider]?.apiKey
        || settings.cloudApiKey
        || '';
    const endpoint = settings.cloudEndpoint || resolveEndpoint(provider, plugin);
    const valid = !!key.trim();

    return {
        valid,
        mode: 'personal',
        provider,
        providerLabel: providerLabel(provider),
        endpointHost: extractHost(endpoint),
        model: settings.cloudModel || '',
        keySource: 'provider',
        error: valid ? undefined : `No API key configured for ${providerLabel(provider)}. Open Settings → AI provider to add one.`,
    };
}
