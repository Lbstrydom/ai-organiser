/**
 * runAction (docs/plans/navigation-discoverability.md, decision 9): the active context runs the
 * command as the palette does; a scoped target runs its binding only after the target is checked
 * again, and is never swapped for the active file.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TFile } from 'obsidian';
import { clearMockNotices, mockNotices } from './mocks/obsidian';
import { runAction, targetStillValid, type RunContext } from '../src/services/actionRunner';

const ready = { state: 'ready' as const, reasons: [] };
const file = (path: string, extension = 'md') => Object.assign(new TFile(), { path, extension, name: path });

function plugin(existing: TFile[]) {
    const exec = vi.fn();
    const tagged: TFile[][] = [];
    const p = {
        app: {
            commands: { executeCommandById: exec },
            vault: { getAbstractFileByPath: (path: string) => existing.find((f) => f.path === path) ?? null },
            workspace: { getActiveViewOfType: () => null },
        },
        analyzeAndTagFiles: async (files: TFile[]) => { tagged.push(files); },
    };
    return { p, exec, tagged };
}
const ctx = (over: Partial<RunContext> = {}): RunContext => ({
    availabilityOf: () => ready,
    reasonText: (s) => `not ready: ${s}`,
    staleTarget: 'stale',
    ...over,
});

beforeEach(() => clearMockNotices());

describe('runAction', () => {
    it('the active context runs the command by id, exactly like the palette', () => {
        const { p, exec } = plugin([]);
        runAction(p as never, 'sweep-inbox', { kind: 'active' }, ctx());
        expect(exec).toHaveBeenCalledWith('ai-organiser:sweep-inbox');
    });

    it('a file target runs its binding on THAT file', async () => {
        const a = file('a.md');
        const { p, exec, tagged } = plugin([a]);
        runAction(p as never, 'smart-tag', { kind: 'file', file: a }, ctx());
        await new Promise((r) => setTimeout(r, 0));
        expect(tagged.map((b) => b.map((f) => f.path))).toEqual([['a.md']]);
        expect(exec).not.toHaveBeenCalled();
    });

    it('a deleted file runs nothing and says so', () => {
        const { p, exec, tagged } = plugin([]);
        runAction(p as never, 'smart-tag', { kind: 'file', file: file('gone.md') }, ctx());
        expect(tagged).toEqual([]);
        expect(exec).not.toHaveBeenCalled();
        expect(mockNotices).toEqual(['stale']);
    });

    it('an action without a binding is never run against a file (no substitution of the active file)', () => {
        const a = file('a.md');
        const { p, exec } = plugin([a]);
        runAction(p as never, 'enhance-note', { kind: 'file', file: a }, ctx());
        expect(exec).not.toHaveBeenCalled();
        expect(mockNotices).toEqual(['stale']);
    });

    it('an action that is no longer ready runs nothing and says why', () => {
        const { p, exec } = plugin([]);
        runAction(p as never, 'sweep-inbox', { kind: 'active' }, ctx({ availabilityOf: () => ({ state: 'feature-off', reasons: ['feature-off'] }) }));
        expect(exec).not.toHaveBeenCalled();
        expect(mockNotices).toEqual(['not ready: feature-off']);
    });
});

describe('targetStillValid', () => {
    it('a selection whose note is not open any more is stale', () => {
        const a = file('a.md');
        const { p } = plugin([a]);
        expect(targetStillValid(p as never, { kind: 'selection', file: a, text: 'x', from: 0, to: 1 })).toBe(false);
    });
    it('a multi-selection with one file gone is stale', () => {
        const a = file('a.md');
        const { p } = plugin([a]);
        expect(targetStillValid(p as never, { kind: 'files', files: [a, file('b.md')] })).toBe(false);
        expect(targetStillValid(p as never, { kind: 'files', files: [a] })).toBe(true);
    });
});
