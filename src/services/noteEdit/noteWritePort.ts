/**
 * NoteWritePort — the single commit mechanism for the note-edit write seam.
 *
 * This is the ONLY module permitted to call `editor.replaceRange` / `vault.process`
 * / `vault.modify` for command-layer note writes (enforced by the ESLint guard in
 * `eslint.config.mjs`). Everything in the command layer routes through
 * `applyNoteEdit` → here.
 *
 * Commit strategy (D1b):
 *  - If the target file is open in ANY visible markdown leaf (not just the active
 *    one — split-pane safe, R3-H2), apply the change as an undo-safe editor
 *    transaction on THAT leaf's editor, computed as a MINIMAL targeted edit
 *    (common-prefix/suffix diff) so unchanged regions keep their folds + cursor (G1/D3).
 *  - Otherwise (user navigated away / closed the note), write via the transactional
 *    `vault.process` API (falling back to `vault.modify` on older Obsidian) so the
 *    result still lands in the captured file (R2-H1) — no abort just because the
 *    note isn't focused.
 *
 * The `apply` callback is PURE and runs against the content read INSIDE the same
 * atomic write (the editor read+replace happen in one synchronous tick; the
 * `vault.process` callback re-reads under the vault lock) — there is no separate
 * "check then write" window (G2 / no TOCTOU). `apply` returning an error aborts the
 * write with the file left byte- and mtime-identical (G-R3 G4: abort by THROWING
 * inside the `vault.process` callback, never by returning the unchanged string).
 */

import { App, Editor, MarkdownView, TFile } from 'obsidian';
import { Result, ok, err } from '../../core/result';
import { logger } from '../../utils/logger';

/** Outcome of a pure content transform: the next full-note content + an optional advisory message. */
export interface ApplyOutcome {
    content: string;
    /** Stable advisory code (e.g. 'degraded-append'); the UI layer translates + fires it, not here. */
    info?: string;
}

/** A pure transform from the current note content to the next content (or an abort error). */
export type ApplyFn = (current: string) => Result<ApplyOutcome>;

/** Internal sentinel used to abort a `vault.process` write without mutating mtime. */
class AbortWriteError extends Error {
    constructor(readonly code: string) {
        super(`note-write-aborted: ${code}`);
        this.name = 'AbortWriteError';
    }
}

type VaultWithProcess = App['vault'] & {
    process?: (file: TFile, fn: (data: string) => string) => Promise<string>;
};

/**
 * Find an open editor for `file` in any visible markdown leaf (active or split).
 * Returns the first match, or null when the note is not open anywhere.
 */
function findEditorForFile(app: App, file: TFile): Editor | null {
    for (const leaf of app.workspace.getLeavesOfType('markdown')) {
        const view = leaf.view;
        if (view instanceof MarkdownView && view.file?.path === file.path) {
            return view.editor;
        }
    }
    return null;
}

/**
 * Compute the minimal contiguous replacement between two strings via common
 * prefix + common suffix. Returns the changed span `[start, oldEnd)` in the old
 * string and the replacement `text`. When the strings are equal this is a no-op
 * (`start === oldEnd && text === ''`).
 *
 * Applying just this span (rather than replacing the whole document) preserves
 * folds + cursor for the unchanged head and tail, and is a single undo step.
 */
export function minimalEdit(oldStr: string, newStr: string): { start: number; oldEnd: number; text: string } {
    const maxPrefix = Math.min(oldStr.length, newStr.length);
    let start = 0;
    while (start < maxPrefix && oldStr.charCodeAt(start) === newStr.charCodeAt(start)) {
        start++;
    }
    let oldEnd = oldStr.length;
    let newEnd = newStr.length;
    while (oldEnd > start && newEnd > start && oldStr.charCodeAt(oldEnd - 1) === newStr.charCodeAt(newEnd - 1)) {
        oldEnd--;
        newEnd--;
    }
    return { start, oldEnd, text: newStr.slice(start, newEnd) };
}

/**
 * Apply via an open editor — fully synchronous (read → transform → replace in one
 * tick), so no concurrent edit can slip between validation and write. Wrapped so a
 * CodeMirror error (e.g. an out-of-range position) surfaces as a typed `Result.err`
 * rather than escaping the "never throws" contract (audit H6).
 */
function writeViaEditor(editor: Editor, apply: ApplyFn): Result<ApplyOutcome> {
    const current = editor.getValue();
    const res = apply(current);
    if (!res.ok) return res;
    const next = res.value.content;
    if (next === current) return ok(res.value);
    try {
        const { start, oldEnd, text } = minimalEdit(current, next);
        editor.replaceRange(text, editor.offsetToPos(start), editor.offsetToPos(oldEnd));
    } catch (e) {
        logger.error('NoteEdit', 'editor write failed', e);
        return err('write-failed');
    }
    return ok(res.value);
}

/**
 * Apply via the vault when the note is not open. Prefers the transactional
 * `vault.process` API (Obsidian 1.4+) which re-reads under the vault lock; falls
 * back to read+modify on older versions.
 */
async function writeViaVault(app: App, file: TFile, apply: ApplyFn): Promise<Result<ApplyOutcome>> {
    const v = app.vault as VaultWithProcess;
    let outcome: ApplyOutcome | null = null;

    try {
        if (typeof v.process === 'function') {
            await v.process(file, (latest) => {
                const res = apply(latest);
                if (!res.ok) {
                    // Abort by throwing — returning `latest` unchanged would still
                    // touch mtime (G-R3 G4). Throwing leaves the file untouched.
                    throw new AbortWriteError(res.error);
                }
                outcome = res.value;
                return res.value.content;
            });
        } else {
            // Legacy fallback: read+modify. Minor TOCTOU window vs `vault.process`,
            // but the only option on pre-1.4 Obsidian.
            const latest = await app.vault.read(file);
            const res = apply(latest);
            if (!res.ok) return res;
            outcome = res.value;
            if (res.value.content !== latest) {
                await app.vault.modify(file, res.value.content);
            }
        }
    } catch (e) {
        if (e instanceof AbortWriteError) {
            return err(e.code);
        }
        logger.error('NoteEdit', 'vault write failed', e);
        return err('write-failed');
    }

    return ok(outcome ?? { content: '' });
}

/**
 * Commit a pure content transform to `file`, choosing the editor-transaction or
 * vault path automatically. Never throws — all failure is a typed `Result.err`.
 */
export async function writeNote(app: App, file: TFile, apply: ApplyFn): Promise<Result<ApplyOutcome>> {
    const editor = findEditorForFile(app, file);
    if (editor) {
        return writeViaEditor(editor, apply);
    }
    return writeViaVault(app, file, apply);
}
