/**
 * Dashboard Commands
 * Commands for creating Obsidian Bases dashboards
 */

import type AIOrganiserPlugin from '../main';
import { DashboardCreationModal } from '../ui/modals/DashboardCreationModal';

/**
 * Register dashboard commands
 */
export function registerDashboardCommands(plugin: AIOrganiserPlugin) {
    // Command: Create Bases Dashboard
    plugin.addCommand({
        id: 'create-bases-dashboard',
        name: plugin.t.commands.createBasesDashboard,
        icon: 'layout-dashboard',
        callback: () => {
            const modal = new DashboardCreationModal(plugin.app, plugin);
            modal.open();
        }
    });
}
