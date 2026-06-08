/**
 * Per-deployment RPM resolution (azure-capability-completion-v2, Phase 2 / plan D8, C11).
 *
 * Azure quotas do NOT follow the TPM:RPM ratio (verified live: gpt-4o-transcribe is
 * 100k TPM but 10,000 RPM; text-embedding-3-large is 60 RPM vs -3-small 600). So RPM
 * must be a per-deployment, USER-configurable override — never derived from TPM and
 * never hardcoded (corporate-isolation: a public plugin can't ship one tenant's quotas).
 *
 * This is the pure SSOT resolver (no Obsidian/network deps) so it's unit-testable in
 * isolation. The override is keyed by deployment NAME (the user-facing identity they
 * type in settings). Lookup is canonical (trim + lowercase) so it matches the pacer
 * registry's `canonicalIdentity` key segment regardless of casing/whitespace.
 */

/** A finite integer ≥ 1, or null. */
function saneRpm(v: unknown): number | null {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= 1 ? n : null;
}

/**
 * The RPM to pace `deployment` at: the user's per-deployment override when present
 * and valid, else the global fallback. Unknown / blank / invalid override → global.
 *
 * @param deployment the deployment (or model) identity — canonicalized internally
 * @param map        `settings.azurePerDeploymentRpm` (may be undefined / arbitrary-cased keys)
 * @param globalRpm  the fallback (`settings.azureMaxRpm`)
 */
export function rpmForDeployment(
    deployment: string,
    map: Record<string, number> | undefined,
    globalRpm: number,
): number {
    const fallback = saneRpm(globalRpm) ?? 60;
    const key = (deployment ?? '').trim().toLowerCase();
    if (!key || !map) return fallback;
    for (const [k, v] of Object.entries(map)) {
        if ((k ?? '').trim().toLowerCase() === key) {
            return saneRpm(v) ?? fallback;
        }
    }
    return fallback;
}
