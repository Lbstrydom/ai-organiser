/**
 * Menu layout: the newsletter commands live in a Newsletters group INSIDE Capture. There is no
 * sixth top-level stage, the stage vocabulary is untouched, and the group disappears with the
 * feature.
 */
import { describe, it, expect } from 'vitest';
import { buildCommandCategories, type CommandCategory, type PickerCommand } from '../src/ui/modals/CommandPickerModal';
import { buildVisibleItems, filterCategoriesByFeature, flattenSingleChildGroups } from '../src/ui/modals/commandPickerViewModel';
import { en } from '../src/i18n/en';
import { WORKFLOW_STAGES } from '../src/core/workflowStages';
import type { FeatureId } from '../src/core/features';

const noop = (): void => {};
const categories = buildCommandCategories(en, noop);
const capture = (cats: CommandCategory[]) => cats.find((c) => c.id === 'capture')!;
const group = (cats: CommandCategory[]) => capture(cats).commands.find((c) => c.id === 'capture-newsletter');

describe('the Newsletters group in Capture', () => {
    it('exists, is labelled, and holds the five newsletter commands in order', () => {
        const g = group(categories)!;
        expect(g.name).toBe('Newsletters');
        expect(g.icon).toBe('mail');
        expect(g.subCommands!.map((c) => c.id)).toEqual([
            'newsletter-fetch', 'newsletter-audio', 'newsletter-mark-caught-up', 'newsletter-mark-brief-read', 'newsletter-mark-catchup-listened',
        ]);
    });

    it('every command carries an icon, a name and a description', () => {
        for (const c of group(categories)!.subCommands!) {
            expect(c.icon, c.id).toBeTruthy();
            expect(c.name, c.id).toBeTruthy();
            expect(c.description, c.id).toBeTruthy();
        }
        expect(group(categories)!.subCommands!.find((c) => c.id === 'newsletter-audio')!.icon).toBe('headphones');
    });

    it('is NOT a new top-level stage: the vocabulary is exactly Pinned plus the five stages', () => {
        expect(categories.map((c) => c.id)).toEqual(['pinned', ...WORKFLOW_STAGES]);
        expect(categories.map((c) => c.id)).not.toContain('newsletter');
    });

    it('the mark-listened command needs an open note; the others need nothing', () => {
        const byId = Object.fromEntries(group(categories)!.subCommands!.map((c) => [c.id, c]));
        expect((byId['newsletter-mark-catchup-listened'] as PickerCommand).requires).toBe('active-note');
        expect((byId['newsletter-audio'] as PickerCommand).requires).toBe('none');
        expect((byId['newsletter-fetch'] as PickerCommand).requires).toBe('none');
    });

    it('stays a real group because it has more than one child (it is never flattened away)', () => {
        const flat = flattenSingleChildGroups(categories);
        expect(group(flat)).toBeDefined();
    });
});

describe('feature gating', () => {
    it('with the newsletter feature off the whole group vanishes, and Capture keeps its other rows', () => {
        const out = filterCategoriesByFeature(categories, (f: FeatureId) => f !== 'newsletter');
        expect(group(out)).toBeUndefined();
        expect(capture(out).commands.length).toBeGreaterThan(0);
    });

    it('with it on, all five commands are reachable', () => {
        const out = filterCategoriesByFeature(categories, () => true);
        expect(group(out)!.subCommands).toHaveLength(5);
    });

    it('every command in the group belongs to the newsletter feature and the capture stage', () => {
        for (const c of group(categories)!.subCommands!) {
            expect(c.feature).toBe('newsletter');
            expect(c.stage).toBe('capture');
        }
    });
});

describe('search finds the catch-up audio', () => {
    // The fuzzy matcher the modal passes is per-text; this one accepts any text mentioning "catch".
    const matcher = (text: string) => (text.toLowerCase().includes('catch') ? { score: 1 } : null);
    const items = buildVisibleItems(categories, new Set(), matcher, new Set(['capture']), () => true);

    it('by its words, under the Newsletters group', () => {
        const hit = items.find((i) => i.command.id === 'newsletter-audio');
        expect(hit).toBeDefined();
        expect(hit!.parentGroupName).toBe('Newsletters');
    });
});
