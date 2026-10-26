/**
 * The sweep export's side of the operation index: one summary per approval record (`sweep-export`), written after the export's own
 * step boundaries. The approval record in the plugin's data stays authoritative: the probe reads it, so a summary that lags is
 * repaired in memory and a summary whose record is gone is shown as orphaned.
 *
 * Best effort on purpose: the index is a view for the weekly review and the Process view. A failure here is logged and never
 * stops an export or changes its outcome.
 */
import type AIOrganiserPlugin from '../../main';
import { logger } from '../../utils/logger';
import { deviceId, getOperationIndex, type OperationIndex } from '../operations/operationIndex';
import type { JournalProbe, OperationStatus, OperationSummary } from '../operations/operationSummary';
import { isComplete, type ApprovalRecord } from './sweepLedger';

export const SWEEP_JOURNAL = 'sweep';

/** What the approval record says about its export right now. */
export function exportStatusOf(record: ApprovalRecord): OperationStatus {
    if (isComplete(record)) return 'done';
    // A task that failed, or that is held (routed but not sent), needs the user: it will not finish by itself.
    const stuck = record.tasks.some((t) => (t.state === 'failed' && t.error !== 'conflict') || (t.state === 'routed' && t.error !== undefined));
    return stuck ? 'needs-attention' : 'running';
}

/** The sweep record's resource keys, for overlap checks with another device. */
export function exportResources(record: ApprovalRecord): string[] {
    const keys = new Set<string>(['sweep-record']);
    for (const t of record.tasks) if (t.projectId) keys.add(`project:${t.projectId}`);
    return [...keys].slice(0, 32);
}

export function probeSweep(plugin: AIOrganiserPlugin): (s: OperationSummary) => Promise<JournalProbe> {
    return (s) => {
        const record = plugin.settings.sweepApprovals.find((r) => r.runId === s.recovery.key);
        if (!record) return Promise.resolve<JournalProbe>({ state: 'missing' });
        const at = Date.parse(record.createdAt);
        return Promise.resolve<JournalProbe>({ state: 'found', status: exportStatusOf(record), updatedAt: Number.isFinite(at) ? at : 0 });
    };
}

const loading = new WeakMap<AIOrganiserPlugin, Promise<OperationIndex | null>>();

/** The index, loaded once; null while no consumer is enabled or the store cannot be read. */
export function sweepOperationIndex(plugin: AIOrganiserPlugin): Promise<OperationIndex | null> {
    const index = getOperationIndex(plugin, probeSweep(plugin));
    if (!index) return Promise.resolve(null);
    if (index.isLoaded()) return Promise.resolve(index);
    // The in-flight load belongs to this plugin's index, never to another instance's.
    let pending = loading.get(plugin);
    if (!pending) {
        pending = index.load().then((res) => (res.ok ? index : null)).finally(() => { loading.delete(plugin); });
        loading.set(plugin, pending);
    }
    return pending;
}

/** Record the export's current state for this approval. Never throws, never blocks an export. */
export async function recordExportOperation(plugin: AIOrganiserPlugin, record: ApprovalRecord, device?: string): Promise<void> {
    try {
        const index = await sweepOperationIndex(plugin);
        if (!index) return;
        const existing = index.get(`op-${record.runId}`);
        const now = Date.now();
        const summary: OperationSummary = {
            opId: `op-${record.runId}`,
            kind: 'sweep-export',
            status: exportStatusOf(record),
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
            device: existing?.device ?? device ?? deviceId(plugin),
            recovery: { journal: SWEEP_JOURNAL, key: record.runId },
            resources: exportResources(record),
        };
        const res = await index.publish(summary);
        if (!res.ok && res.error !== 'operation-not-owner') logger.warn('Sweep', `Could not record the export operation (${res.error})`);
    } catch (e) {
        logger.warn('Sweep', 'Could not record the export operation', e);
    }
}
