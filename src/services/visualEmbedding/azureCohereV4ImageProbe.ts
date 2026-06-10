/**
 * Cohere v4 image-capability probe (plan Phase 5, C3 / DP-2).
 *
 * A CONTRACT test, not a global flag: embeds ONE 1×1 PNG against the typed backend and
 * asserts a `dim`-length float vector. The result is cached by FULL identity —
 * `sha1(endpointHost + modelId + dim + sha1(apiKey))` — so any component change re-probes.
 * The apiKey hash is included (G2): a mistyped key that 401s and caches `unsupported`
 * re-probes automatically once the user corrects the credential (otherwise visual features
 * would be permanently disabled with no obvious reset). Azure backend is selected only on a
 * cached `supported`.
 */
import { CohereV4VisualEmbeddingService, type CohereV4Config } from './cohereV4VisualEmbeddingService';

/** A 1×1 transparent PNG data URI — the minimal valid image payload. */
export const PROBE_ONE_PX_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export interface VisualProbeResult {
    supported: boolean;
    /** Identity this result is valid for — re-probe when it differs from the live config. */
    identityHash: string;
    checkedAt: number;
    reason?: string;
}

/** Hash fn injected for testability (production passes a sha1/sha256 hex helper). */
export type HashFn = (input: string) => string;

function endpointHostOf(endpoint: string | undefined): string {
    if (!endpoint) return 'cohere-native';
    try { return new URL(endpoint).host.toLowerCase(); } catch { return endpoint.toLowerCase(); }
}

/** The cache identity for a probe — changes whenever endpoint/model/dim/key change (G2). */
export function computeProbeIdentity(cfg: Pick<CohereV4Config, 'endpoint' | 'modelId' | 'dim' | 'apiKey'>, hash: HashFn): string {
    return hash([endpointHostOf(cfg.endpoint), cfg.modelId, String(cfg.dim), hash(cfg.apiKey)].join('|'));
}

/** True when a cached probe still matches the live config (no re-probe needed). */
export function isProbeFresh(
    cached: VisualProbeResult | undefined,
    cfg: Pick<CohereV4Config, 'endpoint' | 'modelId' | 'dim' | 'apiKey'>,
    hash: HashFn,
): boolean {
    return !!cached && cached.identityHash === computeProbeIdentity(cfg, hash);
}

/** Run the probe (one 1×1 PNG embed). Never throws. */
export async function probeAzureCohereV4Image(
    cfg: CohereV4Config,
    hash: HashFn,
    now: () => number,
): Promise<VisualProbeResult> {
    const identityHash = computeProbeIdentity(cfg, hash);
    const r = await new CohereV4VisualEmbeddingService(cfg).embedImages([{ dataUrl: PROBE_ONE_PX_PNG }]);
    if (r.ok && r.value.vectors[0]?.length === cfg.dim) {
        return { supported: true, identityHash, checkedAt: now() };
    }
    return { supported: false, identityHash, checkedAt: now(), reason: r.ok ? 'dim-mismatch' : r.error };
}
