/**
 * Tavily Search API Adapter
 *
 * Free tier: 1,000 credits/month.
 * Unique advantage: extractedContent populated from Tavily's response
 * avoids needing a separate fetch during extraction phase.
 */

import { requestUrl } from 'obsidian';
import type { SearchProvider, SearchResult, SearchOptions } from '../researchTypes';
import { classifyUrlSource, extractDomain } from '../../../utils/urlUtils';

export class TavilyAdapter implements SearchProvider {
    readonly type = 'tavily' as const;

    constructor(private getApiKey: () => Promise<string | null>) {}

    async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
        const apiKey = await this.getApiKey();
        if (!apiKey) throw new Error('Tavily not configured');

        const body: Record<string, unknown> = {
            api_key: apiKey,
            query,
            search_depth: 'basic',
            max_results: options?.maxResults ?? 10,
            include_raw_content: true,
            include_answer: false,
        };

        // Map dateRange to Tavily's days parameter
        if (options?.dateRange === 'recent') body.days = 7;
        else if (options?.dateRange === 'year') body.days = 365;
        // 'any' or undefined → no days parameter (all time)

        const response = await requestUrl({
            url: 'https://api.tavily.com/search',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        return (response.json.results || []).map((item: any) => ({
            title: item.title || '',
            url: item.url || '',
            snippet: item.content?.slice(0, 200) || '',
            source: classifyUrlSource(item.url || ''),
            score: item.score,
            extractedContent: item.raw_content || item.content,
            domain: extractDomain(item.url || ''),
        }));
    }

    async isConfigured(): Promise<boolean> {
        const key = await this.getApiKey();
        return !!key;
    }
}
