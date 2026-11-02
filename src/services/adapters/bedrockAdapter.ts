import { BaseAdapter } from './baseAdapter';
import { AdapterConfig, BaseResponse, ContentPart, MultimodalCapability } from './types';
import type { SummarizeOptions } from '../types';
import * as endpoints from './cloudEndpoints.json';
import { SYSTEM_PROMPT } from '../../utils/constants';
import {
    bedrockToClaudeModelId,
    claudeAlwaysThinkingParams,
    claudeSupportsAdaptiveThinking,
} from './modelCapabilities';
import { buildClaudeCachedPrompt } from './claudePromptCache';
import { getModelOutputLimit } from '../tokenLimits';
import { PROVIDER_DEFAULT_MODEL } from './providerRegistry';

/** InvokeModel's body-level API version for Anthropic models (no `anthropic-version` header on Bedrock). */
export const BEDROCK_ANTHROPIC_VERSION = 'bedrock-2023-05-31';

/** The pre-rebuild default host. It names no region, so no request to it can succeed. */
const LEGACY_REGIONLESS_ENDPOINT = 'https://bedrock-runtime.amazonaws.com';

const SUMMARIZE_SYSTEM_PROMPT = 'Complete the task in the user message and follow its output format exactly.';

/**
 * The runtime host the adapter posts to. The model always comes from
 * `modelName`, never from the URL, so a pasted full InvokeModel URL is cut back
 * to its host: one model identity drives the URL and every capability check.
 * A pasted URL naming a different model is refused by `validateConfig`.
 */
export function bedrockRuntimeBase(endpoint: string | undefined): string {
    const host = (endpoint ?? '').trim().replace(/\/model\/.*$/, '').replace(/\/+$/, '');
    return !host || host === LEGACY_REGIONLESS_ENDPOINT ? endpoints.bedrock : host;
}

/** The model id a pasted InvokeModel URL names (`…/model/{id}/invoke`), or `undefined` when it names none. */
function bedrockEndpointModelId(endpoint: string | undefined): string | undefined {
    const m = /\/model\/([^/]+)(?:\/invoke)?\/*$/.exec((endpoint ?? '').trim());
    if (!m) return undefined;
    try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

/**
 * Amazon Bedrock, Anthropic Claude models only, through `InvokeModel` on
 * `bedrock-runtime` with the Anthropic Messages request shape:
 * `POST {host}/model/{modelId}/invoke`, body `anthropic_version` +
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
    /** The endpoint as configured, before it is cut to its host — read only to catch a conflicting pasted model. */
    private readonly configuredEndpoint: string | undefined;

    constructor(config: AdapterConfig) {
        super({
            ...config,
            endpoint: bedrockRuntimeBase(config.endpoint),
            // Bedrock has no `latest-*` alias, so the registry default is a concrete id.
            modelName: config.modelName?.trim() || PROVIDER_DEFAULT_MODEL.bedrock
        });
        this.configuredEndpoint = config.endpoint;
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

    private get adaptiveMode(): boolean {
        return this.config.thinkingMode === 'adaptive';
    }

    /**
     * The one thinking and output-budget policy for every request path:
     * adaptive thinking (lifting the budget to 64K unless the caller set one),
     * or low effort for a model that thinks by default, as `ClaudeAdapter`
     * does; then the budget is clamped to the model's output ceiling.
     */
    private applyThinkingParams(
        body: Record<string, unknown>,
        thinking: boolean,
        callerBudget = false,
    ): Record<string, unknown> {
        const limit = getModelOutputLimit('claude', this.claudeModelId);
        const current = (body.max_tokens as number) || 0;
        if (thinking && claudeSupportsAdaptiveThinking(this.claudeModelId)) {
            const budget = callerBudget ? current : Math.max(current, 64000);
            return { ...body, thinking: { type: 'adaptive' }, max_tokens: Math.min(budget, limit) };
        }
        const clamped = Math.min(current, limit);
        return { ...body, max_tokens: clamped, ...claudeAlwaysThinkingParams(this.claudeModelId, clamped) };
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
        const { systemField, userContent } = buildClaudeCachedPrompt(
            SUMMARIZE_SYSTEM_PROMPT, prompt, this.claudeModelId, options?.stablePrefix,
        );
        const body = this.buildBody(systemField, userContent, options?.maxTokens || 8192);
        return this.applyThinkingParams(body, useThinking, !!options?.maxTokens);
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

    /** `{host}/model/{modelId}/invoke`; the id is encoded (`v1:0`, inference-profile ARNs). */
    getEndpoint(): string {
        return `${bedrockRuntimeBase(this.config.endpoint)}/model/${encodeURIComponent(this.bedrockModelId)}/invoke`;
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
            // Degrade, don't hard-fail (AGENTS.md): a missing array is empty and a
            // non-string element is dropped, never stringified into a tag. Only a
            // payload carrying neither array is a structural break.
            if (!Array.isArray(json.matchedTags) && !Array.isArray(json.newTags)) {
                throw new Error('neither matchedTags nor newTags is an array');
            }
            const strings = (v: unknown): string[] => (Array.isArray(v) ? v : [])
                .filter((t): t is string => typeof t === 'string')
                .map(t => t.trim())
                .filter(t => t !== '');
            return { text, matchedExistingTags: strings(json.matchedTags), suggestedTags: strings(json.newTags) };
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new Error(`Failed to parse Bedrock response: ${message}`);
        }
    }

    public validateConfig(): string | null {
        if (!this.config.apiKey) {
            return 'An Amazon Bedrock API key is required';
        }
        if (!this.config.modelName) {
            return 'Model name is required for Amazon Bedrock';
        }
        // A Bedrock Claude id names the provider and the family (`[region.]anthropic.claude-…`).
        if (!this.claudeModelId.startsWith('claude-')) {
            return 'Only Anthropic Claude models are supported on Amazon Bedrock (for example global.anthropic.claude-sonnet-4-6)';
        }
        const pastedModel = bedrockEndpointModelId(this.configuredEndpoint);
        if (pastedModel !== undefined && pastedModel !== this.config.modelName) {
            return `The endpoint names model ${pastedModel} but the model setting is ${this.config.modelName}; set the endpoint to https://bedrock-runtime.<region>.amazonaws.com`;
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
