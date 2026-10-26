/**
 * Which Google Tasks script text the plugin hands the user: the EXACT current v1 text unless a v2 capability is wanted (more than
 * one list, or completion read-back), chosen by capability and never by list count alone. A list that needs a date works on v1
 * (its upsert already writes `due`), so that alone never forces a redeploy.
 */
import { buildTasksScriptV2, tasksScriptChoice } from '../googleScript/googleScriptBuilder';
import { resolveTasksLists, type ListsHost } from './tasksRouting';
import { buildTasksScript } from './tasksScriptTemplate';

export interface ScriptSettings extends ListsHost {
    tasksReadBack: boolean;
}

/** The deployment text for `approvedListId` (null = the setup deployment, which cannot create tasks). */
export function selectTasksScript(settings: ScriptSettings, secret: string, approvedListId: string | null): { text: string; version: 1 | 2 } {
    const { others } = resolveTasksLists(settings);
    const choice = tasksScriptChoice({ mainListId: approvedListId ?? '', otherListIds: approvedListId === null ? [] : others.map((l) => l.id), readBack: settings.tasksReadBack });
    if (!choice.needsV2) return { text: buildTasksScript({ secret, approvedListId }), version: 1 };
    return { text: buildTasksScriptV2({ secret, approvedListId, approvedListIds: approvedListId === null ? [] : choice.approvedListIds }), version: 2 };
}

/** Every configured list id, main first: what a deployed script must approve for all lists to work. */
export function configuredListIds(settings: ListsHost): string[] {
    const { main, others } = resolveTasksLists(settings);
    return [...(main ? [main.id] : []), ...others.map((l) => l.id)];
}
