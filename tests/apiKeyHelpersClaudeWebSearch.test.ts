/**
 * apiKeyHelpers.getClaudeWebSearchKey — key-source precedence.
 *
 * Regression guard for the live-confirmed Azure 401 (2026-06): under
 * azure-claude the web-search request is Bearer-authed to the Foundry
 * passthrough, so a dedicated (direct-Anthropic, x-api-key) research key must
 * NOT be honoured — it would be Bearer-sent to Azure and 401. On Azure the
 * Foundry key always wins; the dedicated key only applies on the non-Azure path.
 */

import { describe, it, expect, vi } from 'vitest';
import { getClaudeWebSearchKey } from '../src/services/apiKeyHelpers';
import { PLUGIN_SECRET_IDS } from '../src/core/secretIds';

function makePlugin(opts: {
    cloudServiceType?: string;
    azureResolved?: string | null;
    azureApiKey?: string;
    cloudApiKey?: string;
    secrets?: Record<string, string | null>;
}) {
    return {
        settings: {
            cloudServiceType: opts.cloudServiceType ?? '',
            azureApiKey: opts.azureApiKey ?? '',
            cloudApiKey: opts.cloudApiKey ?? '',
        },
        secretStorageService: {
            isAvailable: () => true,
            getSecret: vi.fn(async (id: string) => opts.secrets?.[id] ?? null),
            resolveApiKey: vi.fn(async () => opts.azureResolved ?? null),
        },
    };
}

describe('getClaudeWebSearchKey precedence', () => {
    it('under azure-claude, returns the Foundry key and IGNORES a stale dedicated key', async () => {
        const plugin = makePlugin({
            cloudServiceType: 'azure-claude',
            azureResolved: 'azure-foundry-key',
            secrets: { [PLUGIN_SECRET_IDS.RESEARCH_CLAUDE_WEB_SEARCH_KEY]: 'sk-ant-stale-dedicated' },
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = await getClaudeWebSearchKey(plugin as any);
        expect(r).toBe('azure-foundry-key');
        expect(r).not.toBe('sk-ant-stale-dedicated');
    });

    it('on a non-Azure provider, the dedicated research key still takes precedence', async () => {
        const plugin = makePlugin({
            cloudServiceType: 'openai',
            secrets: { [PLUGIN_SECRET_IDS.RESEARCH_CLAUDE_WEB_SEARCH_KEY]: 'sk-ant-dedicated' },
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = await getClaudeWebSearchKey(plugin as any);
        expect(r).toBe('sk-ant-dedicated');
    });

    it('under direct claude with no dedicated key, falls back to the main Anthropic key', async () => {
        const plugin = makePlugin({
            cloudServiceType: 'claude',
            secrets: { 'anthropic-api-key': 'sk-ant-main' },
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = await getClaudeWebSearchKey(plugin as any);
        expect(r).toBe('sk-ant-main');
    });
});
