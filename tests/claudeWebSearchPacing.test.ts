vi.mock('obsidian', async () => {
    const mod = await import('./mocks/obsidian');
    return { ...mod, requestUrl: vi.fn() };
});
vi.mock('../src/utils/abortableSleep', () => ({ abortableSleep: vi.fn(async () => {}) }));
// Spy on the lease wrapper while keeping the real key builders.
vi.mock('../src/services/azure/azureRequestPacer', async (orig) => {
    const actual = await orig<typeof import('../src/services/azure/azureRequestPacer')>();
    return { ...actual, withAzureLease: vi.fn((_k: string, _s: unknown, fn: () => Promise<unknown>) => fn()) };
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { requestUrl } from 'obsidian';
import { withAzureLease, buildAzureClaudeDeploymentKey } from '../src/services/azure/azureRequestPacer';
import { ClaudeWebSearchAdapter } from '../src/services/research/adapters/claudeWebSearchAdapter';

const mockRequestUrl = requestUrl as unknown as ReturnType<typeof vi.fn>;
const leaseSpy = withAzureLease as unknown as ReturnType<typeof vi.fn>;
const BASE = 'https://res.services.ai.azure.com';
const MODEL = 'claude-sonnet-4-6';

function adapter(azure: boolean): ClaudeWebSearchAdapter {
    return new ClaudeWebSearchAdapter(async () => 'k', azure ? { model: MODEL, azureEndpointBase: BASE } : { model: MODEL });
}

beforeEach(() => {
    vi.clearAllMocks();
    // A 200 with a minimal Claude response so the per-attempt request resolves.
    mockRequestUrl.mockResolvedValue({ status: 200, headers: {}, json: { content: [{ type: 'text', text: 'a' }], usage: {} } });
});

describe('claudeWebSearchAdapter Azure pacing (shared bucket)', () => {
    it('Azure ⇒ acquires a lease on the SAME key the text path builds (shared azure-claude bucket)', async () => {
        try { await adapter(true).searchAndSynthesize('q'); } catch { /* parse shape is out of scope */ }
        expect(leaseSpy).toHaveBeenCalled();
        const key = leaseSpy.mock.calls[0][0];
        // Equal to the key built from the base AND from the cloudService-style full URL.
        expect(key).toBe(buildAzureClaudeDeploymentKey(BASE, MODEL));
        expect(key).toBe(buildAzureClaudeDeploymentKey(`${BASE}/anthropic/v1/messages`, MODEL));
    });

    it('non-Azure (direct Anthropic) ⇒ NO lease acquired', async () => {
        try { await adapter(false).searchAndSynthesize('q'); } catch { /* parse */ }
        expect(leaseSpy).not.toHaveBeenCalled();
    });
});
