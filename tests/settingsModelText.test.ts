import { describe, it, expect } from 'vitest';
import { en } from '../src/i18n/en';
import { usesWhisperDeployment } from '../src/services/azure/resolveAzureCapability';
import { DEFAULT_SETTINGS } from '../src/core/settings';

/** A model version in explanatory text goes stale with the next release. */
const VERSIONED = /\b(claude|sonnet|opus|haiku|gpt)[ -]?\d/i;

function descriptions(node: unknown, path: string): Array<[string, string]> {
    if (node === null || typeof node !== 'object') return [];
    return Object.entries(node).flatMap(([key, value]): Array<[string, string]> => {
        if (typeof value !== 'string') return descriptions(value, `${path}.${key}`);
        return /desc(ription)?$/i.test(key) ? [[`${path}.${key}`, value]] : [];
    });
}

describe('settings descriptions', () => {
    const found = descriptions(en.settings, 'settings');

    it('name no model version', () => {
        expect(found.length).toBeGreaterThan(100); // positive control
        expect(found.filter(([, text]) => VERSIONED.test(text))).toEqual([]);
    });

    it('the pattern catches the text it was written for', () => {
        for (const stale of ['Claude sonnet 4.6 is recommended', 'requires claude 4.6', 'Opus 4.6 adaptive thinking', 'e.g. gpt-5.5']) {
            expect(VERSIONED.test(stale), stale).toBe(true);
        }
    });
});

describe('usesWhisperDeployment', () => {
    type Plugin = Parameters<typeof usesWhisperDeployment>[0];
    const plugin = (patch: Record<string, unknown>): Plugin => ({
        settings: { ...structuredClone(DEFAULT_SETTINGS), cloudServiceType: 'azure-claude', ...patch },
        secretStorageService: { getSecret: async () => null, getProviderKey: async () => null, isAvailable: () => false },
    }) as unknown as Plugin;

    it('is false when strict mode forbids Whisper', async () => {
        expect(await usesWhisperDeployment(plugin({ azureSpeechRequired: true }))).toBe(false);
    });

    it.each(['byo', 'off'])('is false when transcription is %s', async mode => {
        expect(await usesWhisperDeployment(plugin({ azureCapabilities: { transcription: { mode } } }))).toBe(false);
    });

    it('is true when Azure transcribes and Azure AI Speech is not set up', async () => {
        expect(await usesWhisperDeployment(plugin({ azureCapabilities: { transcription: { mode: 'azure' } }, azureSpeechEndpoint: '' }))).toBe(true);
    });

    it('is false when Azure AI Speech serves transcription', async () => {
        const ready = plugin({
            azureCapabilities: { transcription: { mode: 'azure' } },
            azureSpeechEndpoint: 'https://example.cognitiveservices.azure.com',
            azureApiKey: 'k',
        });
        expect(await usesWhisperDeployment(ready)).toBe(false);
    });
});
