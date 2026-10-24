/**
 * Persistence for the capture journal. The in-memory journal is the source of truth after `load()`;
 * every write goes through `updatePluginData`, which serialises with every other data-key writer and
 * always writes the LATEST in-memory journal, so overlapping saves cannot roll anything back.
 *
 * Observations (last-seen size/mtime) change on every file event, so they are persisted lazily on a
 * timer; a state change persists immediately.
 */
import type { Plugin } from 'obsidian';
import { updatePluginData } from '../../core/pluginDataStore';
import { logger } from '../../utils/logger';
import { decodeJournal } from './captureJournal';
import { emptyJournal, type CaptureJournal } from './captureTypes';

export const CAPTURE_JOURNAL_DATA_KEY = 'capture-inbox-journal';
/** Where an unreadable journal is kept (never deleted) when the user chooses to reset. */
export const CAPTURE_JOURNAL_BACKUP_DATA_KEY = 'capture-inbox-journal-backup';

/** How long a lazy (observation-only) change may wait before it is written. */
export const LAZY_PERSIST_MS = 5000;

type Listener = (journal: CaptureJournal) => void;

export class CaptureJournalStore {
    private journal: CaptureJournal = emptyJournal();
    private loaded = false;
    private corrupt: string | null = null;
    private dirty = false;
    private timer: number | null = null;
    private readonly listeners = new Set<Listener>();

    constructor(private readonly plugin: Plugin) {}

    /** False until `load()` has read the persisted journal. A consumer that needs it must fail closed. */
    isLoaded(): boolean {
        return this.loaded;
    }

    get(): CaptureJournal {
        return this.journal;
    }

    /** Why the stored journal could not be read, or null. While set the store is NOT loaded and refuses every write. */
    corruption(): string | null {
        return this.corrupt;
    }

    async load(): Promise<CaptureJournal> {
        let stored: unknown;
        try {
            // Read directly: a read that FAILED must not look like an empty file, or every capture would be handled again.
            const data = (await this.plugin.loadData()) as unknown;
            if (data !== null && data !== undefined && (typeof data !== 'object' || Array.isArray(data))) throw new Error('plugin data is not an object');
            stored = (data as Record<string, unknown> | null)?.[CAPTURE_JOURNAL_DATA_KEY];
        } catch (e) {
            this.corrupt = `plugin data could not be read (${e instanceof Error ? e.message : 'unknown error'})`;
            this.loaded = false;
            this.journal = emptyJournal();
            logger.error('CaptureInbox', `The capture journal could not be read (${this.corrupt}); the capture inbox is stopped`);
            return this.journal;
        }
        const decoded = decodeJournal(stored);
        if (decoded.status === 'corrupt') {
            // Fail closed: nothing is decoded, nothing is overwritten, nothing runs.
            this.corrupt = decoded.reason;
            this.loaded = false;
            this.journal = emptyJournal();
            logger.error('CaptureInbox', `The capture journal could not be read (${decoded.reason}); the capture inbox is stopped`);
            return this.journal;
        }
        this.corrupt = null;
        this.journal = decoded.journal;
        this.loaded = true;
        this.emit();
        return this.journal;
    }

    /** The user's explicit choice: keep a copy of the unreadable journal, then start from an empty one. */
    async resetCorrupt(): Promise<boolean> {
        if (this.corrupt === null) return false;
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
            return false;
        }
        this.corrupt = null;
        this.journal = emptyJournal();
        this.loaded = true;
        this.emit();
        return true;
    }

    subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /**
     * Apply a pure journal transform and persist it now. `durable` makes a failed save reject, for write-ahead
     * markers that crash recovery depends on; otherwise a failure is logged and the in-memory journal stands.
     */
    async mutate(fn: (journal: CaptureJournal) => CaptureJournal, opts: { durable?: boolean } = {}): Promise<CaptureJournal> {
        this.requireLoaded();
        const next = fn(this.journal);
        if (next === this.journal && !opts.durable) return this.journal;
        this.journal = next;
        this.dirty = false;
        this.clearTimer();
        this.emit();
        const saved = await this.persist();
        if (!saved) this.dirty = true;
        if (!saved && opts.durable) throw new Error('capture-journal-unsaved');
        return this.journal;
    }

    /** Apply a pure transform and persist it later (observation churn). */
    mutateLazy(fn: (journal: CaptureJournal) => CaptureJournal): void {
        this.requireLoaded();
        this.journal = fn(this.journal);
        this.dirty = true;
        this.emit();
        if (this.timer === null) {
            this.timer = window.setTimeout(() => {
                this.timer = null;
                void this.flush();
            }, LAZY_PERSIST_MS);
        }
    }

    async flush(): Promise<void> {
        this.clearTimer();
        if (!this.dirty) return;
        this.dirty = false;
        if (!(await this.persist())) this.dirty = true;
    }

    /** Stop timers and write anything pending. */
    async dispose(): Promise<void> {
        this.listeners.clear();
        await this.flush();
    }

    /** Writing before the stored journal was read would replace it with an empty one. */
    private requireLoaded(): void {
        if (!this.loaded) throw new Error('capture-journal-not-loaded');
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

    private async persist(): Promise<boolean> {
        try {
            await updatePluginData(this.plugin, (data) => {
                data[CAPTURE_JOURNAL_DATA_KEY] = this.journal;
                return { changed: true };
            });
            return true;
        } catch (e) {
            logger.error('CaptureInbox', 'Could not save the capture journal', e);
            return false;
        }
    }
}
