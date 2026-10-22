/**
 * Vault upkeep runtime: connects the pure core to a live vault, owns the scheduler lifecycle and
 * remembers the last result.
 *
 * Nothing here writes a user note. The one automatic write is the opt-in rebuild of the agent-index
 * file, done by the existing signed publication. Everything else is a proposal.
 */
import { Notice, Platform, TFile } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { Result, ok, err } from '../../core/result';
import { PLUGIN_SECRET_IDS } from '../../core/secretIds';
import { isProtectedPath } from '../../core/protectedPaths';
import { isFeatureEnabled } from '../featureService';
import { logger } from '../../utils/logger';
import { buildAgentIndex, checkAgentIndex } from '../agentIndex/agentIndexService';
import { checkPair, hubNotePath, makeLister } from '../cloudInventory/cloudInventoryService';
import { validateScriptUrl } from '../appsScriptClient';
import { scanNotes } from '../embedScanService';
import { analyseDuplicates } from '../attachmentDuplicateService';
import { eligibilityFromScan } from '../attachmentEligibility';
import { IntervalJob, intervalMs, nextRunAt, type JobClock } from './intervalJob';
import {
    executeTasks,
    makeContext,
    proposalFingerprint,
    reviewCount,
    shouldNotify,
    toStored,
    type ExecutedRun,
    type ExecutionPolicy,
    type UpkeepConfigSnapshot,
} from './upkeepService';
import type { AttachmentFinding, InventoryCheck, Proposal, RunSummary, TaskName, UpkeepEnv } from './upkeepTasks';

const browserClock: JobClock = {
    now: () => Date.now(),
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (id) => window.clearInterval(id),
};

/** Which tasks can run now: their feature is on (and, for the Drive check, it is set up). */
export function availability(plugin: AIOrganiserPlugin): Record<TaskName, boolean> {
    const s = plugin.settings;
    return {
        agentIndex: isFeatureEnabled(s, 'agent-index'),
        inventories: isFeatureEnabled(s, 'cloud-inventory') && s.cloudInventoryPairs.length > 0 && validateScriptUrl(s.cloudInventoryScriptUrl).ok,
        attachments: isFeatureEnabled(s, 'embed-scan'),
    };
}

/** An immutable copy of the selections and options a run will use. */
export function snapshotConfig(plugin: AIOrganiserPlugin, tasks = plugin.settings.upkeepTasks): UpkeepConfigSnapshot {
    const s = plugin.settings;
    return {
        tasks: { ...tasks },
        available: availability(plugin),
        task: { autoRefreshIndex: s.upkeepAutoRefreshIndex, includeDuplicates: s.upkeepIncludeDuplicates, largeBytes: s.attachmentLargeFileMB * 1024 * 1024 },
    };
}

// ─── The vault, as the tasks see it ─────────────────────────────────────────

function buildEnv(plugin: AIOrganiserPlugin, config: UpkeepConfigSnapshot): UpkeepEnv {
    const app = plugin.app;
    return {
        checkIndex: async (ctx) => {
            const res = await checkAgentIndex(plugin, { signal: ctx.signal });
            if (!res.ok) return err(res.error);
            const r = res.value;
            return ok({ added: r.added.length, removed: r.removed.length, changed: r.changed.length, unreadable: r.unreadable, unstable: r.unstable, scopeChanged: r.scopeChanged, missing: r.missing, fresh: r.fresh });
        },
        refreshIndex: async (ctx) => {
            const res = await buildAgentIndex(plugin, { signal: ctx.signal });
            return res.ok ? ok({ path: res.value.path }) : err(res.error);
        },
        checkInventories: async (ctx) => {
            let secret: string | null = null;
            try {
                secret = await plugin.secretStorageService.getSecret(PLUGIN_SECRET_IDS.CLOUD_INVENTORY);
            } catch {
                secret = null;
            }
            if (!secret) return err('no-secret');
            const list = makeLister(plugin, secret, ctx.signal);
            const out: InventoryCheck[] = [];
            for (const pair of plugin.settings.cloudInventoryPairs) {
                if (ctx.signal.aborted || ctx.now() >= ctx.deadline) return err('cancelled');
                const hub = hubNotePath(pair, plugin.settings.protectedFolders);
                const res = await checkPair(plugin, pair, { list });
                out.push({ pairId: pair.id, hubPath: hub.ok ? hub.value : pair.vaultFolder, changed: res.ok && res.value.changed, failed: res.ok ? undefined : res.error });
            }
            return ok(out);
        },
        scanAttachments: async (ctx) => {
            const s = plugin.settings;
            const files = [...app.vault.getMarkdownFiles(), ...app.vault.getFiles().filter((f) => f.extension === 'canvas')];
            const scan = await scanNotes(app, files, { includeOrphans: true, signal: ctx.signal });
            if (scan.cancelled) return err('cancelled');
            const ambiguous = new Set(scan.ambiguousPaths ?? []);
            const failures = scan.coverageFailures ?? [];
            const attachments: AttachmentFinding[] = [];
            for (const t of scan.targets) {
                if (!t.file) continue;
                attachments.push({ path: t.file.path, sizeBytes: t.sizeBytes, referenceCount: t.references.length, unreferenced: false });
            }
            for (const f of scan.possiblyOrphaned) {
                const e = eligibilityFromScan({ path: f.path, size: f.stat.size, mtime: f.stat.mtime }, 0, ambiguous.has(f.path), failures, s.protectedFolders);
                attachments.push({ path: f.path, sizeBytes: f.stat.size, referenceCount: 0, unreferenced: e.eligible });
            }
            const notes = app.vault.getMarkdownFiles().filter((f) => !isProtectedPath(s.protectedFolders, f.path)).map((f) => f.path);
            let duplicates: string[][] = [];
            if (config.task.includeDuplicates) {
                const dup = await analyseDuplicates(
                    attachments.map((a) => ({ path: a.path, size: a.sizeBytes })),
                    { readBinary: async (path) => {
                        const file = app.vault.getAbstractFileByPath(path);
                        if (!(file instanceof TFile)) throw new Error('missing');
                        return app.vault.readBinary(file);
                    } },
                    { maxBytes: s.attachmentDuplicateMaxMB * 1024 * 1024, signal: ctx.signal },
                );
                if (!dup.ok) return err(dup.error);
                if (dup.value.cancelled) return err('cancelled');
                duplicates = dup.value.groups.map((g) => g.paths);
            }
            return ok({ attachments, notes, duplicates });
        },
    };
}

// ─── The controller ─────────────────────────────────────────────────────────

export interface UpkeepResult {
    summary: RunSummary;
    proposals: Proposal[];
    omitted: number;
}

/** Created once in onload. Owns the schedule, the mutex and the last result. */
export class UpkeepController {
    private job: IntervalJob;
    private timerIds: number[] = [];
    private listeners = new Set<(result: UpkeepResult) => void>();
    /** The last result, in memory (the persisted copy is capped; this one is what the review shows) */
    last: UpkeepResult | null = null;

    constructor(private readonly plugin: AIOrganiserPlugin, clock: JobClock = browserClock) {
        this.job = new IntervalJob({
            clock,
            config: () => {
                const s = plugin.settings;
                return {
                    intervalMs: isFeatureEnabled(s, 'vault-upkeep') ? intervalMs(s.upkeepInterval, s.upkeepCustomMinutes) : null,
                    lastAttemptEnd: Math.max(s.upkeepLastRun?.endedAt ?? -Infinity, this.lastFailedAt ?? -Infinity) === -Infinity ? null : Math.max(s.upkeepLastRun?.endedAt ?? -Infinity, this.lastFailedAt ?? -Infinity),
                    failures: s.upkeepFailures,
                };
            },
            canRun: () => this.contextAllows(),
            run: async () => { await this.execute('scheduled'); },
            onFailure: () => this.recordFailedAttempt(),
            onTimer: (id) => { this.timerIds.push(id); plugin.registerInterval(id); },
        });
    }

    /** When the last scheduled attempt ended without recording a run, so a failure still backs the schedule off */
    private lastFailedAt: number | null = null;

    private recordFailedAttempt(): void {
        this.lastFailedAt = Date.now();
        const s = this.plugin.settings;
        s.upkeepFailures = Math.min(100, s.upkeepFailures + 1);
    }

    /** The run in progress, so unloading can cancel it */
    private active: AbortController | null = null;

    /** Start (or restart) the schedule. A no-op when the feature or the interval is off. */
    start(): void { this.job.start(); }

    /** Stop the schedule and cancel a run that is in progress. */
    stop(): void {
        this.job.stop();
        this.active?.abort();
    }

    get running(): boolean { return this.job.running; }

    onResult(listener: (result: UpkeepResult) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** When the next automatic run is due, or null when automatic runs are off. */
    nextRun(): number | null {
        const s = this.plugin.settings;
        if (!isFeatureEnabled(s, 'vault-upkeep')) return null;
        return nextRunAt(s.upkeepLastRun?.endedAt ?? null, intervalMs(s.upkeepInterval, s.upkeepCustomMinutes), s.upkeepFailures, Date.now());
    }

    /** Page visible, mobile only with opt-in, and no interactive model work in flight. */
    private contextAllows(): boolean {
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return false;
        if (Platform.isMobile && !this.plugin.settings.upkeepRunOnMobile) return false;
        if (this.plugin.foregroundGate.isActive()) return false;
        return true;
    }

    /** A manual run. `err('upkeep-running')` when one is already active. */
    async runNow(): Promise<Result<UpkeepResult>> {
        if (!isFeatureEnabled(this.plugin.settings, 'vault-upkeep')) return err('upkeep-feature-off');
        const release = this.job.claim();
        if (!release) return err('upkeep-running');
        try {
            return await this.executeClaimed('manual');
        } finally {
            release();
        }
    }

    /** The scheduled path: the job already holds the mutex. */
    private async execute(trigger: 'scheduled'): Promise<void> {
        const res = await this.executeClaimed(trigger);
        // A run that never started (nothing selected, a thrown run) is still an attempt.
        if (!res.ok) this.recordFailedAttempt();
    }

    private async executeClaimed(trigger: 'manual' | 'scheduled'): Promise<Result<UpkeepResult>> {
        const s = this.plugin.settings;
        const config = snapshotConfig(this.plugin);
        if (!Object.values(config.tasks).some(Boolean)) return err('upkeep-no-tasks');
        const policy: ExecutionPolicy = { allowIndexPublish: s.upkeepAutoRefreshIndex, retainResult: true, notify: trigger === 'scheduled' };
        const ctl = new AbortController();
        this.active = ctl;
        const timer = window.setTimeout(() => ctl.abort(), s.upkeepRunCapSeconds * 1000);
        let run: ExecutedRun;
        try {
            run = await executeTasks(config, policy, trigger, buildEnv(this.plugin, config), makeContext(s.upkeepRunCapSeconds * 1000, () => Date.now(), ctl.signal));
        } catch (e) {
            logger.error('Upkeep', 'Run failed', e);
            return err('upkeep-task-failed');
        } finally {
            window.clearTimeout(timer);
            this.active = null;
        }
        const result = await this.retain(run, policy, trigger);
        return ok(result);
    }

    private async retain(run: ExecutedRun, policy: ExecutionPolicy, trigger: 'manual' | 'scheduled'): Promise<UpkeepResult> {
        const s = this.plugin.settings;
        const stored = toStored(run);
        const result: UpkeepResult = { summary: run.summary, proposals: run.proposals, omitted: stored.omitted };
        this.last = result;
        s.upkeepLastRun = { ...run.summary, endedAt: Date.now() };
        s.upkeepLastProposals = stored;
        s.upkeepFailures = run.summary.status === 'failed' && trigger === 'scheduled' ? Math.min(100, s.upkeepFailures + 1) : run.summary.status === 'failed' ? s.upkeepFailures : 0;
        const verdict = shouldNotify(run.summary, s.upkeepLastNotified, policy, run.proposals);
        if (verdict.kind === 'proposals') s.upkeepLastNotified = proposalFingerprint(run.summary, run.proposals);
        if (run.summary.status !== 'failed' && reviewCount(run.summary) === 0) s.upkeepLastNotified = '';
        try {
            await this.plugin.saveSettings();
        } catch (e) {
            logger.error('Upkeep', 'Could not save the upkeep result', e);
        }
        // A listener that throws must not turn a finished run into a failure.
        for (const l of this.listeners) {
            try { l(result); } catch (e) { logger.warn('Upkeep', 'A result listener failed', e); }
        }
        if (verdict.notify) this.announce(verdict.kind, reviewCount(run.summary));
        return result;
    }

    private announce(kind: 'proposals' | 'failure' | 'none', count: number): void {
        const t = this.plugin.t.vaultUpkeep;
        if (kind === 'none') return;
        const notice = new Notice('', 12000);
        notice.messageEl.empty();
        notice.messageEl.createSpan({ text: kind === 'failure' ? t.failedNotice : t.foundNotice.replace('{count}', String(count)) });
        const open = notice.messageEl.createEl('button', { text: t.openReview });
        open.addEventListener('click', () => {
            notice.hide();
            (this.plugin.app as unknown as { commands: { executeCommandById: (id: string) => void } }).commands.executeCommandById('ai-organiser:open-upkeep-review');
        });
    }
}

/** The setup's dry run: unsaved draft selections, no publishing, nothing retained or announced. */
export async function previewUpkeep(plugin: AIOrganiserPlugin, draftTasks: Record<TaskName, boolean>): Promise<Result<ExecutedRun>> {
    const s = plugin.settings;
    const ctl = new AbortController();
    const timer = window.setTimeout(() => ctl.abort(), s.upkeepRunCapSeconds * 1000);
    try {
        const config = snapshotConfig(plugin, draftTasks);
        return ok(await executeTasks(config, { allowIndexPublish: false, retainResult: false, notify: false }, 'preview', buildEnv(plugin, config), makeContext(s.upkeepRunCapSeconds * 1000, () => Date.now(), ctl.signal)));
    } catch (e) {
        logger.error('Upkeep', 'Preview failed', e);
        return err('upkeep-task-failed');
    } finally {
        window.clearTimeout(timer);
    }
}
