/**
 * AI workspace commands: edit a project's workspace, copy its instructions, create its context pack. Registered only while
 * `ai-workspaces` is enabled. Each one that shares text goes through the preview: nothing is copied or written before the
 * person confirms the exact notes.
 */
import { Notice } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { describeError, formatGuidance } from '../core/friendlyErrors';
import { getProjectService } from '../services/projects/projectService';
import type { ProjectRef } from '../services/projects/projectIndex';
import { confirmInstructions, confirmPack, preparePack } from '../services/aiWorkspaces/workspaceService';
import { AiWorkspaceModal } from '../ui/modals/AiWorkspaceModal';
import { SharePreviewModal } from '../ui/modals/SharePreviewModal';
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

export function registerAiWorkspaceCommands(plugin: AIOrganiserPlugin): void {
    const t = plugin.t;
    plugin.addCommand({
        id: 'edit-ai-workspace',
        name: t.commands.editAiWorkspace,
        icon: 'messages-square',
        callback: () => chooseProject(plugin, (project) => new AiWorkspaceModal(plugin.app, plugin, project.aioId).open()),
    });
    plugin.addCommand({
        id: 'copy-ai-instructions',
        name: t.commands.copyAiInstructions,
        icon: 'clipboard-copy',
        callback: () => chooseProject(plugin, (project) => { void share(plugin, project, 'copy'); }),
    });
    plugin.addCommand({
        id: 'create-ai-context-pack',
        name: t.commands.createContextPack,
        icon: 'package',
        callback: () => chooseProject(plugin, (project) => { void share(plugin, project, 'pack'); }),
    });
}
