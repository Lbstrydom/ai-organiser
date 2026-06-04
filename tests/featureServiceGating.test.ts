import { describe, it, expect } from 'vitest';
import { isFeatureEnabled } from '../src/services/featureService';
import {
    FEATURE_REGISTRY,
    FEATURE_BY_ID,
    SECTION_FEATURE,
    SURFACE_FEATURE,
    CHATMODE_FEATURE,
    type FeatureId,
} from '../src/core/features';
import { buildCommandCategories, type CommandCategory } from '../src/ui/modals/CommandPickerModal';
import { REGISTER_BY_FEATURE } from '../src/commands/index';
import { en } from '../src/i18n/en';

const noop = (): void => {};

/** Leaf feature ids (LEAF_FEATURE — the leaf field is the map). */
function leafFeatures(categories: CommandCategory[]): FeatureId[] {
    const out: FeatureId[] = [];
    for (const cat of categories) {
        for (const cmd of cat.commands) {
            const list = cmd.subCommands && cmd.subCommands.length > 0 ? cmd.subCommands : [cmd];
            for (const leaf of list) if (leaf.feature) out.push(leaf.feature);
        }
    }
    return out;
}

describe('legacy-master orthogonality (FT-11 outer-gate short-circuit)', () => {
    it('a disabled feature flag suppresses the feature regardless of the legacy toggle value', () => {
        // enableSemanticSearch (legacy) true, but the feature flag is the sole switch now.
        const settings = { featureFlags: { 'semantic-search': false }, enableSemanticSearch: true } as never;
        expect(isFeatureEnabled(settings, 'semantic-search')).toBe(false);
    });

    it('an enabled feature flag enables the feature even when the legacy toggle is false', () => {
        const settings = { featureFlags: { 'semantic-search': true }, enableSemanticSearch: false } as never;
        expect(isFeatureEnabled(settings, 'semantic-search')).toBe(true);
    });

    it('newsletter gates on the flag, not the legacy newsletterEnabled', () => {
        const off = { featureFlags: { newsletter: false }, newsletterEnabled: true } as never;
        const on = { featureFlags: { newsletter: true }, newsletterEnabled: false } as never;
        expect(isFeatureEnabled(off, 'newsletter')).toBe(false);
        expect(isFeatureEnabled(on, 'newsletter')).toBe(true);
    });
});

describe('FT-4 completeness — every non-core feature is referenced by ≥1 ownership map', () => {
    it('no non-core feature is orphaned across all five ownership maps (incl. REGISTER_BY_FEATURE)', () => {
        const referenced = new Set<string>([
            ...Object.keys(REGISTER_BY_FEATURE),
            ...Object.values(SECTION_FEATURE),
            ...Object.values(SURFACE_FEATURE),
            ...Object.values(CHATMODE_FEATURE),
            ...leafFeatures(buildCommandCategories(en, noop)),
        ] as string[]);
        const orphans = FEATURE_REGISTRY
            .filter((f) => !f.core)
            .map((f) => f.id)
            .filter((id) => !referenced.has(id));
        expect(orphans, `orphaned features: ${orphans.join(', ')}`).toEqual([]);
    });

    it('every REGISTER_BY_FEATURE key is a known FeatureId (M3/M12 — native command ownership)', () => {
        for (const id of Object.keys(REGISTER_BY_FEATURE)) {
            expect(FEATURE_BY_ID[id as FeatureId], `register-fn map key '${id}' ∉ registry`).toBeDefined();
        }
    });
});
