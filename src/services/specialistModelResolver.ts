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
