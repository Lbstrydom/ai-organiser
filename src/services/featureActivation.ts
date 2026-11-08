/**
 * Turning a feature on from the picker (docs/plans/navigation-discoverability.md, decision 3).
 *
 *   planActivation   (pure)  what turning `feature` on would do: the new flags, the features
 *                            also turned on, the actions it adds, the setup it needs, and
 *                            whether it can run on this device.
 *   applyActivation          ONE settings write holding the new flags and the resume intent,
 *                            reverted in memory if the write fails; then the reload.
 *   consumePendingResume (pure) what to offer after the reload, and always clears the intent.
 *
 * Nothing here runs an action: after the reload the user is offered "Continue: <action>".
 */
import { ACTION_BY_ID, ACTIONS, type ActionDef } from '../core/actionRegistry';
import { FEATURE_BY_ID, type FeatureId } from '../core/features';
import { err, ok, type Result } from '../core/result';
import { RESUME_MAX_AGE_MS, type ResumeIntent } from '../core/resumeIntent';
import type { StoredTarget } from '../core/actionTarget';
import type { Availability } from '../core/actionAvailability';
import { resolveEnable } from './featureService';

export type FeatureFlags = Partial<Record<FeatureId, boolean>>;

export interface ActivationPlan {
    readonly feature: FeatureId;
    readonly flags: FeatureFlags;
    /** Features turned on as well, because `feature` needs them. Never silent. */
    readonly also: readonly FeatureId[];
    /** Every action the feature (and the also-features) adds. */
    readonly adds: readonly ActionDef[];
    /** The feature's own "Set up …" actions, to run after the reload. */
    readonly setup: readonly ActionDef[];
    /** Set when the feature cannot run on this device; the modal then offers no "Turn on". */
    readonly blocked?: 'desktop-only';
}

/** Every action of `feature` is desktop-only: on a phone there is nothing to turn on. */
function desktopOnlyFeature(feature: FeatureId): boolean {
    const own = ACTIONS.filter((a) => a.feature === feature);
    return own.length > 0 && own.every((a) => a.platform === 'desktop');
}

export function planActivation(flags: FeatureFlags, feature: FeatureId, isMobile: boolean): ActivationPlan {
    const resolved = resolveEnable(flags, feature);
    const featureSet = new Set<FeatureId>([feature, ...resolved.also]);
    const adds = ACTIONS.filter((a) => featureSet.has(a.feature));
    const setup = ACTIONS.filter((a) => a.feature === feature && a.kind === 'setup');
    return {
        feature,
        flags: resolved.flags,
        also: resolved.also,
        adds,
        setup,
        ...(isMobile && desktopOnlyFeature(feature) ? { blocked: 'desktop-only' as const } : {}),
    };
}

/** The feature that must be on for an action to show (its owner, or the first of an OR gate). */
export function featureToActivate(actionId: string): FeatureId | null {
    const def = ACTION_BY_ID.get(actionId);
    if (!def) return null;
    return def.feature;
}

/** The slice of the plugin applyActivation needs; a test passes a fake. */
export interface ActivationHost {
    settings: { featureFlags: FeatureFlags; pendingResume?: ResumeIntent };
    saveSettings(): Promise<void>;
}

/**
 * Write the flags and the intent together. The flags are resolved again from the settings as
 * they are NOW (a toggle made while the window was open is kept, never overwritten by the
 * snapshot the window showed). On a failed write both are restored in memory and `save-failed`
 * is returned: nothing reloads, nothing is half-saved.
 */
const activating = new WeakSet<object>();

export async function applyActivation(host: ActivationHost, plan: ActivationPlan, intent?: ResumeIntent): Promise<Result<'saved'>> {
    if (plan.blocked) return err('blocked');
    // Single-flight: a second activation while one is saving is refused, so two rollbacks can
    // never interleave and undo each other.
    if (activating.has(host)) return err('busy');
    activating.add(host);
    const prevFlags = { ...host.settings.featureFlags };
    const prevIntent = host.settings.pendingResume;
    const written = { ...resolveEnable(prevFlags, plan.feature).flags };
    host.settings.featureFlags = written;
    if (intent) host.settings.pendingResume = intent;
    else delete host.settings.pendingResume;
    try {
        await host.saveSettings();
        return ok('saved');
    } catch {
        // Restore only if nothing replaced our write meanwhile (identity, not equality).
        if (host.settings.featureFlags === written && host.settings.pendingResume === intent) {
            host.settings.featureFlags = prevFlags;
            if (prevIntent) host.settings.pendingResume = prevIntent;
            else delete host.settings.pendingResume;
        }
        return err('save-failed');
    } finally {
        activating.delete(host);
    }
}

export type ResumeOffer =
    | { readonly kind: 'none' }
    | { readonly kind: 'continue'; readonly commandId: string; readonly feature: FeatureId; readonly target?: StoredTarget }
    | { readonly kind: 'not-ready'; readonly commandId: string; readonly feature: FeatureId; readonly reason: Exclude<Availability['state'], 'ready'> }
    | { readonly kind: 'job'; readonly jobId: string };

export interface ResumeContext {
    now: number;
    availabilityOf: (def: ActionDef) => Availability;
    /** Does a stored target path still exist? */
    pathExists: (path: string) => boolean;
}

/**
 * Decide what to offer for a stored intent. The caller clears the intent BEFORE showing the
 * offer (one-shot), whatever this returns.
 */
export function consumePendingResume(intent: ResumeIntent | undefined, ctx: ResumeContext): ResumeOffer {
    if (!intent) return { kind: 'none' };
    if (ctx.now - intent.createdAt > RESUME_MAX_AGE_MS || intent.createdAt > ctx.now) return { kind: 'none' };
    if (intent.kind === 'job') return { kind: 'job', jobId: intent.jobId };
    const def = ACTION_BY_ID.get(intent.commandId);
    if (!def) return { kind: 'none' };
    if (intent.target && !ctx.pathExists(intent.target.path)) return { kind: 'none' };
    const availability = ctx.availabilityOf(def);
    if (availability.state === 'ready') {
        return { kind: 'continue', commandId: def.id, feature: def.feature, ...(intent.target ? { target: intent.target } : {}) };
    }
    return { kind: 'not-ready', commandId: def.id, feature: def.feature, reason: availability.state };
}

/** The label a feature is known by, for messages. */
export function featureExists(id: string): id is FeatureId {
    return id in FEATURE_BY_ID;
}
