/**
 * Vault file scope (D9 — picker prioritises files embedded in the meeting note).
 *
 * Solves the user's complaint about wading through 1000+ files in `99 File
 * Storage`. The picker now defaults to "Files in this note" using
 * metadata-cache-derived embeds/links, with a radio toggle to expand
 * to "All vault files".
 *
 * `sourceFile` is REQUIRED and captured at modal `onOpen` (R2-M6) —
 * we never rely on the workspace's current active file because focus
 * may change while the modal is open.
 */

import { type App, type TFile } from 'obsidian';

export type VaultFileScope = 'active-note' | 'all-vault';

export interface ScopedFileResult {
    scope: VaultFileScope;
    files: TFile[];
    /** Count of in-note files matching the role filter, regardless of selected scope. */
    activeNoteCount: number;
    /** Count of all-vault files matching the role filter, regardless of selected scope. */
    vaultCount: number;
}

/**
 * Build the radio label for the picker header.
 * `null` sourceFile = no in-note count available; only "All vault files" makes sense.
 */
export function getScopedFiles(
    app: App,
    sourceFile: TFile | null,
    scope: VaultFileScope,
    roleFilter: (f: TFile) => boolean,
): ScopedFileResult {
    const allVaultFiles = app.vault.getFiles().filter(roleFilter);

    if (!sourceFile) {
        return {
            scope: 'all-vault',
            files: allVaultFiles,
            activeNoteCount: 0,
            vaultCount: allVaultFiles.length,
        };
    }

    const noteFiles = collectFilesReferencedInNote(app, sourceFile, roleFilter);
    const activeNoteCount = noteFiles.length;
    const vaultCount = allVaultFiles.length;

    // Graceful fallback: if scope='active-note' but no in-note files match the role,
    // default to all-vault so the user isn't stuck with an empty list.
    const effectiveScope: VaultFileScope =
        scope === 'active-note' && activeNoteCount > 0 ? 'active-note' : 'all-vault';

    return {
        scope: effectiveScope,
        files: effectiveScope === 'active-note' ? noteFiles : allVaultFiles,
        activeNoteCount,
        vaultCount,
    };
}

/**
 * Collect TFiles referenced in `sourceFile` via embeds + wiki-links +
 * markdown links, filtered by role. Uses metadataCache for parsing.
 */
function collectFilesReferencedInNote(
    app: App,
    sourceFile: TFile,
    roleFilter: (f: TFile) => boolean,
): TFile[] {
    const cache = app.metadataCache.getFileCache(sourceFile);
    if (!cache) return [];

    const linkPaths: string[] = [];
    if (cache.embeds) {
        for (const e of cache.embeds) linkPaths.push(e.link);
    }
    if (cache.links) {
        for (const l of cache.links) linkPaths.push(l.link);
    }

    const resolved: TFile[] = [];
    const seenPaths = new Set<string>();
    for (const link of linkPaths) {
        // Strip any anchor / block reference
        const cleanLink = link.split('#')[0].split('^')[0];
        if (!cleanLink) continue;
        const file = app.metadataCache.getFirstLinkpathDest(cleanLink, sourceFile.path);
        if (!file) continue;
        if (seenPaths.has(file.path)) continue;
        if (!roleFilter(file)) continue;
        seenPaths.add(file.path);
        resolved.push(file);
    }

    return resolved;
}

/**
 * Default scope for a fresh picker — `'active-note'` when there are
 * in-note files matching the role, otherwise `'all-vault'`.
 */
export function pickDefaultScope(activeNoteCount: number): VaultFileScope {
    return activeNoteCount > 0 ? 'active-note' : 'all-vault';
}
