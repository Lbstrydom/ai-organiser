/**
 * Settings-surface projection (unified-feature-taxonomy plan).
 *
 * The ONE place the Features settings menu's grouping algorithm lives. Both the settings
 * renderer (`FeaturesSettingsSection`) AND the cross-surface consistency test consume this
 * single pure function — the Core/Integrations/stage fold is never re-implemented, so the
 * two can't drift (M4).
 *
 * Returns STRUCTURE ONLY — no `t`, no label, no icon (keeps i18n/Lucide out of `services`,
 * R3-M1). The UI layer maps each group to its label + icon via
 * `ui/settings/featureStagePresentation.ts`.
 *
 * Group order (fixed): Core → WORKFLOW_STAGES order (capture, create, refine, find,
 * maintain) → Integrations last. Within a group, `defaultOn` features sort first, ties
 * broken by registry declaration order (stable — JS `Array.sort` is stable per spec).
 */

import type { FeatureDef } from '../core/features';
import type { WorkflowStage } from '../core/workflowStages';
import { WORKFLOW_STAGES, type FeatureBoundary } from '../core/workflowStages';

/**
 * A settings group — a discriminated union so invalid states are unrepresentable
 * (a `stage` group ALWAYS carries its stage; core/integrations never do — M8).
 */
export type SettingsGroup =
    | { groupKind: 'core'; features: FeatureDef[] }
    | { groupKind: 'integrations'; features: FeatureDef[] }
    | { groupKind: 'stage'; stage: WorkflowStage; features: FeatureDef[] };

export type SettingsGroupKind = SettingsGroup['groupKind'];

const EXTERNAL: FeatureBoundary = 'external-account';

/** A feature genuinely authenticates/transmits to a remote account (Integrations float). */
function isExternalAccount(f: FeatureDef): boolean {
    return (f.boundary ?? []).includes(EXTERNAL);
}

/** defaultOn-first, registry order otherwise (stable sort preserves declaration order for ties). */
function byEnableFriction(a: FeatureDef, b: FeatureDef): number {
    return Number(b.defaultOn) - Number(a.defaultOn);
}

/**
 * Project the registry into ordered settings groups: Core → stages → Integrations.
 * Core features render under Core (the flag wins over their `stage`); non-core
 * external-account features float to Integrations; everything else groups by `stage`.
 * Empty groups are omitted.
 */
export function projectSettingsGroups(registry: readonly FeatureDef[]): SettingsGroup[] {
    const groups: SettingsGroup[] = [];

    const core = registry.filter((f) => f.core);
    if (core.length > 0) groups.push({ groupKind: 'core', features: [...core] });

    for (const stage of WORKFLOW_STAGES) {
        const inStage = registry.filter((f) => !f.core && !isExternalAccount(f) && f.stage === stage);
        if (inStage.length > 0) {
            groups.push({ groupKind: 'stage', stage, features: [...inStage].sort(byEnableFriction) });
        }
    }

    const integrations = registry.filter((f) => !f.core && isExternalAccount(f));
    if (integrations.length > 0) {
        groups.push({ groupKind: 'integrations', features: [...integrations].sort(byEnableFriction) });
    }

    return groups;
}
