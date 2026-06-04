/**
 * SourceMetadataWriter (Cluster C / Phase 4).
 *
 * Derives the source-cleanup targets (which processed-source links/embeds to strip)
 * and contributes the References-section entries to a `NoteMutation`. Pure — it builds
 * data + composes the mutation; it never writes the note.
 *
 * Mirrors the legacy `handleMultiSourceResult` cleanup/reference logic exactly so the
 * `summaryParity` golden test holds.
 */

import type { NoteMutation } from '../noteEdit/noteMutation';
import type { SourceReference, NoteSourceType } from '../../utils/noteStructure';
import type { SelectedSources } from '../../ui/modals/MultiSourceModal';
import type { MultiSourceType, SourceOutcome } from './multiSourceTypes';

export interface CleanupTargets {
    /** External URLs / source links to remove from the body (successful, non-note). */
    urlsToRemove: string[];
    /** Vault file paths (successful pdf/audio/document) to remove; images stay as embeds. */
    vaultFilePaths: string[];
}

/**
 * Derive which processed sources to strip from the body. Identical for the success and
 * failure paths: the vault-path filter only ever matches pdf/audio/document paths, and
 * note (no url) / image (not in those groups) never affect that set.
 */
export function deriveCleanupTargets(outcomes: SourceOutcome[], sources: SelectedSources): CleanupTargets {
    const urlsToRemove = outcomes
        .filter((o) => o.processed.url && o.processed.type !== 'note' && o.processed.success)
        .map((o) => o.processed.url as string);

    const successUrls = new Set(urlsToRemove);
    const vaultFilePaths = [
        ...sources.pdfs.filter((p) => p.isVaultFile && successUrls.has(p.path)).map((p) => p.path),
        ...sources.audio.filter((a) => a.isVaultFile && successUrls.has(a.path)).map((a) => a.path),
        ...sources.documents.filter((d) => d.isVaultFile && successUrls.has(d.path)).map((d) => d.path),
        // Images are NOT removed — they remain useful as visual embeds.
    ];

    return { urlsToRemove, vaultFilePaths };
}

/** Map a processed-source type to its References label type (1:1 today; explicit for parity). */
function toReferenceType(type: MultiSourceType): NoteSourceType {
    switch (type) {
        case 'web': return 'web';
        case 'youtube': return 'youtube';
        case 'pdf': return 'pdf';
        case 'audio': return 'audio';
        case 'document': return 'document';
        case 'image': return 'image';
        case 'note': return 'note';
    }
}

/**
 * Add a References entry for each successful source carrying a URL, in processing
 * order. `vaultFilePaths` (the cleanup set) determines internal vs external linking.
 * Mutates the passed `NoteMutation` in place (fluent), returns it for chaining.
 */
export function addSourceReferences(
    mutation: NoteMutation,
    outcomes: SourceOutcome[],
    vaultFilePaths: Set<string>,
): NoteMutation {
    for (const { processed } of outcomes) {
        if (processed.url && processed.success) {
            const ref: SourceReference = {
                type: toReferenceType(processed.type),
                title: processed.title,
                link: processed.url,
                date: processed.date,
                isInternal: vaultFilePaths.has(processed.url),
            };
            mutation.addReference(ref);
        }
    }
    return mutation;
}
