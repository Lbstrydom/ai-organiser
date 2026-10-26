/**
 * Copy the combined Google script: one deployment for Google Tasks and (when the Drive inventory is on) the inventory, with one
 * secret. The standalone scripts and their wizards are untouched; this is only for a user who chooses to combine.
 *
 * The one secret is the Tasks secret. Nothing is copied or overwritten: the inventory client uses the Tasks secret only while its
 * URL is the same deployment as the Tasks URL (`inventorySecretFor`), so an inventory that still points at its own script keeps
 * its own secret until the person changes the URL. Registered only while `google-tasks-export` is on.
 */
import { Notice } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { describeError, formatGuidance } from '../core/friendlyErrors';
import { isFeatureEnabled } from '../services/featureService';
import { buildCombinedScript } from '../services/googleScript/combinedScript';
import { approvedRoots } from '../services/cloudInventory/cloudInventoryService';
import { allLists } from '../services/inboxSweep/tasksRouting';
import { ensureTasksSecret } from './inboxSweepCommands';
import { logger } from '../utils/logger';

/** `mainListId`: the list the setup window has just chosen but not yet saved; it goes first so the script approves it as the main list. */
export async function copyCombinedScript(plugin: AIOrganiserPlugin, mainListId?: string): Promise<void> {
    const t = plugin.t.googleScript;
    const s = plugin.settings;
    try {
        const saved = allLists(s);
        const lists = mainListId ? [{ id: mainListId }, ...saved.filter((l) => l.id !== mainListId)] : saved;
        const main = lists[0]?.id ?? '';
        const withInventory = isFeatureEnabled(s, 'cloud-inventory');
        const roots = withInventory ? approvedRoots(s.cloudInventoryPairs) : [];
        const { secret } = await ensureTasksSecret(plugin);
        const script = buildCombinedScript({
            secret,
            tasks: { approvedListId: main || null, approvedListIds: lists.map((l) => l.id) },
            ...(withInventory && roots.length > 0 ? { inventory: { rootFolderIds: roots } } : {}),
        });
        await navigator.clipboard.writeText(script);
        new Notice(withInventory && roots.length > 0 ? t.copiedBoth : t.copiedTasks, 12000);
    } catch (e) {
        logger.error('GoogleScript', 'Could not copy the combined script', e);
        new Notice(formatGuidance(describeError(plugin.t, 'unknown')), 9000);
    }
}

export function registerGoogleScriptCommands(plugin: AIOrganiserPlugin): void {
    plugin.addCommand({
        id: 'copy-combined-google-script',
        name: plugin.t.commands.copyCombinedGoogleScript,
        icon: 'clipboard-copy',
        callback: () => { void copyCombinedScript(plugin); },
    });
}
