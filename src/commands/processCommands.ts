/** The Process command: opens the Process view in a tab. Registered only while a feature that feeds it is on. */
import type AIOrganiserPlugin from '../main';
import { PROCESS_VIEW_TYPE } from '../ui/views/ProcessView';
import { logger } from '../utils/logger';

export function registerProcessCommands(plugin: AIOrganiserPlugin): void {
    plugin.addCommand({
        id: 'open-process',
        name: plugin.t.commands.openProcess,
        icon: 'list-checks',
        callback: () => {
            const { workspace } = plugin.app;
            const existing = workspace.getLeavesOfType(PROCESS_VIEW_TYPE)[0];
            if (existing) { void workspace.revealLeaf(existing); return; }
            void workspace.getLeaf('tab').setViewState({ type: PROCESS_VIEW_TYPE, active: true })
                .catch((e: unknown) => logger.error('Process', 'Could not open the Process view', e));
        },
    });
}
