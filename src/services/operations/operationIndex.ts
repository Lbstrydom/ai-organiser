/**
 * The operation index: an in-memory list of operation summaries, one small file per operation in the plugin folder
 * (`operations/<opId>.json`, so two devices never overwrite each other's entries), reconciled with the domain journals.
 *
 * Domain journals stay authoritative. A journal step newer than its summary repairs the summary; a summary without a journal
 * is shown as orphaned; an unreadable journal is surfaced, never trusted. The weekly review and the Process view read only this
 * index (for execution and recovery summaries, never as the source of waiting work).
 *
 * Lazy and gated: storage is created only when the first operation is written, and the index exists only while a consumer
 * is enabled (`operationIndexActive`).
 */
import type AIOrganiserPlugin from '../../main';
import { Result, ok, err } from '../../core/result';
import { isFeatureEnabled } from '../featureService';
import { logger } from '../../utils/logger';
import {
    blockedBy, isFinished, otherDeviceRecentlyActive, ownsOperation, parseSummary, pruneSummaries, reconcileWithJournal, takeOver, viewOf,
    type JournalProbe, type OperationSummary, type OperationView, type Reconciled, type ViewContext,
} from './operationSummary';

/** The features that write operations. Each slice that adds a writer adds it here, once. Fail closed. */
export function operationIndexActive(settings: Parameters<typeof isFeatureEnabled>[0]): boolean {
    return isFeatureEnabled(settings, 'google-tasks-export');
}

/** Where summaries live. Tests fake it; the plugin uses the vault adapter on its own folder. */
export interface OperationStore {
    /** The file names present (never creates the folder) */
    list(): Promise<Result<string[]>>;
    read(file: string): Promise<Result<string>>;
    write(file: string, text: string): Promise<Result<void>>;
    remove(file: string): Promise<Result<void>>;
}

export type DeviceIdPort = { load(): string | null; save(id: string): void };

export type OperationChange = () => void;

export interface OperationIndexDeps {
    store: OperationStore;
    device: string;
    now?: () => number;
    /** Ask the owning domain journal what it says about an operation. Absent: summaries are taken as they are. */
    probe?: (s: OperationSummary) => Promise<JournalProbe>;
}

const fileOf = (opId: string): string => `${opId}.json`;

export class OperationIndex {
    private entries = new Map<string, OperationSummary>();
    private problems = new Map<string, Reconciled['kind']>();
    private live = new Set<string>();
    private listeners = new Set<OperationChange>();
    private loaded = false;
    /** Every load, publish and take-over runs one at a time, so an older write can never land after a newer one. */
    private queue: Promise<unknown> = Promise.resolve();

    constructor(private readonly deps: OperationIndexDeps) {}

    private now(): number {
        return (this.deps.now ?? Date.now)();
    }

    private ctx(): ViewContext {
        return { device: this.deps.device, now: this.now(), live: this.live };
    }

    private serial<T>(job: () => Promise<Result<T>>): Promise<Result<T>> {
        const run = this.queue.then(job, job).catch((e: unknown): Result<T> => {
            logger.warn('Operations', 'An operation step failed', e);
            return err('operation-store-unreadable');
        });
        this.queue = run;
        return run;
    }

    private notify(): void {
        for (const cb of this.listeners) {
            try { cb(); } catch (e) { logger.warn('Operations', 'A change listener failed', e); }
        }
    }

    subscribe(cb: OperationChange): () => void {
        this.listeners.add(cb);
        return () => { this.listeners.delete(cb); };
    }

    isLoaded(): boolean {
        return this.loaded;
    }

    /** What the store holds for one operation right now: the summary, null when absent, or an error when it cannot be told. */
    private async persisted(opId: string): Promise<Result<OperationSummary | null>> {
        const files = await this.deps.store.list();
        if (!files.ok) return err('operation-store-unreadable');
        if (!files.value.includes(fileOf(opId))) return ok(null);
        const text = await this.deps.store.read(fileOf(opId));
        if (!text.ok) return err('operation-store-unreadable');
        try {
            const parsed = parseSummary(JSON.parse(text.value));
            return parsed && parsed.opId === opId ? ok(parsed) : err('operation-store-unreadable');
        } catch {
            return err('operation-store-unreadable');
        }
    }

    /**
     * Read every summary, reconcile with the journals, prune finished entries past retention. Never throws. A summary that
     * cannot be READ makes the whole load fail and leaves the last trustworthy index as it was (an unreadable record is not an
     * absent one). A file that is readable but not a valid summary is ignored. A failed repair write or prune removal is logged
     * and the entry keeps its in-memory value; the next load tries again.
     */
    load(): Promise<Result<void>> {
        return this.serial(async () => {
            const files = await this.deps.store.list();
            if (!files.ok) return err('operation-store-unreadable');
            const next = new Map<string, OperationSummary>();
            const problems = new Map<string, Reconciled['kind']>();
            for (const file of files.value.filter((f) => f.endsWith('.json'))) {
                const text = await this.deps.store.read(file);
                if (!text.ok) return err('operation-store-unreadable');
                let parsed: OperationSummary | null = null;
                try { parsed = parseSummary(JSON.parse(text.value)); } catch { parsed = null; }
                if (!parsed || fileOf(parsed.opId) !== file) continue;
                let summary = parsed;
                if (this.deps.probe) {
                    const reconciled = reconcileWithJournal(parsed, await this.deps.probe(parsed));
                    summary = reconciled.summary;
                    if (reconciled.kind !== 'ok') problems.set(parsed.opId, reconciled.kind);
                    if (reconciled.kind === 'repaired') {
                        const repaired = await this.deps.store.write(file, JSON.stringify(summary));
                        if (!repaired.ok) logger.warn('Operations', `Could not save a repaired summary: ${file}`);
                    }
                }
                next.set(summary.opId, summary);
            }
            const kept = new Set(pruneSummaries([...next.values()], this.now()).map((x) => x.opId));
            for (const id of [...next.keys()].filter((k) => !kept.has(k))) {
                next.delete(id);
                const removed = await this.deps.store.remove(fileOf(id));
                if (!removed.ok) logger.warn('Operations', `Could not remove an expired summary: ${id}`);
            }
            this.entries = next;
            this.problems = problems;
            this.loaded = true;
            this.notify();
            return ok(undefined);
        });
    }

    /** Copies only: the index never hands out, or keeps, a caller's object. */
    list(): OperationSummary[] {
        return [...this.entries.values()].map((x) => structuredClone(x)).sort((a, b) => b.updatedAt - a.updatedAt);
    }

    get(opId: string): OperationSummary | null {
        const found = this.entries.get(opId);
        return found ? structuredClone(found) : null;
    }

    /**
     * Write or update a summary after a step boundary of its domain journal. Needs a loaded index; validates the summary the
     * way a load does; checks the owner against what the store holds NOW (another device may have taken the operation over
     * since this index was read) and refuses another device's operation.
     */
    publish(input: OperationSummary): Promise<Result<void>> {
        return this.serial(async () => {
            if (!this.loaded) return err('operation-not-loaded');
            // The same contract as a load: anything it would reject cannot be written.
            let summary: OperationSummary | null = null;
            try { summary = parseSummary(JSON.parse(JSON.stringify(input))); } catch { summary = null; }
            if (!summary) return err('operation-invalid');
            if (summary.device !== this.deps.device) return err('operation-not-owner');
            const stored = await this.persisted(summary.opId);
            if (!stored.ok) return err(stored.error);
            if (stored.value && !ownsOperation(stored.value, this.deps.device)) {
                this.entries.set(stored.value.opId, stored.value);
                this.notify();
                return err('operation-not-owner');
            }
            const written = await this.deps.store.write(fileOf(summary.opId), JSON.stringify(summary));
            if (!written.ok) return err('operation-store-unwritable');
            this.entries.set(summary.opId, summary);
            if (isFinished(summary)) this.live.delete(summary.opId); else this.live.add(summary.opId);
            this.problems.delete(summary.opId);
            this.notify();
            return ok(undefined);
        });
    }

    /** Unfinished operations of this device that are not running now: the weekly review offers their recovery. */
    interrupted(): OperationSummary[] {
        const ctx = this.ctx();
        return this.list().filter((s) => viewOf(s, ctx) === 'interrupted');
    }

    viewOf(opId: string): OperationView | null {
        const s = this.entries.get(opId);
        return s ? viewOf(s, this.ctx()) : null;
    }

    /** Why a summary needs a look beyond its status: orphaned, unreadable journal, repaired. */
    problemOf(opId: string): Reconciled['kind'] | null {
        return this.problems.get(opId) ?? null;
    }

    /** Another device's unfinished operations that overlap the resources a new operation wants. */
    blockedBy(resources: readonly string[]): OperationSummary[] {
        return blockedBy(this.list(), resources, this.ctx());
    }

    otherDeviceRecentlyActive(): boolean {
        return otherDeviceRecentlyActive(this.list(), this.ctx());
    }

    /** The explicit take-over: 24 hours without an update, and the user confirms the plugin is not running elsewhere. */
    takeOver(opId: string, confirmedNotRunningElsewhere: boolean): Promise<Result<OperationSummary>> {
        return this.serial(async () => {
            if (!this.loaded) return err('operation-not-loaded');
            // Decided against the store, not the cache: a take-over by a third device may have synced in.
            const stored = await this.persisted(opId);
            if (!stored.ok) return err(stored.error);
            if (!stored.value) return err('operation-not-found');
            this.entries.set(opId, stored.value);
            const decided = takeOver(stored.value, this.ctx(), confirmedNotRunningElsewhere);
            if (!decided.ok) return err(decided.error);
            const written = await this.deps.store.write(fileOf(opId), JSON.stringify(decided.summary));
            if (!written.ok) return err('operation-store-unwritable');
            this.entries.set(opId, decided.summary);
            this.notify();
            return ok(structuredClone(decided.summary));
        });
    }

    /** True when this device still owns the operation as far as the last read says (a take-over elsewhere shows after the next sync and load). */
    stillOwner(opId: string): boolean {
        return ownsOperation(this.entries.get(opId) ?? null, this.deps.device);
    }
}

// ─── The vault-adapter store and the plugin-scoped index ────────────────────────────────────────

/** Summaries in `<plugin folder>/operations/`; the folder is created by the first write only. */
export function adapterOperationStore(plugin: AIOrganiserPlugin): OperationStore | null {
    const base = plugin.manifest?.dir;
    if (!base) return null;
    const dir = `${base}/operations`;
    const adapter = plugin.app.vault.adapter;
    const guard = async <T>(work: () => Promise<T>): Promise<Result<T>> => {
        try { return ok(await work()); } catch (e) { logger.warn('Operations', 'Store operation failed', e); return err('operation-store-unreadable'); }
    };
    return {
        list: async () => {
            const exists = await guard(() => adapter.exists(dir));
            if (!exists.ok) return err(exists.error);
            if (!exists.value) return ok([]);
            const listed = await guard(() => adapter.list(dir));
            return listed.ok ? ok(listed.value.files.map((f) => f.slice(f.lastIndexOf('/') + 1))) : err(listed.error);
        },
        read: (file) => guard(() => adapter.read(`${dir}/${file}`)),
        write: async (file, text) => {
            const made = await guard(async () => { if (!(await adapter.exists(dir))) await adapter.mkdir(dir); });
            if (!made.ok) return err(made.error);
            return guard(() => adapter.write(`${dir}/${file}`, text));
        },
        remove: (file) => guard(() => adapter.remove(`${dir}/${file}`)),
    };
}

/** A random id per installation, kept in this device's local storage (never in synced data). */
export function deviceId(plugin: AIOrganiserPlugin): string {
    try {
        const saved: unknown = plugin.app.loadLocalStorage('ai-organiser-device');
        if (typeof saved === 'string' && /^[0-9a-f-]{8,}$/.test(saved)) return saved;
        const fresh = crypto.randomUUID();
        plugin.app.saveLocalStorage('ai-organiser-device', fresh);
        return fresh;
    } catch {
        return crypto.randomUUID();
    }
}

const indexes = new WeakMap<AIOrganiserPlugin, OperationIndex>();

/**
 * The operation index, or null while no consumer is enabled (nothing is created then, not even a folder). The probe is part of
 * the index and is set by whoever creates it first (the plugin start-up wiring); a later caller cannot replace it.
 */
export function getOperationIndex(plugin: AIOrganiserPlugin, probe?: OperationIndexDeps['probe']): OperationIndex | null {
    if (!operationIndexActive(plugin.settings)) return null;
    let index = indexes.get(plugin);
    if (!index) {
        const store = adapterOperationStore(plugin);
        if (!store) return null;
        index = new OperationIndex({ store, device: deviceId(plugin), probe });
        indexes.set(plugin, index);
    }
    return index;
}
