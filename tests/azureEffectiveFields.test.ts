import { describe, it, expect } from 'vitest';
import {
    AZURE_ADVANCED,
    countAdvancedOverrides,
    resolveDeploymentField,
    setDeploymentField,
    standardAdvancedSettings,
} from '../src/services/azure/azureEffectiveFields';
import { getOpenAIEmbeddingsEndpoint, getSpeechEndpoint, getWhisperEndpoint } from '../src/services/azure/endpointResolver';
import { DEFAULT_SETTINGS, type AIOrganiserSettings } from '../src/core/settings';

const make = (o: Partial<AIOrganiserSettings> = {}): AIOrganiserSettings => ({
    ...structuredClone(DEFAULT_SETTINGS),
    azureOpenAIEndpoint: 'https://r.openai.azure.com',
    azureRoutingMode: 'deployment-based',
    ...o,
});

const urlDeployment = (url: string): string => /\/deployments\/([^/]+)\//.exec(url)![1];

describe('resolveDeploymentField follows the endpoint resolver', () => {
    const cases = [
        { id: 'embeddings', build: getOpenAIEmbeddingsEndpoint, legacy: { azureDeployments: { embeddings: 'shared' } } },
        { id: 'transcription', build: getWhisperEndpoint, legacy: { azureWhisperDeployment: 'shared' } },
    ] as const;

    for (const c of cases) {
        it(`${c.id}: the override wins and the field says so`, () => {
            const s = make({ ...c.legacy, azureCapabilities: { [c.id]: { mode: 'azure', deployment: ' own ' } } });
            const field = resolveDeploymentField(s, c.id);
            expect(field).toEqual({ value: 'own', source: 'capability', isOverride: true });
            expect(urlDeployment(c.build(s))).toBe(field.value);
        });

        it(`${c.id}: a blank override leaves the shared value in effect`, () => {
            const s = make({ ...c.legacy, azureCapabilities: { [c.id]: { mode: 'azure', deployment: '  ' } } });
            const field = resolveDeploymentField(s, c.id);
            expect(field).toEqual({ value: 'shared', source: 'legacy', isOverride: false });
            expect(urlDeployment(c.build(s))).toBe(field.value);
        });

        it(`${c.id}: editing and clearing the override changes what is called`, () => {
            const s = make({ ...c.legacy, azureCapabilities: { [c.id]: { mode: 'azure', deployment: 'own' } } });
            setDeploymentField(s, c.id, 'capability', 'next');
            expect(urlDeployment(c.build(s))).toBe('next');
            setDeploymentField(s, c.id, 'capability', '');
            expect(s.azureCapabilities[c.id]).toEqual({ mode: 'azure', deployment: '' });
            expect(urlDeployment(c.build(s))).toBe('shared');
        });

        it(`${c.id}: editing the shared value leaves the capability choice alone`, () => {
            const s = make(c.legacy);
            setDeploymentField(s, c.id, 'legacy', 'next');
            expect(urlDeployment(c.build(s))).toBe('next');
            expect(s.azureCapabilities).toEqual({});
        });
    }

    it('read aloud has only the per-feature deployment', () => {
        const s = make();
        expect(resolveDeploymentField(s, 'tts')).toEqual({ value: '', source: 'capability', isOverride: false });
        setDeploymentField(s, 'tts', 'capability', ' voice-dep ');
        expect(urlDeployment(getSpeechEndpoint(s))).toBe('voice-dep');
    });
});

describe('countAdvancedOverrides', () => {
    it('is zero for default settings', () => {
        expect(countAdvancedOverrides(make({ azureRoutingMode: 'model-based' }), AZURE_ADVANCED)).toBe(0);
    });

    it('counts each Advanced setting that differs', () => {
        const s = make({
            azureMaxRpm: 5, debugMode: true, azurePerDeploymentRpm: {},
            azureCapabilities: { youtube: { mode: 'off' } },
        });
        expect(countAdvancedOverrides(s, AZURE_ADVANCED, { speechKeySet: true })).toBe(6);
    });

    it('counts a changed built-in endpoint, and not one for a custom service', () => {
        const builtIn = make({ serviceType: 'cloud', cloudServiceType: 'openai', cloudEndpoint: 'https://proxy.example/v1' });
        expect(countAdvancedOverrides(builtIn, standardAdvancedSettings(builtIn))).toBe(1);
        const custom = make({ serviceType: 'cloud', cloudServiceType: 'openai-compatible', cloudEndpoint: 'https://proxy.example/v1' });
        expect(standardAdvancedSettings(custom).map(d => d.id)).toEqual(['debug']);
    });
});
