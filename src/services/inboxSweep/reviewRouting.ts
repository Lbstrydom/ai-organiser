/**
 * The review window's routing, as pure functions: whether destination controls are offered at all, the pre-selected
 * destination and date of a row, whether a row is complete, and the fields an approval stamps on a task.
 *
 * The review decides and the rules only pre-select: nothing is sent because a rule matched. A list that needs a date blocks
 * approval until a valid date is picked (the plugin never invents one); an ISO date written in the item's text only PRE-FILLS
 * the input, marked "from the text". With a plain one-list setup (no other list, no rules, a main list that needs no date) no
 * controls are offered and tasks are approved exactly as they always were.
 */
import type { SweepItemKind } from '../prompts/sweepPrompts';
import { allLists, isoDateInText, isValidDue, listById, resolveDestination, resolveTasksLists, type Destination, type RoutingRule, type TasksListConfig } from './tasksRouting';
import type { ApprovedTask } from './sweepLedger';

export interface ReviewRouting {
    /** Every configured list, main first */
    lists: TasksListConfig[];
    mainId: string;
    rules: RoutingRule[];
}

/** The routing the review offers, or null when the setup is the plain one-list one (nothing to choose). */
export function reviewRoutingFor(settings: { tasksListId: string; tasksLists: readonly TasksListConfig[]; tasksRoutingRules: readonly RoutingRule[] }): ReviewRouting | null {
    const { main, others } = resolveTasksLists(settings);
    if (!main) return null;
    const offered = others.length > 0 || main.needsDate || settings.tasksRoutingRules.length > 0;
    return offered ? { lists: allLists(settings), mainId: main.id, rules: [...settings.tasksRoutingRules] } : null;
}

export interface RowRouting {
    destination: Destination;
    due: string;
    /** The date came from the item's text (shown marked, still editable) */
    dueFromText: boolean;
}

export function defaultRowRouting(item: { kind: SweepItemKind; context: string; text: string }, routing: ReviewRouting): RowRouting {
    const destination = resolveDestination(routing.rules, item, { tasksListId: routing.mainId, tasksLists: routing.lists });
    const needs = needsDate(destination, routing);
    const fromText = needs ? isoDateInText(item.text) : null;
    return { destination, due: fromText ?? '', dueFromText: fromText !== null };
}

export function needsDate(destination: Destination, routing: ReviewRouting): boolean {
    return destination.type === 'list' && (listById({ tasksListId: routing.mainId, tasksLists: routing.lists }, destination.listId)?.needsDate ?? false);
}

/** Changing the destination drops a date the new list does not need. */
export function changeDestination(row: RowRouting, destination: Destination, routing: ReviewRouting): RowRouting {
    return needsDate(destination, routing) ? { ...row, destination } : { destination, due: '', dueFromText: false };
}

export type RowCheck = { ok: true } | { ok: false; reason: 'date-needed'; listTitle: string };

export function checkRow(row: RowRouting, routing: ReviewRouting): RowCheck {
    if (row.destination.type !== 'list' || !needsDate(row.destination, routing)) return { ok: true };
    if (isValidDue(row.due)) return { ok: true };
    const list = listById({ tasksListId: routing.mainId, tasksLists: routing.lists }, row.destination.listId);
    return { ok: false, reason: 'date-needed', listTitle: list?.title || list?.id || '' };
}

/**
 * The fields an approval adds to a task when the review offered routing. Every such task is `routed`: it is created in a state
 * an older plugin never exports, so it can never be sent undated or to the wrong list by it.
 */
export function approvalFields(kind: SweepItemKind, row: RowRouting, routing: ReviewRouting): Pick<ApprovedTask, 'routingMode' | 'kind' | 'destination' | 'due' | 'needsDateAtApproval'> {
    const needs = needsDate(row.destination, routing);
    return {
        routingMode: 'routed',
        kind,
        destination: row.destination,
        needsDateAtApproval: needs,
        ...(needs && isValidDue(row.due) ? { due: row.due } : {}),
    };
}
