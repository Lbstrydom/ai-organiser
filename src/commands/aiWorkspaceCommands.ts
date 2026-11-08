import { openSettingsSection } from '../utils/noticeUtils';
/**
 * AI workspace commands: edit a project's workspace, copy its instructions, create its context pack. Registered only while
 * `ai-workspaces` is enabled. Each one that shares text goes through the preview: nothing is copied or written before the
 * person confirms the exact notes.
 */
import { actionName } from '../core/actionRegistry';
import { Notice, TFile } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { describeError, formatGuidance } from '../core/friendlyErrors';
import { getProjectService } from '../services/projects/projectService';
import type { ProjectRef } from '../services/projects/projectIndex';
import { handbackActive, prepareHandback } from '../services/aiWorkspaces/handbackService';
import { review } from './inboxSweepCommands';
import { HandbackReviewModal } from '../ui/modals/HandbackReviewModal';
import { confirmInstructions, confirmPack, preparePack } from '../services/aiWorkspaces/workspaceService';
import { AiWorkspaceModal } from '../ui/modals/AiWorkspaceModal';
import { SharePreviewModal } from '../ui/modals/SharePreviewModal';
import { openLiveReview, outcomeMessage } from '../ui/modals/LivePackReviewModal';
import { ProjectPickerModal } from '../ui/components/ProjectPicker';
import { logger } from '../utils/logger';

const guidance = (plugin: AIOrganiserPlugin, code: string): void => {
    new Notice(formatGuidance(describeError(plugin.t, code)), 9000);
};

/** The active note if it is an adopted project, else a picker. */
function chooseProject(plugin: AIOrganiserPlugin, then: (project: ProjectRef) => void): void {
    const service = getProjectService(plugin);
    if (!service) { guidance(plugin, 'unknown'); return; }
    const index = service.index();
    const active = plugin.app.workspace.getActiveFile();
    const here = active ? index.projects.find((p) => p.notePath === active.path && !index.duplicates.has(p.aioId)) : undefined;
    if (here) { then(here); return; }
    new ProjectPickerModal(plugin.app, {
        plugin,
        projects: index.projects.filter((p) => !index.duplicates.has(p.aioId)),
        duplicateCount: index.duplicates.size,
        unadoptedCount: index.unadopted.length,
        onChoose: then,
    }).open();
}

async function share(plugin: AIOrganiserPlugin, project: ProjectRef, mode: 'pack' | 'copy'): Promise<void> {
    const prepared = await preparePack(plugin, project.aioId);
    if (!prepared.ok) { guidance(plugin, prepared.error); return; }
    new SharePreviewModal(plugin.app, plugin, prepared.value, mode, () => {
        void (async () => {
            try {
                if (mode === 'pack') {
                    const res = await confirmPack(plugin, prepared.value);
                    if (res.ok) new Notice(plugin.t.aiWorkspaces.packCreatedNotice.replace('{path}', res.value.path), 8000);
                    else guidance(plugin, res.error);
                } else {
                    const res = await confirmInstructions(plugin, prepared.value);
                    if (!res.ok) { guidance(plugin, res.error); return; }
                    await navigator.clipboard.writeText(res.value);
                    new Notice(plugin.t.aiWorkspaces.instructionsCopiedNotice, 6000);
                }
            } catch (e) {
                logger.error('AiWorkspaces', 'Sharing failed', e);
                guidance(plugin, 'unknown');
            }
        })();
    }).open();
}

/** Refresh now; a paused live pack opens its review instead (the person decides what may be shared). */
async function refreshLive(plugin: AIOrganiserPlugin, project: ProjectRef): Promise<void> {
    const service = plugin.livePacks?.service;
    if (!service) { guidance(plugin, 'live-desktop-only'); return; }
    try {
        const res = await service.refresh(project.aioId, { force: true });
        if (!res.ok) { guidance(plugin, res.error); return; }
        if (res.value.kind === 'needs-review') { await openLiveReview(plugin, project.aioId); return; }
        new Notice(outcomeMessage(plugin, res.value), 6000);
    } catch (e) {
        logger.error('AiWorkspaces', 'Live pack refresh failed', e);
        guidance(plugin, 'unknown');
    }
}

/** Read a note as a hand-back and open its review. Used by the command and by the Process view. */
export async function openHandbackReview(plugin: AIOrganiserPlugin, file: TFile): Promise<void> {
    const prepared = await prepareHandback(plugin, file);
    if (!prepared.ok) { guidance(plugin, prepared.error); return; }
    if (prepared.value.parse.status === 'malformed' && prepared.value.parse.reasons.includes('no-section')) { new Notice(plugin.t.handback.noHandoffHere, 6000); return; }
    new HandbackReviewModal(plugin.app, plugin, prepared.value, (notes, contexts, projectId) => review(plugin, notes, contexts, projectId)).open();
}

export function registerAiWorkspaceCommands(plugin: AIOrganiserPlugin): void {
    const t = plugin.t;
    // The hand-back review also needs the capture inbox (its gate is both features); with either off the command does not exist.
    if (handbackActive(plugin)) {
        plugin.addCommand({
            id: 'review-ai-handback',
            name: actionName(t, 'review-ai-handback'),
            icon: 'inbox',
            callback: () => {
                const file = plugin.app.workspace.getActiveFile();
                if (!file || file.extension !== 'md') { new Notice(t.handback.openNoteFirst, 5000); return; }
                void openHandbackReview(plugin, file);
            },
        });
    }
    plugin.addCommand({
        id: 'open-ai-workspaces-settings',
        name: actionName(plugin.t, 'open-ai-workspaces-settings'),
        icon: 'settings',
        callback: () => openSettingsSection(plugin, 'integrations', 'sub-ai-workspaces'),
    });
    plugin.addCommand({
        id: 'edit-ai-workspace',
        name: actionName(t, 'edit-ai-workspace'),
        icon: 'messages-square',
        callback: () => chooseProject(plugin, (project) => new AiWorkspaceModal(plugin.app, plugin, project.aioId).open()),
    });
    plugin.addCommand({
        id: 'copy-ai-instructions',
        name: actionName(t, 'copy-ai-instructions'),
        icon: 'clipboard-copy',
        callback: () => chooseProject(plugin, (project) => { void share(plugin, project, 'copy'); }),
    });
    // Desktop only: the live pack is written by a computer with Google Drive for desktop.
    if (plugin.livePacks) {
        plugin.addCommand({
            id: 'refresh-ai-live-pack',
            name: actionName(t, 'refresh-ai-live-pack'),
            icon: 'refresh-cw',
            callback: () => chooseProject(plugin, (project) => { void refreshLive(plugin, project); }),
        });
    }
    plugin.addCommand({
        id: 'create-ai-context-pack',
        name: actionName(t, 'create-ai-context-pack'),
        icon: 'package',
        callback: () => chooseProject(plugin, (project) => { void share(plugin, project, 'pack'); }),
    });
}
