/**
 * featureService — pure feature-flag logic (FT-3). Vault-free, no Obsidian imports;
 * every gating site reads `isFeatureEnabled` so the SSOT (the registry) drives all
 * gating (#1 DRY, #11 pure).
 */

import { FEATURE_REGISTRY, FEATURE_BY_ID, type FeatureId } from '../core/features';

/** The persisted flag shape (a subset of settings). */
export interface FeatureFlagsHost {
    featureFlags?: Partial<Record<FeatureId, boolean>>;
}

/**
 * Is `id` enabled for the given settings?
 *
 *   core  OR  (saved-flag ?? registry.defaultOn)  AND  every `requires[]` enabled
 *
 * FAIL-CLOSED (FT-4): an `id` not in the registry is disabled — a typo can't expose a
 * hidden feature. The `?? defaultOn` coalesce is load-bearing (Gemini-G4): a feature
 * added in a later release won't be in an existing user's saved `featureFlags`, so
 * coalescing `undefined → registry.defaultOn` (not `false`) makes it appear per its
 * declared default rather than silently vanishing.
 */
export function isFeatureEnabled(settings: FeatureFlagsHost, id: FeatureId, _seen?: Set<FeatureId>): boolean {
    const def = FEATURE_BY_ID[id];
    if (!def) return false; // fail-closed: unknown id
    if (def.core) return true;
    // Fail-closed input validation (`featureFlags` is user-editable JSON):
    //   • ABSENT (undefined)        → registry default — a feature added in a later
    //                                 release appears per its declared default (Gemini-G4).
    //   • explicit boolean          → honoured.
    //   • PRESENT but non-boolean   → corruption — fail CLOSED (disabled), never coerce a
    //                                 default-on feature to stay on from a malformed value.
    const raw = settings.featureFlags?.[id];
    let self: boolean;
    if (raw === undefined) self = def.defaultOn;
    else if (typeof raw === 'boolean') self = raw;
    else return false;
    if (!self) return false;
    // Path-based cycle guard: `seen` tracks the CURRENT dependency path (DFS stack), not
    // all-visited — a node is removed on the way back up so a valid diamond (A→B, A→C,
    // B→D, C→D) isn't mis-flagged as a cycle. A true cycle (a node already on the path)
    // fails CLOSED instead of recursing without bound. Registry is acyclic by test; this
    // is defence in depth against a future edit.
    const seen = _seen ?? new Set<FeatureId>();
    if (seen.has(id)) return false;
    seen.add(id);
    const ok = def.requires.every((dep) => isFeatureEnabled(settings, dep, seen));
    seen.delete(id);
    return ok;
}

/**
 * The Lean default flag set (§5): explicit `true`/`false` for every NON-core feature
 * (core features are always-on and omitted — `isFeatureEnabled` short-circuits them).
 * Seeded once by `migrateOldSettings` when `featureFlags` is absent.
 */
export function defaultFeatureFlags(): Partial<Record<FeatureId, boolean>> {
    const flags: Partial<Record<FeatureId, boolean>> = {};
    for (const f of FEATURE_REGISTRY) {
        if (f.core) continue;
        flags[f.id] = f.defaultOn;
    }
    return flags;
}

/**
 * Resolve the flag set after ENABLING `id`: turn on `id` + transitively all `requires[]`
 * (FT-8). Returns a new flag map; the set of ids that were newly enabled (excluding the
 * target) is `also` (drives the "also enabled: …" notice). Core deps are skipped (no
 * flag to set). Idempotent.
 */
export function resolveEnable(
    flags: Partial<Record<FeatureId, boolean>>,
    id: FeatureId,
): { flags: Partial<Record<FeatureId, boolean>>; also: FeatureId[] } {
    const next = { ...flags };
    const also: FeatureId[] = [];
    const seen = new Set<FeatureId>();
    const visit = (target: FeatureId, isRoot: boolean): void => {
        if (seen.has(target)) return; // cycle/diamond guard (acyclic by test, defensive)
        seen.add(target);
        const def = FEATURE_BY_ID[target];
        if (!def || def.core) return; // unknown or core → nothing to flip
        const wasOn = next[target] ?? def.defaultOn;
        next[target] = true;
        if (!isRoot && !wasOn) also.push(target);
        for (const dep of def.requires) visit(dep, false);
    };
    visit(id, true);
    return { flags: next, also };
}

/**
 * The currently-enabled features that DEPEND on `id` (transitively) — the cascade that
 * disabling `id` would break (FT-8). Used to build the confirm modal naming dependents.
 */
export function dependentsOf(settings: FeatureFlagsHost, id: FeatureId): FeatureId[] {
    const out = new Set<FeatureId>();
    const directDependents = (target: FeatureId): FeatureId[] =>
        FEATURE_REGISTRY.filter((f) => f.requires.includes(target)).map((f) => f.id);
    const visit = (target: FeatureId): void => {
        for (const dep of directDependents(target)) {
            if (out.has(dep)) continue;
            // Only report dependents that are actually enabled (a disabled one isn't "broken").
            if (isFeatureEnabled(settings, dep)) {
                out.add(dep);
                visit(dep);
            }
        }
    };
    visit(id);
    return [...out];
}

/**
 * Resolve the flag set after DISABLING `id`: turn off `id` + cascade-disable every
 * currently-enabled dependent (FT-8). Returns the new flag map + the cascaded ids.
 */
export function resolveDisable(
    settings: FeatureFlagsHost,
    id: FeatureId,
): { flags: Partial<Record<FeatureId, boolean>>; cascaded: FeatureId[] } {
    const def = FEATURE_BY_ID[id];
    // Core features are always-on (FT-6) — disabling one is not representable. Refuse at
    // the service boundary (defence in depth; the UI also locks the toggle) so a persisted
    // flag set can never encode `core: false`.
    if (!def || def.core) {
        return { flags: { ...settings.featureFlags }, cascaded: [] };
    }
    const cascaded = dependentsOf(settings, id);
    const next: Partial<Record<FeatureId, boolean>> = { ...settings.featureFlags };
    next[id] = false;
    for (const dep of cascaded) next[dep] = false;
    return { flags: next, cascaded };
}
