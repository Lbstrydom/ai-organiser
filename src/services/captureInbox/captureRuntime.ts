/**
 * The orchestrator: one mutex, one scan -> sync -> process pipeline, and the rule that file events
 * and "opened Obsidian" are only reasons to look, never reasons to spend money.
 *
 *  - `refresh()`  scans and settles stability. It never calls a provider.
 *  - `runOnce()`  refresh + process, one job at a time. Started by the user, or by the opt-in
 *                 process-when-opened path (bounded per run, spaced apart, and only after the user
 *                 confirmed a manual run once).
 *  - `cancel()`   stops between jobs and stages; an in-flight provider call finishes and its result
 *                 is discarded (none of them accept an abort signal).
 *
 * The runtime takes an injected `isEnabled()`, so turning the feature off makes every entry point a
 * no-op without needing a main.ts edit.
 */
import type { Result } from '../../core/result';
import { logger } from '../../utils/logger';
import { reconcile } from './captureJournal';
import { runJobs, syncEntries, type CaptureDeps, type RunSummary } from './captureProcessor';
import { CAPTURE_FILE_MISSING, scanInbox, type ScanOutcome } from './captureScanner';
import { finishBareAccept, noteHasBlockFor, retryPendingWrites, type WriterDeps } from './captureWriter';

/** Automatic runs are spaced at least this far apart. */
export const MIN_AUTO_INTERVAL_MS = 15 * 60 * 1000;
/** File events are coalesced for this long before a refresh. */
export const HINT_DEBOUNCE_MS = 2000;

export interface RuntimeDeps extends CaptureDeps {
    writer: WriterDeps;
    /** Obsidian is in the foreground (mobile runs only while visible) */
    isVisible(): boolean;
    /** The run precondition (an inbox, a keep-out rule, a provider...): null when a run may start */
    blocker(): string | null;
    /** The user confirmed a manual run once; automatic runs never start before it */
    autoRunAllowed(): boolean;
}

export type RunTrigger = 'manual' | 'auto';

export interface RunOptions {
    trigger: RunTrigger;
    /** "Process all existing": ignore the setup cutoff for this run */
    includeExisting?: boolean;
}

export interface RunResult {
    summary: RunSummary;
    scan: ScanOutcome;
}

const yieldTick = (): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, 0));

export class CaptureRuntime {
    private running = false;
    private cancelFlag = false;
    private hintTimer: number | null = null;
    private lastAutoRun = 0;
    /** A file event arrived while a run was active: look again when it ends. */
    private hintPending = false;
    private disposed = false;

    constructor(private readonly deps: RuntimeDeps) {}

    isRunning(): boolean {
        return this.running;
    }

    cancel(): void {
        this.cancelFlag = true;
    }

    dispose(): void {
        this.disposed = true;
        this.cancelFlag = true;
        if (this.hintTimer !== null) window.clearTimeout(this.hintTimer);
        this.hintTimer = null;
    }

    private usable(): boolean {
        return !this.disposed && this.deps.isEnabled();
    }

    /** A file event that arrived during a run is looked at once the run is over. */
    private replayHint(): void {
        if (!this.hintPending) return;
        this.hintPending = false;
        this.hint();
    }

    /** A file event in an inbox folder: a hint to look soon. Never starts processing. */
    hint(): void {
        if (!this.usable() || this.hintTimer !== null) return;
        this.hintTimer = window.setTimeout(() => {
            this.hintTimer = null;
            void this.refresh();
        }, HINT_DEBOUNCE_MS);
    }

    private scan(includeExisting?: boolean): Promise<Result<ScanOutcome>> {
        const { deps } = this;
        return scanInbox(deps.vault, {
            config: deps.config(),
            policy: deps.policy(),
            journal: deps.journal.get(),
            isSwept: (path, text) => deps.isSwept(path, text),
            includeExisting,
        });
    }

    /** Scan and settle stability. Calls no provider, so it is safe to run on every hint. */
    async refresh(): Promise<ScanOutcome | null> {
        if (!this.usable() || !this.deps.isVisible()) return null;
        if (this.running) {
            this.hintPending = true;
            return null;
        }
        this.running = true;
        try {
            const scanned = await this.scan();
            if (!scanned.ok) {
                logger.warn('CaptureInbox', `Refresh skipped (${scanned.error})`);
                return null;
            }
            const scan = scanned.value;
            // A hint is not proof that a sync finished: an old mtime does not count as stable here.
            await syncEntries(this.deps, scan, { trustMtime: false });
            return scan;
        } catch (e) {
            logger.warn('CaptureInbox', 'Refresh failed', e);
            return null;
        } finally {
            this.running = false;
            this.replayHint();
        }
    }

    /** Scan, settle and process. Returns null when another run is active, the feature is off, or an automatic run is not allowed yet. */
    async runOnce(opts: RunOptions): Promise<RunResult | null> {
        const { deps } = this;
        if (!this.usable() || this.running || !deps.isVisible()) return null;
        // Every start, manual or automatic, needs the same precondition: emptying the keep-out rules after the first
        // confirmed run must not let a later automatic run upload.
        if (deps.blocker() !== null) return null;
        const config = deps.config();
        if (opts.trigger === 'auto') {
            if (!deps.autoRunAllowed() || !config.onOpen) return null;
            if (deps.now() - this.lastAutoRun < MIN_AUTO_INTERVAL_MS) return null;
            this.lastAutoRun = deps.now();
        }
        this.running = true;
        this.cancelFlag = false;
        try {
            // "Process all existing" is a manual choice; an automatic run never widens its own scope.
            const scanned = await this.scan(opts.trigger === 'manual' ? opts.includeExisting : false);
            if (!scanned.ok) {
                logger.error('CaptureInbox', `Run skipped (${scanned.error})`);
                return null;
            }
            const scan = scanned.value;
            await syncEntries(deps, scan);
            await yieldTick();
            const limit = opts.trigger === 'auto' ? Math.min(config.onOpenMaxPerRun, config.maxPerRun) : config.maxPerRun;
            const summary = await runJobs(deps, scan, { cancelled: () => this.cancelFlag }, limit);
            return { summary, scan };
        } catch (e) {
            logger.error('CaptureInbox', 'Run failed', e);
            return null;
        } finally {
            this.running = false;
            this.replayHint();
        }
    }

    /**
     * Startup recovery. Only `processing` entries become failed, and the only write that can run is the
     * Accept write that was in flight at the crash (`accept_pending_write`).
     */
    async recoverOnStart(): Promise<void> {
        const { deps } = this;
        // Recovery shares the mutex: a run in flight must not have its `processing` entries failed under it.
        if (!this.usable() || this.running) return;
        this.running = true;
        try {
            const probes = new Map<string, boolean | undefined>();
            const completedBare: Array<{ id: string; path: string }> = [];
            for (const entry of Object.values(deps.journal.get().entries)) {
                if (entry.state !== 'accept_pending_write') continue;
                const uid = entry.uid ?? entry.id;
                let path: string | null = entry.id;
                if (entry.hasNote === false) {
                    path = entry.companionPath && deps.port.exists(entry.companionPath) ? entry.companionPath : deps.writer.port.findNoteByFrontmatter('capture-id', uid);
                }
                if (!path) {
                    probes.set(entry.id, false);
                    continue;
                }
                const read = await deps.vault.readText(path);
                if (!read.ok) {
                    // A note that is gone has no block: the write is retried and, finding no note, goes back to review. A read that merely failed is undecided, so reconcile leaves it for a later start.
                    probes.set(entry.id, read.error === CAPTURE_FILE_MISSING ? false : undefined);
                    continue;
                }
                const present = noteHasBlockFor(read.value, uid);
                probes.set(entry.id, present);
                if (present && entry.hasNote === false) completedBare.push({ id: entry.id, path });
            }
            // A bare-media Accept that reached the companion note must also complete its journal half, or the
            // companion would be offered as a brand new capture.
            for (const done of completedBare) await finishBareAccept(deps.writer, done.id, done.path, 'none');
            let retry: string[] = [];
            const reconciled = await deps.journal.mutate((journal) => {
                const result = reconcile(journal, (id) => probes.get(id), deps.now());
                retry = result.retryWrites;
                return result.journal;
            });
            if (!reconciled.ok) {
                // Nothing was recorded, so nothing is retried: the next start decides again from the same journal.
                logger.warn('CaptureInbox', `Recovery could not update the journal (${reconciled.error})`);
                return;
            }
            if (retry.length > 0) await retryPendingWrites(deps.writer, retry);
        } finally {
            this.running = false;
        }
    }
}
