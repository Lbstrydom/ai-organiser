import { App, Notice } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import type { DetectedContent } from '../utils/embeddedContentDetector';
import { ContentExtractionService } from './contentExtractionService';
import { buildTriagePrompt, insertContentIntoTriagePrompt } from './prompts/triagePrompts';
import { summarizeText, pluginContext } from './llmFacade';
import { CloudLLMService } from './cloudService';
import { getQuickPeekProviderConfig, getYouTubeGeminiApiKey, getAudioTranscriptionApiKey } from './apiKeyHelpers';
import type { QuickPeekProviderConfig } from './apiKeyHelpers';
import { logger } from '../utils/logger';

const QUICK_PEEK_MAX_EXTRACT_CHARS = 3000;
const QUICK_PEEK_FALLBACK_EXCERPT_CHARS = 200;

/** Session-scoped set — each provider key shown at most once per Obsidian session */
const shownFallbackNotice = new Set<string>();

export interface QuickPeekSource {
    detected: DetectedContent;
    triageSummary: string | null;
    extractionError: string | null;
    llmFailed: boolean;
}

export interface QuickPeekResult {
    sources: QuickPeekSource[];
    totalDetected: number;
    totalTriaged: number;
    totalFailed: number;
}

export class QuickPeekService {
    constructor(
        private readonly app: App,
        private readonly plugin: AIOrganiserPlugin
    ) {}

    async triageSources(
        items: DetectedContent[],
        onProgress?: (current: number, total: number, item: DetectedContent) => void,
        signal?: AbortSignal
    ): Promise<QuickPeekResult> {
        const extractor = await this.buildExtractor();
        const config = await this.resolveProviderConfig();

        const sources: QuickPeekSource[] = [];
        let totalTriaged = 0;
        let totalFailed = 0;

        for (let i = 0; i < items.length; i++) {
            if (signal?.aborted) break;
            const item = items[i];
            onProgress?.(i + 1, items.length, item);

            const source = await this.processItem(item, extractor, config, signal);
            sources.push(source);
            if (source.triageSummary && !source.llmFailed) {
                totalTriaged++;
            } else {
                totalFailed++;
            }
        }

        return { sources, totalDetected: items.length, totalTriaged, totalFailed };
    }

    private async buildExtractor(): Promise<ContentExtractionService> {
        const youtubeApiKey = await getYouTubeGeminiApiKey(this.plugin);
        const audioConfig = await getAudioTranscriptionApiKey(this.plugin);

        const extractor = new ContentExtractionService(
            this.app,
            this.plugin.pdfService,
            this.plugin.documentExtractionService,
            youtubeApiKey
                ? { apiKey: youtubeApiKey, model: this.plugin.settings.youtubeGeminiModel || '' }
                : undefined
        );
        if (audioConfig) {
            extractor.setAudioTranscriptionConfig({ provider: audioConfig.provider, apiKey: audioConfig.key });
        }
        return extractor;
    }

    private async resolveProviderConfig(): Promise<QuickPeekProviderConfig | null> {
        const config = await getQuickPeekProviderConfig(this.plugin);
        if (!config && this.plugin.settings.quickPeekProvider !== 'main') {
            const key = this.plugin.settings.quickPeekProvider;
            if (!shownFallbackNotice.has(key)) {
                shownFallbackNotice.add(key);
                new Notice(this.plugin.t.messages.quickPeekProviderFallback, 4000);
            }
            logger.debug('Core', 'Quick Peek: specialist provider unavailable, falling back to main');
        }
        return config;
    }

    private async processItem(
        item: DetectedContent,
        extractor: ContentExtractionService,
        config: QuickPeekProviderConfig | null,
        signal?: AbortSignal
    ): Promise<QuickPeekSource> {
        const { text: extractedText, error: extractionError } = await this.extractItem(item, extractor);
        if (signal?.aborted || !extractedText) {
            return { detected: item, triageSummary: null, extractionError, llmFailed: false };
        }
        return this.triageItem(item, extractedText, config, extractionError);
    }

    private async extractItem(
        item: DetectedContent,
        extractor: ContentExtractionService
    ): Promise<{ text: string | null; error: string | null }> {
        try {
            const result = await extractor.extractContent([item], undefined, true);
            const extracted = result.textContent[0];
            if (extracted?.success && extracted.content) {
                return { text: extracted.content.slice(0, QUICK_PEEK_MAX_EXTRACT_CHARS), error: null };
            }
            return { text: null, error: extracted?.error ?? 'Extraction failed' };
        } catch (e) {
            return { text: null, error: e instanceof Error ? e.message : 'Extraction error' };
        }
    }

    private async triageItem(
        item: DetectedContent,
        extractedText: string,
        config: QuickPeekProviderConfig | null,
        extractionError: string | null
    ): Promise<QuickPeekSource> {
        const language = this.plugin.settings.summaryLanguage || '';
        const prompt = insertContentIntoTriagePrompt(
            buildTriagePrompt({ language: language || undefined, contentType: this.mapContentType(item.type) }),
            extractedText
        );

        try {
            const llmResult = await this.callLLM(config, prompt);
            if (llmResult.success && llmResult.content) {
                return { detected: item, triageSummary: llmResult.content.trim(), extractionError, llmFailed: false };
            }
        } catch {
            // fall through to fallback
        }

        return {
            detected: item,
            triageSummary: extractedText.slice(0, QUICK_PEEK_FALLBACK_EXCERPT_CHARS),
            extractionError,
            llmFailed: true
        };
    }

    private async callLLM(config: QuickPeekProviderConfig | null, prompt: string) {
        if (config) {
            const service = new CloudLLMService(
                { type: config.provider, endpoint: config.endpoint, apiKey: config.apiKey, modelName: config.model },
                this.app
            );
            if (this.plugin.settings.debugMode) service.setDebugMode(true);
            return service.summarizeText(prompt);
        }
        return summarizeText(pluginContext(this.plugin), prompt);
    }

    private mapContentType(type: string): 'web' | 'pdf' | 'youtube' | 'document' | 'audio' {
        const map: Record<string, 'web' | 'pdf' | 'youtube' | 'document' | 'audio'> = {
            youtube: 'youtube',
            pdf: 'pdf',
            document: 'document',
            audio: 'audio'
        };
        return map[type] ?? 'web';
    }
}
