/**
 * Automatic lists: a v3 script keeps its approved lists in its own properties and the plugin sets them.
 *
 * `setLists` runs only from a person's direct action: Finish in the setup window, a change or a button under Your lists, or the
 * button on a held-task notice. **An export never calls this file.** A task for an unapproved list stays held, so a synced edit of
 * the settings cannot widen the lock by itself.
 *
 * Off by default: `tasksAutoLists` is false until someone finishes setup on a v3 script or chooses Switch to automatic lists, and
 * nothing here runs while it is false.
 */
import type AIOrganiserPlugin from '../../main';
import { PLUGIN_SECRET_IDS } from '../../core/secretIds';
import { Result, ok, err } from '../../core/result';
import { validateScriptUrl, type ScriptTransport } from '../appsScriptClient';
import { LIST_CONFIG_CAPABILITY } from '../googleScript/tasksModuleV3';
import { configuredListIds } from './tasksScriptSelect';
import { pingTasksScript, setTasksLists } from './tasksExportService';
import { logger } from '../../utils/logger';

export interface ApproveInput {
    url: string;
    secret: string;
    transport?: ScriptTransport;
    /** Main list first */
    main: string;
    ids: readonly string[];
    /** The revision this device last saw. Null when it never saw one, which trusts what the script reports now. */
    knownRevision: number | null;
    /** Another device changed the lists: told once, so that choosing to approve again is a decision made knowing that. */
    onStale?: (remoteRevision: number) => void | Promise<void>;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

/** Approve exactly these lists and confirm with a ping. Returns the revision now live. Never throws. */
export async function approveLists(input: ApproveInput): Promise<Result<number>> {
    const endpoint = { url: input.url, secret: input.secret, transport: input.transport };
    const before = await pingTasksScript(endpoint);
    if (!before.ok) return err(before.error);
    if (before.value.capabilities?.includes(LIST_CONFIG_CAPABILITY) !== true) return err('tasks-auto-not-deployed');
    const remote = before.value.listsRevision ?? 0;
    if (input.knownRevision !== null && input.knownRevision !== remote) {
        await input.onStale?.(remote);
        return err('tasks-lists-stale');
    }
    // Nothing to change, so nothing is written (a retry after a failed save does not move the revision).
    if (before.value.approvedListId === input.main && sameSet(before.value.approvedListIds ?? [], input.ids)) return ok(remote);
    const set = await setTasksLists(endpoint, { main: input.main, ids: input.ids, expectedRevision: remote });
    if (!set.ok) return err(set.error);
    const after = await pingTasksScript(endpoint);
    if (!after.ok) return err(after.error);
    if (after.value.approvedListId !== input.main || !sameSet(after.value.approvedListIds ?? [], input.ids)) return err('tasks-lists-not-saved');
    return ok(after.value.listsRevision ?? set.value);
}

/**
 * Approve the lists configured under Your lists. From a person's action only. On success the deployment counts as automatic, which is
 * also how Switch to automatic lists completes. If the live script keeps its lists in its text (a v2 script pasted back over v3), the
 * plugin goes back to treating it that way, so the person sees the Copy script row again.
 */
export async function approveConfiguredLists(plugin: AIOrganiserPlugin): Promise<Result<void>> {
    const s = plugin.settings;
    try {
        const ids = configuredListIds(s);
        if (ids.length === 0) return err('tasks-wizard-no-list');
        const url = validateScriptUrl(s.tasksScriptUrl);
        if (!url.ok) return err(url.error);
        const secret = await plugin.secretStorageService.getSecret(PLUGIN_SECRET_IDS.GOOGLE_TASKS);
        if (!secret) return err('no-secret');
        const res = await approveLists({
            url: url.value, secret, main: ids[0], ids,
            knownRevision: s.tasksAutoLists ? s.tasksListsRevision : null,
            onStale: async (remote) => { s.tasksListsRevision = remote; await plugin.saveSettings(); },
        });
        if (!res.ok) {
            if (res.error === 'tasks-auto-not-deployed' && s.tasksAutoLists) {
                s.tasksAutoLists = false;
                s.tasksListsRevision = null;
                await plugin.saveSettings();
            }
            return err(res.error);
        }
        s.tasksAutoLists = true;
        s.tasksListsRevision = res.value;
        await plugin.saveSettings();
        return ok(undefined);
    } catch (e) {
        logger.warn('Sweep', 'Could not approve the Google lists', e);
        return err('unknown');
    }
}
