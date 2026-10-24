import { describe, it, expect, vi } from 'vitest';
import { ResearchModeHandler } from '../src/ui/chat/ResearchModeHandler';

type Harness = {
    selectedUrls: string[];
    actionSaveToPending(ctx: unknown, cb: unknown): void;
};

function run(doc: string, urls: string[]) {
    const handler = Object.create(ResearchModeHandler.prototype) as Harness;
    handler.selectedUrls = urls;
    const editor = { getValue: () => doc, setValue: vi.fn() };
    const notify = vi.fn();
    const ctx = { plugin: { t: { modals: { unifiedChat: {} } } } };
    handler.actionSaveToPending(ctx, { getEditor: () => editor, notify });
    return { editor, notify };
}

describe('ResearchModeHandler.actionSaveToPending', () => {
    it('writes the URLs under an existing Pending heading and reports success', () => {
        const { editor, notify } = run('# T\n\n## Pending', ['https://a.example']);
        expect(editor.setValue).toHaveBeenCalledWith('# T\n\n## Pending\n- https://a.example\n');
        expect(notify).toHaveBeenCalledTimes(1);
    });

    it('a "## Pending Integration" heading no longer swallows the write silently', () => {
        const doc = '# T\n\n## Pending Integration\nkeep\n';
        const { editor, notify } = run(doc, ['https://a.example']);
        expect(editor.setValue).toHaveBeenCalledTimes(1);
        const written = editor.setValue.mock.calls[0][0] as string;
        expect(written).toContain('## Pending\n- https://a.example');
        expect(written.startsWith(doc)).toBe(true);
        expect(notify).toHaveBeenCalledTimes(1);
    });

    it('writes nothing and reports no success when there are no URLs', () => {
        const { editor, notify } = run('# T\n## Pending\n', []);
        expect(editor.setValue).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
    });
});
