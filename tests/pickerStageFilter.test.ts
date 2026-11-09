/**
 * The All actions stage chips. A pressed chip lists only that stage's actions: the sections above
 * All actions (For this context, Pinned, Jobs) and Setup below it leave the list, because they do
 * not follow the chips and, sitting first, made a chip look as if it did nothing (persona report
 * 2026-11-09).
 */
import { describe, it, expect } from 'vitest';
import { buildCommandCategories, type CommandCategory } from '../src/ui/modals/CommandPickerModal';
import { buildVisibleItems, stageFilterView } from '../src/ui/modals/commandPickerViewModel';
import { WORKFLOW_STAGES } from '../src/core/workflowStages';
import { en } from '../src/i18n/en';

const base = buildCommandCategories(en, () => {});
const context: CommandCategory = { id: 'context', name: 'For: note.md', icon: 'file', commands: base.find((c) => c.id === 'all')!.commands.slice(0, 3) };
const categories = [context, ...base];
const expanded = new Set(categories.map((c) => c.id));

describe('picker stage chips', () => {
    it('a pressed chip leaves only the All actions section, filtered to that stage', () => {
        for (const stage of WORKFLOW_STAGES) {
            const view = stageFilterView(categories, 'all', stage);
            expect(view.map((c) => c.id)).toEqual(['all']);
            const rows = buildVisibleItems(view, new Set(), null, expanded).filter((r) => r.kind === 'leaf');
            expect(rows.length, stage).toBeGreaterThan(0);
            for (const row of rows) expect(row.command.stage, `${stage}: ${row.command.id}`).toBe(stage);
        }
    });

    it('the first rows change when a chip is pressed (the list does not look the same)', () => {
        const all = buildVisibleItems(categories, new Set(), null, expanded).slice(0, 5).map((r) => r.command?.id ?? r.categoryId);
        const maintain = buildVisibleItems(stageFilterView(categories, 'all', 'maintain'), new Set(), null, expanded).slice(0, 5).map((r) => r.command?.id ?? r.categoryId);
        expect(maintain).not.toEqual(all);
    });
});
