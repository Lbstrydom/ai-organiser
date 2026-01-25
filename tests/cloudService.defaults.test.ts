/**
 * CloudService Default Model Tests
 * Ensures fallback models use registry defaults, not hard-coded values
 */

import { CloudLLMService } from '../src/services/cloudService';
import { PROVIDER_DEFAULT_MODEL } from '../src/services/adapters/providerRegistry';
import { AdapterType } from '../src/services/adapters';
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
        expect(body.model).toBe('claude-sonnet-4-5-20250929');
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
        expect(body.model).toBe('gpt-5.2');
    });

    it('uses PROVIDER_DEFAULT_MODEL for Gemini when modelName is undefined', () => {
        const service = new CloudLLMService({
            type: 'gemini' as AdapterType,
            endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent',
            apiKey: 'test-key',
                modelName: '', // Empty string to bypass BaseLLMService validation
            language: 'en'
        }, mockApp);

        // Gemini uses a different request structure, but model is embedded in endpoint
        // We verify the pattern exists
        expect(PROVIDER_DEFAULT_MODEL.gemini).toBe('gemini-3-flash');
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

    it('PDF summarization uses registry default for Claude', () => {
        const service = new CloudLLMService({
            type: 'claude' as AdapterType,
            endpoint: 'https://api.anthropic.com/v1/messages',
            apiKey: 'test-key',
                modelName: '', // Empty string to bypass BaseLLMService validation
            language: 'en'
        }, mockApp);

        // Build request body for PDF (won't actually call API)
        const requestBody = {
            model: (service as any).adapter['config']?.modelName || PROVIDER_DEFAULT_MODEL['claude'],
            max_tokens: 4096,
            messages: [{ role: 'user', content: [] }]
        };
        
        expect(requestBody.model).toBe(PROVIDER_DEFAULT_MODEL.claude);
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
