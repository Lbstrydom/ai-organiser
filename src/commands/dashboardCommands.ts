/**
 * Dashboard Commands
 * Commands for creating Obsidian Bases dashboards
 */

import { actionName } from '../core/actionRegistry';
import { TFolder } from 'obsidian';
import { addMenuProvider } from '../ui/pluginMenu';
import type AIOrganiserPlugin from '../main';
import { DashboardCreationModal } from '../ui/modals/DashboardCreationModal';

/**
 * Register dashboard commands
 */
export function registerDashboardCommands(plugin: AIOrganiserPlugin) {
    // Command: Create Bases Dashboard (uses current file's folder or root)
    plugin.addCommand({
        id: 'create-bases-dashboard',
        name: actionName(plugin.t, 'create-bases-dashboard'),
        icon: 'layout-dashboard',
        callback: () => {
            // Get current file's folder, or root if no file open
            const activeFile = plugin.app.workspace.getActiveFile();
            let targetFolder: TFolder;

            if (activeFile) {
                const parent = activeFile.parent;
                targetFolder = parent || plugin.app.vault.getRoot();
            } else {
                targetFolder = plugin.app.vault.getRoot();
            }

            const modal = new DashboardCreationModal(plugin.app, plugin, targetFolder);
            modal.open();
        }
    });

    // Right-click on a folder: a contribution to the AI Organiser section.
    addMenuProvider(plugin, (target) => {
        if (target.kind !== 'folder') return [];
        const folder = target.folder;
        return [{
            id: 'create-bases-dashboard',
            title: plugin.t.commands.createBasesDashboardHere || actionName(plugin.t, 'create-bases-dashboard'),
            icon: 'layout-dashboard',
            priority: 'ranked',
            run: () => new DashboardCreationModal(plugin.app, plugin, folder).open(),
        }];
    });
}
