import { Editor } from 'obsidian';

/**
 * Insert content at the editor cursor with consistent padding.
 */
export function insertAtCursor(editor: Editor, content: string): void {
    const cursor = editor.getCursor();
    const padded = `\n\n${content}\n`;
    editor.replaceRange(padded, cursor);
}

/**
 * Append content as new section(s) at end of main content,
 * before References/Pending sections.
 */
export function appendAsNewSections(editor: Editor, content: string): void {
    const fullText = editor.getValue();
    const refMatch = fullText.match(/(?:^|\n)## References\b/);
    const pendMatch = fullText.match(/(?:^|\n)## Pending Integration\b/);
    const positions = [refMatch?.index, pendMatch?.index].filter((i): i is number => i != null);
    const insertPos = positions.length > 0 ? Math.min(...positions) : fullText.length;
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
