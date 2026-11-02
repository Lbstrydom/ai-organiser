vi.mock('obsidian', async () => {
    const mod = await import('./mocks/obsidian');
    return { ...mod, requestUrl: vi.fn() };
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { requestUrl, App } from 'obsidian';
import { CloudLLMService } from '../src/services/cloudService';
import { AdapterType } from '../src/services/adapters';

const mockRequestUrl = requestUrl as unknown as ReturnType<typeof vi.fn>;

function bedrock(thinkingMode?: 'standard' | 'adaptive'): CloudLLMService {
    return new CloudLLMService({
        type: 'bedrock' as AdapterType,
        endpoint: 'https://bedrock-runtime.us-west-2.amazonaws.com',
        apiKey: 'k', modelName: 'global.anthropic.claude-sonnet-4-6', language: 'en', thinkingMode,
    }, {} as App);
}

const ok = { status: 200, json: { content: [{ type: 'text', text: 'done' }] }, text: JSON.stringify({ content: [{ type: 'text', text: 'done' }] }) };

beforeEach(() => { vi.clearAllMocks(); });

describe('CloudLLMService on Bedrock — what goes on the wire', () => {
    it('summarize posts the Messages body to the InvokeModel URL with the caller options applied', async () => {
        mockRequestUrl.mockResolvedValue(ok);
        const r = await bedrock('adaptive').summarizeText('summarise this', { maxTokens: 3000, disableThinking: true });
        expect(r).toEqual({ success: true, content: 'done' });
        const req = mockRequestUrl.mock.calls[0][0] as { url: string; headers: Record<string, string>; body: string };
        expect(req.url).toBe('https://bedrock-runtime.us-west-2.amazonaws.com/model/global.anthropic.claude-sonnet-4-6/invoke');
        expect(req.headers.Authorization).toBe('Bearer k');
        const body = JSON.parse(req.body);
        expect(body).toEqual({
            anthropic_version: 'bedrock-2023-05-31',
            max_tokens: 3000,
            system: 'Complete the task in the user message and follow its output format exactly.',
            messages: [{ role: 'user', content: 'summarise this' }],
        });
    });

    it('a stable prefix is kept, never dropped, on the summarize path', async () => {
        mockRequestUrl.mockResolvedValue(ok);
        await bedrock().summarizeText('per-call text', { stablePrefix: 'shared head' });
        const body = JSON.parse((mockRequestUrl.mock.calls[0][0] as { body: string }).body);
        expect(JSON.stringify(body.messages)).toContain('shared head');
        expect(JSON.stringify(body.messages)).toContain('per-call text');
    });
});
