import { BaseAdapter } from './baseAdapter';
import { AdapterConfig, ContentPart, MultimodalCapability } from './types';
import * as endpoints from './cloudEndpoints.json';
import { SYSTEM_PROMPT } from '../../utils/constants';
import { claudeSupportsAdaptiveThinking } from './modelCapabilities';

/** Thin export so existing call sites don't change — capability logic lives in
 *  modelCapabilities.ts, pattern-matched on family+version so new releases
 *  (Opus 4.8, 5.0, …) pick up the capability without code edits. */
export function supportsAdaptiveThinking(modelName: string | undefined): boolean {
    return claudeSupportsAdaptiveThinking(modelName);
}

export class ClaudeAdapter extends BaseAdapter {
    private readonly anthropicVersion = '2023-06-01';

    constructor(config: AdapterConfig) {
        super({
            ...config,
            endpoint: config.endpoint || endpoints.claude,
            modelName: config.modelName || 'claude-sonnet-4-6'
        });
        this.provider = {
            name: 'claude',
            requestFormat: {
                url: '/v1/messages',
                headers: {
                    'anthropic-version': this.anthropicVersion
                },
                body: {
                    model: this.config.modelName,
                    messages: [],
                    max_tokens: 1024
                }
            },
            responseFormat: {
                path: ['content', '0', 'text'],
                contentPath: ['content', '0', 'text'],
                errorPath: ['error', 'message']
            }
        };
    }

    /** Whether adaptive thinking is active for this adapter instance */
    private get useAdaptiveThinking(): boolean {
        return supportsAdaptiveThinking(this.config.modelName) && this.config.thinkingMode === 'adaptive';
    }

    /**
     * Injects adaptive thinking parameters into a request body.
     * - Adds `thinking: { type: 'adaptive' }`
     * - Bumps `max_tokens` to 16000 to accommodate thinking + output
     * - Removes temperature (incompatible with thinking)
     */
    private applyThinkingParams(body: Record<string, unknown>): Record<string, unknown> {
        if (!this.useAdaptiveThinking) return body;

        const result: Record<string, unknown> = { ...body };
        result.thinking = { type: 'adaptive' };
        // Thinking requires a larger token budget (thinking + visible output).
        // 64 000 gives ample room: even if thinking uses ~50 000 tokens the
        // remaining 14 000 suffice for structured JSON outputs.
        result.max_tokens = Math.max((result.max_tokens as number) || 0, 64000);
        // Temperature is not compatible with thinking
        delete result.temperature;
        return result;
    }

    /**
     * Formats a request for Claude's Messages API
     * Claude requires 'system' as a separate parameter, not in messages array
     */
    public formatRequest(prompt: string, _language?: string): Record<string, unknown> {
        const body: Record<string, unknown> = {
            model: this.config.modelName,
            max_tokens: 1024,
            system: SYSTEM_PROMPT,
            messages: [
                { role: 'user', content: prompt }
            ]
        };
        return this.applyThinkingParams(body);
    }

    getMultimodalCapability(): MultimodalCapability {
        return 'image+document';
    }

    formatMultimodalRequest(parts: ContentPart[], options?: { maxTokens?: number }): Record<string, unknown> {
        const contentItems = parts.map((part): Record<string, unknown> | null => {
            if (part.type === 'text') {
                return { type: 'text', text: part.text };
            } else if (part.type === 'image') {
                return {
                    type: 'image',
                    source: {
                        type: 'base64',
                        media_type: part.mediaType,
                        data: part.data
                    }
                };
            } else if (part.type === 'document') {
                return {
                    type: 'document',
                    source: {
                        type: 'base64',
                        media_type: part.mediaType,
                        data: part.data
                    }
                };
            }
            return null;
        }).filter((item): item is Record<string, unknown> => item !== null);

        const body: Record<string, unknown> = {
            model: this.config.modelName,
            max_tokens: options?.maxTokens || 4096,
            messages: [
                { role: 'user', content: contentItems }
            ]
        };
        return this.applyThinkingParams(body);
    }

    getHeaders(): Record<string, string> {
        if (!this.config.apiKey) {
            throw new Error('API key is required for Claude');
        }
        return {
            'Content-Type': 'application/json',
            'anthropic-version': this.anthropicVersion,
            'x-api-key': this.config.apiKey,
            // Required for browser / Electron clients — Anthropic's API
            // returns a CORS preflight failure without it. Obsidian's
            // requestUrl bypasses CORS natively (no preflight), but SSE
            // streaming in this plugin uses globalThis.fetch() which DOES
            // trigger a preflight. Without this header the presentation
            // builder's streaming request fails with
            // "blocked by CORS policy: No 'Access-Control-Allow-Origin'".
            'anthropic-dangerous-direct-browser-access': 'true',
        };
    }

    /**
     * Extracts the main text content from a Claude API response.
     * Handles both standard responses (content[0].text) and adaptive thinking
     * responses where content array contains thinking blocks followed by text blocks.
     */
    public parseResponseContent(response: unknown): string {
        const responseObj = response as { content?: Array<{ type?: string; text?: string }> };
        if (!responseObj?.content || !Array.isArray(responseObj.content)) {
            return '';
        }

        // Find text blocks — skip thinking blocks
        const textParts: string[] = [];
        for (const block of responseObj.content) {
            if (block.type === 'text' && block.text) {
                textParts.push(block.text);
            }
        }

        return textParts.join('\n\n') || '';
    }

    supportsStreaming() { return true; }

    formatStreamingRequest(prompt: string) {
        const body: Record<string, unknown> = {
            model: this.config.modelName,
            max_tokens: 4096,
            system: 'You are a helpful assistant that summarizes content accurately and thoroughly.',
            messages: [{ role: 'user', content: prompt }],
            stream: true,
        };
        return {
            url: this.getEndpoint(),
            headers: this.getHeaders(),
            body: this.applyThinkingParams(body),
        };
    }

    /**
     * Claude SSE uses event types: content_block_delta with text_delta.
     * With adaptive thinking, also receives thinking_delta events — skip those.
     */
    parseStreamingChunk(line: string): string | null {
        if (!line.startsWith('data: ')) return null;
        const data = line.slice(6).trim();
        try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
                return parsed.delta.text ?? null;
            }
            // Skip thinking_delta events — only pass through visible text
        } catch { /* skip */ }
        return null;
    }
}
