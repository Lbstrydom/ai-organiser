/**
 * Dashboard Commands
 * Commands for creating Obsidian Bases dashboards
 */

import { TFolder, Menu } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { DashboardCreationModal } from '../ui/modals/DashboardCreationModal';

/**
 * Register dashboard commands
 */
export function registerDashboardCommands(plugin: AIOrganiserPlugin) {
    // Command: Create Bases Dashboard (uses current file's folder or root)
    plugin.addCommand({
        id: 'create-bases-dashboard',
        name: plugin.t.commands.createBasesDashboard,
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

    // Register folder context menu
    plugin.registerEvent(
        plugin.app.workspace.on('file-menu', (menu: Menu, file, _source) => {
            // Only show for folders
            if (!(file instanceof TFolder)) {
                return;
            }

            menu.addItem((item) => {
                const title = plugin.basesService.isBasesEnabled() 
                    ? (plugin.t.commands.createBasesDashboardHere || 'Create Bases Dashboard')
                    : 'Create Dashboard (Bases Recommended)';
                    
                item
                    .setTitle(title)
                    .setIcon('layout-dashboard')
                    .onClick(() => {
                        const modal = new DashboardCreationModal(plugin.app, plugin, file);
                        modal.open();
                    });
            });
        })
    );
}
