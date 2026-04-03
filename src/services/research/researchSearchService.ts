/**
 * Research Search Service
 *
 * Provider orchestrator: executes multi-query searches, deduplicates results,
 * applies site scope and exclusion filters.
 */

import type AIOrganiserPlugin from '../../main';
import { PLUGIN_SECRET_IDS } from '../../core/secretIds';
import { getClaudeWebSearchKey } from '../apiKeyHelpers';
import type { SearchProvider, SearchProviderType, SearchResult, SearchOptions } from './researchTypes';
import { TavilyAdapter } from './adapters/tavilyAdapter';
import { BrightDataSerpAdapter } from './adapters/brightdataSerpAdapter';
import { ClaudeWebSearchAdapter } from './adapters/claudeWebSearchAdapter';
import { normalizeUrl, extractDomain } from '../../utils/urlUtils';
import { enrichWithAcademicMetadata, buildAcademicQueries, ACADEMIC_DOMAINS } from './academicUtils';

export class ResearchSearchService {
    private providers: Map<SearchProviderType, SearchProvider>;
    private lastFallbackUsed: SearchProviderType | null = null;

    constructor(private plugin: AIOrganiserPlugin) {
        const secrets = plugin.secretStorageService;

        this.providers = new Map<SearchProviderType, SearchProvider>([
            ['tavily', new TavilyAdapter(
                () => secrets.getSecret(PLUGIN_SECRET_IDS.RESEARCH_TAVILY_API_KEY),
            )],
            ['brightdata-serp', new BrightDataSerpAdapter(
                () => secrets.getSecret(PLUGIN_SECRET_IDS.BRIGHT_DATA_SERP_KEY),
            )],
            ['claude-web-search', new ClaudeWebSearchAdapter(
                () => this.resolveClaudeWebSearchKey(),
                {
                    model: plugin.settings.cloudServiceType === 'claude' ? plugin.settings.cloudModel : 'claude-sonnet-4-6',
                    maxSearches: plugin.settings.researchClaudeMaxSearches ?? 5,
                    useDynamicFiltering: plugin.settings.researchClaudeUseDynamicFiltering ?? true,
                },
            )],
        ]);
    }

    /**
     * Execute search with multi-query support.
     * Runs queries in parallel, deduplicates by normalizeUrl(),
     * filters excluded sites, and limits to maxResults.
     */
    async search(queries: string[], options?: SearchOptions): Promise<SearchResult[]> {
        this.lastFallbackUsed = null;

        const results = await this.searchWithActiveProvider(queries, options);

        // If primary returned results, use them
        if (results.length > 0) return results;

        // Try fallback provider
        const fallback = await this.getFallbackProvider();
        if (!fallback) return results;

        this.lastFallbackUsed = fallback.type;
        return this.searchWithProvider(fallback.provider, queries, options);
    }

    /** Exposed so the handler can show a notice. Consumed (reset) on read. */
    get fallbackProviderUsed(): SearchProviderType | null {
        const used = this.lastFallbackUsed;
        this.lastFallbackUsed = null;
        return used;
    }

    private async searchWithActiveProvider(queries: string[], options?: SearchOptions): Promise<SearchResult[]> {
        const provider = this.getActiveProvider();
        if (!provider) throw new Error('No search provider configured');
        return this.searchWithProvider(provider, queries, options);
    }

    private async searchWithProvider(
        provider: SearchProvider,
        queries: string[],
        options?: SearchOptions,
    ): Promise<SearchResult[]> {
        // Apply site scope to queries
        let scopedQueries = this.applySiteScope(queries, options);

        // Phase 3: when academic mode is on and scope isn't already academic,
        // expand first query with academic site/filetype variants
        if (options?.academicMode && options.siteScope !== 'academic' && scopedQueries.length > 0) {
            const academicExpansions = buildAcademicQueries(scopedQueries[0]);
            // Skip the first (original query already present), add the academic variants
            scopedQueries = [...scopedQueries, ...academicExpansions.slice(1)];
        }

        // Run all queries in parallel — collect errors to surface if all fail
        // P2-8: retry once on 429/5xx with 2s delay
        const errors: Error[] = [];
        const searchWithRetry = async (q: string): Promise<SearchResult[]> => {
            try {
                return await provider.search(q, options);
            } catch (e: any) {
                const status = e?.status ?? e?.statusCode;
                const msg = e?.message ?? '';
                const isRetryable = status === 429 || (status >= 500 && status < 600)
                    || msg.includes('429') || /\b5\d{2}\b/.test(msg);
                if (isRetryable) {
                    await new Promise(r => setTimeout(r, 2000));
                    try { return await provider.search(q, options); }
                    catch (error_: any) { errors.push(error_ instanceof Error ? error_ : new Error(String(error_))); return []; }
                }
                errors.push(e instanceof Error ? e : new Error(String(e)));
                return [];
            }
        };
        const allResults = await Promise.all(scopedQueries.map(searchWithRetry));

        // If every query failed, throw the first error so the user sees it
        if (allResults.every(r => r.length === 0) && errors.length > 0) {
            throw errors[0];
        }

        // Flatten and deduplicate
        const flat = allResults.flat();
        const seen = new Set<string>();
        const deduped = flat.filter(r => {
            const normalized = normalizeUrl(r.url);
            if (seen.has(normalized)) return false;
            seen.add(normalized);
            return true;
        });

        // Filter excluded sites
        const excluded = new Set(
            (options?.excludedSites || []).map(s => s.toLowerCase().trim())
        );
        const filtered = excluded.size > 0
            ? deduped.filter(r => !excluded.has(extractDomain(r.url)))
            : deduped;

        // Phase 3: enrich with academic metadata when academic mode is on
        if (options?.academicMode) {
            enrichWithAcademicMetadata(filtered);
        }

        // Sort by score descending (if available)
        filtered.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

        // Limit results
        const max = options?.maxResults ?? 10;
        return filtered.slice(0, max);
    }

    private async getFallbackProvider(): Promise<{ type: SearchProviderType; provider: SearchProvider } | null> {
        const activeType = this.plugin.settings.researchProvider as SearchProviderType;
        const preferredFallbacks: SearchProviderType[] = ['claude-web-search', 'tavily', 'brightdata-serp'];
        for (const type of preferredFallbacks) {
            if (type === activeType) continue;
            const provider = this.providers.get(type);
            if (provider && await provider.isConfigured()) {
                return { type, provider };
            }
        }
        return null;
    }

    getProvider(type: SearchProviderType): SearchProvider | null {
        return this.providers.get(type) || null;
    }

    getActiveProvider(): SearchProvider | null {
        const type = this.plugin.settings.researchProvider as SearchProviderType;
        return this.providers.get(type) || null;
    }

    async getAvailableProviders(): Promise<SearchProviderType[]> {
        const available: SearchProviderType[] = [];
        for (const [type, provider] of this.providers) {
            if (await provider.isConfigured()) {
                available.push(type);
            }
        }
        return available;
    }

    /**
     * Resolve Claude Web Search API key with fallback chain (AD-4).
     * Delegates to centralised resolver in apiKeyHelpers.
     */
    private async resolveClaudeWebSearchKey(): Promise<string | null> {
        return getClaudeWebSearchKey(this.plugin);
    }

    private applySiteScope(queries: string[], options?: SearchOptions): string[] {
        if (!options?.siteScope || options.siteScope === 'all') return queries;

        if (options.siteScope === 'preferred' && options.preferredSites?.length) {
            // Add at least one site-scoped query
            const sites = options.preferredSites;
            const siteQuery = sites.map(s => `site:${s}`).join(' OR ');
            return [
                ...queries,
                ...queries.slice(0, 1).map(q => `${q} ${siteQuery}`),
            ];
        }

        if (options.siteScope === 'academic') {
            const academicSites = ACADEMIC_DOMAINS.slice(0, 3)
                .map(d => `site:${d}`)
                .join(' OR ');
            return queries.map(q => `${q} ${academicSites}`);
        }

        return queries;
    }
}
