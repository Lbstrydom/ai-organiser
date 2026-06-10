/**
 * Cohere v4 image-capability probe (plan Phase 5, C3 / DP-2 / CA2).
 *
 * A CONTRACT test, not a global flag: embeds ONE 1×1 PNG against the typed backend and
 * asserts a `dim`-length float vector. The result is cached by FULL identity —
 * `sha1(endpointHost + modelId + dim + sha1(apiKey))` — so any component change re-probes.
 * The apiKey hash is included (G2): a mistyped key that 401s and caches `unsupported`
 * re-probes automatically once the user corrects the credential (otherwise visual features
 * would be permanently disabled with no obvious reset). Azure backend is selected only on a
 * cached `supported`.
 *
 * CA2 (Gemini R3 G3): a DEFINITIVE rejection (4xx / wrong shape / wrong dim) caches
 * `unsupported`; a TRANSIENT failure (429 / 5xx / network / abort) returns `needs-retry`
 * and MUST NOT be cached — a startup network hiccup must not permanently disable
 * visual search. Callers persist only `supported`/`unsupported` results.
 */
import { CohereV4VisualEmbeddingService, type CohereV4Config } from './cohereV4VisualEmbeddingService';

/** A 1×1 transparent PNG data URI — the minimal valid image payload. */
export const PROBE_ONE_PX_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export type VisualProbeStatus = 'supported' | 'unsupported' | 'needs-retry';

export interface VisualProbeResult {
    status: VisualProbeStatus;
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

/** True when a cached probe still matches the live config (no re-probe needed).
 *  A cached `needs-retry` is NEVER fresh (CA2) — it must always re-attempt. */
export function isProbeFresh(
    cached: VisualProbeResult | undefined | null,
    cfg: Pick<CohereV4Config, 'endpoint' | 'modelId' | 'dim' | 'apiKey'>,
    hash: HashFn,
): boolean {
    return !!cached && cached.status !== 'needs-retry' && cached.identityHash === computeProbeIdentity(cfg, hash);
}

/**
 * CA2 classification of an embed failure. Definitive = the backend answered and said no
 * (auth/shape/contract). Transient = we never got a trustworthy answer.
 */
export function classifyProbeFailure(error: string): Exclude<VisualProbeStatus, 'supported'> {
    if (error === 'rate-limited' || error === 'aborted') return 'needs-retry';
    if (error.startsWith('network:')) return 'needs-retry';
    const httpMatch = /^http-(\d{3})/.exec(error);
    if (httpMatch && Number(httpMatch[1]) >= 500) return 'needs-retry';
    // 4xx, dim-mismatch, count-mismatch, parse-failed, endpoint-missing → definitive.
    return 'unsupported';
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
        return { status: 'supported', identityHash, checkedAt: now() };
    }
    if (r.ok) {
        return { status: 'unsupported', identityHash, checkedAt: now(), reason: 'dim-mismatch' };
    }
    return { status: classifyProbeFailure(r.error), identityHash, checkedAt: now(), reason: r.error };
}
