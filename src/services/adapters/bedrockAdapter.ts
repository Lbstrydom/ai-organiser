import { BaseAdapter } from './baseAdapter';
import { AdapterConfig, BaseResponse, ContentPart, MultimodalCapability } from './types';
import type { SummarizeOptions } from '../types';
import * as endpoints from './cloudEndpoints.json';
import { SYSTEM_PROMPT } from '../../utils/constants';
import {
    bedrockToClaudeModelId,
    claudeAlwaysThinkingParams,
    claudeSupportsAdaptiveThinking,
    isClaudeModelId,
} from './modelCapabilities';
import { buildClaudeCachedPrompt } from './claudePromptCache';
import { getModelOutputLimit } from '../tokenLimits';

/** InvokeModel's body-level API version for Anthropic models (no `anthropic-version` header on Bedrock). */
export const BEDROCK_ANTHROPIC_VERSION = 'bedrock-2023-05-31';

/** The pre-rebuild default host. It names no region, so no request to it can succeed. */
const LEGACY_REGIONLESS_ENDPOINT = 'https://bedrock-runtime.amazonaws.com';

const SUMMARIZE_SYSTEM_PROMPT = 'Complete the task in the user message and follow its output format exactly.';

/**
 * Amazon Bedrock, Anthropic Claude models only, through `InvokeModel` on
 * `bedrock-runtime` with the Anthropic Messages request shape:
 * `POST {endpoint}/model/{modelId}/invoke`, body `anthropic_version` +
 * `max_tokens` + `system` + `messages` (the model is in the URL, never the body).
 * Authenticates with a Bedrock API key as a bearer token.
 *
 * Request bodies follow the first-party Claude adapter: no `temperature` /
 * `top_p` / `top_k` (Claude rejects them), no prefill, adaptive thinking only
 * in adaptive mode on a model that supports it, low effort for a model that
 * thinks by default. Capability checks run on the first-party id the Bedrock
 * id stands for (`global.anthropic.claude-sonnet-4-6` → `claude-sonnet-4-6`).
 *
 * No streaming: InvokeModelWithResponseStream uses AWS event-stream framing,
 * not SSE, so callers fall back to a single request.
 */
export class BedrockAdapter extends BaseAdapter {
    constructor(config: AdapterConfig) {
        const endpoint = !config.endpoint || config.endpoint.replace(/\/+$/, '') === LEGACY_REGIONLESS_ENDPOINT
            ? endpoints.bedrock
            : config.endpoint;
        super({
            ...config,
            endpoint,
            // Bedrock has no `latest-*` alias, so this is a concrete id. Sonnet 4.6
            // is served through a cross-region inference profile; the bare base id
            // 400s with "on-demand throughput isn't supported". Keep in step with
            // PROVIDER_DEFAULT_MODEL.bedrock.
            modelName: config.modelName || 'global.anthropic.claude-sonnet-4-6'
        });
        this.provider = {
            name: 'bedrock',
            requestFormat: { url: '/model/{modelId}/invoke', headers: {}, body: {} },
            responseFormat: {
                path: ['content', '0', 'text'],
                contentPath: ['content', '0', 'text'],
                errorPath: ['message']
            }
        };
    }

    /** The Bedrock model id or inference-profile id as configured. */
    private get bedrockModelId(): string {
        return this.config.modelName || '';
    }

    /** The first-party Claude id the Bedrock id stands for — used for every capability check. */
    private get claudeModelId(): string {
        return bedrockToClaudeModelId(this.bedrockModelId);
    }

    /** Adaptive thinking on, or low effort for a model that thinks by default — as `ClaudeAdapter` does. */
    private applyThinkingParams(body: Record<string, unknown>, thinking: boolean): Record<string, unknown> {
        if (thinking && claudeSupportsAdaptiveThinking(this.claudeModelId)) {
            return {
                ...body,
                thinking: { type: 'adaptive' },
                max_tokens: Math.max((body.max_tokens as number) || 0, 64000),
            };
        }
        const extra = claudeAlwaysThinkingParams(this.claudeModelId, (body.max_tokens as number) || 0);
        return Object.keys(extra).length ? { ...body, ...extra } : body;
    }

    private get adaptiveMode(): boolean {
        return this.config.thinkingMode === 'adaptive';
    }

    private buildBody(
        system: string | Array<Record<string, unknown>> | undefined,
        content: string | Array<Record<string, unknown>>,
        maxTokens: number,
    ): Record<string, unknown> {
        return {
            anthropic_version: BEDROCK_ANTHROPIC_VERSION,
            max_tokens: maxTokens,
            ...(system === undefined ? {} : { system }),
            messages: [{ role: 'user', content }],
        };
    }

    public formatRequest(prompt: string, _language?: string): Record<string, unknown> {
        return this.applyThinkingParams(this.buildBody(SYSTEM_PROMPT, prompt, 1024), this.adaptiveMode);
    }

    /** Tagging request with the stable head as an explicit cache breakpoint when it clears the model's minimum. */
    public formatCachedRequest(prompt: string, stablePrefix: string): Record<string, unknown> {
        const { systemField, userContent } = buildClaudeCachedPrompt(
            SYSTEM_PROMPT, prompt, this.claudeModelId, stablePrefix,
        );
        return this.applyThinkingParams(this.buildBody(systemField, userContent, 1024), this.adaptiveMode);
    }

    /**
     * Summarize / chat body, mirroring `CloudLLMService.buildClaudeSummarizeBody`.
     * A per-call `modelOverride` is not honoured: the model is part of the
     * InvokeModel URL, which is fixed per adapter.
     */
    public formatSummarizeRequest(prompt: string, options?: SummarizeOptions): Record<string, unknown> {
        const useThinking = (this.adaptiveMode || !!options?.enableThinking) && !options?.disableThinking;
        const thinkingActive = useThinking && claudeSupportsAdaptiveThinking(this.claudeModelId);
        const requested = options?.maxTokens || (thinkingActive ? 64000 : 8192);
        const maxTokens = Math.min(requested, getModelOutputLimit('claude', this.claudeModelId));
        const { systemField, userContent } = buildClaudeCachedPrompt(
            SUMMARIZE_SYSTEM_PROMPT, prompt, this.claudeModelId, options?.stablePrefix,
        );
        const body = this.buildBody(systemField, userContent, maxTokens);
        if (thinkingActive) return { ...body, thinking: { type: 'adaptive' } };
        return { ...body, ...claudeAlwaysThinkingParams(this.claudeModelId, maxTokens) };
    }

    getMultimodalCapability(): MultimodalCapability {
        return 'image+document';
    }

    formatMultimodalRequest(parts: ContentPart[], options?: { maxTokens?: number }): Record<string, unknown> {
        const content = parts.map((part): Record<string, unknown> => {
            if (part.type === 'text') return { type: 'text', text: part.text };
            return {
                type: part.type,
                source: { type: 'base64', media_type: part.mediaType, data: part.data },
            };
        });
        return this.applyThinkingParams(this.buildBody(undefined, content, options?.maxTokens || 4096), this.adaptiveMode);
    }

    /** `{endpoint}/model/{modelId}/invoke`; the id is encoded (`v1:0`, inference-profile ARNs). */
    getEndpoint(): string {
        const base = (this.config.endpoint || '').replace(/\/+$/, '');
        if (/\/invoke$/.test(base)) return base;
        return `${base}/model/${encodeURIComponent(this.bedrockModelId)}/invoke`;
    }

    /** Text blocks of a Messages response; thinking blocks are skipped. */
    public parseResponseContent(response: unknown): string {
        const content = (response as { content?: unknown } | null)?.content;
        if (!Array.isArray(content)) return '';
        return content
            .filter((b): b is { type: 'text'; text: string } =>
                !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text'
                && typeof (b as { text?: unknown }).text === 'string' && (b as { text: string }).text !== '')
            .map(b => b.text)
            .join('\n\n');
    }

    public parseResponse(response: unknown): BaseResponse {
        const text = this.parseResponseContent(response);
        if (!text) throw new Error('Failed to parse Bedrock response: missing content');
        try {
            const json = this.extractJsonFromContent(text);
            const matched = Array.isArray(json.matchedTags) ? json.matchedTags : [];
            const suggested = Array.isArray(json.newTags) ? json.newTags : [];
            return {
                text,
                matchedExistingTags: matched.map(t => String(t).trim()),
                suggestedTags: suggested.map(t => String(t).trim()),
            };
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new Error(`Failed to parse Bedrock response: ${message}`);
        }
    }

    public validateConfig(): string | null {
        if (!this.config.apiKey) {
            return 'An Amazon Bedrock API key is required';
        }
        if (!this.config.endpoint) {
            return 'Endpoint is required for Amazon Bedrock (https://bedrock-runtime.<region>.amazonaws.com)';
        }
        if (!this.config.modelName) {
            return 'Model name is required for Amazon Bedrock';
        }
        if (!isClaudeModelId(this.config.modelName)) {
            return 'Only Anthropic Claude models are supported on Amazon Bedrock (for example global.anthropic.claude-sonnet-4-6)';
        }
        return null;
    }

    public extractError(error: unknown): string {
        const err = error as { message?: string; response?: { data?: { message?: string } } };
        return err.response?.data?.message || err.message || 'Unknown error occurred';
    }

    public getHeaders(): Record<string, string> {
        return {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': `Bearer ${this.config.apiKey}`
        };
    }
}
