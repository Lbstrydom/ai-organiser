/**
 * Menu layout for the newsletter commands. Since the navigation plan (decision 4) they sit
 * directly in All actions with the Capture stage chip, not in a Newsletters group: every action
 * is two clicks away. There is no newsletter section, and with the feature off the commands
 * are listed only under "Available to turn on", never as runnable rows.
 */
import { describe, it, expect } from 'vitest';
import { buildCommandCategories, AVAILABLE_GROUP_ID, type CommandCategory, type PickerCommand } from '../src/ui/modals/CommandPickerModal';
import { buildVisibleItems, filterCategoriesByFeature, stageChipFor } from '../src/ui/modals/commandPickerViewModel';
import { en } from '../src/i18n/en';
import type { FeatureId } from '../src/core/features';

const noop = (): void => {};
const categories = buildCommandCategories(en, noop);
const NEWSLETTER = [
    'newsletter-fetch', 'newsletter-audio', 'newsletter-mark-caught-up', 'newsletter-mark-brief-read',
    'newsletter-mark-catchup-listened', 'newsletter-regenerate-audio',
];
const allSection = (cats: CommandCategory[]) => cats.find((c) => c.id === 'all')!;
const newsletterRows = (cats: CommandCategory[]): PickerCommand[] =>
    allSection(cats).commands.filter((c) => c.feature === 'newsletter');

describe('the newsletter commands in All actions', () => {
    it('are all there, in registry order, as direct rows', () => {
        expect(newsletterRows(categories).map((c) => c.id)).toEqual(NEWSLETTER);
        for (const c of newsletterRows(categories)) expect(c.subCommands, c.id).toBeUndefined();
    });

    it('every command carries an icon, a name and a description', () => {
        for (const c of newsletterRows(categories)) {
            expect(c.icon, c.id).toBeTruthy();
            expect(c.name, c.id).toBeTruthy();
            expect(c.description, c.id).toBeTruthy();
        }
        expect(newsletterRows(categories).find((c) => c.id === 'newsletter-audio')!.icon).toBe('headphones');
    });

    it('there is no newsletter section: the top level is the picker sections', () => {
        expect(categories.map((c) => c.id)).toEqual(['pinned', 'all', 'setup']);
    });

    it('the mark-listened command needs an open note; the others need nothing', () => {
        const byId = Object.fromEntries(newsletterRows(categories).map((c) => [c.id, c]));
        expect(byId['newsletter-mark-catchup-listened'].requires).toBe('active-note');
        expect(byId['newsletter-audio'].requires).toBe('none');
        expect(byId['newsletter-fetch'].requires).toBe('none');
    });

    it('each row shows the Capture stage chip', () => {
        const items = buildVisibleItems(categories, new Set(), null, new Set(['all']));
        for (const id of NEWSLETTER) {
            const row = items.find((i) => i.command.id === id)!;
            expect(stageChipFor(row), id).toBe('capture');
        }
    });
});

describe('feature gating', () => {
    it('with the newsletter feature off, the rows leave All actions and the filter drops them', () => {
        const out = filterCategoriesByFeature(categories, (f: FeatureId) => f !== 'newsletter');
        expect(newsletterRows(out)).toEqual([]);
        expect(allSection(out).commands.length).toBeGreaterThan(0);
    });

    it('built with the feature off, they are listed under Available to turn on, never runnable', () => {
        const cats = buildCommandCategories(en, noop, [], { isEnabled: (f) => f !== 'newsletter', onActivate: noop });
        const available = allSection(cats).commands.find((c) => c.id === AVAILABLE_GROUP_ID)!;
        expect(available.subCommands!.filter((c) => c.feature === 'newsletter').map((c) => c.id)).toEqual(NEWSLETTER);
        for (const c of available.subCommands!) expect(c.featureOff).toBe(true);
    });

    it('every newsletter row belongs to the newsletter feature and the capture stage', () => {
        for (const c of newsletterRows(categories)) {
            expect(c.feature).toBe('newsletter');
            expect(c.stage).toBe('capture');
        }
    });
});

describe('search finds the catch-up audio', () => {
    // The fuzzy matcher the modal passes is per-text; this one accepts any text mentioning "catch".
    const matcher = (text: string) => (text.toLowerCase().includes('catch') ? { score: 1 } : null);
    const items = buildVisibleItems(categories, new Set(), matcher, new Set(['all']), () => true);

    it('by its words, in All actions', () => {
        const hit = items.find((i) => i.command.id === 'newsletter-audio');
        expect(hit).toBeDefined();
        expect(hit!.categoryId).toBe('all');
    });
});
