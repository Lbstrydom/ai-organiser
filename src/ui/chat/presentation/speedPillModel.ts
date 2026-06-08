/**
 * Speed-pill → storyboard-generator model mapping (presentation-depth-controls D5).
 *
 * Pure resolver for the storyboard GENERATOR's effective per-call `modelOverride`.
 * Priority:
 *   1. an explicit `storyboard_generator` role override WINS (same-provider model swap);
 *   2. otherwise the Speed pill upgrades the MAIN provider — Deep=Opus, Fast=your main model.
 *
 * The pill applies ONLY when the generator runs on the MAIN context: a cross-provider
 * role keeps its own baked model (so we never send a main-provider Opus id to a
 * different provider's service), and a local provider gets no Opus upgrade. Non-Claude
 * mains resolve to '' (Fast=main always works; Deep degrades gracefully — `resolveDepthModel`
 * returns '' for non-Claude). The critic is unaffected — it is resolved separately and
 * never receives this override.
 */

import type { AdapterType } from '../../../services/adapters';
import { computeAvailableModelIds } from '../../../services/cloudService';
import { resolveDepthModel } from '../../../core/modelCatalog';
import type { ModelTier } from '../../../services/chat/presentationTypes';

export function resolveStoryboardModelOverride(params: {
    /** `gen.modelOverride` from `resolveRoleRun` — a same-provider role override. */
    roleOverride: string;
    /** `gen.context === r.llmCtx` — false for a cross-provider specialist role. */
    isMainContext: boolean;
    /** `settings.serviceType === 'local'` — no Opus upgrade for local providers. */
    isLocal: boolean;
    /** The MAIN provider (`settings.cloudServiceType`) the pill upgrades. */
    adapterType: AdapterType;
    /** The deck's Speed pill (`creationConfig.speedTier`). */
    speedTier: ModelTier;
}): string {
    if (params.roleOverride) return params.roleOverride;   // explicit role override wins over the pill
    if (!params.isMainContext) return '';                  // cross-provider role keeps its baked model
    if (params.isLocal) return '';                         // local provider — no Opus upgrade
    return resolveDepthModel({
        adapterType: params.adapterType,
        tier: params.speedTier,
        availableIds: computeAvailableModelIds(params.adapterType),
    });
}
