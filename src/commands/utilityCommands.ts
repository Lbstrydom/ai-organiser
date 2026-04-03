import AIOrganiserPlugin from '../main';
import { TagUtils } from '../utils/tagUtils';
import { getConfigFolderFullPath } from '../core/settings';

export function registerUtilityCommands(plugin: AIOrganiserPlugin) {
    // Command to collect all tags from vault
    plugin.addCommand({
        id: 'collect-all-tags',
        name: plugin.t.commands.collectAllTags,
        icon: 'tags',
        callback: async () => {
            // Save all tags to the config folder
            await TagUtils.saveAllTags(plugin.app, getConfigFolderFullPath(plugin.settings));
        }
    });

    // Command to show tag network visualization
    plugin.addCommand({
        id: 'show-tag-network',
        name: plugin.t.commands.showTagNetwork,
        icon: 'git-graph',
        callback: async () => {
            await plugin.showTagNetwork();
        }
    });
}
