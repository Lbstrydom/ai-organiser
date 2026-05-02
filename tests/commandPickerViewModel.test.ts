import { describe, it, expect } from 'vitest';
import { buildVisibleItems, flattenSingleChildGroups, type VisibleItem } from '../src/ui/modals/commandPickerViewModel';
import type { CommandCategory, PickerCommand } from '../src/ui/modals/CommandPickerModal';

function makeCategories(): CommandCategory[] {
    return [
        {
            id: 'cat-a', name: 'Category A', icon: 'star',
            commands: [
                { id: 'group-1', name: 'Group One', icon: 'folder', callback: () => {}, subCommands: [
                    { id: 'sub-1', name: 'Sub Command Alpha', icon: 'file', callback: () => {}, description: 'Does alpha things' },
                    { id: 'sub-2', name: 'Sub Command Beta', icon: 'file', callback: () => {} },
                ]},
                { id: 'leaf-1', name: 'Standalone Leaf', icon: 'zap', callback: () => {}, description: 'A standalone command' },
            ]
        },
        {
            id: 'cat-b', name: 'Category B', icon: 'settings',
            commands: [
                { id: 'single-group', name: 'Single Child Group', icon: 'box', callback: () => {}, subCommands: [
                    { id: 'only-child', name: 'Only Child', icon: 'file', callback: () => {} },
                ]},
                { id: 'badged', name: 'Coming Feature', icon: 'clock', callback: () => {}, badge: 'coming-soon' as const },
            ]
        }
    ];
}

function simpleMatcher(query: string) {
    return (text: string) => {
        const lower = text.toLowerCase();
        const q = query.toLowerCase();
        return lower.includes(q) ? { score: lower.indexOf(q) === 0 ? 1 : 0.5 } : null;
    };
}

describe('flattenSingleChildGroups', () => {
    it('promotes single-child group to standalone', () => {
        const categories = makeCategories();
        const result = flattenSingleChildGroups(categories);
        // cat-b's single-group had one child — it should be promoted
        const catB = result.find(c => c.id === 'cat-b')!;
        const ids = catB.commands.map(c => c.id);
        expect(ids).toContain('only-child');
        expect(ids).not.toContain('single-group');
    });

    it('leaves multi-child group unchanged', () => {
        const categories = makeCategories();
        const result = flattenSingleChildGroups(categories);
        const catA = result.find(c => c.id === 'cat-a')!;
        const group = catA.commands.find(c => c.id === 'group-1');
        expect(group).toBeDefined();
        expect(group!.subCommands).toHaveLength(2);
    });

    it('passes through categories with no groups', () => {
        const categories: CommandCategory[] = [{
            id: 'flat', name: 'Flat', icon: 'star',
            commands: [
                { id: 'a', name: 'A', icon: 'file', callback: () => {} },
                { id: 'b', name: 'B', icon: 'file', callback: () => {} },
            ]
        }];
        const result = flattenSingleChildGroups(categories);
        expect(result[0].commands).toHaveLength(2);
        expect(result[0].commands.map(c => c.id)).toEqual(['a', 'b']);
    });

    it('handles mixed: one single-child + one multi-child', () => {
        const categories = makeCategories();
        const result = flattenSingleChildGroups(categories);
        // cat-a: multi-child group kept, standalone kept
        const catA = result.find(c => c.id === 'cat-a')!;
        expect(catA.commands).toHaveLength(2);
        expect(catA.commands[0].id).toBe('group-1');
        // cat-b: single-child promoted, badged kept
        const catB = result.find(c => c.id === 'cat-b')!;
        expect(catB.commands).toHaveLength(2);
        expect(catB.commands[0].id).toBe('only-child');
        expect(catB.commands[1].id).toBe('badged');
    });
});

describe('buildVisibleItems — collapsible categories (added 2026-05-02)', () => {
    it('legacy callers (no expandedCategories arg) see no category-header rows', () => {
        const categories = makeCategories();
        const items = buildVisibleItems(categories, new Set(), null);
        expect(items.every(i => i.kind !== 'category-header')).toBe(true);
    });

    it('collapsibility opt-in: pass an empty Set → only headers visible', () => {
        const categories = makeCategories();
        const items = buildVisibleItems(categories, new Set(), null, new Set());
        expect(items.every(i => i.kind === 'category-header')).toBe(true);
        expect(items.length).toBe(categories.length);
    });

    it('expanding a category shows its header + that category contents', () => {
        const categories = makeCategories();
        const items = buildVisibleItems(categories, new Set(), null, new Set(['cat-a']));
        const headers = items.filter(i => i.kind === 'category-header');
        // Both categories get headers; only cat-a is expanded
        expect(headers.length).toBe(2);
        expect(headers[0].categoryExpanded).toBe(true);
        expect(headers[1].categoryExpanded).toBe(false);
        // cat-a contents visible (group-1, leaf-1) but not cat-b's
        const nonHeader = items.filter(i => i.kind !== 'category-header');
        expect(nonHeader.every(i => i.categoryId === 'cat-a')).toBe(true);
    });

    it('category-header carries leaf count for scent-of-content', () => {
        const categories = makeCategories();
        const items = buildVisibleItems(categories, new Set(), null, new Set());
        const catA = items.find(i => i.categoryId === 'cat-a' && i.kind === 'category-header')!;
        // cat-a has group-1 (with 2 sub-commands) + leaf-1 = 3 leaves
        expect(catA.categoryLeafCount).toBe(3);
    });
});

describe('buildVisibleItems — browse mode', () => {
    it('shows only top-level items when all groups collapsed', () => {
        const categories = makeCategories();
        const items = buildVisibleItems(categories, new Set(), null);
        const ids = items.map(i => i.command.id);
        // group-1 (group), leaf-1 (leaf), single-group (group), badged (leaf)
        expect(ids).toEqual(['group-1', 'leaf-1', 'single-group', 'badged']);
        expect(items.every(i => i.depth === 0)).toBe(true);
    });

    it('shows children when one group is expanded', () => {
        const categories = makeCategories();
        const expanded = new Set(['group-1']);
        const items = buildVisibleItems(categories, expanded, null);
        const ids = items.map(i => i.command.id);
        expect(ids).toEqual(['group-1', 'sub-1', 'sub-2', 'leaf-1', 'single-group', 'badged']);
    });

    it('shows children for multiple expanded groups', () => {
        const categories = makeCategories();
        const expanded = new Set(['group-1', 'single-group']);
        const items = buildVisibleItems(categories, expanded, null);
        const ids = items.map(i => i.command.id);
        expect(ids).toEqual(['group-1', 'sub-1', 'sub-2', 'leaf-1', 'single-group', 'only-child', 'badged']);
    });

    it('expanded group children have kind sub-leaf and depth 1', () => {
        const categories = makeCategories();
        const expanded = new Set(['group-1']);
        const items = buildVisibleItems(categories, expanded, null);
        const subItems = items.filter(i => i.kind === 'sub-leaf');
        expect(subItems).toHaveLength(2);
        for (const sub of subItems) {
            expect(sub.depth).toBe(1);
            expect(sub.parentGroupId).toBe('group-1');
        }
    });
});

describe('buildVisibleItems — search mode', () => {
    it('returns flat result when query matches sub-command name', () => {
        const categories = makeCategories();
        const matcher = simpleMatcher('alpha');
        const items = buildVisibleItems(categories, new Set(), matcher);
        expect(items).toHaveLength(1);
        expect(items[0].command.id).toBe('sub-1');
        expect(items[0].kind).toBe('sub-leaf');
    });

    it('returns empty array when query matches nothing', () => {
        const categories = makeCategories();
        const matcher = simpleMatcher('zzzznonexistent');
        const items = buildVisibleItems(categories, new Set(), matcher);
        expect(items).toHaveLength(0);
    });

    it('includes badged commands in search results (audit-code R3 M10 fix)', () => {
        // Earlier behaviour silently dropped badged commands from search,
        // creating inconsistent discoverability vs browse mode where they
        // remain visible with .is-unavailable styling. Audit M10 (Gemini
        // wrongly-dismissed) corrected this — search now mirrors browse.
        const categories = makeCategories();
        const matcher = simpleMatcher('coming');
        const items = buildVisibleItems(categories, new Set(), matcher);
        const ids = items.map(i => i.command.id);
        expect(ids).toContain('badged');
    });

    it('sorts results by score descending', () => {
        const categories = makeCategories();
        // 'Sub Command' matches both sub-1 and sub-2; 'Standalone' matches leaf-1
        // Use a matcher where 'sub command' gives different scores
        const matcher = (text: string) => {
            const lower = text.toLowerCase();
            if (lower.includes('standalone')) return { score: 0.9 };
            if (lower.includes('sub command alpha')) return { score: 0.7 };
            if (lower.includes('sub command beta')) return { score: 0.3 };
            if (lower.includes('only child')) return { score: 0.1 };
            return null;
        };
        const items = buildVisibleItems(categories, new Set(), matcher);
        const scores = items.map(i => i.score);
        for (let i = 1; i < scores.length; i++) {
            expect(scores[i - 1]!).toBeGreaterThanOrEqual(scores[i]!);
        }
    });
});
