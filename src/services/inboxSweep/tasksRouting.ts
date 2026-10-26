/**
 * Where an approved sweep item goes: the user's named Google lists, the first-match routing rules, and the export decision.
 * Pure. Nothing here talks to Google or to the vault.
 *
 * Lists: `tasksListId` is the ONE authority for which list is main (older plugins read and write it). `tasksLists` holds the
 * other lists' configuration plus the main list's title and "needs a date" flag, never a second opinion on which list is main.
 * `resolveTasksLists` is the only reader and reconciles on every read; `updateTasksLists` is the only writer.
 *
 * Rules: data, not switches, evaluated top to bottom, first match wins, with an implicit last rule "everything else -> the main
 * list". With no rules every item goes to the main list exactly as before.
 *
 * Export decision: precedence is fixed (see `decideExport`). A task's frozen target is never rerouted; a list the script does not
 * approve is held, never replaced by another list.
 */
import type { SweepItemKind } from '../prompts/sweepPrompts';

export type Destination =
    | { type: 'list'; listId: string }
    | { type: 'report-only' }
    | { type: 'agenda' };

export interface TasksListConfig {
    id: string;
    title: string;
    /** Each item sent here needs a calendar date; the review does not let it be approved without one */
    needsDate: boolean;
}

export interface RoutingRule {
    kind: SweepItemKind;
    /** Match only next actions with this context (optional) */
    context?: string;
    destination: Destination;
}

/** At most this many lists (the main one plus others). */
export const MAX_TASKS_LISTS = 8;
export const MAX_ROUTING_RULES = 24;

const KINDS: readonly SweepItemKind[] = ['next_action', 'waiting_for', 'project', 'someday_maybe'];

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Coerce stored data: empty and duplicate ids and anything beyond the cap are dropped, `needsDate` becomes a boolean. */
export function normaliseTasksLists(raw: unknown): TasksListConfig[] {
    if (!Array.isArray(raw)) return [];
    const out: TasksListConfig[] = [];
    for (const entry of raw) {
        if (!isRecord(entry)) continue;
        const id = typeof entry.id === 'string' ? entry.id.trim() : '';
        if (id === '' || out.some((l) => l.id === id)) continue;
        out.push({ id, title: typeof entry.title === 'string' ? entry.title.trim().slice(0, 120) : '', needsDate: entry.needsDate === true });
        if (out.length >= MAX_TASKS_LISTS) break;
    }
    return out;
}

export interface ListsHost {
    tasksListId: string;
    tasksLists: readonly TasksListConfig[];
    /** The main list's name as the setup saw it: shown instead of its raw id when the list entry has no title */
    tasksListName?: string;
}

export interface ResolvedLists {
    /** The main list, or null while none is chosen (setup state: every list destination is unavailable) */
    main: TasksListConfig | null;
    others: TasksListConfig[];
}

/** The only reader of the list configuration. Reconciles `tasksListId` and `tasksLists` on every call. */
export function resolveTasksLists(host: ListsHost): ResolvedLists {
    const listed = normaliseTasksLists(host.tasksLists);
    const mainId = typeof host.tasksListId === 'string' ? host.tasksListId.trim() : '';
    if (mainId === '') return { main: null, others: listed };
    const own = listed.find((l) => l.id === mainId);
    const savedName = typeof host.tasksListName === 'string' ? host.tasksListName.trim().slice(0, 120) : '';
    const main = own ? { ...own, title: own.title || savedName } : { id: mainId, title: savedName, needsDate: false };
    return { main, others: listed.filter((l) => l.id !== mainId) };
}

/** Every configured list, main first. */
export function allLists(host: ListsHost): TasksListConfig[] {
    const { main, others } = resolveTasksLists(host);
    return main ? [main, ...others] : others;
}

export function listById(host: ListsHost, id: string): TasksListConfig | null {
    return allLists(host).find((l) => l.id === id) ?? null;
}

/**
 * The only writer. The mutator receives the current lists (main first) and returns the new set plus which one is main; both
 * `tasksListId` and `tasksLists` change together, so they can never disagree. Removing a list or changing the main one never
 * reroutes frozen tasks (they are held when their list is no longer approved).
 */
export function updateTasksLists(host: { tasksListId: string; tasksLists: TasksListConfig[] }, mutate: (lists: TasksListConfig[], mainId: string) => { lists: TasksListConfig[]; mainId: string }): void {
    const next = mutate(allLists(host), resolveTasksLists(host).main?.id ?? '');
    const lists = normaliseTasksLists(next.lists);
    const mainId = lists.some((l) => l.id === next.mainId) ? next.mainId : '';
    host.tasksListId = mainId;
    host.tasksLists = lists;
}

/** Coerce stored rules. The agenda destination is not offered yet: a stored one is dropped. */
export function normaliseRoutingRules(raw: unknown): RoutingRule[] {
    if (!Array.isArray(raw)) return [];
    const out: RoutingRule[] = [];
    for (const entry of raw) {
        if (!isRecord(entry) || !KINDS.includes(entry.kind as SweepItemKind) || !isRecord(entry.destination)) continue;
        const d = entry.destination;
        let destination: Destination | null = null;
        if (d.type === 'list' && typeof d.listId === 'string' && d.listId.trim() !== '') destination = { type: 'list', listId: d.listId.trim() };
        else if (d.type === 'report-only') destination = { type: 'report-only' };
        if (!destination) continue;
        const rawContext = typeof entry.context === 'string' ? entry.context.trim() : '';
        // A context that is present but not valid drops the rule: narrowing a rule must never silently widen it to every item of its kind.
        if (rawContext !== '' && !/^@[a-z0-9][a-z0-9_-]{0,23}$/.test(rawContext)) continue;
        const context = rawContext === '' ? undefined : rawContext;
        out.push({ kind: entry.kind as SweepItemKind, ...(context ? { context } : {}), destination });
        if (out.length >= MAX_ROUTING_RULES) break;
    }
    return out;
}

export interface RoutableItem {
    kind: SweepItemKind;
    context: string;
}

/**
 * The destination the review PRE-SELECTS: the first matching rule, else the main list (else, with no main list, the report
 * only). A rule that points at a list that is no longer configured is skipped. The person's approval is the gate; rules never
 * send anything on their own.
 */
export function resolveDestination(rules: readonly RoutingRule[], item: RoutableItem, host: ListsHost): Destination {
    for (const rule of rules) {
        if (rule.kind !== item.kind) continue;
        if (rule.context !== undefined && rule.context !== item.context) continue;
        if (rule.destination.type === 'list' && !listById(host, rule.destination.listId)) continue;
        return rule.destination;
    }
    const { main } = resolveTasksLists(host);
    return main ? { type: 'list', listId: main.id } : { type: 'report-only' };
}

const KIND_PREFIX: Array<[RegExp, SweepItemKind]> = [[/^waiting:\s*/i, 'waiting_for'], [/^project:\s*/i, 'project'], [/^someday:\s*/i, 'someday_maybe']];

/** The kind of a record written before `kind` was stored: the text prefix the review applied. */
export function kindOfText(text: string): SweepItemKind {
    return KIND_PREFIX.find(([re]) => re.test(text))?.[1] ?? 'next_action';
}

/** A real calendar date `YYYY-MM-DD`. */
export function isValidDue(value: unknown): value is string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [y, m, d] = value.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** The ISO date written in an item's text, only when there is exactly one (no parsing of natural language). */
export function isoDateInText(text: string): string | null {
    const found = [...new Set(text.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? [])].filter(isValidDue);
    return found.length === 1 ? found[0] : null;
}

// ─── The export decision ────────────────────────────────────────────────────

/** The part of an approved task `decideExport` reads. */
export interface RoutedTask {
    state: string;
    error?: string;
    destination?: Destination;
    due?: string;
    target?: { listId: string };
}

export interface ExportContext extends ListsHost {
    /** The lists the deployed script approves, from the last ping; null when unknown */
    approvedListIds: readonly string[] | null;
    /** The deployed script is older than multi-list (so any non-main list must wait for a redeploy) */
    scriptHasMultiList: boolean;
}

export type HoldReason = 'tasks-no-list' | 'tasks-due-missing' | 'tasks-list-not-approved' | 'tasks-script-lists-outdated';

export type ExportDecision =
    | { kind: 'complete' }
    | { kind: 'send'; listId: string; frozen: boolean }
    | { kind: 'hold'; reason: HoldReason }
    | { kind: 'not-sent' }
    | { kind: 'agenda' };

/**
 * Precedence: (1) exported, or failed with `conflict`, is complete; (2) a task with a frozen target is retried or held
 * against THAT target whatever the current lists or rules say; (3) a task without a target uses its stamped destination
 * (none = the main list, today's behaviour): `report-only` is not sent, `agenda` is not a Google item, a list that needs a
 * date and has no valid one is held. A list the script does not approve is held, never replaced by another list.
 */
export function decideExport(task: RoutedTask, ctx: ExportContext): ExportDecision {
    if (task.state === 'exported' || (task.state === 'failed' && task.error === 'conflict')) return { kind: 'complete' };
    const approved = (listId: string): ExportDecision | null => {
        const main = resolveTasksLists(ctx).main;
        if (ctx.approvedListIds === null || ctx.approvedListIds.includes(listId)) return null;
        // A script that predates multi-list approves only the main list: say that a redeploy is what is missing.
        return { kind: 'hold', reason: !ctx.scriptHasMultiList && main && listId !== main.id ? 'tasks-script-lists-outdated' : 'tasks-list-not-approved' };
    };
    if (task.target) return approved(task.target.listId) ?? { kind: 'send', listId: task.target.listId, frozen: true };
    const dest = task.destination;
    if (dest?.type === 'report-only') return { kind: 'not-sent' };
    if (dest?.type === 'agenda') return { kind: 'agenda' };
    const listId = dest?.type === 'list' ? dest.listId : resolveTasksLists(ctx).main?.id ?? '';
    if (listId === '') return { kind: 'hold', reason: 'tasks-no-list' };
    const list = listById(ctx, listId);
    if (list?.needsDate && !isValidDue(task.due)) return { kind: 'hold', reason: 'tasks-due-missing' };
    return approved(listId) ?? { kind: 'send', listId, frozen: false };
}
