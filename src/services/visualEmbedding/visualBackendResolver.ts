/**
 * Visual-embedding backend selector (DP-2): *Azure-served if the probe is green, else
 * BYO Cohere-native, else unavailable-with-notice.* The SINGLE owner of backend choice —
 * the settings panel and the Phase-6 index lane both call `selectVisualBackend` so the
 * status the user sees is the backend the lane uses.
 *
 * Probe discipline (C3/CA2): the Azure backend is selected ONLY on a cached fresh
 * `supported`; a fresh `unsupported` falls through to BYO; no fresh result →
 * `probe-needed` (carrying the exact config to probe). `needs-retry` results are never
 * persisted, so they can never wedge the selector.
 */
import type AIOrganiserPlugin from '../../main';
import { isAzureMode, getFoundryTextEmbeddingsEndpoint } from '../azure/endpointResolver';
import { resolveAzureCapability, capabilityChoice } from '../azure/resolveAzureCapability';
import { getCohereVisualApiKey } from '../apiKeyHelpers';
import { isProbeFresh, type HashFn } from './azureCohereV4ImageProbe';
import type { CohereV4Config } from './cohereV4VisualEmbeddingService';

/** Cohere's native model id for Embed v4 (the Azure side uses the DEPLOYMENT name instead). */
export const COHERE_NATIVE_MODEL_ID = 'embed-v4.0';

/**
 * FNV-1a 64-bit hex — the production `HashFn` for probe identity. NOT cryptographic and
 * doesn't need to be: it's a cache identity (the key digest only marks "the credential
 * changed", and a 64-bit digest is not invertible to the key). Sync, dependency-free.
 */
export function fnv1a64Hex(input: string): string {
    let hash = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    for (let i = 0; i < input.length; i++) {
        hash ^= BigInt(input.charCodeAt(i));
        hash = (hash * prime) & 0xffffffffffffffffn;
    }
    return hash.toString(16).padStart(16, '0');
}

export type VisualUnavailableReason =
    | 'off'                       // capability mode 'off'
    | 'missing-key'               // native path with no COHERE_VISUAL secret
    | 'no-deployment'             // azure path with no deployment name
    | 'no-endpoint'               // azure endpoint malformed/missing
    | 'no-key'                    // azure path with no Foundry key
    | 'azure-unsupported-no-byo'; // probe red AND no BYO key

export type VisualBackendSelection =
    | { kind: 'ready'; cfg: CohereV4Config }
    | { kind: 'probe-needed'; cfg: CohereV4Config }
    | { kind: 'unavailable'; reason: VisualUnavailableReason };

/**
 * Select the visual embedding backend for the current settings. Never throws.
 * `hash` is injectable for tests (production: `fnv1a64Hex`).
 */
export async function selectVisualBackend(plugin: AIOrganiserPlugin, hash: HashFn = fnv1a64Hex): Promise<VisualBackendSelection> {
    const settings = plugin.settings;
    const dim = settings.visualEmbeddingDim;

    if (isAzureMode(settings)) {
        const choice = capabilityChoice(plugin, 'visual-embeddings');
        if (choice.mode === 'off') return { kind: 'unavailable', reason: 'off' };

        if (choice.mode === 'azure') {
            const res = await resolveAzureCapability(plugin, 'visual-embeddings');
            if (res.kind === 'azure') {
                let textEndpoint: string;
                try {
                    textEndpoint = getFoundryTextEmbeddingsEndpoint(settings);
                } catch {
                    return { kind: 'unavailable', reason: 'no-endpoint' };
                }
                const cfg: CohereV4Config = {
                    backend: 'azure-cohere-v4',
                    endpoint: res.endpoint,
                    textEndpoint,
                    apiKey: res.key,
                    modelId: res.deployment,
                    dim,
                };
                const cached = settings.azureVisualImageProbe;
                if (isProbeFresh(cached, cfg, hash)) {
                    if (cached?.status === 'supported') return { kind: 'ready', cfg };
                    // Fresh `unsupported` → fall through to the BYO fallback below.
                } else {
                    return { kind: 'probe-needed', cfg };
                }
            } else if (res.kind === 'unavailable') {
                // Azure intent but unusable config — surface the precise gap rather than
                // silently falling to BYO (the user asked for Azure; D12 clear notices).
                if (res.reason === 'no-deployment') return { kind: 'unavailable', reason: 'no-deployment' };
                if (res.reason === 'no-key') return { kind: 'unavailable', reason: 'no-key' };
                if (res.reason === 'no-endpoint') return { kind: 'unavailable', reason: 'no-endpoint' };
                if (res.reason === 'off') return { kind: 'unavailable', reason: 'off' };
                // 'no-byo-key'/'no-azure-path' fall through to the native check below.
            }
            // res.kind === 'byo' also falls through to the native path.
        }
        // choice.mode === 'byo' → native path below.
        const byoKey = await getCohereVisualApiKey(plugin);
        if (!byoKey) {
            const probeWasRed = settings.azureVisualImageProbe?.status === 'unsupported';
            return { kind: 'unavailable', reason: probeWasRed && choice.mode === 'azure' ? 'azure-unsupported-no-byo' : 'missing-key' };
        }
        return { kind: 'ready', cfg: nativeConfig(byoKey, dim) };
    }

    // Non-Azure main: the only visual backend is Cohere-native BYO (D10 — cloud-only lane).
    const key = await getCohereVisualApiKey(plugin);
    if (!key) return { kind: 'unavailable', reason: 'missing-key' };
    return { kind: 'ready', cfg: nativeConfig(key, dim) };
}

function nativeConfig(apiKey: string, dim: number): CohereV4Config {
    return { backend: 'cohere-native', apiKey, modelId: COHERE_NATIVE_MODEL_ID, dim };
}
