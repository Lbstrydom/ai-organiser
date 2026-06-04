/**
 * featureActions — one shared seam for gating in-app modal action lists (FT-13).
 *
 * Beyond the six primary gating sites, several modals render *static action lists*
 * that launch features: the chat **mode list** (research/presentation/highlight), the
 * `EnhanceNoteModal` action menu (Diagram→`mermaid-chat`, Resources→`research`,
 * Flashcards→`flashcards`), and similar. Rather than enumerate every one (an
 * open-ended, coherence-eroding list), each action descriptor carries an optional
 * `feature?: FeatureId` and every in-app action list is filtered through this ONE
 * helper. An action with no `feature` is always kept (core / host action).
 *
 * Pure: depends only on the registry-backed `isFeatureEnabled`. New action lists adopt
 * the helper by convention (see `src/ui/modals/_conventions.md`).
 */

import type { FeatureId } from '../../core/features';
import { isFeatureEnabled, type FeatureFlagsHost } from '../../services/featureService';

/** Any action descriptor that may declare an owning feature. */
export interface FeatureGatedAction {
    /** Owning feature — when set, the action is dropped if the feature is disabled. */
    feature?: FeatureId;
}

/**
 * Drop actions whose owning feature is disabled. Actions without a `feature` are
 * always retained (a core/host action, e.g. "Improve note", that has no toggle).
 * Returns a new array — does not mutate the input.
 */
export function filterEnabledActions<T extends FeatureGatedAction>(
    actions: readonly T[],
    settings: FeatureFlagsHost,
): T[] {
    return actions.filter((a) => !a.feature || isFeatureEnabled(settings, a.feature));
}
