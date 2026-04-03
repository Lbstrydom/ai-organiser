/**
 * Kindle Commands
 * Registers the kindle-sync command that opens the Kindle sync modal.
 */

import type AIOrganiserPlugin from '../main';
import { KindleSyncModal } from '../ui/modals/KindleSyncModal';

export function registerKindleCommands(plugin: AIOrganiserPlugin): void {
    const t = plugin.t;

    plugin.addCommand({
        id: 'kindle-sync',
        name: t.commands.kindleSync,
        icon: 'book-open',
        callback: async () => {
            new KindleSyncModal(plugin.app, plugin).open();
        }
    });
}
