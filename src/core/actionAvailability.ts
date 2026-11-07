/**
 * Whether an action can run here and now, and if not, why (docs/plans/navigation-discoverability.md,
 * decision 2). Availability is kept apart from setup: a feature that is off, a desktop-only
 * command on a phone, a missing note and an unfinished setup are different states with
 * different remedies.
 *
 * Pure. Feature gating is delegated to the caller's `isEnabled` (which is `isFeatureEnabled`
 * in the plugin), so nothing here re-implements the feature rules; requirement, setup and key
 * checks are also supplied by the caller, so this module reads no plugin state.
 */
import type { FeatureId } from './features';
import type { ActionDef, RequirementKind } from './actionRegistry';

export type AvailabilityState = 'ready' | 'desktop-only' | 'feature-off' | 'needs-setup' | 'missing-key' | 'wrong-target';

/** Precedence: the first state that applies wins. Platform first, since no remedy exists on this device. */
export const AVAILABILITY_PRECEDENCE: readonly Exclude<AvailabilityState, 'ready'>[] = Object.freeze([
    'desktop-only', 'feature-off', 'needs-setup', 'missing-key', 'wrong-target',
]);

export interface Availability {
    readonly state: AvailabilityState;
    /** Every unmet condition, in precedence order. Empty when ready. */
    readonly reasons: readonly Exclude<AvailabilityState, 'ready'>[];
}

export interface AvailabilityContext {
    isEnabled: (feature: FeatureId) => boolean;
    isMobile: boolean;
    /** Is the action's `requires` met for the current target? */
    requirementMet: (requires: RequirementKind) => boolean;
    /** False when the action's feature still needs setup; undefined = no check known (treated as done). */
    isSetupDone?: (def: ActionDef) => boolean | undefined;
    /** False when a provider key the action needs is missing; undefined = no check known. */
    hasKey?: (def: ActionDef) => boolean | undefined;
}

/** The feature half of availability, shared with the picker's feature filter. */
export function actionFeatureOn(
    def: { feature?: FeatureId; anyOfFeatures?: readonly FeatureId[]; alsoRequiresFeatures?: readonly FeatureId[] },
    isEnabled: (feature: FeatureId) => boolean,
): boolean {
    if (def.feature === undefined) return false; // fail closed: an untagged action never shows
    const owned = def.anyOfFeatures ? def.anyOfFeatures.some(isEnabled) : isEnabled(def.feature);
    return owned && (def.alsoRequiresFeatures ?? []).every(isEnabled);
}

export function actionAvailability(def: ActionDef, ctx: AvailabilityContext): Availability {
    const unmet = new Set<Exclude<AvailabilityState, 'ready'>>();
    if (def.platform === 'desktop' && ctx.isMobile) unmet.add('desktop-only');
    const featureOn = actionFeatureOn(def, ctx.isEnabled);
    if (!featureOn) unmet.add('feature-off');
    // Setup and keys belong to a feature that is on; asking about them for an off feature
    // would report a remedy the user cannot reach yet.
    if (featureOn && ctx.isSetupDone?.(def) === false) unmet.add('needs-setup');
    if (featureOn && ctx.hasKey?.(def) === false) unmet.add('missing-key');
    if (!ctx.requirementMet(def.requires)) unmet.add('wrong-target');
    const reasons = AVAILABILITY_PRECEDENCE.filter((s) => unmet.has(s));
    return { state: reasons[0] ?? 'ready', reasons };
}
