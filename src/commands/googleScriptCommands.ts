/**
 * Copy the combined Google script: one deployment for Google Tasks and (when the Drive inventory is on) the inventory, with one
 * secret. The standalone scripts and their wizards are untouched; this is only for a user who chooses to combine.
 *
 * The one secret is the Tasks secret. Nothing is copied or overwritten: the inventory client uses the Tasks secret only while its
 * URL is the same deployment as the Tasks URL (`inventorySecretFor`), so an inventory that still points at its own script keeps
 * its own secret until the person changes the URL. Registered only while `google-tasks-export` is on.
 */
import { Notice, Platform } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { describeError, formatGuidance } from '../core/friendlyErrors';
import { PLUGIN_SECRET_IDS } from '../core/secretIds';
import { validateScriptUrl } from '../services/appsScriptClient';
import { isFeatureEnabled } from '../services/featureService';
import { buildCombinedScript } from '../services/googleScript/combinedScript';
import { approvedRoots } from '../services/cloudInventory/cloudInventoryService';
import { pingTasksScript } from '../services/inboxSweep/tasksExportService';
import { allLists } from '../services/inboxSweep/tasksRouting';
import { selectTasksScript } from '../services/inboxSweep/tasksScriptSelect';
import { ensureTasksSecret } from './inboxSweepCommands';
import { logger } from '../utils/logger';

/**
 * `mainListId`: the list the setup window has just chosen but not yet saved; it goes first so the script approves it as the main list.
 * `redeploy`: the person is replacing a deployed script, so the notice says to paste over it and keep the link, not to start a new project.
 */
export async function copyCombinedScript(plugin: AIOrganiserPlugin, mainListId?: string, redeploy = false): Promise<void> {
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
        new Notice(redeploy ? t.copiedRedeploy : withInventory && roots.length > 0 ? t.copiedBoth : t.copiedTasks, 12000);
    } catch (e) {
        logger.error('GoogleScript', 'Could not copy the combined script', e);
        new Notice(formatGuidance(describeError(plugin.t, 'unknown')), 9000);
    }
}

/**
 * "Copy script" under Your lists: asks the deployed script what it is, so a combined deployment is never handed the standalone script.
 * A standalone deployment gets the same bytes and the same notice as before. No link means nothing is deployed yet, so nothing is asked.
 * If the check fails the copy still happens, because a broken deployment is often why someone is here, and the notice names the risk.
 * Mobile skips the check: a clipboard write after a slow network wait may no longer count as part of the tap.
 */
export async function copyScriptForDeployment(plugin: AIOrganiserPlugin, mainListId: string): Promise<void> {
    const t = plugin.t;
    const s = plugin.settings;
    const secret = await plugin.secretStorageService.getSecret(PLUGIN_SECRET_IDS.GOOGLE_TASKS);
    if (!secret) { new Notice(formatGuidance(describeError(t, 'no-secret')), 8000); return; }
    const url = validateScriptUrl(s.tasksScriptUrl);
    let notice = t.googleTasks.scriptCopied;
    if (url.ok) {
        const ping = Platform.isMobile ? null : await pingTasksScript({ url: url.value, secret });
        if (ping?.ok && ping.value.combined === true) { await copyCombinedScript(plugin, mainListId, true); return; }
        if (!ping?.ok) notice = t.googleTasks.scriptCopiedUnchecked;
    }
    await navigator.clipboard.writeText(selectTasksScript(s, secret, mainListId).text);
    new Notice(notice, 8000);
}

export function registerGoogleScriptCommands(plugin: AIOrganiserPlugin): void {
    plugin.addCommand({
        id: 'copy-combined-google-script',
        name: plugin.t.commands.copyCombinedGoogleScript,
        icon: 'clipboard-copy',
        callback: () => { void copyCombinedScript(plugin); },
    });
}
