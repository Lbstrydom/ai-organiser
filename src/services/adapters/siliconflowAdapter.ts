import { requestUrl } from "obsidian";
import { BaseAdapter } from "./baseAdapter";
import { AdapterConfig, RequestBody } from "./types";
import { ConnectionTestResult, ConnectionTestError } from "../types";

export class SiliconflowAdapter extends BaseAdapter {
  constructor(config: AdapterConfig) {
    super(config);
    this.provider = {
      name: 'siliconflow',
      requestFormat: {
        url: '/v1/chat/completions',
        headers: {},
        body: {
          model: this.config.modelName,
          messages: []
        }
      },
      responseFormat: {
        path: ['choices', 0, 'message', 'content'],
        errorPath: ['error', 'message']
      }
    };
  }

  getHeaders(): Record<string, string> {
    if (!this.config.apiKey) {
      throw new Error('API key is required for Siliconflow');
    }
    return {
      'Authorization': `Bearer ${this.config.apiKey}`,
      'Content-Type': 'application/json'
    };
  }

  formatRequest(prompt: string): RequestBody {
    return {
      model: this.config.modelName || 'siliconflow-chat',
      messages: [{
        role: 'user',
        content: prompt
      }]
    };
  }

  public validateConfig(): string | null {
    const baseValidation = super.validateConfig();
    if (baseValidation) return baseValidation;
    
    if (!this.config.apiKey) {
      return 'API key is required for Siliconflow';
    }
    return null;
  }

  async testConnection(): Promise<{ result: ConnectionTestResult; error?: ConnectionTestError }> {
    try {
      const response = await requestUrl({
        url: `${this.getEndpoint()}/v1/chat/completions`,
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(this.formatRequest('test'))
      });

      if (response.status >= 400) {
        const error = response.json as { error?: { message?: string } };
        return { result: ConnectionTestResult.Failed, error: { type: 'unknown', message: error.error?.message || 'Connection test failed' } };
      }

      return { result: ConnectionTestResult.Success };
    } catch (error) {
      return { result: ConnectionTestResult.Failed, error: { type: 'unknown', message: error instanceof Error ? error.message : 'Unknown error' } };
    }
  }

  parseResponse(response: unknown): import('./types').BaseResponse {
    try {
      let result: unknown = response;
      for (const key of this.provider.responseFormat.path) {
        result = (result as Record<string, unknown>)[key];
      }
      const text = typeof result === 'string' ? result : '';
      return { text, matchedExistingTags: [], suggestedTags: [] };
    } catch {
      throw new Error('Failed to parse Siliconflow response');
    }
  }

  supportsStreaming() { return true; }
  formatStreamingRequest(prompt: string) { return this.buildOpenAIStreamingRequest(prompt); }
  parseStreamingChunk(line: string) { return BaseAdapter.parseOpenAISSEChunk(line); }
}
