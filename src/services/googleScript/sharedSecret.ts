/**
 * Which secret the Drive inventory client uses. With a standalone inventory script it is its own stored secret. When the inventory
 * URL is the same deployment as the Google Tasks URL (the combined script), the one shared secret is the Tasks secret: nothing is
 * copied or overwritten, so choosing to combine can never leave the inventory with a secret its (old) deployment does not know
 * before its URL has been changed.
 *
 * Fail closed: for a combined deployment the standalone inventory secret is never tried (it belongs to a different deployment),
 * and a storage failure is reported as one, not as "no secret".
 */
import type AIOrganiserPlugin from '../../main';
import { PLUGIN_SECRET_IDS } from '../../core/secretIds';
import { Result, ok, err } from '../../core/result';

/** Same deployment = same host and the same path. The host is case-insensitive; a deployment id in the path is not. */
export function sameDeployment(a: string, b: string): boolean {
    const key = (raw: string): string | null => {
        try {
            const u = new URL(raw.trim());
            return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
        } catch {
            return null;
        }
    };
    const ka = key(a);
    return ka !== null && ka === key(b);
}

/** The secret for the inventory script at the configured URL: `ok(null)` when none is stored, `err` when storage failed. */
export async function inventorySecretFor(plugin: AIOrganiserPlugin): Promise<Result<string | null>> {
    const s = plugin.settings;
    try {
        if (sameDeployment(s.cloudInventoryScriptUrl, s.tasksScriptUrl)) {
            return ok(await plugin.secretStorageService.getSecret(PLUGIN_SECRET_IDS.GOOGLE_TASKS));
        }
        return ok(await plugin.secretStorageService.getSecret(PLUGIN_SECRET_IDS.CLOUD_INVENTORY));
    } catch {
        return err('secret-storage-failed');
    }
}
