/**
 * Drive offload (F5): "Resume offload", the entry used by the Find embeds results, and the
 * once-per-load prompt that offers to finish an unfinished offload.
 *
 * Desktop only: the commands are not registered on mobile, and the offload needs the local
 * Google Drive for desktop folder.
 */
import { Notice, Platform, TFile } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { isFeatureEnabled } from '../services/featureService';
import { OffloadPlanModal } from '../ui/modals/OffloadPlanModal';
import { ConfirmationModal } from '../ui/modals/ConfirmationModal';
import { isOffloadAvailable, journalStore } from '../services/offload/offloadRuntime';
import { describeError, formatGuidance } from '../core/friendlyErrors';
import { logger } from '../utils/logger';

/** Open the plan for one file. */
export function openOffloadForFile(plugin: AIOrganiserPlugin, file: TFile): void {
    if (!isOffloadAvailable(plugin)) {
        new Notice(plugin.t.offload.unavailable, 8000);
        return;
    }
    new OffloadPlanModal(plugin.app, plugin, { kind: 'file', file }).open();
}

/** Open the oldest unfinished offload. */
export async function resumeOffload(plugin: AIOrganiserPlugin): Promise<void> {
    const open = await journalStore(plugin).unfinished();
    if (!open.ok) {
        new Notice(formatGuidance(describeError(plugin.t, open.error)), 8000);
        return;
    }
    if (open.value.length === 0) {
        new Notice(plugin.t.offload.nothingToResume, 5000);
        return;
    }
    const oldest = [...open.value].sort((a, b) => (a.copy.createdAt < b.copy.createdAt ? -1 : 1))[0];
    new OffloadPlanModal(plugin.app, plugin, { kind: 'resume', record: oldest }).open();
}

/** After the workspace is ready: if an offload was left unfinished, offer to open it. Never blocks start-up. */
export function promptUnfinishedOffload(plugin: AIOrganiserPlugin): void {
    if (!Platform.isDesktopApp || !isFeatureEnabled(plugin.settings, 'cloud-offload')) return;
    plugin.app.workspace.onLayoutReady(() => {
        void (async () => {
            try {
                const open = await journalStore(plugin).unfinished();
                if (!open.ok || open.value.length === 0) return;
                new ConfirmationModal(plugin.app, plugin.t.offload.resumeTitle, plugin.t.offload.promptUnfinished, () => { void resumeOffload(plugin); }, plugin).open();
            } catch (e) {
                logger.warn('Offload', 'Could not check for unfinished offloads', e);
            }
        })();
    });
}

export function registerOffloadCommands(plugin: AIOrganiserPlugin): void {
    if (!Platform.isDesktopApp) return;
    plugin.addCommand({
        id: 'resume-offload',
        name: plugin.t.commands.resumeOffload,
        icon: 'cloud-upload',
        callback: () => { void resumeOffload(plugin); },
    });
}
