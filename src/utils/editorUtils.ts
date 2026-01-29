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
