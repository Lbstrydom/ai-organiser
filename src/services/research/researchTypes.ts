/**
 * Research Assistant Types
 *
 * Interfaces, types, and session state for the research workflow.
 * All types are JSON-serializable for session persistence (AD-6).
 */

export type SearchProviderType = 'tavily' | 'brightdata-serp' | 'claude-web-search';

export type SiteScope = 'all' | 'preferred' | 'academic' | 'custom';

export type ResearchPhase = 'idle' | 'searching' | 'continuing' | 'reviewing' | 'extracting' | 'synthesizing' | 'done';

export interface SearchOptions {
    maxResults?: number;
    siteScope?: SiteScope;
    customSites?: string[];
    preferredSites?: string[];
    excludedSites?: string[];
    dateRange?: 'recent' | 'year' | 'any';
    academicMode?: boolean;
}

export interface SearchResult {
    title: string;
    url: string;
    snippet: string;
    source: 'web' | 'youtube' | 'academic' | 'pdf';
    date?: string;
    score?: number;
    extractedContent?: string;
    thumbnail?: string;
    domain: string;
    triageAssessment?: string;
    // Phase 3: quality scoring (AD-13)
    qualityScore?: number;
    qualitySignals?: QualitySignals;
    // Phase 3: academic metadata (AD-14)
    doi?: string;
    authors?: string[];
    year?: number;
    // Phase 3: perspective decomposition (§3.6)
    perspective?: string;
}

export interface QualitySignals {
    relevance: number;   // 0.0–1.0, from LLM triage score
    authority: number;   // 0.0–1.0, from domain authority profile
    freshness: number;   // 0.0–1.0, from date decay function
    depth: number;       // 0.0–1.0, from content length
    diversity: number;   // 0.0–1.0, domain uniqueness penalty
}

export interface SearchProvider {
    readonly type: SearchProviderType;
    search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
    isConfigured(): Promise<boolean>;
}

/** Session state — JSON-serializable (AD-6) */
export interface ResearchSessionState {
    question: string;
    searchResults: SearchResult[];
    selectedUrls: string[];
    sourceSummaries: Record<string, string>;
    synthesis?: string;
    provider: SearchProviderType;
    siteScope: SiteScope;
    dateRange?: 'recent' | 'year' | 'any';
    phase: ResearchPhase;
    timestamp: number;
    // Phase 3 session state
    precheckShown?: boolean;
    academicMode?: boolean;
    perspectiveMode?: boolean;
    sourceMetadata?: SourceMetadata[];
    // Phase 3.4: multi-turn conversation history for Claude Web Search resume
    conversationHistory?: Array<{ role: string; content: unknown }>;
}

/** Extraction result for a single source */
export interface SourceExtraction {
    url: string;
    title: string;
    findings: string;
    extractionMethod: 'tavily-inline' | 'readability' | 'web-unlocker' | 'scraping-browser';
    error?: string;
}

// ═══ Phase 3: Usage Guardrails (AD-12) ═══

export type PaidTier = 'brightdata-serp' | 'web-unlocker' | 'scraping-browser' | 'claude-web-search';

export interface ResearchUsageEvent {
    tier: PaidTier;
    timestamp: number;
    estimatedCostUsd: number;
}

export type BudgetStatusLevel = 'ok' | 'warn' | 'blocked';

export interface ResearchBudgetStatus {
    level: BudgetStatusLevel;
    estimatedSpendUsd: number;
    budgetUsd: number;
    percentUsed: number;
    message?: string;
}

export interface UsageLedger {
    version: number;
    month: string;  // 'YYYY-MM'
    totals: { estimatedUsd: number; operations: number };
    byProvider: Record<string, { count: number; estimatedUsd: number }>;
    dailyCounts?: Record<string, Record<string, number>>;
}

// ═══ Phase 3: Vault Pre-check (AD-15) ═══

export interface VaultPrecheckResult {
    relatedNotes: Array<{ path: string; similarity: number; excerpt: string }>;
    formattedContext: string;
    confidence: number;
}

// ═══ Phase 3: Source Metadata for Zotero (AD-17) ═══

export interface SourceMetadata {
    url: string;
    title: string;
    domain: string;
    doi?: string;
    authors?: string[];
    year?: number;
    accessedDate: string;  // ISO date
    extractionMethod: string;
    findings: string;
}

// ═══ Phase 3: Perspective Decomposition (§3.6) ═══

export interface PerspectiveQuery {
    query: string;
    perspective: string;
}

// ═══ Claude Web Search (AD-2) ═══

/** Unified response from Claude Web Search API — contains both search results and synthesis. */
export interface ClaudeWebSearchResponse {
    searchResults: SearchResult[];
    synthesis: string;
    citations: ParsedCitation[];
    searchCount: number;
    usage: { inputTokens: number; outputTokens: number };
    paused: boolean;          // true if stop_reason === 'pause_turn'
    rawContent: unknown[];    // Full content array for pause_turn continuation
}

export interface ParsedCitation {
    url: string;
    title: string;
    citedText: string;
}

/** Callbacks for progressive streaming during Claude Web Search. */
export interface ClaudeWebSearchStreamCallbacks {
    onSearchQuery?: (query: string) => void;
    onTextChunk?: (text: string) => void;
    onSearchResult?: (result: SearchResult) => void;
    onPhaseChange?: (phase: string) => void;
}

// ═══ Phase 3: Zotero CSL-JSON (AD-17) ═══

export interface CslJsonItem {
    type: 'webpage' | 'article-journal' | 'report';
    title: string;
    URL: string;
    accessed: { 'date-parts': [[number, number, number]] };
    author?: Array<{ family: string; given: string }>;
    DOI?: string;
    issued?: { 'date-parts': [[number]] };
    'container-title'?: string;
}
