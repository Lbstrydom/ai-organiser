/**
 * Cross-surface taxonomy consistency — THE drift-killer (unified-feature-taxonomy plan §9).
 *
 * Asserts the Features settings projection and the Command Picker are both derivable from
 * ONE declared dataset (the workflow-stage vocabulary + per-feature/per-leaf `stage` +
 * `boundary`). Every place the two surfaces differ must trace to a DECLARED field
 * (`core` / `boundary∋'external-account'` / an enumerated `leaf.stage` override / the
 * `pinned` cross-cut) — never to an un-mirrored hand-edit. If this test fails, the two
 * menus have drifted.
 */

import { describe, it, expect } from 'vitest';
import { buildCommandCategories, type PickerCommand, type CommandCategory } from '../src/ui/modals/CommandPickerModal';
import { projectSettingsGroups } from '../src/services/featureProjection';
import { FEATURE_REGISTRY, FEATURE_BY_ID, SECTION_FEATURE, SECTION_HOSTED_FEATURES } from '../src/core/features';
import { WORKFLOW_STAGES } from '../src/core/workflowStages';
import { en } from '../src/i18n/en';

const STAGES = new Set<string>(WORKFLOW_STAGES);

/** Every leaf in a category tree, paired with the TOP-LEVEL category id it sits under. */
function leavesWithCategory(categories: CommandCategory[]): Array<{ leaf: PickerCommand; categoryId: string }> {
    const out: Array<{ leaf: PickerCommand; categoryId: string }> = [];
    const walk = (cmd: PickerCommand, categoryId: string) => {
        if (cmd.subCommands && cmd.subCommands.length > 0) {
            for (const sub of cmd.subCommands) walk(sub, categoryId);
        } else {
            out.push({ leaf: cmd, categoryId });
        }
    };
    for (const cat of categories) for (const cmd of cat.commands) walk(cmd, cat.id);
    return out;
}

const categories = buildCommandCategories(en, () => {});
const leaves = leavesWithCategory(categories);

/**
 * The ONLY sanctioned cross-stage leaf placements: a leaf whose `stage` differs from its
 * owning feature's primary `stage`. Each is intentional (a feature whose commands span
 * stages) and asserted here so a NEW divergence can't sneak in silently.
 */
const DECLARED_OVERRIDES: Record<string, string> = {
    'smart-tag': 'create',          // tagging (refine) → a Create action
    'show-tag-network': 'maintain', // tagging (refine) → vault admin
    'collect-all-tags': 'maintain', // tagging (refine) → vault admin
    'record-audio': 'capture',      // summarize (create) → pulls new audio in
    'refresh-onedrive-embed': 'refine', // onedrive-link (capture) → mutates an existing note's embeds
};

describe('cross-surface taxonomy — shared vocabulary', () => {
    it('every feature declares a stage in the shared vocabulary', () => {
        for (const f of FEATURE_REGISTRY) expect(STAGES.has(f.stage)).toBe(true);
    });

    it('every executable picker leaf declares a stage in the shared vocabulary', () => {
        for (const { leaf } of leaves) {
            expect(leaf.stage, `leaf ${leaf.id} missing stage`).toBeDefined();
            expect(STAGES.has(leaf.stage!), `leaf ${leaf.id} stage ${leaf.stage}`).toBe(true);
        }
    });
});

describe('cross-surface taxonomy — picker category ↔ stage identity', () => {
    it('every non-pinned top-level category id is a workflow stage', () => {
        for (const cat of categories) {
            if (cat.id === 'pinned') continue;
            expect(STAGES.has(cat.id), `category ${cat.id}`).toBe(true);
        }
    });

    it('every leaf in a non-pinned category has stage === that category id', () => {
        for (const { leaf, categoryId } of leaves) {
            if (categoryId === 'pinned') continue;
            expect(leaf.stage, `leaf ${leaf.id} in ${categoryId}`).toBe(categoryId);
        }
    });

    it('pinned holds only genuine cross-listings (real stage home + Pinned chip)', () => {
        const pinned = categories.find(c => c.id === 'pinned')!;
        for (const leaf of pinned.commands) {
            // Its real stage is a workflow stage...
            expect(STAGES.has(leaf.stage!), `pinned leaf ${leaf.id} stage ${leaf.stage}`).toBe(true);
            // ...the SAME object is also placed in that stage category (genuine cross-listing)...
            const inStage = leaves.some(l => l.categoryId === leaf.stage && l.leaf === leaf);
            expect(inStage, `pinned leaf ${leaf.id} also lives in its stage`).toBe(true);
            // ...and its search-dedup chip points at the Pinned favourites home (not a stage).
            expect(leaf.canonicalCategoryId, `pinned leaf ${leaf.id} chip`).toBe('pinned');
        }
    });
});

describe('cross-surface taxonomy — declared divergences only (no un-mirrored hand-edits)', () => {
    it('any leaf whose stage differs from its feature stage is an ENUMERATED override', () => {
        for (const { leaf } of leaves) {
            if (!leaf.feature || !leaf.stage) continue;
            const featureStage = FEATURE_BY_ID[leaf.feature].stage;
            if (leaf.stage !== featureStage) {
                expect(DECLARED_OVERRIDES[leaf.id], `undeclared override: ${leaf.id} (${featureStage}→${leaf.stage})`).toBe(leaf.stage);
            }
        }
    });

    it('every enumerated override actually occurs (no stale entries)', () => {
        const actual = new Set(
            leaves
                .filter(({ leaf }) => leaf.feature && leaf.stage && FEATURE_BY_ID[leaf.feature].stage !== leaf.stage)
                .map(({ leaf }) => leaf.id),
        );
        expect(new Set(Object.keys(DECLARED_OVERRIDES))).toEqual(actual);
    });

    it('the settings Integrations float is driven ONLY by external-account boundary', () => {
        const groups = projectSettingsGroups(FEATURE_REGISTRY);
        const integ = groups.find(g => g.groupKind === 'integrations');
        const integIds = (integ?.features ?? []).map(f => f.id).sort();
        expect(integIds).toEqual(['kindle', 'newsletter']);
        // The local tools must NOT float, even though they relate to external products.
        for (const id of ['bases', 'notebooklm'] as const) {
            expect((FEATURE_BY_ID[id].boundary ?? []).includes('external-account')).toBe(false);
        }
    });
});

describe('cross-surface taxonomy — shared labels', () => {
    it('picker stage categories are labelled from t.workflowStages.* (same SSOT as settings)', () => {
        for (const cat of categories) {
            if (cat.id === 'pinned') continue;
            expect(cat.name).toBe(en.workflowStages[cat.id as keyof typeof en.workflowStages]);
        }
    });
});

describe('cross-surface taxonomy — completeness', () => {
    // Declared exceptions (SSOT: features.ts SECTION_HOSTED_FEATURES, C17): features
    // with NO picker command whose settings panel is hosted INSIDE another feature's
    // section, so an own SECTION_FEATURE mapping would hide the consent UI when disabled.
    const SECTION_HOSTED: ReadonlySet<string> = new Set(SECTION_HOSTED_FEATURES);

    it('every non-core feature is reachable from ≥1 picker leaf or owns a settings section', () => {
        const leafFeatures = new Set(leaves.map(({ leaf }) => leaf.feature).filter(Boolean));
        const sectionOwners = new Set(Object.values(SECTION_FEATURE));
        for (const f of FEATURE_REGISTRY) {
            if (f.core) continue;
            const reachable = leafFeatures.has(f.id) || sectionOwners.has(f.id) || SECTION_HOSTED.has(f.id);
            expect(reachable, `feature ${f.id} unreachable from both surfaces`).toBe(true);
        }
    });

    it('section-hosted exceptions are not ALSO reachable normally (no stale entries)', () => {
        const leafFeatures = new Set(leaves.map(({ leaf }) => leaf.feature).filter(Boolean));
        const sectionOwners = new Set(Object.values(SECTION_FEATURE));
        for (const id of SECTION_HOSTED) {
            expect(leafFeatures.has(id as never) || sectionOwners.has(id as never),
                `'${id}' is reachable normally — remove it from SECTION_HOSTED`).toBe(false);
        }
    });
});
