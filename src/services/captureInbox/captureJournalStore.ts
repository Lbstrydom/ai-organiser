/**
 * Persistence for the capture journal. The in-memory journal is the source of truth after `load()`;
 * every write goes through `updatePluginData`, which serialises with every other data-key writer and
 * always writes the LATEST in-memory journal, so overlapping saves cannot roll anything back.
 *
 * Observations (last-seen size/mtime) change on every file event, so they are persisted lazily on a
 * timer; a state change persists immediately.
 *
 * Every operation that can fail returns a `Result` (never throws past its contract). Failing CLOSED is
 * kept: while the stored journal is unreadable the store is not loaded and refuses every write, so
 * nothing runs on an empty journal that would reprocess (and recharge) every capture.
 */
import type { Plugin } from 'obsidian';
import { Result, ok, err } from '../../core/result';
import { updatePluginData } from '../../core/pluginDataStore';
import { logger } from '../../utils/logger';
import { decodeJournal } from './captureJournal';
import { emptyJournal, type CaptureJournal } from './captureTypes';

export const CAPTURE_JOURNAL_DATA_KEY = 'capture-inbox-journal';
/** Where an unreadable journal is kept (never deleted) when the user chooses to reset. */
export const CAPTURE_JOURNAL_BACKUP_DATA_KEY = 'capture-inbox-journal-backup';

/** How long a lazy (observation-only) change may wait before it is written. */
export const LAZY_PERSIST_MS = 5000;

/** Stable codes for the failures a caller can see (internal: user-facing text comes from the caller). */
export const JOURNAL_NOT_LOADED = 'capture-journal-not-loaded';
export const JOURNAL_UNSAVED = 'capture-journal-unsaved';
export const JOURNAL_CORRUPT = 'capture-journal-corrupt';
export const JOURNAL_TRANSFORM_FAILED = 'capture-journal-transform-failed';

type Listener = (journal: CaptureJournal) => void;

export class CaptureJournalStore {
    private journal: CaptureJournal = emptyJournal();
    private loaded = false;
    private corrupt: string | null = null;
    private dirty = false;
    private timer: number | null = null;
    private readonly inflight = new Set<Promise<boolean>>();
    private readonly listeners = new Set<Listener>();

    constructor(private readonly plugin: Plugin) {}

    /** False until `load()` has read the persisted journal. A consumer that needs it must fail closed. */
    isLoaded(): boolean {
        return this.loaded;
    }

    /** Why the stored journal could not be read, or null. While set the store is NOT loaded and refuses every write. */
    corruption(): string | null {
        return this.corrupt;
    }

    get(): CaptureJournal {
        return this.journal;
    }

    /** ok = the journal is loaded; err(`capture-journal-corrupt`) = it could not be read (see `corruption()` for why). */
    async load(): Promise<Result<CaptureJournal>> {
        let stored: unknown;
        try {
            // Read directly: a read that FAILED must not look like an empty file, or every capture would be handled again.
            const data = (await this.plugin.loadData()) as unknown;
            if (data !== null && data !== undefined && (typeof data !== 'object' || Array.isArray(data))) throw new Error('plugin data is not an object');
            stored = (data as Record<string, unknown> | null)?.[CAPTURE_JOURNAL_DATA_KEY];
        } catch (e) {
            return this.fail(`plugin data could not be read (${e instanceof Error ? e.message : 'unknown error'})`);
        }
        const decoded = decodeJournal(stored);
        if (decoded.status === 'corrupt') return this.fail(decoded.reason);
        this.corrupt = null;
        this.journal = decoded.journal;
        this.loaded = true;
        this.emit();
        return ok(this.journal);
    }

    /** Fail closed: nothing is decoded, nothing is overwritten, nothing runs. */
    private fail(reason: string): Result<CaptureJournal> {
        this.corrupt = reason;
        this.loaded = false;
        this.journal = emptyJournal();
        // Nothing scheduled before this point may write the (now empty) journal over the unreadable one.
        this.dirty = false;
        this.clearTimer();
        logger.error('CaptureInbox', `The capture journal could not be read (${reason}); the capture inbox is stopped`);
        return err(JOURNAL_CORRUPT);
    }

    /** The user's explicit choice: keep a copy of the unreadable journal (the last three), then start from an empty one. */
    async resetCorrupt(): Promise<Result<void>> {
        if (this.corrupt === null) return err('capture-journal-not-corrupt');
        try {
            await updatePluginData(this.plugin, (data) => {
                // Every unreadable journal is kept (the last three), never overwritten by the next reset.
                const earlier = Array.isArray(data[CAPTURE_JOURNAL_BACKUP_DATA_KEY]) ? (data[CAPTURE_JOURNAL_BACKUP_DATA_KEY] as unknown[]) : [];
                data[CAPTURE_JOURNAL_BACKUP_DATA_KEY] = [...earlier, { at: new Date().toISOString(), journal: data[CAPTURE_JOURNAL_DATA_KEY] ?? null }].slice(-3);
                data[CAPTURE_JOURNAL_DATA_KEY] = emptyJournal();
                return { changed: true };
            });
        } catch (e) {
            logger.error('CaptureInbox', 'Could not reset the capture journal', e);
            return err(JOURNAL_UNSAVED);
        }
        this.corrupt = null;
        this.journal = emptyJournal();
        this.loaded = true;
        this.emit();
        return ok(undefined);
    }

    subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /**
     * Apply a pure journal transform and persist it now. `durable` makes a failed save an error, for write-ahead markers
     * that crash recovery depends on; otherwise a failed save is logged, the in-memory journal stands and a later flush
     * retries. Before the journal has loaded nothing is applied (`capture-journal-not-loaded`).
     */
    async mutate(fn: (journal: CaptureJournal) => CaptureJournal, opts: { durable?: boolean } = {}): Promise<Result<CaptureJournal>> {
        if (!this.loaded) return err(JOURNAL_NOT_LOADED);
        const applied = this.apply(fn);
        if (!applied.ok) return applied;
        const next = applied.value;
        if (next === this.journal && !opts.durable) return ok(this.journal);
        this.journal = next;
        this.dirty = false;
        this.clearTimer();
        this.emit();
        const saved = await this.persist();
        if (!saved) this.dirty = true;
        if (!saved && opts.durable) return err(JOURNAL_UNSAVED);
        return ok(this.journal);
    }

    /** Apply a pure transform and persist it later (observation churn). */
    mutateLazy(fn: (journal: CaptureJournal) => CaptureJournal): Result<void> {
        if (!this.loaded) return err(JOURNAL_NOT_LOADED);
        const applied = this.apply(fn);
        if (!applied.ok) return applied;
        this.journal = applied.value;
        this.dirty = true;
        this.emit();
        if (this.timer === null) {
            this.timer = window.setTimeout(() => {
                this.timer = null;
                void this.flush();
            }, LAZY_PERSIST_MS);
        }
        return ok(undefined);
    }

    /** A throwing transform leaves the journal untouched and is an error, not a rejection. */
    private apply(fn: (journal: CaptureJournal) => CaptureJournal): Result<CaptureJournal> {
        try {
            return ok(fn(this.journal));
        } catch (e) {
            logger.error('CaptureInbox', 'A journal change failed and was not applied', e);
            return err(JOURNAL_TRANSFORM_FAILED);
        }
    }

    /** Write anything pending. A failed save leaves the journal dirty so the next flush retries it. */
    async flush(): Promise<Result<void>> {
        this.clearTimer();
        if (!this.dirty) {
            // A save already in flight is part of "everything pending": shutdown must not return before it ends.
            const saved = await Promise.all([...this.inflight]);
            return saved.every(Boolean) ? ok(undefined) : err(JOURNAL_UNSAVED);
        }
        this.dirty = false;
        if (await this.persist()) return ok(undefined);
        this.dirty = true;
        return err(JOURNAL_UNSAVED);
    }

    /** Stop timers and write anything pending. */
    async dispose(): Promise<void> {
        this.listeners.clear();
        const flushed = await this.flush();
        if (!flushed.ok) logger.warn('CaptureInbox', 'Pending journal changes could not be saved on shutdown');
    }

    private clearTimer(): void {
        if (this.timer !== null) {
            window.clearTimeout(this.timer);
            this.timer = null;
        }
    }

    private emit(): void {
        for (const listener of this.listeners) {
            try {
                listener(this.journal);
            } catch (e) {
                logger.warn('CaptureInbox', 'Journal listener failed', e);
            }
        }
    }

    private persist(): Promise<boolean> {
        const save = (async (): Promise<boolean> => {
            try {
                let skipped = false;
                await updatePluginData(this.plugin, (data) => {
                    // A save queued before a failed load runs after it: it must not write the emptied journal over the unreadable one.
                    if (!this.loaded) {
                        skipped = true;
                        return { changed: false };
                    }
                    data[CAPTURE_JOURNAL_DATA_KEY] = this.journal;
                    return { changed: true };
                });
                // A write that was refused is not a save: the caller must not read it as durable.
                return !skipped;
            } catch (e) {
                logger.error('CaptureInbox', 'Could not save the capture journal', e);
                return false;
            }
        })();
        this.inflight.add(save);
        void save.finally(() => this.inflight.delete(save));
        return save;
    }
}
