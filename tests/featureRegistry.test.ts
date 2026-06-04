import { describe, it, expect } from 'vitest';
import {
    FEATURE_REGISTRY,
    FEATURE_BY_ID,
    SECTION_FEATURE,
    SURFACE_FEATURE,
    CHATMODE_FEATURE,
    INFRA_SECTIONS,
    type FeatureId,
} from '../src/core/features';
import { WORKFLOW_STAGES } from '../src/core/workflowStages';
import { en } from '../src/i18n/en';

/** Walk a dotted i18n path into a translations object. */
function resolvePath(root: unknown, path: string): unknown {
    let cur: unknown = root;
    for (const p of path.split('.')) {
        if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
            cur = (cur as Record<string, unknown>)[p];
        } else {
            return undefined;
        }
    }
    return cur;
}

const IDS = new Set<string>(FEATURE_REGISTRY.map((f) => f.id));

describe('FEATURE_REGISTRY structural invariants', () => {
    it('has no duplicate ids', () => {
        expect(IDS.size).toBe(FEATURE_REGISTRY.length);
    });

    it('FEATURE_BY_ID indexes every entry', () => {
        for (const f of FEATURE_REGISTRY) expect(FEATURE_BY_ID[f.id]).toBe(f);
    });

    it('every requires[] entry is a known FeatureId', () => {
        for (const f of FEATURE_REGISTRY) {
            for (const dep of f.requires) expect(IDS.has(dep)).toBe(true);
        }
    });

    it('the requires graph is acyclic', () => {
        // DFS cycle detection over requires edges.
        const WHITE = 0, GREY = 1, BLACK = 2;
        const colour = new Map<FeatureId, number>();
        const dfs = (id: FeatureId): boolean => {
            colour.set(id, GREY);
            for (const dep of FEATURE_BY_ID[id].requires) {
                const c = colour.get(dep) ?? WHITE;
                if (c === GREY) return false; // back-edge → cycle
                if (c === WHITE && !dfs(dep)) return false;
            }
            colour.set(id, BLACK);
            return true;
        };
        for (const f of FEATURE_REGISTRY) {
            if ((colour.get(f.id) ?? WHITE) === WHITE) {
                expect(dfs(f.id)).toBe(true);
            }
        }
    });

    it('core features carry no non-core requirement and default on', () => {
        for (const f of FEATURE_REGISTRY.filter((x) => x.core)) {
            expect(f.defaultOn).toBe(true);
            for (const dep of f.requires) expect(FEATURE_BY_ID[dep].core).toBe(true);
        }
    });

    it('every feature declares a known workflow stage', () => {
        for (const f of FEATURE_REGISTRY) expect(WORKFLOW_STAGES).toContain(f.stage);
    });

    it('only genuinely-remote features carry the external-account boundary (Integrations float)', () => {
        const external = FEATURE_REGISTRY.filter((f) => (f.boundary ?? []).includes('external-account')).map((f) => f.id);
        // Kindle (Amazon) + Newsletter (Gmail) authenticate to a remote account; local tools
        // (bases, notebooklm) must NOT — mislabeling would pollute the privacy signal.
        expect(external.sort()).toEqual(['kindle', 'newsletter']);
    });

    it('labelKey/descKey are non-empty i18n paths', () => {
        for (const f of FEATURE_REGISTRY) {
            expect(f.labelKey).toMatch(/^features\./);
            expect(f.descKey).toMatch(/^features\./);
        }
    });

    it('every labelKey/descKey resolves to a non-empty string in en (i18n SSOT — FT-1)', () => {
        for (const f of FEATURE_REGISTRY) {
            const label = resolvePath(en, f.labelKey);
            const desc = resolvePath(en, f.descKey);
            expect(typeof label, `missing/!string ${f.labelKey}`).toBe('string');
            expect((label as string).length, `empty ${f.labelKey}`).toBeGreaterThan(0);
            expect(typeof desc, `missing/!string ${f.descKey}`).toBe('string');
            expect((desc as string).length, `empty ${f.descKey}`).toBeGreaterThan(0);
        }
    });
});

describe('ownership maps reference only known features', () => {
    it('SECTION_FEATURE values ∈ registry', () => {
        for (const id of Object.values(SECTION_FEATURE)) expect(IDS.has(id as string)).toBe(true);
    });
    it('SURFACE_FEATURE values ∈ registry', () => {
        for (const id of Object.values(SURFACE_FEATURE)) expect(IDS.has(id as string)).toBe(true);
    });
    it('CHATMODE_FEATURE values ∈ registry', () => {
        for (const id of Object.values(CHATMODE_FEATURE)) expect(IDS.has(id as string)).toBe(true);
    });
});

describe('settings-section ownership is well-formed', () => {
    it('SECTION_FEATURE keys and INFRA_SECTIONS are disjoint', () => {
        const sectionKeys = new Set(Object.keys(SECTION_FEATURE));
        for (const infra of INFRA_SECTIONS) expect(sectionKeys.has(infra)).toBe(false);
    });

    it('shared-host features are NOT section owners (FT-9: translate/smart-note/presentation/flashcards)', () => {
        const owned = new Set(Object.values(SECTION_FEATURE));
        for (const id of ['translate', 'smart-note', 'presentation', 'flashcards'] as FeatureId[]) {
            expect(owned.has(id)).toBe(false);
        }
    });
});
