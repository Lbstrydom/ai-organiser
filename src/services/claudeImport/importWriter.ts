/**
 * The importer's only writes: create the destination folder and create a NEW note there with the exact bytes of the
 * original. Never overwrites, never modifies, moves or deletes an existing note; every write asserts writability first
 * (protected folders). Once a copy is created it belongs to the vault and to whatever reviews it next.
 */
import { TFile, TFolder } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { Result, ok, err } from '../../core/result';
import { assertWritable } from '../../core/protectedPaths';
import { logger } from '../../utils/logger';

export interface ImportVaultPort {
    /** The bytes of the file at `path`; 'none' when nothing is there; 'other' when it is a folder or cannot be read */
    fileBytes(path: string): Promise<Uint8Array | 'none' | 'other'>;
    /** Create the folder and any missing parents (each guarded) */
    ensureFolder(folder: string): Promise<Result<void>>;
    /** Exclusive create: refuses when anything is at the path. `exists` = something is there now */
    createBinary(path: string, bytes: Uint8Array): Promise<Result<void>>;
}

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/** The Obsidian-backed port. */
export function createImportVaultPort(plugin: AIOrganiserPlugin): ImportVaultPort {
    const { app } = plugin;
    return {
        async fileBytes(path) {
            const f = app.vault.getAbstractFileByPath(path);
            if (f === null) return 'none';
            if (!(f instanceof TFile)) return 'other';
            try {
                return new Uint8Array(await app.vault.readBinary(f));
            } catch {
                return 'other';
            }
        },
        async ensureFolder(folder) {
            const parts = folder.split('/');
            for (let i = 1; i <= parts.length; i++) {
                const path = parts.slice(0, i).join('/');
                const existing = app.vault.getAbstractFileByPath(path);
                if (existing instanceof TFolder) continue;
                if (existing !== null) return err('claude-import-destination-invalid');
                const allowed = assertWritable(plugin.settings, 'create', path);
                if (!allowed.ok) return err('claude-import-destination-protected');
                try {
                    await app.vault.createFolder(path);
                } catch (e) {
                    // Another writer may have made it in between; only a folder that still is not there is a failure.
                    if (!(app.vault.getAbstractFileByPath(path) instanceof TFolder)) {
                        logger.warn('ClaudeImport', `Could not create ${path}`, e);
                        return err('claude-import-destination-invalid');
                    }
                }
            }
            return ok(undefined);
        },
        async createBinary(path, bytes) {
            const allowed = assertWritable(plugin.settings, 'create', path);
            if (!allowed.ok) return err('claude-import-destination-protected');
            if (app.vault.getAbstractFileByPath(path) !== null) return err('exists');
            // A file synced to disk but not indexed yet must not be overwritten: ask the disk too. Obsidian's createBinary also
            // refuses a path it knows; together they leave only the instant between these awaits, never a known file.
            try {
                if (await app.vault.adapter.exists(path)) return err('exists');
            } catch {
                return err('claude-import-copy-failed');
            }
            try {
                await app.vault.createBinary(path, toArrayBuffer(bytes));
                return ok(undefined);
            } catch (e) {
                if (app.vault.getAbstractFileByPath(path) !== null) return err('exists');
                logger.warn('ClaudeImport', `Could not create ${path}`, e);
                return err('claude-import-copy-failed');
            }
        },
    };
}
