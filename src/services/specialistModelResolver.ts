/**
 * Specialist Model Resolver
 *
 * Single entry point for specialist paths (YouTube, PDF multimodal, PDF
 * translation, etc.) that construct their own HTTP requests bypassing
 * `CloudLLMService`. Without this, a setting like `latest-flash` —
 * introduced by the dynamic-model / latest-sentinel work — would be sent
 * as-is to the provider API and 400.
 *
 * Mirrors the resolution logic in the CloudLLMService constructor:
 *   live-fetched model catalog (if any) → static registry → passthrough.
 *
 * All specialist sites should import `resolveForProvider(providerId, modelId)`
 * from here, so when we add new `latest-*` tiers or new providers the logic
 * lives in one place.
 */

import { resolveSpecialistModel } from './adapters/modelCapabilities';
import { PROVIDER_MODELS } from './adapters/modelRegistry';
import { getCachedModels } from './adapters/dynamicModelService';
import type { AdapterType } from './adapters';
import type { ModelTier } from './chat/presentationTypes';

/**
 * Resolve a possibly-sentinel model id to a concrete one for the given
 * provider. Returns the input unchanged when it's already a concrete id,
 * when no provider match exists, or when the sentinel can't be resolved
 * (empty live cache + no matching registry entry).
 *
 * Safe to call on every request path — O(1) cache read + one registry
 * lookup. No network I/O.
 */
export function resolveForProvider(providerId: AdapterType, modelId: string): string {
    const liveCache = getCachedModels(providerId);
    const staticIds = Object.keys(PROVIDER_MODELS[providerId] || {})
        .filter(id => !id.startsWith('latest-'));
    return resolveSpecialistModel(providerId, modelId, {
        liveIds: liveCache ? liveCache.map(m => m.id) : null,
        staticIds,
    });
}

/**
 * Per-provider sentinel for the "fast" tier. Resolved via `resolveForProvider`
 * so the existing `latest-*` rotation tracking applies — no separate
 * configuration of fast-model identifiers (SSoT).
 *
 * Only providers with a matching `resolveLatestModel` case AND a registry
 * entry for the sentinel are listed here. Adding a new entry without both
 * sides of the contract would silently send the literal sentinel string to
 * the provider API and 400 (Gemini final-gate finding R5, 2026-04-25).
 *
 * Plan: docs/completed/slide-authoring-editing-backend.md §"Model tier dispatch"
 */
const FAST_TIER_SENTINELS: Partial<Record<AdapterType, string>> = {
    claude: 'latest-haiku',
    gemini: 'latest-flash',
    openai: 'latest-gpt-mini',
    // groq, mistral, deepseek, etc.: no `latest-*` resolver case yet —
    // omit so `resolveSlideTierModel('fast')` falls back to mainModel
    // rather than POSTing an unresolved sentinel.
};

/**
 * Resolve the model to use for slide generation given a tier choice and
 * the user's main configured model.
 *
 * - 'quality' → resolves `mainModel` through `resolveForProvider` so any
 *   `latest-*` sentinel in the user's settings (e.g. `latest-sonnet`) is
 *   normalised to the concrete model id, just like the fast path.
 * - 'fast'    → resolves the per-provider fast-tier sentinel; falls back
 *               to a resolved `mainModel` when no fast tier is defined for
 *               the provider.
 *
 * Edit-flow refinement should always pass `tier === 'quality'` so committing
 * changes goes through the user's main model, not the cheaper one.
 */
export function resolveSlideTierModel(
    providerId: AdapterType,
    tier: ModelTier,
    mainModel: string,
): string {
    if (tier === 'quality') {
        return resolveForProvider(providerId, mainModel);
    }
    const sentinel = FAST_TIER_SENTINELS[providerId];
    if (!sentinel) return resolveForProvider(providerId, mainModel);
    return resolveForProvider(providerId, sentinel);
}
