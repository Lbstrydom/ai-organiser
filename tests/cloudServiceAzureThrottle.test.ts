vi.mock('obsidian', async () => {
    const mod = await import('./mocks/obsidian');
    return { ...mod, requestUrl: vi.fn() };
});
// Make backoff instant so the RPM-retry test doesn't wait real seconds.
vi.mock('../src/utils/abortableSleep', () => ({ abortableSleep: vi.fn(async () => {}) }));

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { requestUrl, App } from 'obsidian';
import { CloudLLMService } from '../src/services/cloudService';
import { AdapterType } from '../src/services/adapters';
import { disposeAzurePacers, getAzurePacer } from '../src/services/azure/azureRequestPacer';

const mockRequestUrl = requestUrl as unknown as ReturnType<typeof vi.fn>;
const app = {} as App;

function azureClaude(): CloudLLMService {
    return new CloudLLMService({
        type: 'azure-claude' as AdapterType,
        endpoint: 'https://res.services.ai.azure.com/anthropic/v1/messages',
        apiKey: 'k', modelName: 'claude-sonnet-4-6', language: 'en',
    }, app);
}
function plainClaude(): CloudLLMService {
    return new CloudLLMService({
        type: 'claude' as AdapterType,
        endpoint: 'https://api.anthropic.com/v1/messages',
        apiKey: 'k', modelName: 'claude-sonnet-4-6', language: 'en',
    }, app);
}

beforeEach(() => { vi.clearAllMocks(); disposeAzurePacers(); });

describe('CloudLLMService Azure throttle', () => {
    it('>TPM 429 (token-dim, est>limit) fails fast — typed message, NO retry', async () => {
        mockRequestUrl.mockResolvedValue({
            status: 429,
            headers: { 'x-ratelimit-limit-tokens': '10000' },
            json: { error: { message: 'Rate limit of 10000 per 60s exceeded for ...UncachedInputTokens' } },
            text: 'Rate limit exceeded for tokens',
        });
        const svc = azureClaude();
        // A prompt big enough that the lower-bound estimate exceeds 10k tokens.
        const r = await svc.summarizeText('x'.repeat(60_000));
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/per-minute token limit|TPM/i);
        expect(mockRequestUrl).toHaveBeenCalledTimes(1); // fail-fast, no retry burn
    });

    it('a NON-Azure provider never touches the pacer (byte-identical path)', async () => {
        mockRequestUrl.mockResolvedValue({ status: 200, json: { content: [{ type: 'text', text: 'hi' }] }, text: '' });
        await plainClaude().summarizeText('hello');
        // No pacer was created for any key — non-Azure short-circuits pacedRequestUrl.
        expect(getAzurePacer('claude|api.anthropic.com|claude-sonnet-4-6').queueLength).toBe(0);
        expect(getAzurePacer('claude|api.anthropic.com|claude-sonnet-4-6').recentStarts).toBe(0);
    });

    it('a normal RPM 429 is paced + retried, then succeeds', async () => {
        mockRequestUrl
            .mockResolvedValueOnce({
                status: 429,
                headers: { 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '1' },
                json: { error: { message: 'Rate limit exceeded for requests' } },
                text: 'requests',
            })
            .mockResolvedValueOnce({ status: 200, json: { content: [{ type: 'text', text: 'ok' }] }, text: '' });
        await azureClaude().summarizeText('hi');
        // The RPM 429 is RETRIED (not fail-fast) — the 2nd attempt fired. Pacing +
        // dimension-aware backoff worked; response-body parsing is out of scope here.
        expect(mockRequestUrl).toHaveBeenCalledTimes(2);
    });
});

describe('sendMultimodal Azure throttle (azure-throttle-coverage)', () => {
    const pdfPart = () => [{ type: 'document' as const, mimeType: 'application/pdf', data: 'JVBERi'.repeat(20_000) }];

    it('token-dim 429 + max_tokens > limit ⇒ >TPM fail-fast, NO retry', async () => {
        mockRequestUrl.mockResolvedValue({
            status: 429,
            headers: { 'x-ratelimit-limit-tokens': '10000' },
            json: { error: { message: 'Rate limit exceeded for ...Tokens' } },
            text: 'tokens',
        });
        const r = await azureClaude().sendMultimodal(pdfPart(), { maxTokens: 64000 });
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/per-minute token limit/i);
        expect(mockRequestUrl).toHaveBeenCalledTimes(1); // fail-fast — the huge base64 body did NOT need char counting
    });

    it('a base64-heavy RPM 429 (request dim) does NOT false-fail-fast — it retries', async () => {
        mockRequestUrl
            .mockResolvedValueOnce({
                status: 429,
                headers: { 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '1' },
                json: { error: { message: 'Rate limit exceeded for requests' } },
                text: 'requests',
            })
            .mockResolvedValueOnce({ status: 200, text: JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }) });
        const r = await azureClaude().sendMultimodal(pdfPart(), { maxTokens: 1024 });
        expect(r.success).toBe(true);
        expect(mockRequestUrl).toHaveBeenCalledTimes(2); // retried, not fail-fast (no token dim in the body)
    });

    it('exhausted token-dim 429 ⇒ AzureRateLimitError (audit M4)', async () => {
        // Every attempt 429s on the token dimension, but max_tokens is small so the
        // conservative est can't pre-empt — the exhausted path still surfaces >TPM.
        mockRequestUrl.mockResolvedValue({
            status: 429,
            headers: { 'x-ratelimit-limit-tokens': '10000' },
            json: { error: { message: 'Rate limit exceeded for ...Tokens' } },
            text: 'tokens',
        });
        const r = await azureClaude().sendMultimodal(pdfPart(), { maxTokens: 100 });
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/per-minute token limit/i);
        expect(mockRequestUrl).toHaveBeenCalledTimes(3); // retried to exhaustion, THEN the actionable error
    });

    it('non-Azure multimodal makes a single un-paced call', async () => {
        mockRequestUrl.mockResolvedValue({ status: 200, json: { content: [{ type: 'text', text: 'hi' }] }, text: '' });
        await plainClaude().sendMultimodal(pdfPart(), { maxTokens: 1024 });
        expect(mockRequestUrl).toHaveBeenCalledTimes(1);
    });
});
