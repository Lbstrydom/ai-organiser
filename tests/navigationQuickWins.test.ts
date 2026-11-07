/**
 * Navigation quick wins (docs/plans/navigation-discoverability.md, Phase 1).
 *
 * 1. The Phase 1 migration oracle: today's picker tree equals the tree at 2b29b6b plus an
 *    explicit, enumerated delta. Anything else that moved, renamed or changed its owner fails.
 * 2. The new leaves follow their commands' registration gates.
 * 3. The five commands that had different names on different surfaces now share one.
 * 4. The right-click "Tag selected" item works on a real multi-selection.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { TFile, TFolder } from 'obsidian';
import { buildCommandCategories, DESKTOP_ONLY_LEAVES } from '../src/ui/modals/CommandPickerModal';
import { filterCategoriesByFeature } from '../src/ui/modals/commandPickerViewModel';
import { en } from '../src/i18n/en';
import type { FeatureId } from '../src/core/features';
import { snapshotPickerTree, type LeafRow } from './helpers/pickerTreeSnapshot';
import { selectedMarkdownFiles, registerGenerateCommands } from '../src/commands/generateCommands';

const baseline: LeafRow[] = JSON.parse(readFileSync('tests/fixtures/navigation/picker-tree-2b29b6b.json', 'utf8'));
const current = snapshotPickerTree(buildCommandCategories(en, () => {}));
/** The tree as Phase 1 shipped it (captured on its branch); Phase 2's own oracle is in actionRegistry.test.ts. */
const phase1: LeafRow[] = JSON.parse(readFileSync('tests/fixtures/navigation/picker-tree-phase1.json', 'utf8'));
const key = (r: LeafRow): string => `${r.category}/${r.id}`;

/** Every change Phase 1 makes to the tree, and nothing else. */
const ADDED: Record<string, Partial<LeafRow>> = {
    'create/edit-ai-workspace': { feature: 'ai-workspaces', stage: 'create', requires: 'none' },
    'create/copy-ai-instructions': { feature: 'ai-workspaces', stage: 'create', requires: 'none' },
    'create/create-ai-context-pack': { feature: 'ai-workspaces', stage: 'create', requires: 'none' },
    'create/review-ai-handback': { feature: 'ai-workspaces', stage: 'create', requires: 'active-note', alsoRequiresFeatures: ['capture-inbox'], anyOfFeatures: null },
    'refine/open-process': { feature: 'capture-inbox', stage: 'refine', requires: 'none', anyOfFeatures: ['capture-inbox', 'inbox-sweep', 'ai-workspaces'], alsoRequiresFeatures: null },
};
const RENAMED: Record<string, string> = {
    'smart-summarize': en.commands.summarize,
    'smart-tag': en.commands.tag,
    'find-related': en.commands.showRelatedNotes,
    'quick-peek': en.commands.quickPeek,
};
const REQUIRES_CHANGED: Record<string, string> = { 'play-narration': 'mp3-file' };

describe('Phase 1 oracle: the picker tree is the 2b29b6b tree plus the declared delta', () => {
    it('adds exactly the declared leaves, with the declared owners', () => {
        const before = new Set(baseline.map(key));
        const added = phase1.filter((r) => !before.has(key(r)));
        expect(added.map(key).sort()).toEqual(Object.keys(ADDED).sort());
        for (const row of added) expect(row).toMatchObject(ADDED[key(row)]);
    });

    it('removes nothing', () => {
        const after = new Set(phase1.map(key));
        expect(baseline.filter((r) => !after.has(key(r))).map(key)).toEqual([]);
    });

    it('changes existing leaves only by the declared renames, requirement and platform flags', () => {
        const now = new Map(phase1.map((r) => [key(r), r]));
        for (const old of baseline) {
            const expected: LeafRow = {
                ...old,
                name: RENAMED[old.id] ?? old.name,
                requires: REQUIRES_CHANGED[old.id] ?? old.requires,
                platform: DESKTOP_ONLY_LEAVES.has(old.id) ? 'desktop' : old.platform,
            };
            expect(now.get(key(old)), key(old)).toEqual(expected);
        }
    });

    it('every declared rename really changed a name (no stale manifest entries)', () => {
        for (const id of Object.keys(RENAMED)) {
            const old = baseline.find((r) => r.id === id)!;
            expect(old.name, id).not.toBe(RENAMED[id]);
        }
    });
});

describe('desktop-only leaves', () => {
    it('are the canvas boards, the OneDrive commands and Resume offload', () => {
        const flagged = current.filter((r) => r.platform === 'desktop').map((r) => r.id).sort();
        expect(flagged).toEqual([...DESKTOP_ONLY_LEAVES].sort());
        expect(flagged).toHaveLength(6);
    });
});

describe('new leaves follow their commands\' registration gates', () => {
    const tree = buildCommandCategories(en, () => {});
    const visibleIds = (on: FeatureId[]): string[] =>
        snapshotPickerTree(filterCategoriesByFeature(tree, (f) => on.includes(f))).map((r) => r.id);

    it('Open Process shows when any feature that feeds the Process view is on', () => {
        for (const f of ['capture-inbox', 'inbox-sweep', 'ai-workspaces'] as FeatureId[]) {
            expect(visibleIds([f]), f).toContain('open-process');
        }
        expect(visibleIds(['chat'])).not.toContain('open-process');
    });

    it('the AI-workspace leaves show with ai-workspaces on', () => {
        const ids = visibleIds(['ai-workspaces']);
        for (const id of ['edit-ai-workspace', 'copy-ai-instructions', 'create-ai-context-pack']) expect(ids).toContain(id);
    });

    it('Review AI hand-back needs the capture inbox too, as its command does', () => {
        expect(visibleIds(['ai-workspaces'])).not.toContain('review-ai-handback');
        expect(visibleIds(['capture-inbox'])).not.toContain('review-ai-handback');
        expect(visibleIds(['ai-workspaces', 'capture-inbox'])).toContain('review-ai-handback');
    });

    it('Edit AI workspace is found by searching "workspace"', () => {
        const leaf = current.find((r) => r.id === 'edit-ai-workspace')!;
        expect(leaf.name.toLowerCase()).toContain('workspace');
    });
});

describe('one label per action on Ctrl+P and the picker', () => {
    // Since Phase 2 every command takes its name from the action registry (actionName), and
    // tests/actionRegistry.test.ts checks every registered name against it. Here: the five
    // commands that used to disagree.
    const SOURCES: Array<[string, string]> = [
        ['src/commands/summarizeCommands.ts', 'smart-summarize'],
        ['src/commands/generateCommands.ts', 'smart-tag'],
        ['src/commands/smartNoteCommands.ts', 'enhance-note'],
        ['src/commands/semanticSearchCommands.ts', 'find-related'],
        ['src/commands/quickPeekCommands.ts', 'quick-peek'],
    ];
    it.each(SOURCES)('%s names %s through the registry', (file, id) => {
        const src = readFileSync(file, 'utf8');
        const at = src.indexOf(`id: '${id}'`);
        expect(at, `${id} registration`).toBeGreaterThan(-1);
        const nameLine = src.slice(at, at + 200).split('\n').find((l) => l.trim().startsWith('name:'))!;
        expect(nameLine.trim(), nameLine).toBe(`name: actionName(plugin.t, '${id}'),`);
    });

    it('the picker shows the same strings', () => {
        const name = (id: string): string => current.find((r) => r.id === id)!.name;
        expect(name('smart-summarize')).toBe(en.commands.summarize);
        expect(name('smart-tag')).toBe(en.commands.tag);
        expect(name('enhance-note')).toBe(en.commands.improveNote);
        expect(name('find-related')).toBe(en.commands.showRelatedNotes);
        expect(name('quick-peek')).toBe(en.commands.quickPeek);
    });

    it('Quick peek has one name in the palette, picker and right-click menu', () => {
        expect(en.commands.quickPeek).toBe('Quick peek');
        expect(en.contextMenu.quickPeek).toBe(en.commands.quickPeek);
    });
});

describe('Tag selected (files-menu)', () => {
    const file = (path: string, extension: string): TFile => Object.assign(new TFile(), { path, extension });

    it('keeps only the Markdown notes of a multi-selection', () => {
        const picked = selectedMarkdownFiles([file('a.md', 'md'), file('b.pdf', 'pdf'), new TFolder(), file('c.md', 'md')]);
        expect(picked.map((f) => f.path)).toEqual(['a.md', 'c.md']);
    });

    /** A fake plugin that records the workspace handlers registerGenerateCommands installs. */
    function harness(confirm: boolean) {
        const handlers: Record<string, (...args: unknown[]) => unknown> = {};
        const tagged: TFile[][] = [];
        const plugin = {
            t: en,
            settings: {},
            addCommand: () => {},
            registerEvent: () => {},
            app: { workspace: { on: (name: string, fn: (...args: unknown[]) => unknown) => { handlers[name] = fn; return {}; } } },
            showConfirmationDialog: async () => confirm,
            analyzeAndTagFiles: async (files: TFile[]) => { tagged.push(files); },
        };
        registerGenerateCommands(plugin as never);
        const menu = () => {
            const items: Array<{ title: string; click: () => unknown }> = [];
            return {
                items,
                addItem(cb: (item: unknown) => void) {
                    const it = { title: '', click: (): unknown => undefined };
                    const api = {
                        setTitle(s: string) { it.title = s; return api; },
                        setIcon() { return api; },
                        onClick(fn: () => unknown) { it.click = fn; return api; },
                    };
                    cb(api);
                    items.push(it);
                    return this;
                },
            };
        };
        return { handlers, tagged, menu };
    }

    it('a multi-selection gets one item that tags exactly its Markdown notes', async () => {
        const h = harness(true);
        const m = h.menu();
        h.handlers['files-menu'](m, [file('a.md', 'md'), file('b.pdf', 'pdf'), file('c.md', 'md')]);
        expect(m.items).toHaveLength(1);
        expect(m.items[0].title).toBe(en.commands.aiTagSelectedNotes.replace('{count}', '2'));
        await m.items[0].click();
        expect(h.tagged.map((batch) => batch.map((f) => f.path))).toEqual([['a.md', 'c.md']]);
    });

    it('cancelling the confirmation tags nothing', async () => {
        const h = harness(false);
        const m = h.menu();
        h.handlers['files-menu'](m, [file('a.md', 'md')]);
        await m.items[0].click();
        expect(h.tagged).toEqual([]);
    });

    it('a selection with no Markdown notes adds no item', () => {
        const h = harness(true);
        const m = h.menu();
        h.handlers['files-menu'](m, [file('b.pdf', 'pdf')]);
        expect(m.items).toHaveLength(0);
    });

    it('a single note still gets Tag this note on file-menu', () => {
        const h = harness(true);
        const m = h.menu();
        h.handlers['file-menu'](m, file('a.md', 'md'));
        expect(m.items.map((i) => i.title)).toEqual([en.commands.aiTagThisNote]);
    });
});

describe('wording Louis found unclear', () => {
    it('a project with no Drive link shows no pairing text', () => {
        expect(en.projects.pairing.none).toBe('');
        expect(en.projects.pairing.paired).toMatch(/drive folder/i);
    });

    it('Google Tasks has one set of lists: the script "accepts" them, nothing else is "approved"', () => {
        const gt = en.googleTasks;
        expect(gt.repairListsTitle).not.toMatch(/approved lists/i);
        expect(gt.autoListsDesc).toMatch(/only lists/i);
        expect(gt.approveLists).toBe('Send these lists');
    });
});
