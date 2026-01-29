/**
 * Tests for Editor Utilities
 */

import { describe, it, expect, vi } from 'vitest';
import { insertAtCursor, appendAsNewSections } from '../src/utils/editorUtils';

function createMockEditor(content = '', cursorLine = 0, cursorCh = 0) {
    return {
        getCursor: vi.fn().mockReturnValue({ line: cursorLine, ch: cursorCh }),
        getValue: vi.fn().mockReturnValue(content),
        replaceRange: vi.fn(),
        offsetToPos: vi.fn((offset: number) => {
            // Simple offset-to-pos: count newlines
            const lines = content.substring(0, offset).split('\n');
            return { line: lines.length - 1, ch: lines[lines.length - 1].length };
        })
    } as any;
}

describe('Editor Utils', () => {
    describe('insertAtCursor', () => {
        it('should call replaceRange with padded content at cursor position', () => {
            const editor = createMockEditor();
            insertAtCursor(editor, 'Hello World');

            expect(editor.replaceRange).toHaveBeenCalledWith(
                '\n\nHello World\n',
                { line: 0, ch: 0 }
            );
        });

        it('should use the current cursor position', () => {
            const editor = createMockEditor('', 5, 10);
            insertAtCursor(editor, 'Test');

            expect(editor.getCursor).toHaveBeenCalled();
            expect(editor.replaceRange).toHaveBeenCalledWith(
                '\n\nTest\n',
                { line: 5, ch: 10 }
            );
        });
    });

    describe('appendAsNewSections', () => {
        it('should insert before ## References when present', () => {
            const content = 'Main content here\n\n## References\n- Source 1';
            const editor = createMockEditor(content);

            appendAsNewSections(editor, 'New section');

            expect(editor.replaceRange).toHaveBeenCalled();
            const call = editor.replaceRange.mock.calls[0];
            expect(call[0]).toBe('\n\nNew section\n');
            // Position should correspond to before "## References"
            const insertOffset = content.indexOf('\n## References');
            expect(editor.offsetToPos).toHaveBeenCalledWith(insertOffset);
        });

        it('should insert at end when no References section', () => {
            const content = 'Main content only';
            const editor = createMockEditor(content);

            appendAsNewSections(editor, 'New section');

            expect(editor.replaceRange).toHaveBeenCalled();
            const call = editor.replaceRange.mock.calls[0];
            expect(call[0]).toBe('\n\nNew section\n');
            expect(editor.offsetToPos).toHaveBeenCalledWith(content.length);
        });

        it('should insert before Pending Integration when it appears before References', () => {
            const content = 'Main content\n\n## Pending Integration\nPending stuff\n\n## References\n- Source';
            const editor = createMockEditor(content);

            appendAsNewSections(editor, 'New section');

            expect(editor.replaceRange).toHaveBeenCalled();
            // Should insert before Pending Integration (appears first)
            const pendingOffset = content.indexOf('\n## Pending Integration');
            expect(editor.offsetToPos).toHaveBeenCalledWith(pendingOffset);
        });

        it('should insert before References when it appears before Pending Integration', () => {
            const content = 'Main content\n\n## References\n- Source\n\n## Pending Integration\nPending stuff';
            const editor = createMockEditor(content);

            appendAsNewSections(editor, 'New section');

            expect(editor.replaceRange).toHaveBeenCalled();
            // Should insert before References (appears first)
            const refOffset = content.indexOf('\n## References');
            expect(editor.offsetToPos).toHaveBeenCalledWith(refOffset);
        });

        it('should match ## References at the very start of the file', () => {
            const content = '## References\n- Source 1';
            const editor = createMockEditor(content);

            appendAsNewSections(editor, 'New section');

            expect(editor.replaceRange).toHaveBeenCalled();
            expect(editor.offsetToPos).toHaveBeenCalledWith(0);
        });
    });
});
