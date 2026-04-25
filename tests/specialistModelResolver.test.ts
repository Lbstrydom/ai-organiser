/**
 * specialistModelResolver tests — slide tier dispatch.
 *
 * Pins the contract from R5 HIGH-1 fix: only providers with both a
 * `resolveLatestModel` case AND a registry entry for the sentinel may be
 * listed in `FAST_TIER_SENTINELS`. Unlisted providers must fall back to
 * `mainModel` rather than POSTing an unresolved sentinel.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/services/adapters/dynamicModelService', () => ({
    getCachedModels: () => null,
}));

import { resolveSlideTierModel } from '../src/services/specialistModelResolver';

describe('resolveSlideTierModel — fast tier fallback (R5 HIGH-1 fix)', () => {
    it('groq has no fast-tier sentinel, so fast tier falls back to mainModel', () => {
        // Critical: groq is NOT in FAST_TIER_SENTINELS because
        // `resolveLatestModel` has no `case 'groq'` — sending a literal
        // `latest-fast` to the Groq API would 400. The contract is that
        // any provider missing from the table degrades to mainModel.
        const out = resolveSlideTierModel('groq', 'fast', 'llama-3.1-70b-versatile');
        expect(out).toBe('llama-3.1-70b-versatile');
    });

    it('claude fast tier resolves the haiku sentinel', () => {
        const out = resolveSlideTierModel('claude', 'fast', 'claude-opus-4-7');
        // The fast sentinel is `latest-haiku`. With no live cache and the
        // test setup, the registry resolver returns the sentinel unchanged
        // OR a concrete haiku id. Either way it must NOT be the main model.
        expect(out).not.toBe('claude-opus-4-7');
    });

    it('quality tier always returns the resolved main model', () => {
        const out = resolveSlideTierModel('groq', 'quality', 'llama-3.1-70b-versatile');
        expect(out).toBe('llama-3.1-70b-versatile');
    });

    it('quality tier on claude resolves through resolveForProvider', () => {
        // Concrete model id passes through unchanged.
        const out = resolveSlideTierModel('claude', 'quality', 'claude-opus-4-7');
        expect(out).toBe('claude-opus-4-7');
    });
});
