// @vitest-environment happy-dom
/**
 * llmEnhancerProvider unit tests — Gemini + Haiku adapter HTTP contract.
 * Mocks Obsidian's requestUrl + global fetch (Anthropic /v1/models).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRequestUrl = vi.fn();
vi.mock('obsidian', async () => {
    const actual = await vi.importActual('../mocks/obsidian');
    return {
        ...actual,
        requestUrl: (...args: unknown[]) => mockRequestUrl(...args),
    };
});

import {
    LLM_ENHANCEMENT_PROVIDERS,
    __resetHaikuModelCacheForTests,
} from '../../src/services/audioNarration/llmEnhancerProvider';

const makeApp = (): any => ({ vault: {} });
const CTX = {
    noteTitle: 'Test',
    chunkIndex: 1,
    chunkTotal: 1,
    prevSectionTitle: '',
    nextSectionTitle: '',
};

function okGeminiResponse(json: unknown): any {
    return {
        status: 200,
        text: JSON.stringify(json),
        headers: {},
    };
}

describe('GeminiEnhancementProvider', () => {
    beforeEach(() => mockRequestUrl.mockReset());
    const provider = LLM_ENHANCEMENT_PROVIDERS.gemini;

    it('returns no-api-key when key is empty', async () => {
        const o = await provider.enhance(makeApp(), 'md', '', CTX);
        expect(o.ok).toBe(false);
        if (o.ok) return;
        expect(o.code).toBe('no-api-key');
        expect(mockRequestUrl).not.toHaveBeenCalled();
    });

    it('uses the gemini-flash-latest URL alias — never a pinned version', async () => {
        mockRequestUrl.mockResolvedValueOnce(okGeminiResponse({
            candidates: [{ content: { parts: [{ text: JSON.stringify({ enhancedMarkdown: 'out', decisions: [] }) }] } }],
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 80 },
        }));
        await provider.enhance(makeApp(), 'md', 'fake-key', CTX);
        const calledUrl = (mockRequestUrl.mock.calls[0][0] as { url: string }).url;
        expect(calledUrl).toContain('gemini-flash-latest');
        // Never any pinned version number
        expect(calledUrl).not.toMatch(/gemini-\d+\.\d+-flash/);
        expect(calledUrl).not.toMatch(/gemini-\d-flash/);
    });

    it('audit-code H10: sends API key in x-goog-api-key header, NOT URL query', async () => {
        mockRequestUrl.mockResolvedValueOnce(okGeminiResponse({
            candidates: [{ content: { parts: [{ text: JSON.stringify({ enhancedMarkdown: 'out', decisions: [] }) }] } }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }));
        await provider.enhance(makeApp(), 'md', 'secret-key-xyz', CTX);
        const call = mockRequestUrl.mock.calls[0][0] as { url: string; headers: Record<string, string> };
        expect(call.url).not.toContain('secret-key-xyz');
        expect(call.url).not.toContain('?key=');
        expect(call.headers['x-goog-api-key']).toBe('secret-key-xyz');
    });

    it('parses 200 OK + computes cost from usage metadata', async () => {
        mockRequestUrl.mockResolvedValueOnce(okGeminiResponse({
            candidates: [{ content: { parts: [{ text: JSON.stringify({
                enhancedMarkdown: 'enhanced output',
                decisions: [{ blockType: 'mermaid', action: 'summarise', reason: 'flowchart described' }],
            }) }] } }],
            usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 500 },
        }));
        const o = await provider.enhance(makeApp(), 'md', 'k', CTX);
        expect(o.ok).toBe(true);
        if (!o.ok) return;
        expect(o.value.enhancedMarkdown).toBe('enhanced output');
        expect(o.value.decisions).toHaveLength(1);
        // 1000 * 0.075/M + 500 * 0.30/M = 0.000075 + 0.00015 = 0.000225
        expect(o.value.actualCostUsd).toBeCloseTo(0.000225, 8);
    });

    it('http-429 → retryable=true with Retry-After honoured', async () => {
        mockRequestUrl.mockResolvedValueOnce({
            status: 429, text: '{"err":"rate"}', headers: { 'Retry-After': '7' },
        });
        const o = await provider.enhance(makeApp(), 'md', 'k', CTX);
        expect(o.ok).toBe(false);
        if (o.ok) return;
        expect(o.code).toBe('http-429');
        expect(o.metadata.retryable).toBe(true);
        expect(o.metadata.retryAfterMs).toBe(7000);
    });

    it('http-503 is retryable; http-401 is not', async () => {
        mockRequestUrl.mockResolvedValueOnce({ status: 503, text: '', headers: {} });
        const o1 = await provider.enhance(makeApp(), 'md', 'k', CTX);
        expect(o1.ok).toBe(false);
        if (!o1.ok) expect(o1.metadata.retryable).toBe(true);

        mockRequestUrl.mockResolvedValueOnce({ status: 401, text: '', headers: {} });
        const o2 = await provider.enhance(makeApp(), 'md', 'k', CTX);
        expect(o2.ok).toBe(false);
        if (!o2.ok) {
            expect(o2.code).toBe('http-401');
            expect(o2.metadata.retryable).toBe(false);
        }
    });

    it('malformed JSON → malformed-response', async () => {
        mockRequestUrl.mockResolvedValueOnce({
            status: 200, text: 'not-json', headers: {},
        });
        const o = await provider.enhance(makeApp(), 'md', 'k', CTX);
        expect(o.ok).toBe(false);
        if (!o.ok) expect(o.code).toBe('malformed-response');
    });

    it('200 OK with missing enhancedMarkdown → no-enhancement', async () => {
        mockRequestUrl.mockResolvedValueOnce(okGeminiResponse({
            candidates: [{ content: { parts: [{ text: JSON.stringify({ decisions: [] }) }] } }],
        }));
        const o = await provider.enhance(makeApp(), 'md', 'k', CTX);
        expect(o.ok).toBe(false);
        if (!o.ok) expect(o.code).toBe('no-enhancement');
    });

    it('handles markdown-fenced JSON output (some LLMs wrap their JSON)', async () => {
        mockRequestUrl.mockResolvedValueOnce(okGeminiResponse({
            candidates: [{ content: { parts: [{
                text: '```json\n' + JSON.stringify({ enhancedMarkdown: 'wrapped output', decisions: [] }) + '\n```',
            }] } }],
        }));
        const o = await provider.enhance(makeApp(), 'md', 'k', CTX);
        expect(o.ok).toBe(true);
        if (o.ok) expect(o.value.enhancedMarkdown).toBe('wrapped output');
    });
});

describe('HaikuEnhancementProvider', () => {
    const provider = LLM_ENHANCEMENT_PROVIDERS.haiku;

    beforeEach(() => {
        mockRequestUrl.mockReset();
        __resetHaikuModelCacheForTests();
    });

    function modelsResp(ids: string[]): any {
        return {
            status: 200,
            text: JSON.stringify({ data: ids.map(id => ({ id })) }),
            headers: {},
        };
    }

    it('queries /v1/models then issues /v1/messages — never hardcodes a version', async () => {
        mockRequestUrl
            .mockResolvedValueOnce(modelsResp(['claude-haiku-3-5-20241022', 'claude-haiku-4-5-20251001']))
            .mockResolvedValueOnce({
                status: 200,
                text: JSON.stringify({
                    content: [{ type: 'text', text: JSON.stringify({ enhancedMarkdown: 'h', decisions: [] }) }],
                    usage: { input_tokens: 100, output_tokens: 50 },
                }),
                headers: {},
            });
        const o = await provider.enhance(makeApp(), 'md', 'sk-ant-test', CTX);
        expect(mockRequestUrl).toHaveBeenCalledTimes(2);
        const modelsCallUrl = (mockRequestUrl.mock.calls[0][0] as { url: string }).url;
        expect(modelsCallUrl).toContain('/v1/models');
        // The body posted to /v1/messages should use the NEWEST Haiku id
        const messagesBody = JSON.parse((mockRequestUrl.mock.calls[1][0] as { body: string }).body);
        expect(messagesBody.model).toBe('claude-haiku-4-5-20251001');
        expect(o.ok).toBe(true);
    });

    it('computes cost from Anthropic usage metadata', async () => {
        mockRequestUrl
            .mockResolvedValueOnce(modelsResp(['claude-haiku-4-5-20251001']))
            .mockResolvedValueOnce({
                status: 200,
                text: JSON.stringify({
                    content: [{ type: 'text', text: JSON.stringify({ enhancedMarkdown: 'h', decisions: [] }) }],
                    usage: { input_tokens: 1000, output_tokens: 500 },
                }),
                headers: {},
            });
        const o = await provider.enhance(makeApp(), 'md', 'sk-ant', CTX);
        expect(o.ok).toBe(true);
        if (!o.ok) return;
        // 1000 * 0.80/M + 500 * 4.00/M = 0.0008 + 0.002 = 0.0028
        expect(o.value.actualCostUsd).toBeCloseTo(0.0028, 6);
    });

    it('http error from /v1/messages bubbles up as http-<code>', async () => {
        mockRequestUrl
            .mockResolvedValueOnce(modelsResp(['claude-haiku-4-5-20251001']))
            .mockResolvedValueOnce({
                status: 429, text: '{"err":"rate"}', headers: { 'retry-after': '3' },
            });
        const o = await provider.enhance(makeApp(), 'md', 'sk-ant', CTX);
        expect(o.ok).toBe(false);
        if (o.ok) return;
        expect(o.code).toBe('http-429');
        expect(o.metadata.retryAfterMs).toBe(3000);
    });

    /**
     * Live-spot-check regression 2026-05-24: first-run-per-account /v1/models
     * discovery hung forever, blocking all 4 parallel enhance chunks.
     *
     * Mock the GET as a never-resolving promise. With the new
     * DISCOVERY_TIMEOUT_MS race, the discovery aborts at 10s, falls through to
     * the sentinel, and the /v1/messages POST still fires using 'latest-haiku'.
     * Anthropic will return 404 for the sentinel (which the test simulates) —
     * surfaced as a visible http-404 warning instead of a silent hang.
     */
    it('regression: /v1/models hang is bounded by DISCOVERY_TIMEOUT_MS, falls through to sentinel + visible http-4xx', async () => {
        vi.useFakeTimers();
        try {
            // Discovery never resolves (simulates network/Electron net.request hang)
            mockRequestUrl
                .mockReturnValueOnce(new Promise(() => { /* never resolves */ }))
                .mockResolvedValueOnce({
                    status: 404,
                    text: '{"error":{"type":"not_found_error","message":"model: latest-haiku"}}',
                    headers: {},
                });
            const pending = provider.enhance(makeApp(), 'md', 'sk-ant-test', CTX);
            // Advance past the 10s discovery timeout
            await vi.advanceTimersByTimeAsync(10_001);
            const o = await pending;

            // POST to /v1/messages DID fire after the discovery timed out
            expect(mockRequestUrl).toHaveBeenCalledTimes(2);
            const messagesBody = JSON.parse((mockRequestUrl.mock.calls[1][0] as { body: string }).body);
            expect(messagesBody.model).toBe('latest-haiku');  // sentinel fallback

            // Surfaces as http-404 — visible warning to user, not silent hang
            expect(o.ok).toBe(false);
            if (!o.ok) {
                expect(o.code).toBe('http-404');
                expect(o.metadata.httpStatus).toBe(404);
                expect(o.metadata.retryable).toBe(false);
            }
        } finally {
            vi.useRealTimers();
        }
    });

    it('regression: /v1/models thrown error also falls through to sentinel', async () => {
        // Network-layer rejection (e.g. DNS, TLS, offline) — should NOT hang
        mockRequestUrl
            .mockRejectedValueOnce(new Error('ENOTFOUND api.anthropic.com'))
            .mockResolvedValueOnce({
                status: 404, text: '{}', headers: {},
            });
        const o = await provider.enhance(makeApp(), 'md', 'sk-ant-test', CTX);
        expect(mockRequestUrl).toHaveBeenCalledTimes(2);
        const messagesBody = JSON.parse((mockRequestUrl.mock.calls[1][0] as { body: string }).body);
        expect(messagesBody.model).toBe('latest-haiku');
        expect(o.ok).toBe(false);
        if (!o.ok) expect(o.code).toBe('http-404');
    });
});
