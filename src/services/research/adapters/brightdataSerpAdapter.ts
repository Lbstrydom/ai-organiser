/**
 * Bright Data SERP API Adapter
 *
 * Search provider using Bright Data's SERP API.
 * Cost: ~$3/1k requests.
 */

import { requestUrl } from 'obsidian';
import type { SearchProvider, SearchResult, SearchOptions } from '../researchTypes';
import { classifyUrlSource, extractDomain } from '../../../utils/urlUtils';

export class BrightDataSerpAdapter implements SearchProvider {
    readonly type = 'brightdata-serp' as const;

    constructor(
        private getApiKey: () => Promise<string | null>,
        private country?: string,
    ) {}

    async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
        const apiKey = await this.getApiKey();
        if (!apiKey) throw new Error('Bright Data SERP API key not configured');

        const body: Record<string, unknown> = {
            query,
            search_engine: 'google',
            num: options?.maxResults ?? 10,
            brd_json: 1,
        };

        // Only set country when explicitly configured (let API auto-detect otherwise)
        if (this.country) body.country = this.country;

        // Map dateRange to Google's tbs parameter
        if (options?.dateRange && options.dateRange !== 'any') {
            body.tbs = options.dateRange === 'recent' ? 'qdr:w' : 'qdr:y';
        }

        const response = await requestUrl({
            url: 'https://api.brightdata.com/serp/req',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });

        const data = response.json;
        return (data.organic || []).map((item: { title?: string; link?: string; url?: string; description?: string; snippet?: string; rank?: number }): SearchResult => ({
            title: item.title || '',
            url: item.link || item.url || '',
            snippet: item.description || item.snippet || '',
            source: classifyUrlSource(item.link || item.url || ''),
            domain: extractDomain(item.link || item.url || ''),
            score: item.rank ? Math.max(0, 1 - (item.rank / 100)) : undefined,
        }));
    }

    async isConfigured(): Promise<boolean> {
        const key = await this.getApiKey();
        return !!key;
    }
}
