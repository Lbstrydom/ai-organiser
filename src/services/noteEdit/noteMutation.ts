/**
 * NoteMutation — pure, composable string transforms for the note-edit write seam.
 *
 * Every method here is a PURE function of note content → note content. No editor,
 * no vault, no Obsidian mutation. This is the single place the command layer composes
 * a note edit; `NoteWritePort` turns the resulting candidate into a minimal targeted
 * write. Keeping the composition pure makes it trivially testable (no editor mocks)
 * and is the SSOT for "what the note becomes" (D3).
 *
 * The lower-level text helpers reuse the EXISTING pure exports from
 * `noteStructure.ts` (`formatSourceReference`, `findSectionInText`, the header
 * constants) and `sourceDetection.ts` (`removeProcessedSources`) so behaviour stays
 * in lock-step with the editor-based helpers. They intentionally mirror the offset
 * math of the editor helpers (`addToReferencesSection`, `ensureStandardStructure`,
 * `replaceMainContent`) so a migrated write produces the same bytes as before
 * (parity is locked by the Cluster C golden tests).
 *
 * NOTE: the editor-based helpers in `noteStructure.ts` are NOT changed by this
 * cluster (out of scope). A future consolidation can reimplement them over these
 * pure cores; for now they coexist and the parity tests keep them aligned.
 */

import { Result, ok, err } from '../../core/result';
import {
    REFERENCES_HEADER,
    PENDING_INTEGRATION_HEADER,
    SECTION_DIVIDER,
    findSectionInText,
    formatSourceReference,
    type SourceReference,
} from '../../utils/noteStructure';
import { removeProcessedSources } from '../../utils/sourceDetection';
import type { ApplyOutcome } from './noteWritePort';

/** Character offset of the start of line `line` (0-based) in `content`. */
function lineStartOffset(content: string, line: number): number {
    if (line <= 0) return 0;
    let offset = 0;
    let seen = 0;
    for (let i = 0; i < content.length && seen < line; i++) {
        if (content.charCodeAt(i) === 10 /* \n */) {
            seen++;
            offset = i + 1;
        }
    }
    return offset;
}

/**
 * Remove processed source URLs / vault paths from the body. Pure delegate to the
 * existing `removeProcessedSources`. No-op when nothing matches.
 */
export function cleanupSourcesText(content: string, urls: string[], vaultPaths: string[] = []): string {
    if (urls.length === 0 && vaultPaths.length === 0) return content;
    return removeProcessedSources(content, urls, vaultPaths);
}

/**
 * Ensure the Pending Integration section exists (idempotent). Mirrors
 * `ensurePendingIntegrationExists` — appends the section block at end of doc when
 * absent.
 */
function ensurePendingText(content: string): string {
    if (findSectionInText(content, PENDING_INTEGRATION_HEADER).found) return content;
    return content + `${SECTION_DIVIDER}\n${PENDING_INTEGRATION_HEADER}\n\n`;
}

/**
 * Ensure the References section exists (idempotent), placed BEFORE Pending
 * Integration when that section is present. Mirrors `ensureReferencesExists`.
 */
function ensureReferencesText(content: string): string {
    if (findSectionInText(content, REFERENCES_HEADER).found) return content;

    const pending = findSectionInText(content, PENDING_INTEGRATION_HEADER);
    const block = `${SECTION_DIVIDER}\n${REFERENCES_HEADER}\n\n`;

    if (pending.found) {
        const lines = content.split('\n');
        let insertLine = pending.headerLine;
        while (insertLine > 0 && lines[insertLine - 1].trim() === '---') {
            insertLine--;
        }
        const offset = lineStartOffset(content, insertLine);
        return content.slice(0, offset) + block + content.slice(offset);
    }

    // No pending section — append at end of document.
    return content + block;
}

/**
 * Ensure standard structure (References + Pending Integration) when enabled.
 * Order matches `ensureStandardStructure`: pending first, then references-before-pending.
 */
export function ensureStructureText(content: string, enabled: boolean): string {
    if (!enabled) return content;
    return ensureReferencesText(ensurePendingText(content));
}

/**
 * Insert a formatted source reference at the top of the References section,
 * creating the section if needed. Mirrors `addToReferencesSection`.
 */
export function addReferenceText(content: string, ref: SourceReference): string {
    const ensured = ensureReferencesText(content);
    const refs = findSectionInText(ensured, REFERENCES_HEADER);
    const offset = lineStartOffset(ensured, refs.startLine);
    const referenceText = formatSourceReference(ref) + '\n';
    return ensured.slice(0, offset) + referenceText + ensured.slice(offset);
}

/**
 * Replace the main content while preserving trailing References / Pending sections.
 * Mirrors `replaceMainContent` (walks back only `---` dividers before the section).
 */
export function replaceMainContentText(content: string, newMain: string): string {
    const refs = findSectionInText(content, REFERENCES_HEADER);
    const pending = findSectionInText(content, PENDING_INTEGRATION_HEADER);

    let headerLine = -1;
    if (refs.found) headerLine = refs.headerLine;
    else if (pending.found) headerLine = pending.headerLine;

    if (headerLine === -1) return newMain;

    const lines = content.split('\n');
    let dividerStart = headerLine;
    while (dividerStart > 0 && lines[dividerStart - 1].trim() === '---') {
        dividerStart--;
    }
    const preserved = '\n' + lines.slice(dividerStart).join('\n');
    return newMain + preserved;
}

/**
 * Insert `addition` before the earliest trailing structural section (References /
 * Pending Integration), or at end of document. Mirrors the multi-source translate
 * append logic exactly (including the `\n---\n` horizontal-rule lookback).
 */
export function insertBeforeTrailingSectionsText(content: string, addition: string): string {
    const refIndex = content.indexOf('\n## References');
    const pendingIndex = content.indexOf('\n## Pending Integration');

    let insertIndex = content.length;
    if (refIndex > -1 && refIndex < insertIndex) insertIndex = refIndex;
    if (pendingIndex > -1 && pendingIndex < insertIndex) insertIndex = pendingIndex;

    const hrBeforeRef = content.lastIndexOf('\n---\n', insertIndex);
    if (hrBeforeRef > -1 && insertIndex - hrBeforeRef < 10) {
        insertIndex = hrBeforeRef;
    }

    return content.slice(0, insertIndex) + addition + content.slice(insertIndex);
}

/**
 * Insert `text` after a content anchor (the ~chars immediately before the cursor at
 * capture). Re-locates the anchor's LAST occurrence in the current content (D1). If
 * the anchor is empty (cursor at doc start) inserts at offset 0. If the anchor can't
 * be located (surrounding text changed) DEGRADES to inserting before the trailing
 * sections, with an advisory `info` message (G1).
 *
 * `text` is inserted verbatim — the caller supplies any padding.
 */
export function insertAtAnchorText(content: string, anchorSnippet: string, text: string): Result<ApplyOutcome> {
    if (anchorSnippet === '') {
        return ok({ content: text + content });
    }
    const idx = content.indexOf(anchorSnippet);
    const lastIdx = content.lastIndexOf(anchorSnippet);
    // Degrade when the anchor is ABSENT (idx === -1) OR AMBIGUOUS (more than one
    // occurrence — idx !== lastIdx): we can't know which one the cursor sat after,
    // so appending is safer than inserting at the wrong spot (plan D1). Emit a stable
    // CODE (not UI copy); the UI layer (applyNoteEdit) translates it.
    if (idx === -1 || idx !== lastIdx) {
        return ok({
            content: insertBeforeTrailingSectionsText(content, text),
            info: 'degraded-append',
        });
    }
    const insertAt = idx + anchorSnippet.length;
    return ok({ content: content.slice(0, insertAt) + text + content.slice(insertAt) });
}

/** A captured selection range, anchored by its surrounding text for re-location. */
export interface AnchoredSelection {
    before: string;
    selected: string;
    after: string;
}

/**
 * Replace a captured selection located by its `before`/`selected`/`after` anchors.
 * Re-locates in the current content (handles text shifting above — G-R3 G2). Returns
 * `err('range-invalid')` when the span can't be uniquely located (the surrounding
 * text changed) so the caller aborts rather than replacing the wrong span.
 */
export function replaceAnchoredSelectionText(content: string, sel: AnchoredSelection, replacement: string): Result<ApplyOutcome> {
    const needle = sel.before + sel.selected + sel.after;
    const first = content.indexOf(needle);
    if (first === -1) {
        return err('range-invalid');
    }
    if (content.indexOf(needle, first + 1) !== -1) {
        // Ambiguous — more than one match. Refuse rather than guess.
        return err('range-invalid');
    }
    const selStart = first + sel.before.length;
    const selEnd = selStart + sel.selected.length;
    return ok({ content: content.slice(0, selStart) + replacement + content.slice(selEnd) });
}

/**
 * Fluent builder composing an ordered set of pure body transforms into a single
 * `recompute(current) => Result<ApplyOutcome>` for an additive `composite` edit.
 * Each step runs against the running content; the first step that errors aborts
 * the whole composite (atomic — all-or-nothing).
 */
export class NoteMutation {
    private readonly steps: Array<(content: string) => Result<ApplyOutcome>> = [];

    /** Strip processed source links/embeds from the body. */
    cleanupSources(urls: string[], vaultPaths: string[] = []): this {
        this.steps.push((c) => ok({ content: cleanupSourcesText(c, urls, vaultPaths) }));
        return this;
    }

    /** Append a section before the trailing structural sections (or at end). */
    appendSection(section: string): this {
        this.steps.push((c) => ok({ content: insertBeforeTrailingSectionsText(c, section) }));
        return this;
    }

    /** Append raw text to the very end of the body (after trimming trailing whitespace). */
    appendToEnd(text: string): this {
        this.steps.push((c) => ok({ content: c.trimEnd() + '\n' + text }));
        return this;
    }

    /** Insert text after a content anchor (cursor-insert), degrading to append on anchor loss. */
    insertAtAnchor(anchorSnippet: string, text: string): this {
        this.steps.push((c) => insertAtAnchorText(c, anchorSnippet, text));
        return this;
    }

    /** Replace a captured selection (re-located by its anchors); aborts on ambiguity. */
    replaceSelection(sel: AnchoredSelection, replacement: string): this {
        this.steps.push((c) => replaceAnchoredSelectionText(c, sel, replacement));
        return this;
    }

    /** Add a formatted source reference to the References section. */
    addReference(ref: SourceReference): this {
        this.steps.push((c) => ok({ content: addReferenceText(c, ref) }));
        return this;
    }

    /** Ensure standard note structure when enabled in settings. */
    ensureStructure(enabled: boolean): this {
        this.steps.push((c) => ok({ content: ensureStructureText(c, enabled) }));
        return this;
    }

    /** Run an arbitrary pure transform (escape hatch for bespoke composition). */
    transform(fn: (content: string) => string): this {
        this.steps.push((c) => ok({ content: fn(c) }));
        return this;
    }

    /** Build the composite recompute. Carries forward the LAST advisory `info`. */
    build(): (current: string) => Result<ApplyOutcome> {
        const steps = this.steps;
        return (current: string): Result<ApplyOutcome> => {
            let content = current;
            let info: string | undefined;
            for (const step of steps) {
                const res = step(content);
                if (!res.ok) return res;
                content = res.value.content;
                if (res.value.info) info = res.value.info;
            }
            return ok({ content, info });
        };
    }
}
