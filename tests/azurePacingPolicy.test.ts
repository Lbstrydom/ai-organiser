import { describe, it, expect } from 'vitest';
import { rpmForDeployment } from '../src/services/azure/azurePacingPolicy';

describe('rpmForDeployment — per-deployment RPM resolver (Phase 2)', () => {
    const GLOBAL = 60;

    it('returns the override when the deployment has a valid entry', () => {
        expect(rpmForDeployment('whisper', { whisper: 3 }, GLOBAL)).toBe(3);
        expect(rpmForDeployment('gpt-4o-transcribe', { 'gpt-4o-transcribe': 10000 }, GLOBAL)).toBe(10000);
    });

    it('falls back to global RPM on a miss', () => {
        expect(rpmForDeployment('gpt-5.5', { whisper: 3 }, GLOBAL)).toBe(GLOBAL);
        expect(rpmForDeployment('anything', {}, GLOBAL)).toBe(GLOBAL);
        expect(rpmForDeployment('anything', undefined, GLOBAL)).toBe(GLOBAL);
    });

    it('canonicalizes (trim + lowercase) on both the name and the map keys', () => {
        expect(rpmForDeployment('  Whisper ', { whisper: 3 }, GLOBAL)).toBe(3);
        expect(rpmForDeployment('whisper', { '  WHISPER': 3 }, GLOBAL)).toBe(3);
    });

    it('falls back to global for invalid override values (0, negative, NaN, non-int)', () => {
        expect(rpmForDeployment('d', { d: 0 }, GLOBAL)).toBe(GLOBAL);
        expect(rpmForDeployment('d', { d: -5 }, GLOBAL)).toBe(GLOBAL);
        expect(rpmForDeployment('d', { d: Number.NaN }, GLOBAL)).toBe(GLOBAL);
        expect(rpmForDeployment('d', { d: Infinity }, GLOBAL)).toBe(GLOBAL);
        // a fractional override floors to a valid int
        expect(rpmForDeployment('d', { d: 12.9 }, GLOBAL)).toBe(12);
    });

    it('blank deployment name → global', () => {
        expect(rpmForDeployment('', { '': 5 }, GLOBAL)).toBe(GLOBAL);
        expect(rpmForDeployment('   ', { whisper: 3 }, GLOBAL)).toBe(GLOBAL);
    });

    it('guards an invalid global fallback (defaults to 60)', () => {
        expect(rpmForDeployment('miss', {}, Number.NaN)).toBe(60);
        expect(rpmForDeployment('miss', {}, 0)).toBe(60);
    });
});
