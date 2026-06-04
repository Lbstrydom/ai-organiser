import { describe, it, expect } from 'vitest';
import { buildCommandCategories, type CommandCategory, type PickerCommand } from '../src/ui/modals/CommandPickerModal';
import { buildVisibleItems, filterCategoriesByFeature } from '../src/ui/modals/commandPickerViewModel';
import { en } from '../src/i18n/en';
import { FEATURE_REGISTRY, type FeatureId } from '../src/core/features';

const REGISTRY_IDS = new Set<string>(FEATURE_REGISTRY.map((f) => f.id));
const noop = (): void => {};

/** Collect every executable leaf (no subCommands) across the tree. */
function collectLeaves(categories: CommandCategory[]): PickerCommand[] {
    const leaves: PickerCommand[] = [];
    for (const cat of categories) {
        for (const cmd of cat.commands) {
            if (cmd.subCommands && cmd.subCommands.length > 0) leaves.push(...cmd.subCommands);
            else leaves.push(cmd);
        }
    }
    return leaves;
}

describe('picker leaf completeness (FT-4 LEAF_FEATURE)', () => {
    const categories = buildCommandCategories(en, noop);

    it('every executable leaf carries a feature', () => {
        for (const leaf of collectLeaves(categories)) {
            expect(leaf.feature, `leaf '${leaf.id}' has no feature`).toBeDefined();
        }
    });

    it('every leaf feature is a known FeatureId', () => {
        for (const leaf of collectLeaves(categories)) {
            expect(REGISTRY_IDS.has(leaf.feature as string), `leaf '${leaf.id}' → unknown '${leaf.feature}'`).toBe(true);
        }
    });

    it('group containers carry no feature (structural rows)', () => {
        for (const cat of categories) {
            for (const cmd of cat.commands) {
                if (cmd.subCommands && cmd.subCommands.length > 0) {
                    expect(cmd.feature).toBeUndefined();
                }
            }
        }
    });
});

describe('filterCategoriesByFeature (FT-10ii)', () => {
    const categories = buildCommandCategories(en, noop);
    const enableAll = () => true;
    const enableNone = () => false;

    it('keeps everything when all features enabled', () => {
        const out = filterCategoriesByFeature(categories, enableAll);
        expect(collectLeaves(out).length).toBe(collectLeaves(categories).length);
    });

    it('drops every category when nothing is enabled', () => {
        expect(filterCategoriesByFeature(categories, enableNone)).toHaveLength(0);
    });

    it('hides only the disabled feature\'s leaves', () => {
        const disableCanvas = (f: FeatureId) => f !== 'canvas';
        const out = filterCategoriesByFeature(categories, disableCanvas);
        const ids = collectLeaves(out).map((l) => l.id);
        expect(ids).not.toContain('build-investigation-canvas');
        expect(ids).not.toContain('build-context-canvas');
        expect(ids).not.toContain('build-cluster-canvas');
        // Siblings in the same Visualise group survive.
        expect(ids).toContain('edit-mermaid-diagram');
        expect(ids).toContain('new-sketch');
    });

    it('suppresses a sub-group whose every leaf is gated out', () => {
        // maintain-bases holds the 3 bases commands → all owned by `bases`. Disable it.
        const out = filterCategoriesByFeature(categories, (f) => f !== 'bases');
        const maintain = out.find((c) => c.id === 'maintain');
        const groupIds = maintain?.commands.filter((c) => c.subCommands).map((c) => c.id) ?? [];
        expect(groupIds).not.toContain('maintain-bases');
    });

    it('returns a new tree (no mutation of the source)', () => {
        const before = collectLeaves(categories).length;
        filterCategoriesByFeature(categories, enableNone);
        expect(collectLeaves(categories).length).toBe(before);
    });
});

describe('buildVisibleItems feature gating', () => {
    const categories = buildCommandCategories(en, noop);

    it('emits no category-header for a fully-disabled category (empty-category suppression)', () => {
        // Disable every feature that appears in Maintain so the whole category empties.
        const maintain = categories.find((c) => c.id === 'maintain')!;
        const maintainFeatures = new Set<FeatureId>(
            collectLeaves([maintain]).map((l) => l.feature!).filter(Boolean),
        );
        const items = buildVisibleItems(
            categories, new Set(), null, new Set(categories.map((c) => c.id)),
            (f) => !maintainFeatures.has(f),
        );
        expect(items.some((i) => i.kind === 'category-header' && i.categoryId === 'maintain')).toBe(false);
    });

    it('keeps an enabled category visible', () => {
        const items = buildVisibleItems(
            categories, new Set(), null, new Set(['create']),
            () => true,
        );
        expect(items.some((i) => i.kind === 'category-header' && i.categoryId === 'create')).toBe(true);
    });
});
