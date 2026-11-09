/**
 * Persistence of the import record (data-only key `claude-import-ledger`). Fails CLOSED: while the stored record cannot be
 * read the store is not loaded and refuses every save, so no run happens on an empty record (that would copy every file in
 * the folder again). Every operation returns a `Result`; nothing throws past this boundary.
 *
 * A save replaces the in-memory record only after the data file was written, so a failed save leaves the record that is
 * really on disk: the write-ahead marker of a copy is either saved or the copy is not made.
 */
import type { Plugin } from 'obsidian';
import { Result, ok, err } from '../../core/result';
import { updatePluginData } from '../../core/pluginDataStore';
import { logger } from '../../utils/logger';
import { decodeLedger, emptyLedger, type ImportLedger } from './importLedger';

export const IMPORT_LEDGER_DATA_KEY = 'claude-import-ledger';
/** Unreadable records kept by a reset (the last three), never deleted. */
export const IMPORT_LEDGER_BACKUP_DATA_KEY = 'claude-import-ledger-backup';

/** What the import service needs from the store. */
export interface LedgerPort {
    get(): ImportLedger;
    save(next: ImportLedger): Promise<Result<void>>;
}

export class ImportLedgerStore implements LedgerPort {
    private ledger: ImportLedger = emptyLedger();
    private loaded = false;
    private corrupt: string | null = null;

    constructor(private readonly plugin: Plugin) {}

    isLoaded(): boolean {
        return this.loaded;
    }

    corruption(): string | null {
        return this.corrupt;
    }

    get(): ImportLedger {
        return this.ledger;
    }

    async load(): Promise<Result<ImportLedger>> {
        let stored: unknown;
        try {
            const data = (await this.plugin.loadData()) as unknown;
            if (data !== null && data !== undefined && (typeof data !== 'object' || Array.isArray(data))) throw new Error('plugin data is not an object');
            stored = (data as Record<string, unknown> | null)?.[IMPORT_LEDGER_DATA_KEY];
        } catch (e) {
            return this.fail(`plugin data could not be read (${e instanceof Error ? e.message : 'unknown error'})`);
        }
        const decoded = decodeLedger(stored);
        if (decoded.status === 'corrupt') return this.fail(decoded.reason);
        this.corrupt = null;
        this.ledger = decoded.ledger;
        this.loaded = true;
        return ok(this.ledger);
    }

    private fail(reason: string): Result<ImportLedger> {
        logger.error('ClaudeImport', `The import record could not be read: ${reason}`);
        this.corrupt = reason;
        this.loaded = false;
        return err('claude-import-ledger-corrupt');
    }

    async save(next: ImportLedger): Promise<Result<void>> {
        if (!this.loaded) return err(this.corrupt !== null ? 'claude-import-ledger-corrupt' : 'claude-import-ledger-unsaved');
        try {
            const written = await updatePluginData<boolean>(this.plugin, (data) => {
                // The data file as it is NOW (inside the serialized write): one that is not an object is not overwritten.
                if (typeof data !== 'object' || data === null || Array.isArray(data)) return { changed: false, value: false };
                data[IMPORT_LEDGER_DATA_KEY] = next;
                return { changed: true, value: true };
            });
            if (written !== true) return err('claude-import-ledger-unsaved');
        } catch (e) {
            logger.error('ClaudeImport', 'Could not save the import record', e);
            return err('claude-import-ledger-unsaved');
        }
        this.ledger = JSON.parse(JSON.stringify(next)) as ImportLedger;
        return ok(undefined);
    }

    /** Start an empty record after keeping a copy of the unreadable one. Only while it is unreadable. */
    async resetCorrupt(): Promise<Result<void>> {
        if (this.corrupt === null) return err('claude-import-ledger-unsaved');
        try {
            const done = await updatePluginData<boolean>(this.plugin, (data) => {
                // A data file that is not an object cannot be repaired here: nothing is written and the reset reports failure.
                if (typeof data !== 'object' || data === null || Array.isArray(data)) return { changed: false, value: false };
                const earlier = Array.isArray(data[IMPORT_LEDGER_BACKUP_DATA_KEY]) ? (data[IMPORT_LEDGER_BACKUP_DATA_KEY] as unknown[]) : [];
                data[IMPORT_LEDGER_BACKUP_DATA_KEY] = [...earlier, { at: new Date().toISOString(), ledger: data[IMPORT_LEDGER_DATA_KEY] ?? null }].slice(-3);
                data[IMPORT_LEDGER_DATA_KEY] = emptyLedger();
                return { changed: true, value: true };
            });
            if (done !== true) return err('claude-import-ledger-unsaved');
        } catch (e) {
            logger.error('ClaudeImport', 'Could not reset the import record', e);
            return err('claude-import-ledger-unsaved');
        }
        this.corrupt = null;
        this.ledger = emptyLedger();
        this.loaded = true;
        return ok(undefined);
    }
}
