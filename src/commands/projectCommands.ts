/**
 * Project commands: adopt a note as a project (one reviewed edit) and open a project through the shared picker.
 * Registered only while a project consumer is enabled (see `projectServiceActive`), so with none enabled nothing is added.
 */
import { Notice, TFile } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { describeError, formatGuidance } from '../core/friendlyErrors';
import { getProjectService } from '../services/projects/projectService';
import { ProjectPickerModal } from '../ui/components/ProjectPicker';

const guidance = (plugin: AIOrganiserPlugin, code: string): void => {
    new Notice(formatGuidance(describeError(plugin.t, code)), 9000);
};

export function registerProjectCommands(plugin: AIOrganiserPlugin): void {
    const t = plugin.t;
    plugin.addCommand({
        id: 'adopt-project',
        name: t.commands.adoptProject,
        icon: 'folder-kanban',
        callback: () => {
            const service = getProjectService(plugin);
            const file = plugin.app.workspace.getActiveFile();
            if (!service) { guidance(plugin, 'unknown'); return; }
            if (!file || file.extension !== 'md') { new Notice(t.projects.noActiveNote, 5000); return; }
            void service.adoptProject(file.path).then((res) => {
                if (res.ok) new Notice(t.projects.adoptedNotice.replace('{path}', res.value.notePath), 6000);
                // A reviewer who declines the edit is not an error to shout about.
                else if (res.error !== 'rejected') guidance(plugin, res.error);
            });
        },
    });
    plugin.addCommand({
        id: 'open-project',
        name: t.commands.openProject,
        icon: 'folder-open',
        callback: () => {
            const service = getProjectService(plugin);
            if (!service) { guidance(plugin, 'unknown'); return; }
            const index = service.index();
            new ProjectPickerModal(plugin.app, {
                plugin,
                projects: index.projects.filter((p) => !index.duplicates.has(p.aioId)),
                duplicateCount: index.duplicates.size,
                unadoptedCount: index.unadopted.length,
                onChoose: (project) => {
                    const target = plugin.app.vault.getAbstractFileByPath(project.notePath);
                    if (target instanceof TFile) void plugin.app.workspace.getLeaf(false).openFile(target);
                },
            }).open();
        },
    });
}
