/**
 * Speed-pill → storyboard-generator model mapping (presentation-depth-controls
 * Cluster B, Phase 3 / D5). Covers the priority order: explicit role override wins;
 * else the Speed pill upgrades the MAIN provider (Deep=Opus, Fast=main); the pill
 * applies ONLY on the main context (cross-provider role keeps its model) and never
 * to local. The critic is unaffected by construction (resolved separately — this
 * resolver is only ever called for the generator call sites).
 */

import { describe, it, expect } from 'vitest';
import { resolveStoryboardModelOverride } from '../src/ui/chat/presentation/speedPillModel';
import { AdapterType } from '../src/services/adapters';

const base = {
    roleOverride: '',
    isMainContext: true,
    isLocal: false,
    adapterType: 'claude' as AdapterType,
    speedTier: 'quality' as const,
};

describe('resolveStoryboardModelOverride (D5)', () => {
    it('an explicit role override WINS over the pill (any tier)', () => {
        expect(resolveStoryboardModelOverride({ ...base, roleOverride: 'claude-sonnet-4-6', speedTier: 'quality' }))
            .toBe('claude-sonnet-4-6');
        expect(resolveStoryboardModelOverride({ ...base, roleOverride: 'claude-sonnet-4-6', speedTier: 'fast' }))
            .toBe('claude-sonnet-4-6');
    });

    it('a cross-provider role (not main context) keeps its model — pill does NOT apply', () => {
        expect(resolveStoryboardModelOverride({ ...base, isMainContext: false, speedTier: 'quality' })).toBe('');
    });

    it('a local main provider gets no Opus upgrade', () => {
        expect(resolveStoryboardModelOverride({ ...base, isLocal: true, speedTier: 'quality' })).toBe('');
    });

    it('direct claude — Deep upgrades to opus; Fast = main (no override)', () => {
        const deep = resolveStoryboardModelOverride({ ...base, adapterType: 'claude', speedTier: 'quality' });
        expect(deep).toBe('latest-opus'); // sentinel → resolved downstream by resolveModelOverride
        expect(resolveStoryboardModelOverride({ ...base, adapterType: 'claude', speedTier: 'fast' })).toBe('');
    });

    it('azure-claude — Deep resolves to a concrete Opus; Fast = main', () => {
        const deep = resolveStoryboardModelOverride({ ...base, adapterType: 'azure-claude', speedTier: 'quality' });
        expect(deep).toMatch(/^claude-opus/);
        expect(deep.startsWith('latest-')).toBe(false);
        expect(resolveStoryboardModelOverride({ ...base, adapterType: 'azure-claude', speedTier: 'fast' })).toBe('');
    });

    it('non-Claude mains get no upgrade — Fast=main always works, Deep degrades to ""', () => {
        for (const adapterType of ['gemini', 'openai', 'azure-openai', 'groq'] as AdapterType[]) {
            expect(resolveStoryboardModelOverride({ ...base, adapterType, speedTier: 'quality' })).toBe('');
            expect(resolveStoryboardModelOverride({ ...base, adapterType, speedTier: 'fast' })).toBe('');
        }
    });

    it('role override on a cross-provider context still wins (override is checked first)', () => {
        expect(resolveStoryboardModelOverride({ ...base, roleOverride: 'gemini-3.1-pro', isMainContext: false }))
            .toBe('gemini-3.1-pro');
    });
});
