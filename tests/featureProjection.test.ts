import { describe, it, expect } from 'vitest';
import { FEATURE_REGISTRY, type FeatureDef } from '../src/core/features';
import { projectSettingsGroups } from '../src/services/featureProjection';
import { WORKFLOW_STAGES } from '../src/core/workflowStages';

describe('projectSettingsGroups — settings-surface projection', () => {
    const groups = projectSettingsGroups(FEATURE_REGISTRY);

    it('emits Core first, then stages in WORKFLOW_STAGES order, then Integrations last', () => {
        const kinds = groups.map((g) => (g.groupKind === 'stage' ? g.stage : g.groupKind));
        expect(kinds[0]).toBe('core');
        expect(kinds[kinds.length - 1]).toBe('integrations');
        // The stage groups between them appear in canonical order (subsequence of WORKFLOW_STAGES).
        const stageKinds = kinds.filter((k) => (WORKFLOW_STAGES as readonly string[]).includes(k as string));
        const canonical = WORKFLOW_STAGES.filter((s) => stageKinds.includes(s));
        expect(stageKinds).toEqual(canonical);
    });

    it('partitions the registry — every feature appears exactly once across all groups', () => {
        const projected = groups.flatMap((g) => g.features.map((f) => f.id)).sort();
        const all = FEATURE_REGISTRY.map((f) => f.id).sort();
        expect(projected).toEqual(all);
    });

    it('Core group holds exactly the core-flagged features (regardless of their stage)', () => {
        const core = groups.find((g) => g.groupKind === 'core')!;
        expect(core.features.map((f) => f.id).sort()).toEqual(['chat', 'provider', 'tagging']);
    });

    it('Integrations holds exactly the external-account features (kindle + newsletter)', () => {
        const integ = groups.find((g) => g.groupKind === 'integrations')!;
        expect(integ.features.map((f) => f.id).sort()).toEqual(['kindle', 'newsletter']);
    });

    it('local tools bases + notebooklm render under the Maintain stage, NOT Integrations', () => {
        const maintain = groups.find((g) => g.groupKind === 'stage' && g.stage === 'maintain')!;
        const ids = maintain.features.map((f) => f.id);
        expect(ids).toContain('bases');
        expect(ids).toContain('notebooklm');
    });

    it('core features are absent from their stage groups (the flag wins over stage)', () => {
        for (const g of groups) {
            if (g.groupKind === 'stage') {
                for (const f of g.features) expect(f.core).toBeFalsy();
            }
        }
    });

    it('orders each group defaultOn-first, ties in registry order (stable)', () => {
        for (const g of groups) {
            const flags = g.features.map((f) => f.defaultOn);
            // No `false` may precede a `true` — defaultOn sorts ahead.
            const firstFalse = flags.indexOf(false);
            if (firstFalse !== -1) {
                expect(flags.slice(firstFalse).some((v) => v === true)).toBe(false);
            }
        }
    });

    it('omits empty groups', () => {
        for (const g of groups) expect(g.features.length).toBeGreaterThan(0);
    });

    it('is pure — does not mutate the input registry order', () => {
        const before = FEATURE_REGISTRY.map((f) => f.id);
        projectSettingsGroups(FEATURE_REGISTRY);
        expect(FEATURE_REGISTRY.map((f) => f.id)).toEqual(before);
    });

    it('handles an empty registry without throwing', () => {
        expect(projectSettingsGroups([] as readonly FeatureDef[])).toEqual([]);
    });
});
