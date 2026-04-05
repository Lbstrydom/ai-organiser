import { BaseAdapter } from "./baseAdapter";
import { AdapterConfig, BaseResponse } from "./types";
import * as endpoints from './cloudEndpoints.json';

export class DeepseekAdapter extends BaseAdapter {
  constructor(config: AdapterConfig) {
    super({
      ...config,
      endpoint: config.endpoint || endpoints.deepseek,
      modelName: config.modelName || 'deepseek-v3.2'
    });
    this.provider = {
      name: 'deepseek',
      requestFormat: {
        body: {
          model: this.modelName
        }
      },
      responseFormat: {
        path: ['choices', '0', 'message', 'content'],
        errorPath: ['error', 'message']
      }
    };
  }

  getHeaders(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.config.apiKey}`,
      'Content-Type': 'application/json'
    };
  }

  private readonly defaultConfig = {
    defaultModel: 'deepseek-v3.2'
  };

  public validateConfig(): string | null {
    const baseValidation = super.validateConfig();
    if (baseValidation) return baseValidation;
    
    if (!this.config.apiKey) {
      return 'API key is required for Deepseek';
    }
    return null;
  }

  parseResponse(response: unknown): BaseResponse {
    try {
      const responseObj = response as { choices?: Array<{ message?: { content?: string } }> };
      let result: unknown = response;
      let content = '';

      // 先获取原始的响应内容
      if (responseObj.choices?.[0]?.message?.content) {
        content = responseObj.choices[0].message.content;
      }

      // 解析结构化数据
      for (const key of this.provider.responseFormat.path) {
        if (!result || typeof result !== 'object') {
          throw new Error('Invalid response structure');
        }
        result = (result as Record<string, unknown>)[key];
      }

      // 提取标签数据
      const jsonContent = this.extractJsonFromContent(content);

      return {
        text: content,
        matchedExistingTags: (jsonContent.matchedTags as string[]) || [],
        suggestedTags: (jsonContent.newTags as string[]) || []
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to parse Deepseek response: ${message}`);
    }
  }

  supportsStreaming() { return true; }
  formatStreamingRequest(prompt: string) { return this.buildOpenAIStreamingRequest(prompt); }
  parseStreamingChunk(line: string) { return BaseAdapter.parseOpenAISSEChunk(line); }
}
