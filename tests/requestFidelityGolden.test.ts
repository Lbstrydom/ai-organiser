// @vitest-environment happy-dom
/**
 * Request bytes for every provider configuration, captured from settings:
 * the chat request the live service sends and every Azure endpoint the
 * resolver builds. A settings-screen change must not move any of them.
 * The snapshot was recorded before the layout change; do not update it for a
 * UI-only change.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

vi.mock('obsidian', async () => ({
    ...await import('./mocks/obsidian'),
    ...(await import('./helpers/settingsHarness')).settingsObsidianOverrides(),
    requestUrl: vi.fn(),
}));

import { requestUrl } from 'obsidian';
import { setupSettingsDom, makeSettingsPlugin, flushRender } from './helpers/settingsHarness';
import { SETTINGS_FIXTURES } from './helpers/settingsFixtures';
import AIOrganiserPlugin from '../src/main';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { en } from '../src/i18n/en';
import * as ep from '../src/services/azure/endpointResolver';
import { disposeAzurePacers } from '../src/services/azure/azureRequestPacer';
import { createEmbeddingServiceFromSettings } from '../src/services/embeddings/embeddingServiceFactory';

const mockRequestUrl = requestUrl as unknown as ReturnType<typeof vi.fn>;
const DEPS = { Plugin: AIOrganiserPlugin, defaults: DEFAULT_SETTINGS, t: en };

beforeAll(setupSettingsDom);
beforeEach(() => {
    vi.clearAllMocks();
    disposeAzurePacers();
    mockRequestUrl.mockResolvedValue({
        status: 200, headers: {}, text: '',
        json: { choices: [{ message: { content: 'ok' } }], content: [{ type: 'text', text: 'ok' }], data: [{ embedding: [0.1] }] },
    });
});

interface Sent { url: string; headers: string[]; body: unknown }

function lastRequest(): Sent {
    const call = mockRequestUrl.mock.calls.at(-1)?.[0] as { url: string; headers?: Record<string, string>; body?: string };
    return {
        url: call.url,
        headers: Object.entries(call.headers ?? {}).map(([k, v]) => `${k}: ${v}`).sort(),
        body: call.body ? JSON.parse(call.body) : undefined,
    };
}

function azureUrls(settings: unknown): Record<string, string> {
    const s = settings as Parameters<typeof ep.getOpenAIChatEndpoint>[0];
    const builders = {
        claude: ep.getClaudeMessagesEndpoint,
        chat: ep.getOpenAIChatEndpoint,
        embeddings: ep.getOpenAIEmbeddingsEndpoint,
        whisper: ep.getWhisperEndpoint,
        speech: ep.getSpeechEndpoint,
        imageEmbeddings: ep.getFoundryImageEmbeddingsEndpoint,
    };
    return Object.fromEntries(Object.entries(builders).map(([k, build]) => [k, build(s)]));
}

describe('request fidelity golden', () => {
    for (const [name, fixture] of Object.entries(SETTINGS_FIXTURES)) {
        it(name, async () => {
            const { plugin } = await makeSettingsPlugin(DEPS, structuredClone(fixture));
            await flushRender();
            mockRequestUrl.mockClear();
            await (plugin as unknown as { llmService: { summarizeText(t: string): Promise<unknown> } }).llmService.summarizeText('hello');
            const out: Record<string, unknown> = { chat: lastRequest() };

            if (String(plugin.settings.cloudServiceType).startsWith('azure') && plugin.settings.serviceType === 'cloud') {
                out.azureUrls = azureUrls(plugin.settings);
            } else {
                const { service } = await createEmbeddingServiceFromSettings({ ...plugin.settings, featureFlags: { 'semantic-search': true } });
                if (service) {
                    mockRequestUrl.mockClear();
                    await service.generateEmbedding('hello');
                    out.embeddings = lastRequest();
                }
            }
            expect(out).toMatchSnapshot();
        });
    }
});
