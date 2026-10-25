/**
 * Settings -> capture configuration, the run precondition, and the pieces that depend on the shared
 * inbox settings. The inbox folders and what is kept out are the SWEEP's settings: one inbox, one
 * privacy policy. Everything here works with the inbox sweep switched off.
 */
import { getPluginManagedFolders, type AIOrganiserSettings } from '../../core/settings';
import { normalisePath, rewriteOnRename } from '../../core/protectedPaths';
import { propertiesAreReadable } from '../inboxSweep/sweepGuard';
import { validateCaptureSetup } from './capturePolicy';
import type { CaptureConfig } from './captureTypes';

type SettingsSlice = Pick<
    AIOrganiserSettings,
    | 'sweepInboxFolders' | 'captureDestinationRoot' | 'captureSince' | 'captureOnOpen' | 'captureOnOpenMaxPerRun' | 'captureMaxPerRun'
    | 'captureMaxAttachmentMB' | 'captureMinWords' | 'captureDigitiseImages' | 'captureMaxImagesPerCapture' | 'captureMaxTextChars'
    | 'captureStabilitySeconds' | 'captureRequireMarker'
>;

export function readCaptureConfig(s: SettingsSlice): CaptureConfig {
    return {
        inboxFolders: s.sweepInboxFolders,
        destinationRoot: s.captureDestinationRoot,
        since: s.captureSince,
        onOpen: s.captureOnOpen,
        onOpenMaxPerRun: s.captureOnOpenMaxPerRun,
        maxPerRun: s.captureMaxPerRun,
        maxAttachmentBytes: s.captureMaxAttachmentMB * 1024 * 1024,
        minWords: s.captureMinWords,
        digitiseImages: s.captureDigitiseImages,
        maxImagesPerCapture: s.captureMaxImagesPerCapture,
        maxTextChars: s.captureMaxTextChars,
        stabilityMs: s.captureStabilitySeconds * 1000,
        requireMarker: s.captureRequireMarker,
    };
}

/**
 * Folders the plugin itself writes into (never an inbox, never a destination for organised notes):
 * the managed output folders plus the sweep report, the upkeep report folder and the agent index.
 */
export function captureOutputRoots(s: Pick<AIOrganiserSettings, 'sweepReportPath' | 'upkeepReportFolder' | 'agentIndexOutputPath'> & Parameters<typeof getPluginManagedFolders>[0]): string[] {
    const parent = (path: string): string => normalisePath(path).split('/').slice(0, -1).join('/');
    return [
        ...getPluginManagedFolders(s),
        s.sweepReportPath,
        s.upkeepReportFolder,
        parent(s.agentIndexOutputPath),
    ].filter((p) => normalisePath(p) !== '');
}

type BlockerSettings = Pick<AIOrganiserSettings, 'sweepInboxFolders' | 'sweepExcludedFolders' | 'sweepExcludedTags' | 'sweepExcludedProperties' | 'sweepExcludedTerms' | 'sweepNothingToExclude' | 'captureDestinationRoot' | 'protectedFolders' | 'sweepReportPath' | 'upkeepReportFolder' | 'agentIndexOutputPath'> & Parameters<typeof getPluginManagedFolders>[0];

/**
 * A stable code for the first thing missing, or null when a run may start. Fails closed. It repeats the
 * sweep's rule for the SHARED settings (the sweep's own blocker only exists when the sweep is on) and
 * adds the capture-only rules.
 */
export function captureBlocker(s: BlockerSettings, hasProvider: boolean): string | null {
    if (s.sweepInboxFolders.length === 0) return 'capture-no-folders';
    const anyExclusion = s.sweepExcludedFolders.length + s.sweepExcludedTags.length + s.sweepExcludedProperties.length + s.sweepExcludedTerms.length > 0;
    if (!anyExclusion && !s.sweepNothingToExclude) return 'capture-keepout-required';
    if (!propertiesAreReadable(s.sweepExcludedProperties)) return 'sweep-property-invalid';
    const problems = validateCaptureSetup(s.sweepInboxFolders, s.captureDestinationRoot, s.protectedFolders, captureOutputRoots(s), s.sweepExcludedFolders);
    if (problems.some((p) => p.code === 'inbox-protected' || p.code === 'inbox-output-root')) return 'capture-inbox-invalid';
    if (problems.some((p) => p.code.startsWith('destination-'))) return 'capture-destination-refused';
    if (!hasProvider) return 'capture-no-provider';
    return null;
}

/**
 * True once the user has deliberately started using the capture inbox: the guided setup was finished, or a manual run was confirmed.
 * Turning the feature on is not that. Until then the capture inbox neither watches the inbox in the background nor holds any note
 * back from the sweep, so enabling the feature changes nothing the user did not choose.
 */
export function captureSetupConfirmed(s: Pick<AIOrganiserSettings, 'featureSetupCompletedAt' | 'captureConfirmedAt'>): boolean {
    return !!s.featureSetupCompletedAt?.['capture-inbox'] || !!s.captureConfirmedAt;
}

export interface SharedScopePatch {
    sweepInboxFolders: string[];
    sweepExcludedFolders: string[];
    captureDestinationRoot: string;
    changed: boolean;
}

/**
 * The folder settings after `oldPath` was renamed or moved to `newPath`. Idempotent: applying it
 * again for the same rename changes nothing, so it is safe next to the sweep's own rename tracking
 * (which runs only when the sweep is on).
 */
export function remapSharedScope(
    s: Pick<AIOrganiserSettings, 'sweepInboxFolders' | 'sweepExcludedFolders' | 'captureDestinationRoot'>,
    oldPath: string,
    newPath: string,
): SharedScopePatch {
    const inbox = rewriteOnRename(s.sweepInboxFolders, oldPath, newPath);
    const excluded = rewriteOnRename(s.sweepExcludedFolders, oldPath, newPath);
    const dest = rewriteOnRename([s.captureDestinationRoot], oldPath, newPath);
    return {
        sweepInboxFolders: inbox.list,
        sweepExcludedFolders: excluded.list,
        captureDestinationRoot: dest.list[0],
        changed: inbox.changed || excluded.changed || dest.changed,
    };
}
