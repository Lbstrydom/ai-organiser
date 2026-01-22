/**
 * Migration Commands
 * Commands for migrating notes to Obsidian Bases format
 */

import { Notice, TFolder } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { MigrationModal } from '../ui/modals/MigrationModal';

/**
 * Register migration commands
 */
export function registerMigrationCommands(plugin: AIOrganiserPlugin) {
    // Command: Upgrade to Bases Metadata
    plugin.addCommand({
        id: 'upgrade-metadata',
        name: plugin.t.commands.upgradeToBases,
        icon: 'database',
        callback: () => {
            const modal = new MigrationModal(plugin.app, plugin);
            modal.open();
        }
    });
    
    // Command: Upgrade Folder to Bases Metadata
    plugin.addCommand({
        id: 'upgrade-folder-metadata',
        name: plugin.t.commands.upgradeFolderToBases,
        icon: 'folder-sync',
        callback: () => {
            const activeFile = plugin.app.workspace.getActiveFile();
            if (!activeFile) {
                new Notice(plugin.t.messages.noActiveFile);
                return;
            }
            
            // Get parent folder
            const folder = activeFile.parent;
            if (!folder) {
                new Notice(plugin.t.messages.noParentFolder);
                return;
            }
            
            const modal = new MigrationModal(plugin.app, plugin, folder);
            modal.open();
        }
    });
}
