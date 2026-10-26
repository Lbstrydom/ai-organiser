/**
 * Which secret the Drive inventory client uses. With a standalone inventory script it is its own stored secret. When the inventory
 * URL is the same deployment as the Google Tasks URL (the combined script), the one shared secret is the Tasks secret: nothing is
 * copied or overwritten, so choosing to combine can never leave the inventory with a secret its (old) deployment does not know
 * before its URL has been changed.
 */
import type AIOrganiserPlugin from '../../main';
import { PLUGIN_SECRET_IDS } from '../../core/secretIds';

const sameDeployment = (a: string, b: string): boolean => {
    const norm = (u: string): string => u.trim().replace(/\/+$/, '').toLowerCase();
    return norm(a) !== '' && norm(a) === norm(b);
};

/** The secret for the inventory script at the configured URL, or null when none is stored. Never throws. */
export async function inventorySecretFor(plugin: AIOrganiserPlugin): Promise<string | null> {
    const s = plugin.settings;
    try {
        if (sameDeployment(s.cloudInventoryScriptUrl, s.tasksScriptUrl)) {
            const shared = await plugin.secretStorageService.getSecret(PLUGIN_SECRET_IDS.GOOGLE_TASKS);
            if (shared) return shared;
        }
        return await plugin.secretStorageService.getSecret(PLUGIN_SECRET_IDS.CLOUD_INVENTORY);
    } catch {
        return null;
    }
}
