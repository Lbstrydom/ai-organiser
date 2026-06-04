import { Editor } from 'obsidian';

/**
 * Low-level editor insertion helpers.
 *
 * NOTE: the canonical write seam for the command layer is `applyNoteEdit`
 * (`src/services/noteEdit/applyNoteEdit.ts`) — capture-then-verify against the
 * file open at command start, with the Reviewed Edits gate. These primitives remain
 * for synchronous, in-place callers that have no async gap (e.g. chat / smart-note /
 * integration insertions). Async command flows MUST use `applyNoteEdit` instead.
 */

/**
 * Insert content at the editor cursor with consistent padding.
 */
export function insertAtCursor(editor: Editor, content: string): void {
    const cursor = editor.getCursor();
    const padded = `\n\n${content}\n`;
    editor.replaceRange(padded, cursor);
}

/**
 * Pure SSOT for the append-as-new-sections insert point: the character offset
 * immediately before the earliest References / Pending Integration section, or the
 * end of the document when neither exists. Shared so the insert position is decided
 * in exactly one place (R3-M3).
 */
export function findAppendSectionOffset(fullText: string): number {
    const refMatch = fullText.match(/(?:^|\n)## References\b/);
    const pendMatch = fullText.match(/(?:^|\n)## Pending Integration\b/);
    const positions = [refMatch?.index, pendMatch?.index].filter((i): i is number => i != null);
    return positions.length > 0 ? Math.min(...positions) : fullText.length;
}

/**
 * Append content as new section(s) at end of main content,
 * before References/Pending sections.
 */
export function appendAsNewSections(editor: Editor, content: string): void {
    const fullText = editor.getValue();
    const insertPos = findAppendSectionOffset(fullText);
    const padded = `\n\n${content}\n`;
    editor.replaceRange(padded, editor.offsetToPos(insertPos));
}

/**
 * Insert or replace the ## Quick Peek section idempotently.
 * Replaces existing section if found; appends as new section otherwise.
 */
export function insertOrReplaceQuickPeekSection(editor: Editor, newSection: string): void {
    const content = editor.getValue();
    // Handle section at start of file (no preceding newline) separately
    const headMatch = /^## Quick Peek\n[\s\S]*?(?=\n## |\n*$)/.exec(content);
    if (headMatch) {
        const from = editor.offsetToPos(0);
        const to = editor.offsetToPos(headMatch[0].length);
        editor.replaceRange(newSection, from, to);
        return;
    }
    const midMatch = /\n## Quick Peek\n[\s\S]*?(?=\n## |\n*$)/.exec(content);
    if (midMatch === null) {
        appendAsNewSections(editor, newSection);
        return;
    }
    const from = editor.offsetToPos(midMatch.index);
    const to = editor.offsetToPos(midMatch.index + midMatch[0].length);
    editor.replaceRange('\n' + newSection, from, to);
}
