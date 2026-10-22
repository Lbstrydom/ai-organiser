/**
 * The vault upkeep sweep's execution core. Pure of Obsidian.
 *
 * One core runs the tasks (`executeTasks`) for both entry points:
 *  - a real run (`runUpkeep` in the runtime): saved settings, may refresh the index when opted in,
 *    retains and announces its result;
 *  - the setup's dry run: unsaved draft selections, never publishes, never retains.
 * The core takes an immutable config snapshot and an explicit execution policy, so setup cannot reach
 * the tasks without saving settings or inheriting a persisted option.
 *
 * A thrown error inside a task becomes a failed outcome, never a stuck run. A failed or partial run
 * is never reported as "nothing to review".
 */
import { Result, ok, err } from '../../core/result';
import {
    collect,
    isStopped,
    MAX_PERSISTED_ITEMS,
    runAgentIndexTask,
    runAttachmentsTask,
    runInventoriesTask,
    type Proposal,
    type ProposalKind,
    type RunContext,
    type RunSummary,
    type TaskConfig,
    type TaskName,
    type TaskOutcome,
    type UpkeepEnv,
} from './upkeepTasks';

export const TASK_ORDER: readonly TaskName[] = ['agentIndex', 'inventories', 'attachments'];

export interface UpkeepConfigSnapshot {
    tasks: Record<TaskName, boolean>;
    /** Which selected tasks can run now (their feature is on and set up) */
    available: Record<TaskName, boolean>;
    task: TaskConfig;
}

export interface ExecutionPolicy {
    allowIndexPublish: boolean;
    retainResult: boolean;
    notify: boolean;
}

export interface ExecutedRun {
    summary: RunSummary;
    /** The kept proposals, capped per task (exact totals are in the summary) */
    proposals: Proposal[];
}

/** Overall status from the task outcomes. */
export function deriveStatus(outcomes: readonly TaskOutcome[]): RunSummary['status'] {
    if (outcomes.length === 0) return 'failed';
    if (outcomes.every((o) => o.status === 'failed')) return 'failed';
    return outcomes.some((o) => o.status !== 'ok') ? 'partial' : 'ok';
}

export function selectedTasks(config: UpkeepConfigSnapshot): TaskName[] {
    return TASK_ORDER.filter((t) => config.tasks[t]);
}

/** Run the selected tasks in order. Never throws. */
export async function executeTasks(
    config: UpkeepConfigSnapshot,
    policy: ExecutionPolicy,
    trigger: RunSummary['trigger'],
    env: UpkeepEnv,
    ctx: RunContext,
): Promise<ExecutedRun> {
    const startedAt = ctx.now();
    const outcomes: TaskOutcome[] = [];
    const proposals: Proposal[] = [];
    const totals: Partial<Record<ProposalKind, number>> = {};

    for (const task of selectedTasks(config)) {
        const empty = { counts: {}, omitted: 0 };
        if (!config.available[task]) { outcomes.push({ task, status: 'skipped', reason: 'upkeep-task-unavailable', ...empty }); continue; }
        if (isStopped(ctx)) { outcomes.push({ task, status: 'cancelled', ...empty }); continue; }
        let result: Result<ReturnType<typeof collect>>;
        try {
            if (task === 'agentIndex') result = await runAgentIndexTask(env, config.task, policy.allowIndexPublish, ctx);
            else if (task === 'inventories') result = await runInventoriesTask(env, ctx);
            else result = await runAttachmentsTask(env, config.task, ctx);
        } catch {
            result = err('upkeep-task-failed');
        }
        if (!result.ok) {
            outcomes.push({ task, status: result.error === 'cancelled' || (ctx.signal.aborted && result.error === 'script-network') ? 'cancelled' : 'failed', reason: result.error, ...empty });
            continue;
        }
        outcomes.push({ task, status: 'ok', counts: result.value.totals, omitted: result.value.omitted });
        proposals.push(...result.value.proposals);
        for (const [kind, n] of Object.entries(result.value.totals) as Array<[ProposalKind, number]>) totals[kind] = (totals[kind] ?? 0) + n;
    }

    return {
        summary: { startedAt: new Date(startedAt).toISOString(), durationMs: Math.max(0, ctx.now() - startedAt), trigger, outcomes, totals, status: deriveStatus(outcomes) },
        proposals,
    };
}

/** The most items the plugin keeps between runs. */
export function toStored(run: ExecutedRun): { items: Proposal[]; omitted: number } {
    const items = run.proposals.slice(0, MAX_PERSISTED_ITEMS);
    return { items, omitted: run.proposals.length - items.length };
}

/** A key that changes when the set of proposals changes; an unchanged backlog is not announced again. */
export function proposalFingerprint(summary: RunSummary, proposals: readonly Proposal[] = []): string {
    const identities = proposals.map((p) => JSON.stringify(p)).sort();
    return JSON.stringify([Object.entries(summary.totals).sort(([a], [b]) => (a < b ? -1 : 1)), identities]);
}

/** Total number of things to review in a summary. */
export function reviewCount(summary: RunSummary): number {
    return Object.values(summary.totals).reduce<number>((a, b) => a + (b ?? 0), 0);
}

/** Whether a scheduled run should announce itself. */
export function shouldNotify(summary: RunSummary, lastNotifiedKey: string, policy: ExecutionPolicy, proposals: readonly Proposal[] = []): { notify: boolean; kind: 'proposals' | 'failure' | 'none' } {
    if (!policy.notify) return { notify: false, kind: 'none' };
    if (summary.status === 'failed') return { notify: true, kind: 'failure' };
    if (reviewCount(summary) > 0 && proposalFingerprint(summary, proposals) !== lastNotifiedKey) return { notify: true, kind: 'proposals' };
    return { notify: false, kind: 'none' };
}

/** A run context bound to a cap. The caller aborts the controller when the cap expires. */
export function makeContext(capMs: number, now: () => number, signal: AbortSignal): RunContext {
    return { signal, deadline: now() + capMs, now };
}

/** `ok` unless a run is already active. Used by both entry points before they start. */
export function claimRun<T extends { claim(): (() => void) | null }>(job: T): Result<() => void> {
    const release = job.claim();
    return release ? ok(release) : err('upkeep-running');
}
