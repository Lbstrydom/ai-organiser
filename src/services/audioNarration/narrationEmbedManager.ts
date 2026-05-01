/**
 * Narration embed manager — manages the `🎧 ![[narration.mp3]]` block in the
 * source note via HTML-comment markers.
 *
 * Single function `syncEmbed(app, file, mp3Path, enabled)`:
 *   - enabled=true:  upsert the managed block
 *   - enabled=false: remove any existing managed block (no-op if absent)
 *
 * Re-reads vault content INSIDE the function — protects user edits made
 * during the multi-minute TTS run (concurrency safety / TOCTOU).
 */

import { App, TFile } from 'obsidian';
import { logger } from '../../utils/logger';
import { errFrom, ok, makeError } from './narrationTypes';
import type { Result } from '../../core/result';

export const EMBED_START = '<!-- AIO-NARRATION:START -->';
export const EMBED_END = '<!-- AIO-NARRATION:END -->';

const EMBED_BLOCK_RE = /<!--\s*AIO-NARRATION:START\s*-->[\s\S]*?<!--\s*AIO-NARRATION:END\s*-->/;
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\n---\r?\n?/;

export interface EmbedBlockLocation {
    start: number;
    end: number;
}

/** Find the managed block in raw content. Returns indices (start, end exclusive) or null. */
export function findEmbedBlock(content: string): EmbedBlockLocation | null {
    const m = EMBED_BLOCK_RE.exec(content);
    if (!m) return null;
    return { start: m.index, end: m.index + m[0].length };
}

function buildBlock(mp3Path: string): string {
    return `${EMBED_START}\n🎧 ![[${mp3Path}]]\n${EMBED_END}`;
}

/**
 * Insert or replace the managed narration block (when enabled=true), or
 * remove it (when enabled=false). Returns ok on success, EMBED_FAILED if
 * the file became unreadable mid-flight.
 *
 * Concurrency safety (audit H10):
 *   1. Snapshot file.stat.mtime BEFORE read.
 *   2. Re-read fresh content inside the function (TOCTOU mitigation).
 *   3. Re-check stat.mtime BEFORE write — if it changed during our compute
 *      window, the user (or another plugin) edited the note. Abort with
 *      EMBED_FAILED rather than overwriting their changes.
 *   4. Use app.vault.process() when available (Obsidian 1.4+) for additional
 *      lock-protected write — falls back to vault.modify() on older versions.
 */
export async function syncEmbed(
    app: App,
    file: TFile,
    mp3Path: string,
    enabled: boolean,
): Promise<Result<void>> {
    const mtimeAtStart = file.stat?.mtime;
    let content: string;
    try {
        content = await app.vault.read(file);
    } catch (e) {
        const err = makeError('EMBED_FAILED', `Failed to read note for embed sync: ${describeError(e)}`, e);
        logger.warn('AudioNarration', err.message);
        return errFrom<void>(err);
    }

    const existing = findEmbedBlock(content);
    let updated: string | null = null;

    if (enabled) {
        const block = buildBlock(mp3Path);
        if (existing) {
            // Replace in place (preserves block position)
            updated = content.slice(0, existing.start) + block + content.slice(existing.end);
        } else {
            // Insert after frontmatter, before any other content
            const fmMatch = FRONTMATTER_RE.exec(content);
            if (fmMatch) {
                const insertAt = fmMatch[0].length;
                const sep = content.slice(insertAt).startsWith('\n') ? '' : '\n';
                updated = content.slice(0, insertAt) + sep + block + '\n\n' + content.slice(insertAt).replace(/^\n+/, '');
            } else {
                // No frontmatter — prepend
                updated = block + '\n\n' + content.replace(/^\n+/, '');
            }
        }
    } else {
        // enabled=false → remove if present
        if (!existing) return ok(undefined);
        // Trim a trailing blank line that may surround the block
        let removeStart = existing.start;
        let removeEnd = existing.end;
        // Drop one trailing newline if present
        if (content[removeEnd] === '\n') removeEnd++;
        if (content[removeEnd] === '\n') removeEnd++;
        updated = content.slice(0, removeStart) + content.slice(removeEnd);
    }

    if (updated === content) {
        return ok(undefined);
    }

    // Conflict check (audit H10): if the file was edited during our compute
    // window, the in-memory `content` we transformed is now stale. Abort
    // rather than clobbering the user's intervening changes.
    const mtimeNow = file.stat?.mtime;
    if (typeof mtimeAtStart === 'number' && typeof mtimeNow === 'number' && mtimeNow !== mtimeAtStart) {
        const err = makeError(
            'EMBED_FAILED',
            'Note was modified during narration; embed link not added to avoid overwriting your changes.',
        );
        logger.warn('AudioNarration', err.message);
        return errFrom<void>(err);
    }

    // Prefer the transactional `vault.process` API when available (Obsidian
    // 1.4+) — it serialises read+write under the vault's lock. Fall back to
    // `vault.modify` on older versions.
    type VaultWithProcess = typeof app.vault & {
        process?: (file: TFile, fn: (data: string) => string) => Promise<string>;
    };
    const v = app.vault as VaultWithProcess;
    let conflictDetected = false;
    try {
        if (typeof v.process === 'function') {
            await v.process(file, (latest) => {
                if (latest !== content) {
                    // Underlying file changed between our read and the lock-protected
                    // re-read. Mark conflict so we can return EMBED_FAILED below
                    // rather than reporting a false success (audit R2-H3 fix).
                    conflictDetected = true;
                    return latest;
                }
                return updated;
            });
        } else {
            await app.vault.modify(file, updated);
        }
    } catch (e) {
        const err = makeError('EMBED_FAILED', `Failed to write embed: ${describeError(e)}`, e);
        logger.warn('AudioNarration', err.message);
        return errFrom<void>(err);
    }

    if (conflictDetected) {
        const err = makeError(
            'EMBED_FAILED',
            'Note was modified during write; embed link skipped to avoid overwriting your changes.',
        );
        logger.warn('AudioNarration', err.message);
        return errFrom<void>(err);
    }
    return ok(undefined);
}

function describeError(e: unknown): string {
    if (e instanceof Error) return e.message;
    return String(e);
}
