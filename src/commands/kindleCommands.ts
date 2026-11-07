/**
 * Kindle Commands
 * Registers the kindle-sync command that opens the Kindle sync modal.
 */

import { actionName } from '../core/actionRegistry';
import type AIOrganiserPlugin from '../main';
import { KindleSyncModal } from '../ui/modals/KindleSyncModal';

export function registerKindleCommands(plugin: AIOrganiserPlugin): void {
    const t = plugin.t;

    plugin.addCommand({
        id: 'kindle-sync',
        name: actionName(t, 'kindle-sync'),
        icon: 'book-open',
        callback: () => {
            new KindleSyncModal(plugin.app, plugin).open();
        }
    });
}
