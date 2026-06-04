/**
 * Presentation map for settings-feature groups (unified-feature-taxonomy plan, R3-M1).
 *
 * Lucide icon names + i18n label resolution for the groups `projectSettingsGroups` emits.
 * Lives in `ui` (not neutral `core`/`services`) so Lucide/i18n coupling stays out of the
 * pure layers. The settings renderer and (label only) the consistency test use these.
 */

import type { WorkflowStage } from '../../core/workflowStages';
import type { SettingsGroup } from '../../services/featureProjection';
import type { Translations } from '../../i18n/types';

/** Lucide icon per workflow stage (UX §6 — common-region grouping). */
export const STAGE_ICON: Record<WorkflowStage, string> = {
    capture: 'inbox',
    create: 'sparkles',
    refine: 'wand-2',
    find: 'search',
    maintain: 'wrench',
};

const CORE_ICON = 'lock';
const INTEGRATIONS_ICON = 'puzzle';

/** Lucide icon for a settings group. */
export function settingsGroupIcon(group: SettingsGroup): string {
    if (group.groupKind === 'core') return CORE_ICON;
    if (group.groupKind === 'integrations') return INTEGRATIONS_ICON;
    return STAGE_ICON[group.stage];
}

/** i18n label for a settings group — stage groups share `t.workflowStages.*` with the picker. */
export function settingsGroupLabel(group: SettingsGroup, t: Translations): string {
    if (group.groupKind === 'core') return t.features.clusters.core;
    if (group.groupKind === 'integrations') return t.features.clusters.integrations;
    return t.workflowStages[group.stage];
}
