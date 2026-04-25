/**
 * Post-op metadata helper.
 *
 * Single seam called by every command that mutates note content
 * (summarize, translate, integrate, youtube-summarize). Owns the
 * post-write metadata refresh: status flip, word_count recalc,
 * and caller-supplied patch merge — all written atomically via
 * a single processFrontMatter call.
 *
 * Plan: docs/plans/post-op-metadata-helper.md
 */

import { TFile } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import {
    AIOMetadata,
    countWords,
    getAIOMetadata,
    updateAIOMetadata,
} from '../utils/frontmatterUtils';
import { logger } from '../utils/logger';

export interface MarkNoteProcessedOptions {
    /** Skip the pending → processed status flip (caller manages status itself). */
    skipStatusFlip?: boolean;
    /** Skip the word_count recalculation (e.g. content not yet flushed to vault). */
    skipWordCount?: boolean;
    /** Override the source of truth for word_count (use editor buffer when vault is stale). */
    contentForWordCount?: string;
}

/**
 * Post-op metadata refresh.
 *
 * Responsibilities:
 *   - Flip `status: pending` → `status: processed` (preserves `error`, custom values).
 *   - Recompute `word_count` from current note content.
 *   - Merge the resulting patch into frontmatter via a single
 *     `processFrontMatter` call (the merge step itself is atomic).
 *
 * Atomicity contract: only the FRONTMATTER MERGE is atomic. The status
 * decision and word_count derivation read state BEFORE the write, then
 * write — under concurrent edits to the same note, the helper follows
 * last-writer-wins semantics. This matches the plan §1.5 ordering contract:
 * commands write body first, await any pending editor flush, then call
 * this helper for a best-effort metadata refresh. Concurrent-edit races
 * during the read→write window are accepted (rare in practice — commands
 * complete before the user can mutate the same note manually).
 *
 * Gating: respects `plugin.settings.enableStructuredMetadata`.
 *
 * Returns: false if gating blocked the write or the underlying call failed;
 * true on successful merge. Failures are logged via the central logger and
 * never throw — callers may ignore the return value.
 */
export async function markNoteProcessed(
    plugin: AIOrganiserPlugin,
    file: TFile,
    patch: Partial<AIOMetadata> = {},
    options: MarkNoteProcessedOptions = {},
): Promise<boolean> {
    if (!plugin.settings.enableStructuredMetadata) return false;

    // Build derived defaults FIRST, then layer caller patch ON TOP so explicit
    // caller-supplied fields always win (G-WD-M6 — the helper is a merge utility,
    // not a status oracle). Caller-supplied `status: 'error'` must not be flipped.
    const derived: Partial<AIOMetadata> = {};

    if (!options.skipStatusFlip) {
        const current = getAIOMetadata(plugin.app, file);
        const currentStatus = current?.status;
        if (currentStatus === 'pending' || currentStatus === undefined) {
            derived.status = 'processed';
        }
    }

    if (!options.skipWordCount) {
        let content = options.contentForWordCount;
        if (content === undefined) {
            try {
                content = await plugin.app.vault.read(file);
            } catch (e) {
                // File deleted/moved during post-op — degrade gracefully.
                logger.warn('Metadata', `markNoteProcessed: vault.read failed for ${file.path}`, e);
                return false;
            }
        }
        derived.word_count = countWords(content);
    }

    // Caller patch layered on top — explicit fields override derived defaults.
    const fullPatch: Partial<AIOMetadata> = { ...derived, ...patch };

    let ok = false;
    try {
        ok = await updateAIOMetadata(plugin.app, file, fullPatch);
    } catch (e) {
        // Defensive — updateAIOMetadata already swallows errors, but caller
        // contract says we never propagate.
        logger.warn('Metadata', `markNoteProcessed: write threw for ${file.path}`, e);
        return false;
    }
    if (!ok) {
        logger.warn('Metadata', `markNoteProcessed write failed for ${file.path}`);
    }
    return ok;
}
