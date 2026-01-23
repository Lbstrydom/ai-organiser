import type AIOrganiserPlugin from '../main';
import { MinutesCreationModal } from '../ui/modals/MinutesCreationModal';

export function registerMinutesCommands(plugin: AIOrganiserPlugin): void {
    plugin.addCommand({
        id: 'create-meeting-minutes',
        name: plugin.t.commands.createMeetingMinutes || 'Create Meeting Minutes',
        callback: () => {
            new MinutesCreationModal(plugin.app, plugin).open();
        }
    });
}
