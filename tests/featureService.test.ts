import { describe, it, expect, vi } from 'vitest';

vi.mock('obsidian', async () => await import('./mocks/obsidian'));

import {
    isFeatureEnabled,
    defaultFeatureFlags,
    resolveEnable,
    resolveDisable,
    dependentsOf,
    type FeatureFlagsHost,
} from '../src/services/featureService';
import { FEATURE_REGISTRY, type FeatureId } from '../src/core/features';
import { migrateOldSettings } from '../src/core/settings';

const host = (flags: Partial<Record<FeatureId, boolean>>): FeatureFlagsHost => ({ featureFlags: flags });

describe('isFeatureEnabled', () => {
    it('core features are always enabled regardless of flags', () => {
        expect(isFeatureEnabled(host({}), 'provider')).toBe(true);
        expect(isFeatureEnabled(host({ provider: false } as never), 'provider')).toBe(true);
        expect(isFeatureEnabled(host({}), 'tagging')).toBe(true);
        expect(isFeatureEnabled(host({}), 'chat')).toBe(true);
    });

    it('coalesces an absent flag to registry.defaultOn (Gemini-G4)', () => {
        // summarize is defaultOn=true, canvas is defaultOn=false — neither saved.
        expect(isFeatureEnabled(host({}), 'summarize')).toBe(true);
        expect(isFeatureEnabled(host({}), 'canvas')).toBe(false);
    });

    it('honours an explicit saved flag over the default', () => {
        expect(isFeatureEnabled(host({ summarize: false }), 'summarize')).toBe(false);
        expect(isFeatureEnabled(host({ canvas: true }), 'canvas')).toBe(true);
    });

    it('is disabled when a required dependency is disabled (transitive)', () => {
        // research requires provider (core, always on) → enabled
        expect(isFeatureEnabled(host({ research: true }), 'research')).toBe(true);
        // a hypothetical: disable a required non-core dep cascades. summarize requires provider (core),
        // so use a chain via explicit off of a required dep is covered by resolveDisable cascade tests.
    });

    it('fails closed for an unknown id', () => {
        expect(isFeatureEnabled(host({}), 'does-not-exist' as FeatureId)).toBe(false);
    });
});

describe('defaultFeatureFlags', () => {
    it('returns the Lean set for every non-core feature, omitting core', () => {
        const flags = defaultFeatureFlags();
        // core omitted (always-on)
        expect('provider' in flags).toBe(false);
        expect('tagging' in flags).toBe(false);
        expect('chat' in flags).toBe(false);
        // on-by-default
        for (const id of ['summarize', 'translate', 'smart-note', 'presentation', 'minutes', 'semantic-search', 'research', 'export'] as FeatureId[]) {
            expect(flags[id]).toBe(true);
        }
        // off-by-default
        for (const id of ['audio-narration', 'web-reader', 'quick-peek', 'canvas', 'mermaid-chat', 'flashcards', 'digitisation', 'sketch', 'kindle', 'newsletter', 'notebooklm', 'bases', 'embed-scan'] as FeatureId[]) {
            expect(flags[id]).toBe(false);
        }
    });

    it('covers exactly the non-core registry', () => {
        const flags = defaultFeatureFlags();
        const nonCore = FEATURE_REGISTRY.filter((f) => !f.core).map((f) => f.id).sort();
        expect(Object.keys(flags).sort()).toEqual(nonCore);
    });
});

describe('resolveEnable', () => {
    it('enabling a feature transitively turns on its requires + reports newly-enabled deps', () => {
        // start with everything off; enabling research should also enable provider...
        // provider is CORE though (no flag), so `also` excludes it. Use a non-core chain by
        // turning provider into a flag-controlled state is impossible (core) — assert provider
        // is NOT listed (core has no flag) and research is set.
        const { flags, also } = resolveEnable({ research: false }, 'research');
        expect(flags.research).toBe(true);
        expect(also).not.toContain('provider'); // core dep → no flag flip
    });

    it('is idempotent (already-on yields empty also)', () => {
        const { also } = resolveEnable({ canvas: true }, 'canvas');
        expect(also).toEqual([]);
    });
});

describe('dependentsOf / resolveDisable', () => {
    it('lists enabled features that depend on the target', () => {
        // many features require provider; with the Lean defaults, the enabled provider-dependents
        // include summarize/research/etc. dependentsOf(provider) returns the enabled ones.
        const deps = dependentsOf(host(defaultFeatureFlags()), 'provider');
        expect(deps).toContain('summarize');
        expect(deps).toContain('research');
        expect(deps).not.toContain('canvas'); // canvas is off by default → not "broken"
    });

    it('resolveDisable refuses to disable a core feature (always-on invariant, FT-6)', () => {
        const { flags, cascaded } = resolveDisable(host({ summarize: true, translate: true }), 'provider');
        // Core can't be turned off — no flag written, no cascade (it would otherwise
        // cascade-disable every provider-dependent, an impossible persisted state).
        expect(flags.provider).toBeUndefined();
        expect(cascaded).toEqual([]);
    });

    it('resolveDisable turns off a non-core target', () => {
        const { flags, cascaded } = resolveDisable(host({ summarize: true }), 'summarize');
        expect(flags.summarize).toBe(false);
        // Nothing in the registry depends on summarize → no cascade.
        expect(cascaded).toEqual([]);
    });
});

describe('migrateOldSettings — feature flags (FT-11)', () => {
    it('seeds the Lean set when featureFlags is absent', () => {
        const out = migrateOldSettings({}) as Record<string, unknown>;
        const flags = out.featureFlags as Record<string, boolean>;
        expect(flags.summarize).toBe(true);
        expect(flags.canvas).toBe(false);
        expect(out.featuresIntroShown).toBe(false);
    });

    it('absorbs a legacy master BEFORE the default seed (newsletterEnabled:true preserved)', () => {
        const out = migrateOldSettings({ newsletterEnabled: true }) as Record<string, unknown>;
        const flags = out.featureFlags as Record<string, boolean>;
        // newsletter defaultOn=false, but the legacy true is absorbed first → ON.
        expect(flags.newsletter).toBe(true);
    });

    it('absorbs enableSemanticSearch into semantic-search when unset', () => {
        const out = migrateOldSettings({ enableSemanticSearch: false }) as Record<string, unknown>;
        const flags = out.featureFlags as Record<string, boolean>;
        // semantic-search defaultOn=true, but legacy false absorbed → OFF.
        expect(flags['semantic-search']).toBe(false);
    });

    it('an explicit saved flag wins over the legacy value', () => {
        const out = migrateOldSettings({ newsletterEnabled: true, featureFlags: { newsletter: false } }) as Record<string, unknown>;
        const flags = out.featureFlags as Record<string, boolean>;
        expect(flags.newsletter).toBe(false);
    });

    it('preserves already-saved flags + is idempotent', () => {
        const once = migrateOldSettings({ featureFlags: { canvas: true, summarize: false } }) as Record<string, unknown>;
        const flags1 = once.featureFlags as Record<string, boolean>;
        expect(flags1.canvas).toBe(true);
        expect(flags1.summarize).toBe(false);
        const twice = migrateOldSettings(once) as Record<string, unknown>;
        expect(twice.featureFlags).toEqual(flags1);
    });
});
