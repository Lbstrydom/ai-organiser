/**
 * Research Orchestrator
 *
 * All business logic for the research workflow. No DOM/UI dependencies.
 * Independently testable. Handles search, extraction, synthesis, and session persistence.
 *
 * Phase 3 additions: usage tracking, quality scoring, vault pre-check,
 * perspective decomposition, source metadata, streaming synthesis.
 */

import { requestUrl } from 'obsidian';
import { TFile, TFolder } from 'obsidian';
import { Readability } from '@mozilla/readability';
import type AIOrganiserPlugin from '../../main';
import { summarizeText, summarizeTextStream, pluginContext } from '../llmFacade';
import {
    buildQueryDecompositionPrompt,
    buildContextualAnswerPrompt,
    buildResultTriagePrompt,
    buildSourceExtractionPrompt,
    buildSynthesisPrompt,
    PERSPECTIVE_PRESETS,
} from '../prompts/researchPrompts';
import type {
    SearchResult,
    SourceExtraction,
    ResearchSessionState,
    SearchOptions,
    SearchProviderType,
    PaidTier,
    VaultPrecheckResult,
    SourceMetadata,
    PerspectiveQuery,
    ClaudeWebSearchResponse,
    ClaudeWebSearchStreamCallbacks,
    ParsedCitation,
} from './researchTypes';
import type { ClaudeWebSearchAdapter, ClaudeWebSearchOptions } from './adapters/claudeWebSearchAdapter';
import type { ResearchSearchService } from './researchSearchService';
import type { ResearchUsageService } from './researchUsageService';
import type { SourceQualityService } from './sourceQualityService';
import { enrichWithAcademicMetadata } from './academicUtils';
import { resolvePluginPath } from '../../core/settings';
import { PLUGIN_SECRET_IDS } from '../../core/secretIds';
import { ensureFolderExists } from '../../utils/minutesUtils';
import { generateId } from '../canvas/canvasUtils';
import { WebUnlocker } from './brightdata/webUnlocker';
import { ScrapingBrowser } from './brightdata/scrapingBrowser';
import { extractDomain } from '../../utils/urlUtils';
import { tryExtractJson } from '../../utils/responseParser';
import { RAGService } from '../ragService';
import { getMaxContentCharsForModel, truncateAtBoundary } from '../tokenLimits';

/** Callback to request user consent before escalating to a paid tier. */
/** Maximum parallel fetch+extract operations during source reading. */
const EXTRACTION_CONCURRENCY = 3;

/** Default assumed source count when actual count unavailable (for budget division). */
const DEFAULT_SOURCE_COUNT = 5;

/** Characters reserved for prompt structure, instructions, and system prompt. */
const PROMPT_RESERVED_CHARS = 16_000;

/** Minimum characters allocated per source (floor). */
const MIN_CHARS_PER_SOURCE = 5_000;

/** Maximum decomposed queries from a single user question. */
const MAX_DECOMPOSED_QUERIES = 5;

/** Number of top results to pre-select for reading. */
const PRESELECT_COUNT = 3;

/** Excerpt length for vault pre-check results. */
const PRECHECK_EXCERPT_LENGTH = 200;

/** Callback to request user consent before escalating to a paid tier. */
export type EscalationConsentFn = (url: string, tier: 'web-unlocker' | 'scraping-browser') => Promise<boolean>;

export class ResearchOrchestrator {
    private sessionId: string;
    private readonly webUnlocker: WebUnlocker;
    private readonly scrapingBrowser: ScrapingBrowser;

    // Phase 3: optional services (no-op when absent)
    private usageService?: ResearchUsageService;
    private qualityService?: SourceQualityService;

    constructor(
        private searchService: ResearchSearchService,
        private plugin: AIOrganiserPlugin,
        options?: {
            usageService?: ResearchUsageService;
            qualityService?: SourceQualityService;
        },
    ) {
        this.sessionId = generateId().slice(0, 6);
        this.webUnlocker = new WebUnlocker(
            () => plugin.secretStorageService.getSecret(PLUGIN_SECRET_IDS.BRIGHT_DATA_WEB_UNLOCKER_KEY),
        );
        this.scrapingBrowser = new ScrapingBrowser(
            () => plugin.secretStorageService.getSecret(PLUGIN_SECRET_IDS.BRIGHT_DATA_BROWSER),
        );
        this.usageService = options?.usageService;
        this.qualityService = options?.qualityService;
    }

    // ═══ SEARCH PHASE ═══

    /**
     * Decompose question into 3-5 targeted search queries via LLM.
     * Falls back to [question] if LLM fails or returns invalid JSON.
     * Phase 3: supports perspective-aware and academic-mode decomposition.
     */
    async decomposeQuestion(
        question: string,
        noteContext?: string,
        preferredSites?: string[],
        language?: string,
        options?: {
            academicMode?: boolean;
            perspectiveMode?: boolean;
            perspectivePreset?: string;
            customPerspectives?: string;
        },
    ): Promise<string[] | PerspectiveQuery[]> {
        // Resolve perspectives
        let perspectives: string[] | undefined;
        if (options?.perspectiveMode) {
            if (options.perspectivePreset === 'custom' && options.customPerspectives) {
                perspectives = options.customPerspectives.split(',').map(s => s.trim()).filter(Boolean);
            } else {
                perspectives = PERSPECTIVE_PRESETS[options.perspectivePreset || 'balanced'] || PERSPECTIVE_PRESETS.balanced;
            }
        }

        const prompt = buildQueryDecompositionPrompt(question, noteContext, preferredSites, language, {
            academicMode: options?.academicMode,
            perspectiveMode: options?.perspectiveMode,
            perspectives,
        });
        const response = await summarizeText(pluginContext(this.plugin), prompt);
        if (!response.success || !response.content) return [question];

        try {
            const parsed = tryExtractJson(response.content) ?? JSON.parse(response.content);
            if (!Array.isArray(parsed)) return [question];

            // Check if perspective-aware (array of objects) or plain (array of strings)
            if (parsed.length > 0 && typeof parsed[0] === 'object' && parsed[0].query) {
                // Perspective-aware format: [{ query, perspective }]
                return (parsed as PerspectiveQuery[]).slice(0, MAX_DECOMPOSED_QUERIES);
            }
            // Plain format: ["q1", "q2", ...] — wrap if perspectives requested
            if (options?.perspectiveMode && perspectives && perspectives.length > 0) {
                return (parsed as string[]).slice(0, MAX_DECOMPOSED_QUERIES).map((q, i) => ({
                    query: q,
                    perspective: perspectives[i % perspectives.length],
                }));
            }
            return (parsed as string[]).slice(0, MAX_DECOMPOSED_QUERIES);
        } catch {
            return [question];
        }
    }

    /**
     * Execute search via configured provider.
     * Phase 3: tracks usage when brightdata-serp is the active search provider.
     */
    async executeSearch(queries: string[], options: SearchOptions): Promise<SearchResult[]> {
        const providerType = this.plugin.settings.researchProvider as SearchProviderType;

        // Budget check for paid search providers
        if (providerType === 'brightdata-serp' && this.usageService) {
            const budget = this.usageService.checkBudget('brightdata-serp');
            if (!budget.allowed) {
                throw new Error(budget.message || 'Monthly budget limit reached for SERP searches.');
            }
        }

        const results = await this.searchService.search(queries, options);

        // Record usage for paid search providers
        if (providerType === 'brightdata-serp' && this.usageService && results.length > 0) {
            await this.usageService.recordOperation('brightdata-serp');
        }

        return results;
    }

    /**
     * Triage results via LLM: assess relevance, return pre-selected top 3.
     * Updates result scores from LLM assessment.
     * Phase 3: applies quality scoring when enabled.
     */
    async triageResults(
        results: SearchResult[],
        question: string,
        language?: string,
    ): Promise<{ results: SearchResult[]; preSelectedUrls: string[] }> {
        if (results.length === 0) return { results: [], preSelectedUrls: [] };

        const prompt = buildResultTriagePrompt(results, question, language);
        const response = await summarizeText(pluginContext(this.plugin), prompt);

        if (!response.success || !response.content) {
            return {
                results,
                preSelectedUrls: results.slice(0, PRESELECT_COUNT).map(r => r.url),
            };
        }

        try {
            interface TriageAssessment { url: string; score: number; assessment?: string; selected?: boolean }
            const assessments = JSON.parse(response.content) as TriageAssessment[];
            for (const a of assessments) {
                const result = results.find(r => r.url === a.url);
                if (result) {
                    result.score = a.score / 10;
                    result.triageAssessment = a.assessment;
                }
            }
            results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
            const preSelected = assessments
                .filter((a: TriageAssessment) => a.selected)
                .map((a: TriageAssessment) => a.url);

            // Phase 3: apply quality scoring if enabled
            if (this.qualityService && this.plugin.settings.enableResearchQualityScoring) {
                this.qualityService.scoreResults(results);
            }

            return {
                results,
                preSelectedUrls: preSelected.length > 0
                    ? preSelected
                    : results.slice(0, PRESELECT_COUNT).map(r => r.url),
            };
        } catch {
            return { results, preSelectedUrls: results.slice(0, PRESELECT_COUNT).map(r => r.url) };
        }
    }

    // ═══ CONTEXTUAL ANSWER ═══

    /**
     * Try to answer from existing search result snippets.
     * Returns answer string if snippets contain relevant info, null if new search needed.
     */
    async tryAnswerFromContext(
        query: string,
        searchResults: SearchResult[],
        language?: string,
    ): Promise<string | null> {
        const snippetContext = searchResults
            .map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}\n${r.triageAssessment || ''}`)
            .join('\n\n');
        const prompt = buildContextualAnswerPrompt(query, snippetContext, language);
        const response = await summarizeText(pluginContext(this.plugin), prompt);
        if (!response.success || !response.content) return null;
        try {
            const parsed = JSON.parse(response.content);
            return parsed.answerable ? parsed.answer : null;
        } catch {
            return null;
        }
    }

    // ═══ EXTRACTION PHASE ═══

    /**
     * Extract content from selected URLs.
     * Concurrency: 3 parallel fetches + LLM extractions.
     * Tavily results with extractedContent skip re-fetch.
     * Smart escalation: requestUrl → Web Unlocker → Scraping Browser (with consent).
     * Phase 3: records usage for paid tiers.
     */
    async extractSources(
        urls: string[],
        searchResults: SearchResult[],
        question: string,
        onProgress?: (current: number, total: number, url: string) => void,
        language?: string,
        onEscalation?: EscalationConsentFn,
    ): Promise<SourceExtraction[]> {
        const extractions: SourceExtraction[] = [];
        for (let i = 0; i < urls.length; i += EXTRACTION_CONCURRENCY) {
            const batch = urls.slice(i, i + EXTRACTION_CONCURRENCY);
            const batchResults = await Promise.all(
                batch.map(async (url, batchIdx) => {
                    onProgress?.(i + batchIdx + 1, urls.length, url);
                    return this.extractSingleSource(url, searchResults, question, language, onEscalation);
                }),
            );
            extractions.push(...batchResults);
        }

        return extractions;
    }

    private async extractSingleSource(
        url: string,
        searchResults: SearchResult[],
        question: string,
        language?: string,
        onEscalation?: EscalationConsentFn,
    ): Promise<SourceExtraction> {
        const result = searchResults.find(r => r.url === url);
        const title = result?.title || url;

        const { content, method } = await this.fetchContent(url, result, onEscalation);

        if (!content) {
            return { url, title, findings: '', extractionMethod: method, error: `Could not read ${url}` };
        }

        // Truncate to token budget — pass actual URL count for accurate per-source budgeting
        const maxChars = this.getMaxContentCharsPerSource(
            searchResults.filter(r => r.url).length || 5,
        );
        const truncated = truncateAtBoundary(content, maxChars, '');

        // Extract key findings via LLM
        const prompt = buildSourceExtractionPrompt(truncated, question, title, language);
        const response = await summarizeText(pluginContext(this.plugin), prompt);

        return {
            url,
            title,
            findings: response.success && response.content ? response.content : 'Extraction failed',
            extractionMethod: method,
        };
    }

    /**
     * Fetch content through tiered escalation chain:
     * Tier 0: Tavily inline → Tier 1: requestUrl+Readability →
     * Tier 2: Web Unlocker → Tier 3: Scraping Browser
     * Phase 3: records usage for paid tiers via usageService.
     */
    private async fetchContent(
        url: string,
        result: SearchResult | undefined,
        onEscalation?: EscalationConsentFn,
    ): Promise<{ content: string | null; method: SourceExtraction['extractionMethod'] }> {
        // Tier 0: Tavily pre-extracted content
        if (result?.extractedContent) {
            return { content: result.extractedContent, method: 'tavily-inline' };
        }

        // Tier 1: requestUrl + Readability
        const tier1 = await this.fetchWithReadability(url);
        if (tier1) return { content: tier1, method: 'readability' };

        // Tier 2: Web Unlocker (if configured and consent given)
        const tier2 = await this.fetchWithEscalation(url, 'web-unlocker', this.webUnlocker, onEscalation);
        if (tier2) return { content: tier2, method: 'web-unlocker' };

        // Tier 3: Scraping Browser (if configured and consent given)
        const tier3 = await this.fetchWithEscalation(url, 'scraping-browser', this.scrapingBrowser, onEscalation);
        if (tier3) return { content: tier3, method: 'scraping-browser' };

        return { content: null, method: 'readability' };
    }

    private async fetchWithReadability(url: string): Promise<string | null> {
        try {
            const response = await requestUrl({ url });
            return this.parseWithReadability(response.text, url)?.textContent || null;
        } catch {
            return null;
        }
    }

    private async fetchWithEscalation(
        url: string,
        tier: 'web-unlocker' | 'scraping-browser',
        fetcher: { isConfigured(): Promise<boolean>; fetchHTML(url: string): Promise<string> },
        onEscalation?: EscalationConsentFn,
    ): Promise<string | null> {
        if (!await fetcher.isConfigured()) return null;

        // Phase 3: check budget before paid operation
        if (this.usageService) {
            const budget = this.usageService.checkBudget(tier as PaidTier);
            if (!budget.allowed) return null;
        }

        const consent = onEscalation ? await onEscalation(url, tier) : false;
        if (!consent) return null;
        try {
            const html = await fetcher.fetchHTML(url);
            // Phase 3: record paid operation
            if (this.usageService) {
                await this.usageService.recordOperation(tier as PaidTier);
            }
            return this.parseWithReadability(html, url)?.textContent || null;
        } catch {
            return null;
        }
    }

    private parseWithReadability(html: string, url: string): { textContent: string; title: string } | null {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const base = doc.createElement('base');
        base.href = url;
        doc.head.insertBefore(base, doc.head.firstChild);
        const reader = new Readability(doc);
        const parsed = reader.parse();
        if (!parsed?.textContent) return null;
        return { textContent: parsed.textContent, title: parsed.title ?? url };
    }

    private getMaxContentCharsPerSource(selectedCount: number = DEFAULT_SOURCE_COUNT): number {
        const modelLimit = this.getModelContextChars();
        const availableBudget = modelLimit - PROMPT_RESERVED_CHARS;
        const perSource = Math.floor(availableBudget / Math.max(selectedCount, 1));
        // Large-context models (>500K chars after 0.5× factor) get a higher cap
        const hardCap = modelLimit > 500_000 ? 50_000 : 15_000;
        return Math.max(MIN_CHARS_PER_SOURCE, Math.min(hardCap, perSource));
    }

    private getModelContextChars(): number {
        const provider = this.plugin.settings.cloudServiceType;
        const model = this.plugin.settings.cloudModel;
        return Math.floor(getMaxContentCharsForModel(provider, model) * 0.5);
    }

    // ═══ CLAUDE WEB SEARCH UNIFIED PIPELINE (AD-1) ═══

    /**
     * Unified search cycle for Claude Web Search.
     * Replaces decompose → search → triage → extract → synthesize with one API call.
     * Handles pause_turn auto-continuation (AD-9, max 3 continuations).
     * Records per-search usage for budget tracking (AD-6).
     */
    async executeClaudeWebSearch(
        question: string,
        options: ClaudeWebSearchOptions,
        callbacks?: { onPhaseChange?: (phase: string) => void },
    ): Promise<{
        results: SearchResult[];
        synthesis: string;
        sourceMetadata: SourceMetadata[];
        searchCount: number;
        rawContent: unknown[];
    }> {
        callbacks?.onPhaseChange?.('searching');

        const provider = this.getClaudeWebSearchProvider();
        this.checkClaudeWebSearchBudget();

        // Single API call
        let response: ClaudeWebSearchResponse = await provider.searchAndSynthesize(question, options);

        // Handle pause_turn — accumulate results/citations/usage across continuations
        let totalSearchCount = response.searchCount;
        let continuations = 0;
        while (response.paused && continuations < provider.maxContinuations) {
            continuations++;
            callbacks?.onPhaseChange?.('continuing');
            const prev = response;
            response = await provider.continueSearch(question, prev.rawContent, options);
            totalSearchCount += response.searchCount;
            this.accumulateContinuation(prev, response);
        }

        const finalized = await this.finalizeClaudeWebSearchResult(response, totalSearchCount, callbacks, { academicMode: options.academicMode });
        return { ...finalized, rawContent: response.rawContent };
    }

    /**
     * Streaming Claude Web Search — progressive text output via SSE.
     * Feature-gated by enableResearchStreamingSynthesis setting.
     * Shares accumulation + finalization logic with non-streaming path.
     */
    async executeClaudeWebSearchStream(
        question: string,
        options: ClaudeWebSearchOptions,
        callbacks: ClaudeWebSearchStreamCallbacks,
        signal?: AbortSignal,
    ): Promise<{
        results: SearchResult[];
        synthesis: string;
        sourceMetadata: SourceMetadata[];
        searchCount: number;
        rawContent: unknown[];
    }> {
        callbacks.onPhaseChange?.('searching');

        const provider = this.getClaudeWebSearchProvider();
        this.checkClaudeWebSearchBudget();

        let response = await provider.searchAndSynthesizeStream(question, options, callbacks, signal);

        let totalSearchCount = response.searchCount;
        let continuations = 0;
        while (response.paused && continuations < provider.maxContinuations) {
            continuations++;
            callbacks.onPhaseChange?.('continuing');
            const prev = response;
            response = await provider.continueSearchStream(question, prev.rawContent, options, callbacks, signal);
            totalSearchCount += response.searchCount;
            this.accumulateContinuation(prev, response);
        }

        const finalized = await this.finalizeClaudeWebSearchResult(response, totalSearchCount, callbacks, { academicMode: options.academicMode });
        return { ...finalized, rawContent: response.rawContent };
    }

    // ═══ CLAUDE WEB SEARCH MULTI-TURN (Phase 3, AD-18) ═══

    /**
     * Multi-turn Claude Web Search: follow-up question with conversation history.
     * Passes previous rawContent as assistant messages so Claude can reference
     * encrypted_content/encrypted_index from prior search results.
     */
    async executeClaudeWebSearchMultiTurn(
        messages: Array<{ role: string; content: unknown }>,
        options: ClaudeWebSearchOptions,
        callbacks?: { onPhaseChange?: (phase: string) => void },
    ): Promise<{
        results: SearchResult[];
        synthesis: string;
        sourceMetadata: SourceMetadata[];
        searchCount: number;
        rawContent: unknown[];
    }> {
        callbacks?.onPhaseChange?.('searching');

        const provider = this.getClaudeWebSearchProvider();
        this.checkClaudeWebSearchBudget();

        let response = await provider.searchAndSynthesizeMultiTurn(messages, options);

        let totalSearchCount = response.searchCount;
        let continuations = 0;
        while (response.paused && continuations < provider.maxContinuations) {
            continuations++;
            callbacks?.onPhaseChange?.('continuing');
            const prev = response;
            // Keep full message history including the user's follow-up, then append paused assistant + continue prompt
            const continuationMessages = [
                ...messages,
                { role: 'assistant', content: prev.rawContent },
                { role: 'user', content: 'Please continue.' },
            ];
            response = await provider.searchAndSynthesizeMultiTurn(continuationMessages, options);
            totalSearchCount += response.searchCount;
            this.accumulateContinuation(prev, response);
        }

        const finalized = await this.finalizeClaudeWebSearchResult(response, totalSearchCount, callbacks, { academicMode: options.academicMode });
        return { ...finalized, rawContent: response.rawContent };
    }

    /**
     * Streaming multi-turn Claude Web Search.
     */
    async executeClaudeWebSearchMultiTurnStream(
        messages: Array<{ role: string; content: unknown }>,
        options: ClaudeWebSearchOptions,
        callbacks: ClaudeWebSearchStreamCallbacks,
        signal?: AbortSignal,
    ): Promise<{
        results: SearchResult[];
        synthesis: string;
        sourceMetadata: SourceMetadata[];
        searchCount: number;
        rawContent: unknown[];
    }> {
        callbacks.onPhaseChange?.('searching');

        const provider = this.getClaudeWebSearchProvider();
        this.checkClaudeWebSearchBudget();

        let response = await provider.searchAndSynthesizeMultiTurnStream(messages, options, callbacks, signal);

        let totalSearchCount = response.searchCount;
        let continuations = 0;
        while (response.paused && continuations < provider.maxContinuations) {
            continuations++;
            callbacks.onPhaseChange?.('continuing');
            const prev = response;
            // Keep full message history including the user's follow-up, then append paused assistant + continue prompt
            const continuationMessages = [
                ...messages,
                { role: 'assistant', content: prev.rawContent },
                { role: 'user', content: 'Please continue.' },
            ];
            response = await provider.searchAndSynthesizeMultiTurnStream(continuationMessages, options, callbacks, signal);
            totalSearchCount += response.searchCount;
            this.accumulateContinuation(prev, response);
        }

        const finalized = await this.finalizeClaudeWebSearchResult(response, totalSearchCount, callbacks, { academicMode: options.academicMode });
        return { ...finalized, rawContent: response.rawContent };
    }

    // ═══ CLAUDE WEB SEARCH SHARED HELPERS ═══

    /** Get the Claude Web Search provider or throw. */
    private getClaudeWebSearchProvider(): ClaudeWebSearchAdapter {
        const provider = this.searchService.getProvider('claude-web-search') as ClaudeWebSearchAdapter | null;
        if (!provider) throw new Error('Claude Web Search provider not available');
        return provider;
    }

    /** Check budget for Claude Web Search or throw. */
    private checkClaudeWebSearchBudget(): void {
        if (this.usageService) {
            const budget = this.usageService.checkBudget('claude-web-search');
            if (!budget.allowed) throw new Error(budget.message || 'Budget exceeded');
        }
    }

    /** Merge prior continuation data into current response (dedup search results by URL, merge citations, prepend synthesis). */
    private accumulateContinuation(prev: ClaudeWebSearchResponse, current: ClaudeWebSearchResponse): void {
        const existingUrls = new Set(current.searchResults.map(r => r.url));
        for (const r of prev.searchResults) {
            if (!existingUrls.has(r.url)) current.searchResults.push(r);
        }
        current.citations = [...prev.citations, ...current.citations];
        current.synthesis = prev.synthesis + current.synthesis;
    }

    /** Build deduplicated source metadata from citations, enriched with academic fields from searchResults. */
    private buildSourceMetadataMap(citations: ParsedCitation[], searchResults?: SearchResult[]): SourceMetadata[] {
        const metaByUrl = new Map<string, SourceMetadata>();
        for (const cit of citations) {
            const existing = metaByUrl.get(cit.url);
            if (existing) {
                if (cit.citedText && !existing.findings?.includes(cit.citedText)) {
                    existing.findings = (existing.findings ? existing.findings + '\n\n' : '') + cit.citedText;
                }
            } else {
                metaByUrl.set(cit.url, {
                    url: cit.url,
                    title: cit.title,
                    domain: extractDomain(cit.url),
                    accessedDate: new Date().toISOString().slice(0, 10),
                    extractionMethod: 'claude-web-search',
                    findings: cit.citedText,
                });
            }
        }
        // Propagate academic metadata (doi, authors, year) from enriched search results
        if (searchResults) {
            for (const result of searchResults) {
                const meta = metaByUrl.get(result.url);
                if (meta) {
                    if (result.doi) meta.doi = result.doi;
                    if (result.authors?.length) meta.authors = result.authors;
                    if (result.year) meta.year = result.year;
                }
            }
        }
        return Array.from(metaByUrl.values());
    }

    /** Shared finalization: record usage, apply quality scoring, academic enrichment, build source metadata. */
    private async finalizeClaudeWebSearchResult(
        response: ClaudeWebSearchResponse,
        totalSearchCount: number,
        callbacks?: { onPhaseChange?: (phase: string) => void },
        options?: { academicMode?: boolean },
    ): Promise<{
        results: SearchResult[];
        synthesis: string;
        sourceMetadata: SourceMetadata[];
        searchCount: number;
    }> {
        if (this.usageService && totalSearchCount > 0) {
            for (let i = 0; i < totalSearchCount; i++) {
                await this.usageService.recordOperation('claude-web-search');
            }
        }

        // Phase 3: enrich results with DOI/author/year when academic mode is on
        if (options?.academicMode) {
            this.enrichAcademicMetadata(response.searchResults);
        }

        if (this.qualityService && this.plugin.settings.enableResearchQualityScoring) {
            this.qualityService.scoreResults(response.searchResults);
        }

        const sourceMetadata = this.buildSourceMetadataMap(response.citations, response.searchResults);

        callbacks?.onPhaseChange?.('done');

        return {
            results: response.searchResults,
            synthesis: response.synthesis,
            sourceMetadata,
            searchCount: totalSearchCount,
        };
    }

    // ═══ SYNTHESIS PHASE ═══

    /**
     * Synthesize across all source findings into cited write-up.
     * Post-processes to verify citation indices match actual sources.
     * Phase 3: supports citation style, builds source metadata.
     */
    async synthesize(
        extractions: SourceExtraction[],
        question: string,
        noteContext?: string,
        language?: string,
        includeCitations?: boolean,
        options?: {
            citationStyle?: 'numeric' | 'author-year';
            searchResults?: SearchResult[];
        },
    ): Promise<{ synthesis: string; sourceMetadata: SourceMetadata[] }> {
        const summaries = extractions
            .filter(e => !e.error)
            .map(e => {
                const result = options?.searchResults?.find(r => r.url === e.url);
                return {
                    url: e.url,
                    title: e.title,
                    findings: e.findings,
                    authors: result?.authors,
                    year: result?.year,
                    doi: result?.doi,
                };
            });

        const prompt = buildSynthesisPrompt(
            summaries, question, noteContext, language, includeCitations,
            options?.citationStyle,
        );
        const response = await summarizeText(pluginContext(this.plugin), prompt);

        // Build source metadata for Zotero/save-findings
        const sourceMetadata: SourceMetadata[] = summaries.map(s => ({
            url: s.url,
            title: s.title,
            domain: extractDomain(s.url),
            doi: s.doi,
            authors: s.authors,
            year: s.year,
            accessedDate: new Date().toISOString().slice(0, 10),
            extractionMethod: extractions.find(e => e.url === s.url)?.extractionMethod || 'readability',
            findings: s.findings,
        }));

        if (response.success && response.content) {
            const synthesis = includeCitations === false
                ? response.content
                : this.verifyCitations(response.content, summaries);
            return { synthesis, sourceMetadata };
        }
        return { synthesis: 'Synthesis failed. Please try again.', sourceMetadata };
    }

    /** Streaming variant of synthesize(). Delivers chunks via onChunk callback,
     *  then returns the full result with citation verification. */
    async synthesizeStream(
        extractions: SourceExtraction[],
        question: string,
        onChunk: (chunk: string) => void,
        streamOpts?: {
            signal?: AbortSignal;
            noteContext?: string;
            language?: string;
            includeCitations?: boolean;
            citationStyle?: 'numeric' | 'author-year';
            searchResults?: SearchResult[];
        },
    ): Promise<{ synthesis: string; sourceMetadata: SourceMetadata[] }> {
        const { signal, noteContext, language, includeCitations } = streamOpts ?? {};
        const summaries = extractions
            .filter(e => !e.error)
            .map(e => {
                const result = streamOpts?.searchResults?.find(r => r.url === e.url);
                return {
                    url: e.url,
                    title: e.title,
                    findings: e.findings,
                    authors: result?.authors,
                    year: result?.year,
                    doi: result?.doi,
                };
            });

        const prompt = buildSynthesisPrompt(
            summaries, question, noteContext, language, includeCitations,
            streamOpts?.citationStyle,
        );
        const response = await summarizeTextStream(
            pluginContext(this.plugin), prompt, onChunk, signal,
        );

        const sourceMetadata: SourceMetadata[] = summaries.map(s => ({
            url: s.url,
            title: s.title,
            domain: extractDomain(s.url),
            doi: s.doi,
            authors: s.authors,
            year: s.year,
            accessedDate: new Date().toISOString().slice(0, 10),
            extractionMethod: extractions.find(e => e.url === s.url)?.extractionMethod || 'readability',
            findings: s.findings,
        }));

        if (response.success && response.content) {
            const synthesis = includeCitations === false
                ? response.content
                : this.verifyCitations(response.content, summaries);
            return { synthesis, sourceMetadata };
        }
        return { synthesis: 'Synthesis failed. Please try again.', sourceMetadata };
    }

    /**
     * Verify [N] citation indices in synthesis match actual source list.
     * Removes hallucinated citations. Adds missing source entries.
     */
    private verifyCitations(
        synthesis: string,
        sources: Array<{ url: string; title: string; findings: string }>,
    ): string {
        const citedIndices = new Set(
            [...synthesis.matchAll(/\[(\d+)\]/g)].map(m => parseInt(m[1])),
        );
        let cleaned = synthesis;
        for (const idx of citedIndices) {
            if (idx < 1 || idx > sources.length) {
                cleaned = cleaned.replaceAll(`[${idx}]`, '');
            }
        }
        if (!cleaned.includes('### Sources') && !cleaned.includes('## Sources')
            && !cleaned.includes('### References') && !cleaned.includes('## References')) {
            const sourceList = sources
                .map((s, i) => `${i + 1}. [${s.title}](${s.url})`)
                .join('\n');
            cleaned += `\n\n### Sources\n${sourceList}`;
        }
        return cleaned;
    }

    // ═══ VAULT PRE-CHECK (Phase 3, AD-15) ═══

    /**
     * Check if the vault already contains relevant context for this question.
     * Returns null if RAG is unavailable or no relevant notes found.
     * Advisory only — never blocks research.
     */
    async precheckVaultContext(
        question: string,
        noteFile?: TFile,
    ): Promise<VaultPrecheckResult | null> {
        try {
            // Check RAG availability — requires vectorStore + embeddingService
            if (!this.plugin.vectorStore || !this.plugin.embeddingService) return null;
            if (!this.plugin.settings.enableSemanticSearch) return null;

            const ragService = new RAGService(
                this.plugin.vectorStore,
                this.plugin.settings,
                this.plugin.embeddingService,
            );

            const minSimilarity = this.plugin.settings.researchVaultPrecheckMinSimilarity ?? 0.65;
            const context = await ragService.retrieveContext(question, noteFile, {
                maxChunks: 5,
                minSimilarity,
            });

            if (!context?.chunks?.length) return null;

            interface ContextChunk { similarity?: number; filePath?: string; path?: string; content?: string }
            const chunks = context.chunks as ContextChunk[];
            const maxSimilarity = Math.max(...chunks.map((c) => c.similarity ?? 0));
            if (maxSimilarity < minSimilarity) return null;

            const relatedNotes = chunks
                .slice(0, 5)
                .map((c) => ({
                    path: c.filePath || c.path || 'Unknown',
                    similarity: c.similarity ?? 0,
                    excerpt: (c.content || '').slice(0, PRECHECK_EXCERPT_LENGTH),
                }));

            return {
                relatedNotes,
                formattedContext: context.formattedContext || '',
                confidence: maxSimilarity,
            };
        } catch {
            // Advisory feature — never block on error
            return null;
        }
    }

    // ═══ ACADEMIC ENRICHMENT (Phase 3, AD-14) ═══

    /** Enrich search results with DOI, year, author metadata. */
    enrichAcademicMetadata(results: SearchResult[]): void {
        enrichWithAcademicMetadata(results);
    }

    // ═══ SESSION MANAGEMENT ═══

    private get sessionFilePath(): string {
        const folder = resolvePluginPath(this.plugin.settings, 'Config', 'Config');
        return `${folder}/.research-session-${this.sessionId}.json`;
    }

    /** Find most recent valid session file for resume. */
    async findResumableSession(): Promise<ResearchSessionState | null> {
        const folder = resolvePluginPath(this.plugin.settings, 'Config', 'Config');
        const configFolder = this.plugin.app.vault.getAbstractFileByPath(folder);
        if (!configFolder || !(configFolder instanceof TFolder)) return null;

        const sessionFiles = configFolder.children
            .filter((f): f is TFile => f instanceof TFile && f.name.startsWith('.research-session-') && f.name.endsWith('.json'))
            .sort((a, b) => b.stat.mtime - a.stat.mtime);

        for (const f of sessionFiles) {
            try {
                const content = await this.plugin.app.vault.read(f);
                const state: ResearchSessionState = JSON.parse(content);
                if (Date.now() - state.timestamp < 3_600_000) return state;
                await this.plugin.app.fileManager.trashFile(f);
            } catch {
                await this.plugin.app.fileManager.trashFile(f).catch(() => {});
            }
        }
        return null;
    }

    /** Save session state to ephemeral file. */
    async saveSession(state: ResearchSessionState): Promise<void> {
        const folder = resolvePluginPath(this.plugin.settings, 'Config', 'Config');
        await ensureFolderExists(this.plugin.app.vault, folder);
        const json = JSON.stringify(state, null, 2);
        const file = this.plugin.app.vault.getAbstractFileByPath(this.sessionFilePath);
        if (file instanceof TFile) {
            await this.plugin.app.vault.modify(file, json);
        } else {
            await this.plugin.app.vault.create(this.sessionFilePath, json);
        }
    }

    /** Delete current session file. */
    async clearSession(): Promise<void> {
        const file = this.plugin.app.vault.getAbstractFileByPath(this.sessionFilePath);
        if (file instanceof TFile) await this.plugin.app.fileManager.trashFile(file);
    }

    /** Cleanup: close any active CDP connections. Called from plugin.onunload(). */
    forceCleanup(): void {
        void this.scrapingBrowser.forceClose();
    }

    // ═══ SERVICE ACCESSORS ═══

    getUsageService(): ResearchUsageService | undefined {
        return this.usageService;
    }
}
