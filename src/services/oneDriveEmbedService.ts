/**
 * Vault-copy + refresh logic for the OneDrive-link "visual embed" extension
 * (brainstormed 2026-07-15, docs/completed/onedrive-link-insert.md).
 *
 * A picked local file (already a plain file on disk — no Graph API, no OAuth)
 * is copied into a plugin-managed vault folder so Obsidian can render it
 * natively (`![[file.pdf]]`) or open it in the system app on click
 * (`[[file.pptx]]`). The OneDrive-synced original stays the source of
 * truth; this is a manually-refreshed snapshot, never a live/auto-sync —
 * consistent with this feature's "cheap, no-auth" design (no permanent
 * link, no background polling).
 */
import type { App } from 'obsidian';
import { normalizePath, TFile } from 'obsidian';
import { getFs } from '../utils/desktopRequire';
import { ensureFolderExists, getAvailableFilePath, sanitizeFileName } from '../utils/minutesUtils';
import { logger } from '../utils/logger';
import { Result, ok, err } from '../core/result';
import type { OneDriveEmbedMarker } from '../ui/utils/oneDriveLinkUtils';

/** 25 MB — matches this codebase's existing "large attachment" ceiling
 *  (Kindle/audio-compression conventions); above it, callers should fall
 *  back to the plain `file://` link rather than duplicating a large file
 *  into the vault. */
export const ONEDRIVE_EMBED_MAX_BYTES = 25 * 1024 * 1024;

export const ONEDRIVE_EMBED_FOLDER = 'AI-Organiser/OneDrive Embeds';

export interface OneDriveEmbedCopy {
    vaultPath: string;
    mtimeMs: number;
}

/**
 * Copy `absolutePath` into the plugin's managed vault folder. Never throws —
 * every failure is a typed `Result.err`: `'desktop-only'` (no fs access,
 * e.g. mobile), `'too-large'` (over `ONEDRIVE_EMBED_MAX_BYTES`),
 * `'stat-failed'` / `'read-failed'` / `'write-failed'` (I/O errors).
 * Collision-safe naming reuses `getAvailableFilePath` for the same `(2)`,
 * `(3)`, ... suffixing convention used across the codebase.
 */
export async function copyOneDriveFileIntoVault(app: App, absolutePath: string): Promise<Result<OneDriveEmbedCopy>> {
    const fs = getFs();
    if (!fs) return err('desktop-only');

    let stat;
    try {
        stat = fs.statSync(absolutePath);
    } catch (error) {
        logger.warn('OneDriveEmbed', `Failed to stat ${absolutePath}: ${String(error)}`);
        return err('stat-failed');
    }
    if (stat.size > ONEDRIVE_EMBED_MAX_BYTES) return err('too-large');

    let bytes: ArrayBuffer;
    try {
        const buf = fs.readFileSync(absolutePath);
        // Buffer is a Uint8Array subclass — slice into a clean ArrayBuffer
        // (matches the conversion `audioImportService.ts` already uses for
        // the same fs-read → vault.createBinary handoff).
        bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    } catch (error) {
        logger.warn('OneDriveEmbed', `Failed to read ${absolutePath}: ${String(error)}`);
        return err('read-failed');
    }

    const fileName = sanitizeFileName(absolutePath.split(/[\\/]/).pop() ?? 'file');
    try {
        await ensureFolderExists(app.vault, ONEDRIVE_EMBED_FOLDER);
        const vaultPath = await getAvailableFilePath(app.vault, ONEDRIVE_EMBED_FOLDER, fileName);
        await app.vault.createBinary(vaultPath, bytes);
        return ok({ vaultPath: normalizePath(vaultPath), mtimeMs: stat.mtimeMs });
    } catch (error) {
        logger.warn('OneDriveEmbed', `Failed to write vault copy for ${absolutePath}: ${String(error)}`);
        return err('write-failed');
    }
}

/** A marker whose source file's mtime no longer matches the recorded one. */
export interface StaleOneDriveEmbed {
    marker: OneDriveEmbedMarker;
    currentMtimeMs: number;
}

/**
 * Check each marker's source file against its recorded mtime. Never throws —
 * a source that can no longer be stat'd (moved/deleted/desktop-only) is
 * silently excluded from the stale list (nothing to refresh it FROM), not
 * reported as an error; the caller's "no stale embeds" path already covers
 * that case gracefully.
 */
export function findStaleOneDriveEmbeds(markers: OneDriveEmbedMarker[]): StaleOneDriveEmbed[] {
    const fs = getFs();
    if (!fs) return [];
    const stale: StaleOneDriveEmbed[] = [];
    for (const marker of markers) {
        let stat;
        try {
            stat = fs.statSync(marker.source);
        } catch {
            continue; // source unreachable — nothing to refresh from
        }
        if (Math.round(stat.mtimeMs) !== Math.round(marker.mtimeMs)) {
            stale.push({ marker, currentMtimeMs: stat.mtimeMs });
        }
    }
    return stale;
}

/**
 * Re-read `stale.marker.source` and overwrite the SAME vault-copied file at
 * `stale.marker.vaultPath` (never re-derives a new collision-safe name —
 * refresh replaces in place). Never throws; typed `Result.err` on any I/O
 * failure, matching `copyOneDriveFileIntoVault`'s error vocabulary.
 */
export async function refreshOneDriveEmbed(app: App, stale: StaleOneDriveEmbed): Promise<Result<{ mtimeMs: number }>> {
    const fs = getFs();
    if (!fs) return err('desktop-only');

    let bytes: ArrayBuffer;
    try {
        const buf = fs.readFileSync(stale.marker.source);
        bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    } catch (error) {
        logger.warn('OneDriveEmbed', `Refresh: failed to read ${stale.marker.source}: ${String(error)}`);
        return err('read-failed');
    }

    const vaultFile = app.vault.getAbstractFileByPath(stale.marker.vaultPath);
    if (!(vaultFile instanceof TFile)) return err('vault-copy-missing');

    try {
        await app.vault.modifyBinary(vaultFile, bytes);
        return ok({ mtimeMs: stale.currentMtimeMs });
    } catch (error) {
        logger.warn('OneDriveEmbed', `Refresh: failed to overwrite ${stale.marker.vaultPath}: ${String(error)}`);
        return err('write-failed');
    }
}
