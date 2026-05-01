/**
 * apiKeyHelpers.getAudioNarrationProviderConfig — verifies the canonical
 * resolver wires through `audioNarrationProvider` settings key (audit R2-H4).
 */

import { describe, it, expect, vi } from 'vitest';
import { getAudioNarrationProviderConfig } from '../src/services/apiKeyHelpers';

interface MockPlugin {
    settings: Record<string, unknown>;
    secretStorageService: { isAvailable: () => boolean; resolveApiKey?: ReturnType<typeof vi.fn>; getProviderKey?: ReturnType<typeof vi.fn> };
}

function makePlugin(opts: {
    audioNarrationProvider?: string;
    cloudServiceType?: string;
    cloudApiKey?: string;
    providerKey?: string;
    secretKey?: string | null;
}): MockPlugin {
    const provider = opts.audioNarrationProvider || 'gemini';
    return {
        settings: {
            audioNarrationProvider: opts.audioNarrationProvider ?? 'gemini',
            cloudServiceType: opts.cloudServiceType ?? '',
            cloudApiKey: opts.cloudApiKey ?? '',
            providerSettings: opts.providerKey ? { [provider]: { apiKey: opts.providerKey } } : {},
        },
        secretStorageService: {
            isAvailable: () => opts.secretKey !== undefined,
            resolveApiKey: vi.fn(async () => opts.secretKey ?? null),
            getProviderKey: vi.fn(async () => opts.secretKey ?? null),
        },
    };
}

describe('getAudioNarrationProviderConfig', () => {
    it('returns null when no key is resolvable', async () => {
        const plugin = makePlugin({});
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = await getAudioNarrationProviderConfig(plugin as any);
        expect(r).toBeNull();
    });

    it('returns config when SecretStorage has the key', async () => {
        const plugin = makePlugin({ secretKey: 'sk-secret' });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = await getAudioNarrationProviderConfig(plugin as any);
        expect(r).not.toBeNull();
        expect(r?.apiKey).toBe('sk-secret');
        expect(r?.provider).toBe('gemini');
    });

    it('returns config when providerSettings has the key (no SecretStorage)', async () => {
        const plugin = makePlugin({ providerKey: 'sk-provider' });
        plugin.secretStorageService.isAvailable = () => false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = await getAudioNarrationProviderConfig(plugin as any);
        expect(r).not.toBeNull();
        expect(r?.apiKey).toBe('sk-provider');
    });

    it('returns config when cloudServiceType matches and cloudApiKey is set', async () => {
        const plugin = makePlugin({ cloudServiceType: 'gemini', cloudApiKey: 'sk-main' });
        plugin.secretStorageService.isAvailable = () => false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = await getAudioNarrationProviderConfig(plugin as any);
        expect(r).not.toBeNull();
        expect(r?.apiKey).toBe('sk-main');
    });

    it('respects audioNarrationProvider setting (provider routing)', async () => {
        // For v1 only 'gemini' is in the registry, but the helper should pass
        // whatever the setting says through to resolveSpecialistProvider.
        const plugin = makePlugin({ audioNarrationProvider: 'gemini', secretKey: 'sk-x' });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = await getAudioNarrationProviderConfig(plugin as any);
        expect(r?.provider).toBe('gemini');
    });
});
