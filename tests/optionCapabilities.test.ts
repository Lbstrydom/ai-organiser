/**
 * Option-fidelity capability table (llm-option-fidelity, Phase 1).
 * One table answers, per provider, which per-call options it can honour; the
 * critic resolver and the cloud service both read it.
 */
import { describe, it, expect } from 'vitest';
import {
    OPTION_CAPABILITIES,
    getOptionCapabilities,
    canHonourModelOverride,
    modelOverrideRouting,
    routeRole,
} from '../src/services/llm/optionCapabilities';
import { ALL_ADAPTERS } from '../src/services/adapters/providerRegistry';

describe('optionCapabilities table', () => {
    it('has a row for every adapter type and for local', () => {
        for (const a of ALL_ADAPTERS) expect(OPTION_CAPABILITIES[a], a).toBeDefined();
        expect(OPTION_CAPABILITIES.local).toBeDefined();
    });

    it('records the scattered rules in one place', () => {
        expect(modelOverrideRouting('azure-openai')).toBe('deployment');
        expect(modelOverrideRouting('bedrock')).toBe('service-config');
        expect(modelOverrideRouting('local')).toBe('none');
        for (const p of ['claude', 'azure-claude', 'gemini', 'openai', 'openrouter', 'groq'] as const) {
            expect(modelOverrideRouting(p), p).toBe('per-call');
        }
        expect(getOptionCapabilities('local').thinking).toBe('none');
        expect(getOptionCapabilities('claude').thinking).toBe('model-gated');
        expect(getOptionCapabilities('openai').thinking).toBe('none');
    });

    it('fails closed for an unknown or missing provider', () => {
        for (const p of ['nope', '', undefined, null]) {
            const caps = getOptionCapabilities(p);
            expect(caps.modelOverride).toBe('none');
            expect(caps.thinking).toBe('none');
            expect(canHonourModelOverride(p)).toBe(false);
        }
    });

    it('canHonourModelOverride is true only for per-call providers', () => {
        expect(canHonourModelOverride('gemini')).toBe(true);
        expect(canHonourModelOverride('bedrock')).toBe(false);
        expect(canHonourModelOverride('azure-openai')).toBe(false);
        expect(canHonourModelOverride('local')).toBe(false);
    });
});

describe('routeRole (D3 routing matrix)', () => {
    const cases: Array<[string, string, boolean, string]> = [
        // provider, label, sameProvider, expected
        ['gemini', 'same', true, 'per-call'],
        ['openai', 'same', true, 'per-call'],
        ['claude', 'same', true, 'per-call'],
        ['bedrock', 'same', true, 'specialist'],
        ['azure-openai', 'same', true, 'downgrade'],
        ['local', 'same', true, 'downgrade'],
        ['local', 'cross', false, 'downgrade'],
        ['gemini', 'cross', false, 'specialist'],
        ['bedrock', 'cross', false, 'specialist'],
        ['azure-openai', 'cross', false, 'specialist'],
    ];
    it.each(cases)('%s (%s provider) -> %s', (provider, _label, same, expected) => {
        expect(routeRole(provider, same).route).toBe(expected);
    });

    it('fails closed for a missing or unrecognised provider on another provider', () => {
        expect(routeRole(undefined, false)).toEqual({ route: 'downgrade', reason: 'override-unsupported' });
        expect(routeRole('not-a-provider', false)).toEqual({ route: 'downgrade', reason: 'override-unsupported' });
    });

    it('gives a stable downgrade reason', () => {
        expect(routeRole('azure-openai', true)).toEqual({ route: 'downgrade', reason: 'deployment-routed' });
        expect(routeRole('local', true)).toEqual({ route: 'downgrade', reason: 'override-unsupported' });
        expect(routeRole('local', false)).toEqual({ route: 'downgrade', reason: 'override-unsupported' });
    });
});
