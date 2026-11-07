/**
 * Migration Commands
 * Commands for migrating notes to Obsidian Bases format
 */

import { Notice } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { MigrationModal } from '../ui/modals/MigrationModal';
import { AiStatusMoveModal } from '../ui/modals/AiStatusMoveModal';
import { AIO_STATUS_KEY, aiStatusKey } from '../core/aiStatus';

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

    // Command: move the AI's marks from `status` to `aio-status` (opt-in; a review comes before any write)
    plugin.addCommand({
        id: 'move-ai-status-marks',
        name: plugin.t.commands.moveAiStatusMarks,
        icon: 'arrow-right-left',
        callback: () => {
            if (aiStatusKey(plugin.settings) !== AIO_STATUS_KEY) {
                new Notice(plugin.t.modals.aiStatusMove.notOptedIn, 8000);
                return;
            }
            new AiStatusMoveModal(plugin.app, plugin).open();
        }
    });
}
