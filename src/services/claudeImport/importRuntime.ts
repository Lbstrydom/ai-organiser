/**
 * The Claude importer while Obsidian runs (desktop only): the command and the automatic look share one run at a time; a
 * run is bound to a generation, and turning the feature off, unloading, a device change or a change to any importer setting
 * ends it before its next write. Only the computer that owns the import (`claudeImportDeviceId`) imports; a manual run on a
 * computer with no owner yet claims it.
 */
import { FileSystemAdapter, Notice } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { Result, err } from '../../core/result';
import { isProtectedPath } from '../../core/protectedPaths';
import { describeError, formatGuidance } from '../../core/friendlyErrors';
import { logger } from '../../utils/logger';
import { isFeatureEnabled } from '../featureService';
import { nodeDeps, type NodeDeps } from '../offload/fingerprint';
import { deviceId } from '../operations/operationIndex';
import { getProjectService } from '../projects/projectService';
import { handbackActive } from '../aiWorkspaces/handbackService';
import { resolveSweepContexts } from '../inboxSweep/sweepContexts';
import { classifyHandoff } from './handoffRoute';
import { ImportLedgerStore } from './ledgerStore';
import { createImportVaultPort } from './importWriter';
import { resolveAmbiguous, runImport, type ImportReport, type ImportSnapshot, type Trigger } from './importService';

export type Ownership = 'this' | 'other' | 'none';

export interface RuntimeStatus {
    running: boolean;
    last: { at: number; report?: ImportReport; error?: string } | null;
    corrupt: boolean;
    ownership: Ownership;
}

/** The settings a run depends on; a change to any of them ends a running run. */
const snapshotOf = (plugin: AIOrganiserPlugin): string => JSON.stringify([
    isFeatureEnabled(plugin.settings, 'claude-import'),
    plugin.settings.claudeImportSourceFolder,
    plugin.settings.claudeImportDestination,
    plugin.settings.claudeImportMaxKB,
    plugin.settings.claudeImportStabilitySeconds,
    plugin.settings.claudeImportAutoMinutes,
    plugin.settings.claudeImportDeviceId,
]);

export class ClaudeImportRuntime {
    readonly store: ImportLedgerStore;
    private generation = 0;
    private inflight: Promise<Result<ImportReport>> | null = null;
    /** Every change to the import record (a run, a choice about an ambiguous copy, a reset) runs in this one queue */
    private queue: Promise<unknown> = Promise.resolve();
    private interval: number | null = null;
    private settleTimer: number | null = null;
    private loaded: Promise<unknown> | null = null;
    private last: RuntimeStatus['last'] = null;
    private settingsKey: string;
    private stopped = false;
    private readonly listeners = new Set<() => void>();

    constructor(private readonly plugin: AIOrganiserPlugin, private readonly deps: NodeDeps) {
        this.store = new ImportLedgerStore(plugin);
        this.settingsKey = snapshotOf(plugin);
    }

    private active(): boolean {
        return !this.stopped && isFeatureEnabled(this.plugin.settings, 'claude-import');
    }

    ownership(): Ownership {
        const owner = this.plugin.settings.claudeImportDeviceId;
        if (owner === '') return 'none';
        return owner === deviceId(this.plugin) ? 'this' : 'other';
    }

    status(): RuntimeStatus {
        return { running: this.inflight !== null, last: this.last, corrupt: this.store.corruption() !== null, ownership: this.ownership() };
    }

    subscribe(fn: () => void): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    private emit(): void {
        for (const fn of this.listeners) {
            try { fn(); } catch (e) { logger.warn('ClaudeImport', 'A status listener failed', e); }
        }
    }

    private ensureLoaded(): Promise<unknown> {
        if (!this.loaded) this.loaded = this.store.load();
        return this.loaded;
    }

    /** Load the record and arm the automatic look. Called once the workspace is ready. */
    start(): void {
        if (!this.active()) return;
        void this.ensureLoaded().then(() => {
            this.arm();
            if (this.ownership() === 'this') void this.run('background');
        });
    }

    private disarm(): void {
        if (this.interval !== null) window.clearInterval(this.interval);
        if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
        this.interval = null;
        this.settleTimer = null;
    }

    private arm(): void {
        this.disarm();
        const minutes = this.plugin.settings.claudeImportAutoMinutes;
        if (!this.active() || minutes <= 0 || this.plugin.settings.claudeImportSourceFolder.trim() === '') return;
        this.interval = window.setInterval(() => { void this.run('background'); }, minutes * 60_000);
    }

    /** Stop for good (plugin unload, feature off): the running run makes no further write. */
    stop(): void {
        this.stopped = true;
        this.generation++;
        this.disarm();
    }

    teardown(): void {
        this.stop();
    }

    /** After every settings save: a change that matters ends the running run and re-arms the timer. */
    afterSave(): void {
        const key = snapshotOf(this.plugin);
        if (key === this.settingsKey) return;
        this.settingsKey = key;
        this.generation++;
        this.arm();
        this.emit();
    }

    /** Run after everything already queued, whatever its outcome; never rejects past its Result. */
    private exclusive<T>(fn: () => Promise<Result<T>>): Promise<Result<T>> {
        const next = this.queue.then(fn, fn).catch((e: unknown): Result<T> => {
            logger.error('ClaudeImport', 'An import step failed', e);
            return err('claude-import-failed');
        });
        this.queue = next.then(() => undefined, () => undefined);
        return next;
    }

    /** Make this computer the one that imports. A save that fails puts the previous owner back. */
    async claim(): Promise<Result<void>> {
        const before = this.plugin.settings.claudeImportDeviceId;
        this.plugin.settings.claudeImportDeviceId = deviceId(this.plugin);
        try {
            await this.plugin.saveSettings();
            return { ok: true, value: undefined };
        } catch (e) {
            logger.error('ClaudeImport', 'Could not save which computer imports', e);
            this.plugin.settings.claudeImportDeviceId = before;
            return err('claude-import-failed');
        }
    }

    resetRecord(): Promise<Result<void>> {
        return this.exclusive(async () => {
            const res = await this.store.resetCorrupt();
            this.emit();
            return res;
        });
    }

    resolve(hash: string, choice: 'is-import' | 'fresh-copy'): Promise<Result<void>> {
        return this.exclusive(async () => {
            const res = await resolveAmbiguous(this.store, hash, choice, new Date().toISOString());
            this.emit();
            return res;
        });
    }

    /** One run. A second request while one runs gets the same run (the command) or nothing (the timer). */
    run(trigger: Trigger): Promise<Result<ImportReport>> {
        if (this.inflight) return trigger === 'manual' ? this.inflight : Promise.resolve(err('claude-import-busy-skip'));
        const p = this.exclusive(() => this.runOnce(trigger)).finally(() => {
            this.inflight = null;
            this.emit();
        });
        this.inflight = p;
        this.emit();
        return p;
    }

    private async runOnce(trigger: Trigger): Promise<Result<ImportReport>> {
        if (!this.active()) return err('claude-import-failed');
        const started = this.generation;
        await this.ensureLoaded();
        if (!this.store.isLoaded()) return this.finish(err('claude-import-ledger-corrupt'));
        // Something that ends runs happened while the record loaded: this one does not start.
        if (started !== this.generation || !this.active()) return err('claude-import-failed');
        const owner = this.ownership();
        if (owner === 'other') return this.finish(err('claude-import-other-device'));
        if (owner === 'none') {
            if (trigger !== 'manual') return err('claude-import-other-device');
            const claimed = await this.claim();
            if (!claimed.ok) return this.finish(claimed as Result<never>);
            if (this.ownership() !== 'this' || !this.active()) return this.finish(err('claude-import-other-device'));
        }
        const s = this.plugin.settings;
        const snapshot: ImportSnapshot = {
            sourceFolder: s.claudeImportSourceFolder,
            destination: s.claudeImportDestination,
            maxKB: s.claudeImportMaxKB,
            stabilitySeconds: s.claudeImportStabilitySeconds,
        };
        const gen = this.generation;
        const adapter = this.plugin.app.vault.adapter;
        const result = await runImport({
            deps: this.deps,
            vaultBase: adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null,
            notes: createImportVaultPort(this.plugin),
            ledger: this.store,
            settings: snapshot,
            isProtected: (path) => isProtectedPath(this.plugin.settings, path),
            configDir: this.plugin.app.vault.configDir,
            route: (text) => classifyHandoff(text, {
                reviewActive: handbackActive(this.plugin),
                index: getProjectService(this.plugin)?.index() ?? null,
                isProtected: (path) => isProtectedPath(this.plugin.settings, path),
                contexts: resolveSweepContexts(this.plugin.settings),
            }),
            now: () => Date.now(),
            // Ownership is checked on every write too: a rebind elsewhere that syncs in stops this run.
            alive: () => gen === this.generation && this.active() && this.ownership() === 'this',
        }, trigger);
        if (result.ok) this.afterRun(result.value);
        return this.finish(result);
    }

    private finish(result: Result<ImportReport>): Result<ImportReport> {
        this.last = result.ok ? { at: Date.now(), report: result.value } : { at: Date.now(), error: result.error };
        return result;
    }

    /** A background run speaks only when it did something or found a new problem; a settling file gets one more look. */
    private afterRun(report: ImportReport): void {
        if (report.nextReadyAt !== null && this.active()) {
            if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
            const delay = Math.max(1000, report.nextReadyAt - Date.now() + 1000);
            this.settleTimer = window.setTimeout(() => { this.settleTimer = null; void this.run('background'); }, delay);
        }
        if (report.trigger !== 'background') return;
        const t = this.plugin.t.claudeImport;
        const parts: string[] = [];
        if (report.imported.length > 0) parts.push(t.noticeImported.replace('{count}', String(report.imported.length)));
        const handbacks = report.imported.filter((i) => i.route.kind === 'routed').length;
        if (handbacks > 0) parts.push(t.noticeHandbacks.replace('{count}', String(handbacks)));
        if (report.newRefusals.length > 0) parts.push(t.noticeRefused.replace('{count}', String(report.newRefusals.length)));
        if (report.stoppedBy) parts.push(formatGuidance(describeError(this.plugin.t, report.stoppedBy)));
        if (parts.length > 0) new Notice(parts.join(' '), 8000);
    }
}

/** The runtime, or null on mobile or while the feature is off. */
export function createClaudeImportRuntime(plugin: AIOrganiserPlugin): ClaudeImportRuntime | null {
    if (!isFeatureEnabled(plugin.settings, 'claude-import')) return null;
    const deps = nodeDeps();
    return deps ? new ClaudeImportRuntime(plugin, deps) : null;
}
