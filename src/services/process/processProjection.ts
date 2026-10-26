/**
 * What is waiting for the person, read from the owners of that work. Read-only: nothing here writes, and the view never keeps
 * its own copy of anyone's state. One adapter per owner; an adapter that fails shows its group as "could not load" while the
 * others render. Pure except for the adapters the caller supplies.
 *
 * Groups in this version: captures to review, AI hand-backs, and items the export is holding. (Filing, agendas and
 * script-update holds beyond the export's own are not owned by anything yet.)
 */
import type { Result } from '../../core/result';
import { logger } from '../../utils/logger';
import type { CaptureJournal } from '../captureInbox/captureTypes';
import { buildQueue } from '../captureInbox/captureQueueModel';
import type { HandbackRecord } from '../aiWorkspaces/handbackJournal';
import type { ApprovalRecord } from '../inboxSweep/sweepLedger';

export type ProcessGroup = 'captures' | 'handbacks' | 'held';
export const PROCESS_GROUPS: readonly ProcessGroup[] = ['captures', 'handbacks', 'held'];

export type ProcessAction = 'review' | 'retry' | 'open';

/** Where a row leads. The owner's own window opens; the view never reimplements it. */
export type ProcessRoute =
    | { type: 'command'; id: string }
    | { type: 'handback'; path: string }
    | { type: 'open-note'; path: string };

export interface ProcessItem {
    /** Stable across reads: the owner's own id */
    sourceId: string;
    group: ProcessGroup;
    title: string;
    detail?: string;
    /** A stable guidance code when the item is waiting on something */
    heldReason?: string;
    actions: ProcessAction[];
    route: ProcessRoute;
}

export interface ProcessGroupResult {
    group: ProcessGroup;
    items: ProcessItem[];
    /** Set when this group's adapter failed */
    error?: string;
}

export interface ProcessAdapter {
    group: ProcessGroup;
    read(): Result<ProcessItem[]> | Promise<Result<ProcessItem[]>>;
}

/** Read every adapter; one that throws or fails is its own group's error and nothing else's. */
export async function projectProcess(adapters: readonly ProcessAdapter[]): Promise<ProcessGroupResult[]> {
    const out: ProcessGroupResult[] = [];
    for (const adapter of adapters) {
        try {
            const res = await adapter.read();
            out.push(res.ok ? { group: adapter.group, items: res.value } : { group: adapter.group, items: [], error: res.error });
        } catch (e) {
            logger.warn('Process', `The ${adapter.group} group could not be read`, e);
            out.push({ group: adapter.group, items: [], error: 'unknown' });
        }
    }
    return out;
}

// ─── The adapters' pure halves ───────────────────────────────────────────────

/** Captures waiting for a review or failed (the capture owner's own queue model decides which). */
export function captureItems(journal: CaptureJournal, now: number, stabilityMs: number): ProcessItem[] {
    return buildQueue(journal, now, { stabilityMs })
        .filter((r) => r.reviewable || r.retriable)
        .map((r): ProcessItem => ({
            sourceId: r.id,
            group: 'captures',
            title: r.title,
            ...(r.errorText ? { detail: r.errorText } : {}),
            actions: r.retriable ? ['retry', 'open'] : ['review'],
            route: { type: 'command', id: 'review-captures' },
        }));
}

const base = (path: string): string => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');

/** Hand-backs with something still to do: items pending or failed. A finished hand-back is not listed. */
export function handbackItems(records: Readonly<Record<string, HandbackRecord>>, exists: (path: string) => boolean): ProcessItem[] {
    const out: ProcessItem[] = [];
    for (const r of Object.values(records)) {
        const waiting = Object.values(r.items).filter((i) => i.state === 'pending' || i.state === 'failed' || i.state === 'applying').length;
        // Deliverables are listed in the review but never applied in this version, so they do not keep a hand-back open.
        const actionable = Object.values(r.items).filter((i) => i.section !== 'deliverables' && (i.state === 'pending' || i.state === 'failed' || i.state === 'applying')).length;
        if (actionable === 0 || waiting === 0 || !exists(r.notePath)) continue;
        // Failure is judged on the same items that keep the hand-back open.
        const failed = Object.values(r.items).some((i) => i.section !== 'deliverables' && i.state === 'failed');
        out.push({
            sourceId: r.id,
            group: 'handbacks',
            title: base(r.notePath),
            detail: String(actionable),
            ...(failed ? { heldReason: 'handback-item-failed' } : {}),
            actions: failed ? ['retry', 'open'] : ['review', 'open'],
            route: { type: 'handback', path: r.notePath },
        });
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
}

/** Tasks the export could not or did not send: failed, or routed with a stable reason. */
export function heldItems(approvals: readonly ApprovalRecord[]): ProcessItem[] {
    const out: ProcessItem[] = [];
    for (const record of approvals) {
        for (const t of record.tasks) {
            const stuck = (t.state === 'failed' && t.error !== 'conflict') || (t.state === 'routed' && t.error !== undefined);
            if (!stuck) continue;
            out.push({
                sourceId: t.id,
                group: 'held',
                title: t.text,
                ...(t.error ? { heldReason: t.error } : {}),
                actions: ['retry'],
                route: { type: 'command', id: 'send-tasks-to-google' },
            });
        }
    }
    return out;
}

/** The cap on rows drawn per group; the rest are counted, never dropped silently. */
export const MAX_ROWS_PER_GROUP = 50;

export function capRows(items: readonly ProcessItem[]): { shown: ProcessItem[]; more: number } {
    return { shown: items.slice(0, MAX_ROWS_PER_GROUP), more: Math.max(0, items.length - MAX_ROWS_PER_GROUP) };
}

