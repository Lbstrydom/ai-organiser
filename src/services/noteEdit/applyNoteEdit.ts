/**
 * applyNoteEdit — the single write primitive for the command layer (D1).
 *
 * Compare-and-commit against the file CAPTURED at command start. A long async
 * pipeline (fetch + extract + transcribe + N LLM calls) runs between capture and
 * commit; this primitive guarantees the result lands in the right note or is safely
 * refused — never a blind write to a stale/changed buffer (the data-loss class).
 *
 * Flow:
 *   1. capture a snapshot at command start (`captureSnapshot`) — file path + baseline
 *      content + cursor/selection anchors.
 *   2. after the async work, build a typed `EditTarget` carrying the snapshot + the
 *      produced content.
 *   3. `applyNoteEdit` re-resolves the file, optionally shows the review modal, and on
 *      approval re-validates + commits via `NoteWritePort` — the write targets
 *      `target.filePath`, NOT whatever is active at commit (R2-H1).
 *
 * Validation happens INSIDE the atomic write (NoteWritePort), so there is no
 * check-then-write window (G2). Rewrites (`full-replace`) refuse on baseline
 * divergence (the result is preserved on the clipboard, never silently dropped).
 * Additive edits (`append`/`cursor-insert`/`composite`) carry no baseline gate, so a
 * benign concurrent keystroke can't discard the result (G2); they recompute against
 * the live content at commit.
 *
 * BASELINE NOTE: the plan specifies an sha256 hash for the rewrite baseline; we keep
 * the captured baseline STRING and compare by exact equality. This is semantically
 * identical (exact-match refusal when the buffer changed) but synchronous — required
 * because the `vault.process` callback cannot await a hash — and has no
 * crypto-unavailable failure mode.
 */

import { MarkdownView, Notice, TFile } from 'obsidian';
import type { App, Editor } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { Result, ok, err } from '../../core/result';
import { logger } from '../../utils/logger';
import { showReviewOrApply } from '../../utils/reviewEditsHelper';
import { writeNote, type ApplyFn, type ApplyOutcome } from './noteWritePort';
import {
    insertAtAnchorText,
    insertBeforeTrailingSectionsText,
    replaceAnchoredSelectionText,
    type AnchoredSelection,
} from './noteMutation';

const CURSOR_ANCHOR_CHARS = 120;
const SELECTION_ANCHOR_CHARS = 80;

/** Snapshot of the positional edit context captured at command start. */
export interface EditSnapshot {
    filePath: string;
    baseline: string;
    /** ~120 chars of body immediately before the cursor at capture (content anchor). */
    cursorAnchor: string;
    /** The selection + its surrounding anchors, or null when there is no selection. */
    selection: AnchoredSelection | null;
}

interface BaseTarget {
    filePath: string;
    baseline: string;
}

/** Replace the whole note (genuine rewrite). Refuses on baseline divergence. */
export interface FullReplaceTarget extends BaseTarget {
    kind: 'full-replace';
    nextContent: string;
}
/** Replace a captured selection, re-located by its anchors. */
export interface RangeReplaceTarget extends BaseTarget {
    kind: 'range-replace';
    selection: AnchoredSelection;
    replacement: string;
}
/** Insert text after the captured cursor anchor (degrades to append on anchor loss). */
export interface CursorInsertTarget extends BaseTarget {
    kind: 'cursor-insert';
    anchorSnippet: string;
    text: string;
}
/** Append a section before the trailing structural sections (additive). */
export interface AppendTarget extends BaseTarget {
    kind: 'append';
    text: string;
}
/** An ordered set of pure transforms (additive-with-cleanup), applied atomically. */
export interface CompositeTarget extends BaseTarget {
    kind: 'composite';
    recompute: (current: string) => Result<ApplyOutcome>;
}

export type EditTarget =
    | FullReplaceTarget
    | RangeReplaceTarget
    | CursorInsertTarget
    | AppendTarget
    | CompositeTarget;

export interface ApplyNoteEditOptions {
    /**
     * When true (default), route through the Reviewed Edits modal (which itself
     * honours `settings.enableReviewedEdits`). Pass false when the caller already
     * owns a preview gate (e.g. the summary preview modal) to avoid a double prompt.
     */
    review?: boolean;
}

/** Build a snapshot from a file path + its (captured) editor. */
function buildSnapshot(filePath: string, editor: Editor): EditSnapshot {
    const baseline = editor.getValue();
    const cursor = editor.getCursor();
    const cursorOffset = editor.posToOffset(cursor);
    const cursorAnchor = baseline.slice(Math.max(0, cursorOffset - CURSOR_ANCHOR_CHARS), cursorOffset);

    let selection: AnchoredSelection | null = null;
    const selectedText = editor.getSelection();
    if (selectedText && editor.somethingSelected()) {
        const from = editor.posToOffset(editor.getCursor('from'));
        const to = editor.posToOffset(editor.getCursor('to'));
        selection = {
            before: baseline.slice(Math.max(0, from - SELECTION_ANCHOR_CHARS), from),
            selected: baseline.slice(from, to),
            after: baseline.slice(to, to + SELECTION_ANCHOR_CHARS),
        };
    }

    return { filePath, baseline, cursorAnchor, selection };
}

/** Capture the edit context at command start. Returns null when there is no file. */
export function captureSnapshot(view: MarkdownView): EditSnapshot | null {
    const file = view.file;
    const editor = view.editor;
    if (!file || !editor) return null;
    return buildSnapshot(file.path, editor);
}

/**
 * Capture a snapshot from a bare editor by finding its owning markdown leaf/file.
 * Used by call sites that only hold an `Editor` reference (the summarize insert
 * helpers). The owning leaf identifies the correct note even if the user navigated
 * to a different note (the editor still belongs to its original file). Returns null
 * when the editor isn't backed by an open markdown file.
 */
export function captureSnapshotFromEditor(app: App, editor: Editor): EditSnapshot | null {
    for (const leaf of app.workspace.getLeavesOfType('markdown')) {
        const view = leaf.view;
        if (view instanceof MarkdownView && view.editor === editor && view.file) {
            return buildSnapshot(view.file.path, editor);
        }
    }
    return null;
}

/** Map a target to its pure commit transform (run inside the atomic write). */
function resolveApply(target: EditTarget): ApplyFn {
    switch (target.kind) {
        case 'full-replace':
            return (current) =>
                current === target.baseline
                    ? ok({ content: target.nextContent })
                    : err('baseline-changed');
        case 'range-replace':
            return (current) => replaceAnchoredSelectionText(current, target.selection, target.replacement);
        case 'cursor-insert':
            return (current) => insertAtAnchorText(current, target.anchorSnippet, target.text);
        case 'append':
            return (current) => ok({ content: insertBeforeTrailingSectionsText(current, target.text) });
        case 'composite':
            return target.recompute;
    }
}

/** True when the new content this target introduces is empty/whitespace (no-op write). */
function isEmptyOutput(target: EditTarget): boolean {
    switch (target.kind) {
        case 'full-replace':
            return target.nextContent.trim() === '';
        case 'range-replace':
            return target.replacement.trim() === '';
        case 'cursor-insert':
            return target.text.trim() === '';
        case 'append':
            return target.text.trim() === '';
        case 'composite':
            return false; // composite owns its own emptiness; caller guarantees content
    }
}

async function preserveOnClipboard(text: string): Promise<void> {
    try {
        await navigator.clipboard.writeText(text);
    } catch (e) {
        logger.warn('NoteEdit', 'Failed to copy preserved output to clipboard', e);
    }
}

/**
 * Apply an edit to the captured note. Never throws — every outcome is a typed
 * `Result`. `ok(undefined)` = written. `err(code)` = not written (the code is from
 * the §5 failure matrix). Failure / degrade Notices are fired here; the caller fires
 * success Notices.
 */
export async function applyNoteEdit(
    plugin: AIOrganiserPlugin,
    target: EditTarget,
    opts: ApplyNoteEditOptions = {},
): Promise<Result<void>> {
    const { app } = plugin;
    const m = plugin.t.messages;

    // 1. Re-resolve the captured file.
    const file = app.vault.getAbstractFileByPath(target.filePath);
    if (!(file instanceof TFile)) {
        new Notice(m.noteDeletedEditCancelled, 6000);
        logger.warn('NoteEdit', `Target note missing at commit: ${target.filePath}`);
        return err('target-missing');
    }

    // 2. Empty-output guard — never perform a destructive no-op write.
    if (isEmptyOutput(target)) {
        new Notice(m.nothingToInsert, 4000);
        logger.warn('NoteEdit', 'Empty output — write skipped');
        return err('empty-output');
    }

    const apply = resolveApply(target);

    // 3. Build the preview candidate from the captured baseline (for the review diff).
    const previewRes = apply(target.baseline);
    if (!previewRes.ok) {
        // The captured baseline itself can't satisfy the edit (e.g. anchor already
        // ambiguous at capture). Surface and abort.
        return finishWithError(previewRes.error, plugin, target);
    }
    const candidate = previewRes.value.content;

    // 4. Review (or commit directly when the caller owns the gate).
    let commitRes: Result<ApplyOutcome> = err('not-committed');
    if (opts.review === false) {
        commitRes = await writeNote(app, file, apply);
    } else {
        const action = await showReviewOrApply(plugin, target.baseline, candidate, async () => {
            commitRes = await writeNote(app, file, apply);
        });
        if (action === 'reject' || action === 'copy') {
            // User chose not to apply (copy already wrote to clipboard via the modal).
            return err('rejected');
        }
    }

    // 5. Map the commit result.
    if (!commitRes.ok) {
        return finishWithError(commitRes.error, plugin, target);
    }
    if (commitRes.value.info === 'degraded-append') {
        new Notice(m.insertionPointMovedAppended, 5000);
    }
    return ok(undefined);
}

/** Fire the appropriate Notice for a commit/preview error and preserve output when relevant. */
function finishWithError(code: string, plugin: AIOrganiserPlugin, target: EditTarget): Result<void> {
    const m = plugin.t.messages;
    switch (code) {
        case 'baseline-changed':
        case 'range-invalid': {
            // Preserve the result — never silently drop it (§5).
            const preserved = target.kind === 'full-replace' ? target.nextContent
                : target.kind === 'range-replace' ? target.replacement
                : target.kind === 'cursor-insert' ? target.text
                : target.kind === 'append' ? target.text
                : '';
            if (preserved) void preserveOnClipboard(preserved);
            new Notice(m.noteChangedReRun, 7000);
            logger.warn('NoteEdit', `Write aborted (${code}) for ${target.filePath}`);
            return err(code);
        }
        case 'write-failed':
            new Notice(m.couldNotWriteNote, 6000);
            return err(code);
        default:
            logger.warn('NoteEdit', `Write not applied (${code}) for ${target.filePath}`);
            return err(code);
    }
}
