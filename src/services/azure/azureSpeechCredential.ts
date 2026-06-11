/**
 * Azure AI Speech credential + readiness resolution (plan D9/D10).
 *
 * Single source for "which key/endpoint/region does the azure-speech surface
 * use". Resolution order for the key: dedicated Speech secret
 * (`PLUGIN_SECRET_IDS.AZURE_SPEECH`) → shared Foundry key (`getAzureApiKey`,
 * documented fallback — a Speech resource co-located with the Foundry resource
 * shares its key) → unavailable. NEVER the user's personal cloud key
 * (`useMainKeyFallback: false` everywhere — the Deepgram lesson).
 *
 * Readiness predicates are SEPARATE per operation (plan D10/H4): TTS needs
 * region + key (the `{region}.tts.speech.microsoft.com` host); Fast
 * Transcription needs the explicit `azureSpeechEndpoint` custom domain + key —
 * no prefix derivation from `azureOpenAIEndpoint`, which is unsafe when the
 * Speech resource differs. Voice readiness (`no-voice`) is the capability
 * resolver's concern, not a credential property.
 *
 * Never throws — secret lookups are wrapped; failures resolve to `err`.
 */

import type AIOrganiserPlugin from '../../main';
import { type Result, ok, err } from '../../core/result';
import { PLUGIN_SECRET_IDS } from '../../core/secretIds';
import { getAzureApiKey } from './azureKey';

export interface AzureSpeechCredential {
    /** The `Ocp-Apim-Subscription-Key` value. */
    key: string;
    /** Raw `azureSpeechEndpoint` setting (may be '' — STT readiness is per-op). */
    endpoint: string;
    /** Raw `azureSpeechRegion` setting (may be '' — TTS readiness is per-op). */
    region: string;
}

/** Resolve the Speech key: dedicated secret → shared Foundry key → err('no-key'). */
async function resolveSpeechKey(plugin: AIOrganiserPlugin): Promise<string | null> {
    const s = plugin.secretStorageService;
    try {
        if (s.isAvailable()) {
            const dedicated = await s.getSecret(PLUGIN_SECRET_IDS.AZURE_SPEECH);
            if (dedicated) return dedicated;
        }
    } catch {
        // fall through to the shared Foundry key
    }
    try {
        return await getAzureApiKey(plugin, 'azure-claude');
    } catch {
        return null;
    }
}

/**
 * Resolve the full Speech credential bundle. `endpoint`/`region` are returned
 * raw (possibly empty) — callers use the per-op readiness predicates or the
 * endpoint builders (which validate + host-anchor) before any egress.
 */
export async function resolveAzureSpeechCredential(
    plugin: AIOrganiserPlugin,
): Promise<Result<AzureSpeechCredential>> {
    const key = await resolveSpeechKey(plugin);
    if (!key) return err('no-key');
    return ok({
        key,
        endpoint: typeof plugin.settings.azureSpeechEndpoint === 'string' ? plugin.settings.azureSpeechEndpoint.trim() : '',
        region: typeof plugin.settings.azureSpeechRegion === 'string' ? plugin.settings.azureSpeechRegion.trim() : '',
    });
}

/** TTS readiness = region + key (voice is checked separately → `no-voice`). */
export async function isAzureSpeechTtsConfigured(plugin: AIOrganiserPlugin): Promise<boolean> {
    if (typeof plugin.settings.azureSpeechRegion !== 'string' || !plugin.settings.azureSpeechRegion.trim()) return false;
    return !!(await resolveSpeechKey(plugin));
}

/** Fast Transcription readiness = explicit custom-domain endpoint + key (plan D10). */
export async function isAzureSpeechFastTranscriptionConfigured(plugin: AIOrganiserPlugin): Promise<boolean> {
    if (typeof plugin.settings.azureSpeechEndpoint !== 'string' || !plugin.settings.azureSpeechEndpoint.trim()) return false;
    return !!(await resolveSpeechKey(plugin));
}
