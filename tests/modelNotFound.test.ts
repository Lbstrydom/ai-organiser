import { describe, it, expect, afterEach, vi } from 'vitest';
import { isModelNotFound, requestedModelName, withModelGuidance } from '../src/services/modelNames/modelNotFound';
import { en } from '../src/i18n/en';
import { makeService, stubFetch } from './helpers/streamHarness';

const json = (v: unknown): string => JSON.stringify(v);

const MISSING: Array<[string, number, string]> = [
    ['Azure', 404, json({ error: { code: 'DeploymentNotFound', message: 'The API deployment for this resource does not exist.' } })],
    ['OpenAI', 404, json({ error: { code: 'model_not_found', message: 'The model `gpt-x` does not exist or you do not have access to it.' } })],
    ['Anthropic', 404, json({ type: 'error', error: { type: 'not_found_error', message: 'model: claude-x' } })],
    ['Gemini', 404, json([{ error: { code: 404, status: 'NOT_FOUND', message: 'models/gemini-x is not found for API version v1beta.' } }])],
    ['OpenRouter', 400, json({ error: { code: 400, message: 'vendor/x is not a valid model ID' } })],
    ['Mistral', 400, json({ message: 'Invalid model: mistral-x' })],
    ['Bedrock', 400, json({ message: 'The provided model identifier is invalid.' })],
    ['Ollama', 404, json({ error: "model 'llama-x' not found, try pulling it first" })],
    ['plain text', 404, 'model "x" not found'],
];

const OTHER: Array<[string, number, string]> = [
    ['wrong address', 404, json({ error: { code: '404', message: 'Resource not found' } })],
    ['empty 404', 404, ''],
    ['bad parameter', 400, json({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model." } })],
    ['capability', 400, json({ error: { message: 'This model does not support image input.' } })],
    ['bad key', 401, json({ error: { code: 'model_not_found', message: 'x' } })],
    ['server error', 500, json({ error: { message: 'The model does not exist' } })],
];

describe('isModelNotFound', () => {
    it.each(MISSING)('recognises %s', (_name, status, body) => {
        expect(isModelNotFound(status, body)).toBe(true);
    });
    it.each(OTHER)('ignores %s', (_name, status, body) => {
        expect(isModelNotFound(status, body)).toBe(false);
    });
});

describe('withModelGuidance', () => {
    it('keeps the original message first and names the next step and the model', () => {
        const out = withModelGuidance('HTTP error 404: gone', 404, MISSING[0][2], 'claude-x');
        expect(out.startsWith('HTTP error 404: gone')).toBe(true);
        expect(out).toContain(en.guidance['model-not-found'].nextStep);
        expect(out).toContain('"claude-x"');
    });
    it('returns every other message unchanged', () => {
        for (const [, status, body] of OTHER) expect(withModelGuidance('m', status, body, 'x')).toBe('m');
    });
});

describe('requestedModelName', () => {
    it('prefers the body, then the URL, then the configured name', () => {
        expect(requestedModelName({ model: 'a' }, 'https://h/deployments/b/chat', 'c')).toBe('a');
        expect(requestedModelName({}, 'https://h/deployments/b/chat', 'c')).toBe('b');
        expect(requestedModelName({}, 'https://h/v1beta/models/g:generateContent', 'c')).toBe('g');
        expect(requestedModelName(undefined, 'https://h/v1/messages', 'c')).toBe('c');
    });
});

describe('cloud service streaming', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it.each(['claude', 'azure-claude'] as const)('%s: a missing model reaches the caller with the next step', async type => {
        stubFetch(() => new Response(MISSING[0][2], { status: 404 }));
        const result = await makeService(type, 'claude-x').summarizeTextStream('p', () => undefined);
        expect(result.success).toBe(false);
        expect(result.error).toContain('HTTP 404');
        expect(result.error).toContain('Replace a model name');
        expect(result.error).toContain('"claude-x"');
    });

    it('any other failure keeps the old message', async () => {
        stubFetch(() => new Response('boom', { status: 500 }));
        const result = await makeService('claude', 'claude-x').summarizeTextStream('p', () => undefined);
        expect(result.error).toBe('HTTP 500');
    });
});
