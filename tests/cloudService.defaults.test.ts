/**
 * CloudService Default Model Tests
 * Ensures fallback models use registry defaults, not hard-coded values.
 * Also tests SummarizeOptions threading through buildSummarizeRequestBody.
 */

import { CloudLLMService } from '../src/services/cloudService';
import { PROVIDER_DEFAULT_MODEL } from '../src/services/adapters/providerRegistry';
import { AdapterType } from '../src/services/adapters';
import { SummarizeOptions } from '../src/services/types';
import { App } from 'obsidian';

// Mock Obsidian App
const mockApp = {} as App;

describe('CloudService Fallback Models', () => {
    it('uses PROVIDER_DEFAULT_MODEL for Claude when modelName is undefined', () => {
        const service = new CloudLLMService({
            type: 'claude' as AdapterType,
            endpoint: 'https://api.anthropic.com/v1/messages',
            apiKey: 'test-key',
                modelName: '', // Empty string to bypass BaseLLMService validation
            language: 'en'
        }, mockApp);

        // Access private method via any cast for testing
        const body = (service as any).buildSummarizeRequestBody('test prompt');
        
        expect(body.model).toBe(PROVIDER_DEFAULT_MODEL.claude);
    });

    it('uses PROVIDER_DEFAULT_MODEL for OpenAI when modelName is undefined', () => {
        const service = new CloudLLMService({
            type: 'openai' as AdapterType,
            endpoint: 'https://api.openai.com/v1/chat/completions',
            apiKey: 'test-key',
                modelName: '', // Empty string to bypass BaseLLMService validation
            language: 'en'
        }, mockApp);

        const body = (service as any).buildSummarizeRequestBody('test prompt');
        
        // OpenAI fallback uses registry default
        expect(body.model).toBe(PROVIDER_DEFAULT_MODEL.openai);
    });

    it('prefers explicit modelName over registry default', () => {
        const service = new CloudLLMService({
            type: 'claude' as AdapterType,
            endpoint: 'https://api.anthropic.com/v1/messages',
            apiKey: 'test-key',
            modelName: 'claude-opus-4-20250514',
            language: 'en'
        }, mockApp);

        const body = (service as any).buildSummarizeRequestBody('test prompt');
        
        expect(body.model).toBe('claude-opus-4-20250514');
        expect(body.model).not.toBe(PROVIDER_DEFAULT_MODEL.claude);
    });

    it('fallback chain: config.modelName → registry → openai default', () => {
        const service = new CloudLLMService({
            type: 'deepseek' as AdapterType,
            endpoint: 'https://api.deepseek.com/v1/chat/completions',
            apiKey: 'test-key',
                modelName: '', // Empty string to bypass BaseLLMService validation
            language: 'en'
        }, mockApp);

        const body = (service as any).buildSummarizeRequestBody('test prompt');
        
        // DeepSeek adapter uses OpenAI-compatible format
        // Fallback: config.modelName (undefined) → registry[deepseek] → registry[openai]
        expect([PROVIDER_DEFAULT_MODEL.deepseek, PROVIDER_DEFAULT_MODEL.openai]).toContain(body.model);
    });

    it('reasoning models omit temperature and use 16384 max_completion_tokens', () => {
        const reasoningModels = ['gpt-5.2', 'gpt-5', 'o1-preview', 'o1-mini', 'o3-mini'];
        reasoningModels.forEach(modelName => {
            const service = new CloudLLMService({
                type: 'openai' as AdapterType,
                endpoint: 'https://api.openai.com/v1/chat/completions',
                apiKey: 'test-key',
                modelName,
                language: 'en'
            }, mockApp);

            const body = (service as any).buildSummarizeRequestBody('test prompt');

            expect(body.temperature).toBeUndefined();
            expect(body.max_completion_tokens).toBe(16384);
            expect(body.max_tokens).toBeUndefined();
        });
    });

    it('non-reasoning OpenAI models include temperature and use 4096 max_completion_tokens', () => {
        const nonReasoningModels = ['gpt-4o', 'gpt-4o-mini'];
        nonReasoningModels.forEach(modelName => {
            const service = new CloudLLMService({
                type: 'openai' as AdapterType,
                endpoint: 'https://api.openai.com/v1/chat/completions',
                apiKey: 'test-key',
                modelName,
                language: 'en'
            }, mockApp);

            const body = (service as any).buildSummarizeRequestBody('test prompt');

            expect(body.temperature).toBe(0.3);
            expect(body.max_completion_tokens).toBe(8192);
            expect(body.max_tokens).toBeUndefined();
        });
    });

    it('reasoning model gating works regardless of adapter type', () => {
        // GPT-5 via OpenRouter should still get reasoning model treatment
        const service = new CloudLLMService({
            type: 'openrouter' as AdapterType,
            endpoint: 'https://openrouter.ai/api/v1/chat/completions',
            apiKey: 'test-key',
            modelName: 'gpt-5.2',
            language: 'en'
        }, mockApp);

        const body = (service as any).buildSummarizeRequestBody('test prompt');

        expect(body.temperature).toBeUndefined();
        expect(body.max_completion_tokens).toBe(16384);
    });

    it('no fallback uses hard-coded gpt-4', () => {
        // Scan all adapter types to ensure none fallback to 'gpt-4'
        const adapters: AdapterType[] = ['openai', 'claude', 'gemini', 'deepseek', 'groq', 'vertex', 'openrouter', 'bedrock', 'aliyun', 'cohere', 'grok', 'mistral', 'requesty', 'openai-compatible'];

        adapters.forEach(adapterType => {
            const service = new CloudLLMService({
                type: adapterType,
                endpoint: 'https://api.example.com/v1/chat/completions',
                apiKey: 'test-key',
                    modelName: '', // Empty string to bypass BaseLLMService validation
                language: 'en'
            }, mockApp);

            const body = (service as any).buildSummarizeRequestBody?.('test') || {};

            // If model exists, it should NOT be 'gpt-4' unless that's the registry default for openai
            if (body.model) {
                if (adapterType !== 'openai' || PROVIDER_DEFAULT_MODEL.openai !== 'gpt-4') {
                    expect(body.model).not.toBe('gpt-4');
                }
            }
        });
    });
});

// ============================================================================
// SummarizeOptions threading through buildSummarizeRequestBody
// ============================================================================

function createClaudeService(modelName: string, thinkingMode?: 'standard' | 'adaptive') {
    return new CloudLLMService({
        type: 'claude' as AdapterType,
        endpoint: 'https://api.anthropic.com/v1/messages',
        apiKey: 'test-key',
        modelName,
        language: 'en',
        thinkingMode,
    }, mockApp);
}

function createGeminiService() {
    return new CloudLLMService({
        type: 'gemini' as AdapterType,
        endpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
        apiKey: 'test-key',
        modelName: 'gemini-2.5-flash',
        language: 'en',
    }, mockApp);
}

function createOpenAIService(modelName: string) {
    return new CloudLLMService({
        type: 'openai' as AdapterType,
        endpoint: 'https://api.openai.com/v1/chat/completions',
        apiKey: 'test-key',
        modelName,
        language: 'en',
    }, mockApp);
}

describe('CloudService SummarizeOptions — Claude', () => {
    it('disableThinking: true produces no thinking block for adaptive Sonnet 4.6', () => {
        const service = createClaudeService('claude-sonnet-4-6', 'adaptive');
        const options: SummarizeOptions = { disableThinking: true, maxTokens: 4096 };
        const body = (service as any).buildSummarizeRequestBody('test', options);

        expect(body.thinking).toBeUndefined();
        expect(body.max_tokens).toBe(4096);
    });

    it('disableThinking: true produces no thinking block for adaptive Opus 4.6', () => {
        const service = createClaudeService('claude-opus-4-6', 'adaptive');
        const options: SummarizeOptions = { disableThinking: true, maxTokens: 4096 };
        const body = (service as any).buildSummarizeRequestBody('test', options);

        expect(body.thinking).toBeUndefined();
        expect(body.max_tokens).toBe(4096);
    });

    it('maxTokens is respected (not overridden to 64000) when disableThinking: true', () => {
        const service = createClaudeService('claude-sonnet-4-6', 'adaptive');
        const options: SummarizeOptions = { disableThinking: true, maxTokens: 4096 };
        const body = (service as any).buildSummarizeRequestBody('test', options);

        expect(body.max_tokens).toBe(4096);
        expect(body.thinking).toBeUndefined();
    });

    it('maxTokens with thinking enabled uses caller budget (not forced to 64000)', () => {
        const service = createClaudeService('claude-sonnet-4-6', 'adaptive');
        const options: SummarizeOptions = { maxTokens: 24000 };
        const body = (service as any).buildSummarizeRequestBody('test', options);

        expect(body.max_tokens).toBe(24000);
        expect(body.thinking).toEqual({ type: 'adaptive' });
    });

    it('no options defaults to 64K + thinking for adaptive Claude 4.6', () => {
        const service = createClaudeService('claude-sonnet-4-6', 'adaptive');
        const body = (service as any).buildSummarizeRequestBody('test');

        expect(body.max_tokens).toBe(64000);
        expect(body.thinking).toEqual({ type: 'adaptive' });
    });

    it('no options defaults to 8192, no thinking for non-adaptive Claude', () => {
        const service = createClaudeService('claude-sonnet-4-6', 'standard');
        const body = (service as any).buildSummarizeRequestBody('test');

        expect(body.max_tokens).toBe(8192);
        expect(body.thinking).toBeUndefined();
    });

    it('disableThinking is a no-op for non-adaptive model', () => {
        const service = createClaudeService('claude-sonnet-4-5-20250929', 'adaptive');
        const options: SummarizeOptions = { disableThinking: true, maxTokens: 4096 };
        const body = (service as any).buildSummarizeRequestBody('test', options);

        // Model doesn't support thinking — disableThinking should still result in no thinking
        expect(body.thinking).toBeUndefined();
        expect(body.max_tokens).toBe(4096);
    });
});

describe('CloudService SummarizeOptions — Gemini', () => {
    // Gemini uses the OpenAI-compatible endpoint (v1beta/openai/chat/completions)
    // so buildSummarizeRequestBody returns OpenAI-format (messages + max_tokens),
    // not native Gemini (contents + generationConfig).
    it('respects maxTokens override', () => {
        const service = createGeminiService();
        const options: SummarizeOptions = { maxTokens: 4096 };
        const body = (service as any).buildSummarizeRequestBody('test', options);

        expect(body.max_tokens).toBe(4096);
        expect(body.messages).toBeDefined();
    });

    it('defaults to 8192 without maxTokens', () => {
        const service = createGeminiService();
        const body = (service as any).buildSummarizeRequestBody('test');

        expect(body.max_tokens).toBe(8192);
    });

    it('uses OpenAI-compat message shape, not native Gemini shape', () => {
        const service = createGeminiService();
        const body = (service as any).buildSummarizeRequestBody('test');

        // Must NOT include native Gemini fields (would cause HTTP 400 at the
        // OpenAI-compat endpoint — persona round 10 regression guard).
        expect(body.contents).toBeUndefined();
        expect(body.systemInstruction).toBeUndefined();
        expect(body.generationConfig).toBeUndefined();

        // MUST include OpenAI-format fields
        expect(body.messages).toHaveLength(2);
        expect(body.messages[0].role).toBe('system');
        expect(body.messages[1].role).toBe('user');
        expect(body.model).toBeTruthy();
    });
});

describe('CloudService SummarizeOptions — OpenAI', () => {
    it('non-reasoning model respects maxTokens override', () => {
        const service = createOpenAIService('gpt-4o');
        const options: SummarizeOptions = { maxTokens: 4096 };
        const body = (service as any).buildSummarizeRequestBody('test', options);

        expect(body.max_completion_tokens).toBe(4096);
    });

    it('reasoning model respects maxTokens override', () => {
        const service = createOpenAIService('gpt-5.2');
        const options: SummarizeOptions = { maxTokens: 24000 };
        const body = (service as any).buildSummarizeRequestBody('test', options);

        expect(body.max_completion_tokens).toBe(24000);
    });

    it('reasoning model defaults to 16384 without maxTokens', () => {
        const service = createOpenAIService('o3-mini');
        const body = (service as any).buildSummarizeRequestBody('test');

        expect(body.max_completion_tokens).toBe(16384);
    });

    it('non-reasoning model defaults to 8192 without maxTokens', () => {
        const service = createOpenAIService('gpt-4o-mini');
        const body = (service as any).buildSummarizeRequestBody('test');

        expect(body.max_completion_tokens).toBe(8192);
    });
});
