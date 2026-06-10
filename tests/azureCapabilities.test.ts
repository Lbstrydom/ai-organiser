import { describe, it, expect } from 'vitest';
import {
    AZURE_CAPABILITIES,
    AZURE_CAPABILITY_IDS,
    listCapabilities,
    getCapability,
    defaultModeFor,
    azureSituation,
} from '../src/services/azure/azureCapabilities';
import { FEATURE_REGISTRY } from '../src/core/features';

const FEATURE_IDS = new Set(FEATURE_REGISTRY.map((f) => f.id));

describe('azureCapabilities registry', () => {
    it('exposes exactly the 6 specialist capabilities', () => {
        expect([...AZURE_CAPABILITY_IDS].sort()).toEqual(
            ['embeddings', 'transcription', 'tts', 'visual-embeddings', 'websearch', 'youtube'].sort(),
        );
        expect(listCapabilities()).toHaveLength(6);
    });

    it('every featureFlag is a real FeatureId', () => {
        for (const def of listCapabilities()) {
            for (const f of def.featureFlags) {
                expect(FEATURE_IDS.has(f), `${def.id} → ${f}`).toBe(true);
            }
        }
    });

    it('support/surface are consistent (none ⇒ no surface; full/partial ⇒ surface set)', () => {
        for (const def of listCapabilities()) {
            if (def.support === 'none') expect(def.surface).toBeNull();
            else expect(def.surface).not.toBeNull();
        }
    });

    it('youtube has no Azure path (support none, surface null)', () => {
        expect(getCapability('youtube').support).toBe('none');
        expect(getCapability('youtube').surface).toBeNull();
    });

    it('websearch is partial on the azure-claude surface', () => {
        expect(getCapability('websearch').support).toBe('partial');
        expect(getCapability('websearch').surface).toBe('azure-claude');
    });

    it('tts ships as full (Azure Speech engine in scope) on azure-openai', () => {
        expect(getCapability('tts').support).toBe('full');
        expect(getCapability('tts').surface).toBe('azure-openai');
    });

    it('websearch gates on both research and presentation (grounding)', () => {
        expect([...getCapability('websearch').featureFlags].sort()).toEqual(['presentation', 'research']);
    });

    it('defaultModeFor: none→byo, otherwise→azure', () => {
        expect(defaultModeFor(getCapability('youtube'))).toBe('byo');
        expect(defaultModeFor(getCapability('transcription'))).toBe('azure');
        expect(defaultModeFor(getCapability('embeddings'))).toBe('azure');
        expect(defaultModeFor(getCapability('websearch'))).toBe('azure');
        expect(defaultModeFor(getCapability('tts'))).toBe('azure');
    });

    it('azureSituation maps support → badge', () => {
        expect(azureSituation(getCapability('transcription'))).toBe('has');
        expect(azureSituation(getCapability('websearch'))).toBe('partial');
        expect(azureSituation(getCapability('youtube'))).toBe('none');
    });

    it('registry is frozen (SSOT immutability)', () => {
        expect(Object.isFrozen(AZURE_CAPABILITIES)).toBe(true);
    });
});
