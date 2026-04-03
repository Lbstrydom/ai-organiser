/**
 * Source Quality Service
 *
 * Deterministic quality scoring for search results (AD-13).
 * Weighted scoring: 0.45 relevance + 0.20 authority + 0.15 freshness + 0.10 depth + 0.10 diversity
 * Each signal normalized to 0.0–1.0. Explainable breakdown for UI tooltips.
 */

import type { SearchResult, QualitySignals } from './researchTypes';
import { extractDomain } from '../../utils/urlUtils';

/** Built-in domain authority profiles (AD-13). */
const AUTHORITY_TIERS: Record<string, number> = {
    // Tier 1.0 — Authoritative reference
    'nature.com': 1.0, 'science.org': 1.0, 'arxiv.org': 0.95,
    'pubmed.ncbi.nlm.nih.gov': 1.0, 'scholar.google.com': 0.9,
    'ieee.org': 0.95, 'acm.org': 0.95, 'nih.gov': 1.0,
    'gov.uk': 0.9, 'who.int': 0.95,

    // Tier 0.8 — High-quality editorial
    'bbc.com': 0.8, 'nytimes.com': 0.8, 'theguardian.com': 0.8,
    'reuters.com': 0.85, 'apnews.com': 0.85,

    // Tier 0.7 — Established technical
    'stackoverflow.com': 0.7, 'github.com': 0.7, 'developer.mozilla.org': 0.8,
    'docs.microsoft.com': 0.8, 'cloud.google.com': 0.75,

    // Tier 0.5 — User-generated / mixed quality
    'medium.com': 0.5, 'dev.to': 0.5, 'reddit.com': 0.4,
    'wikipedia.org': 0.6,
};

const DEFAULT_AUTHORITY = 0.3;

/** Scoring weights per AD-13. */
const WEIGHTS = {
    relevance: 0.45,
    authority: 0.20,
    freshness: 0.15,
    depth: 0.10,
    diversity: 0.10,
};

/**
 * Compute freshness signal from a date string.
 * 1.0 (< 30 days) → 0.5 (< 1 year) → 0.2 (< 3 years) → 0.0
 */
function computeFreshness(dateStr: string | undefined, now: Date): number {
    if (!dateStr) return 0.3; // unknown date gets a neutral score

    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return 0.3;

    const daysDiff = (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24);
    if (daysDiff < 30) return 1.0;
    if (daysDiff < 365) return 0.5;
    if (daysDiff < 365 * 3) return 0.2;
    return 0.0;
}

/**
 * Compute depth signal from snippet length and extracted content presence.
 * clamped(tokens / 500, 1.0) where tokens ≈ chars / 4.
 */
function computeDepth(result: SearchResult): number {
    const chars = (result.snippet?.length || 0) + (result.extractedContent?.length || 0);
    const estimatedTokens = chars / 4;
    return Math.min(estimatedTokens / 500, 1.0);
}

/**
 * Look up domain authority from built-in profiles.
 * Checks exact domain, then tries stripping leading subdomain.
 */
function lookupAuthority(domain: string): number {
    const lower = domain.toLowerCase();
    if (AUTHORITY_TIERS[lower] !== undefined) return AUTHORITY_TIERS[lower];

    // Try parent domain (e.g., blog.nature.com → nature.com)
    const parts = lower.split('.');
    if (parts.length > 2) {
        const parent = parts.slice(1).join('.');
        if (AUTHORITY_TIERS[parent] !== undefined) return AUTHORITY_TIERS[parent];
    }

    // Check if it's a .gov, .edu, or .ac.* domain
    if (lower.endsWith('.gov') || lower.endsWith('.edu')) return 0.8;
    if (lower.includes('.ac.') || lower.endsWith('.ac')) return 0.75;

    return DEFAULT_AUTHORITY;
}

export class SourceQualityService {
    /** Score all results after LLM triage. Mutates results in-place.
     *  @param results Results to score
     *  @param now Optional reference date for freshness computation (for testing) */
    scoreResults(results: SearchResult[], now?: Date): void {
        const refDate = now ?? new Date();
        const domainCounts = new Map<string, number>();

        // First pass: count domains for diversity penalty
        for (const result of results) {
            const domain = extractDomain(result.url);
            domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
        }

        // Track assignment order for diversity
        const domainAssigned = new Map<string, number>();

        for (const result of results) {
            const signals = this.computeSignals(result, domainAssigned, refDate);
            result.qualitySignals = signals;
            result.qualityScore =
                WEIGHTS.relevance * signals.relevance +
                WEIGHTS.authority * signals.authority +
                WEIGHTS.freshness * signals.freshness +
                WEIGHTS.depth * signals.depth +
                WEIGHTS.diversity * signals.diversity;
        }

        // Sort by qualityScore descending
        results.sort((a, b) => (b.qualityScore ?? 0) - (a.qualityScore ?? 0));
    }

    /** Get human-readable quality label. */
    static getQualityLabel(score: number): 'High' | 'Medium' | 'Low' {
        if (score >= 0.7) return 'High';
        if (score >= 0.4) return 'Medium';
        return 'Low';
    }

    /** Compute individual signal values. */
    private computeSignals(
        result: SearchResult,
        domainAssigned: Map<string, number>,
        now: Date,
    ): QualitySignals {
        const domain = extractDomain(result.url);

        // Relevance: from LLM triage score (0–10 → 0.0–1.0)
        const relevance = result.score ?? 0.5;

        // Authority: domain tier lookup
        const authority = lookupAuthority(domain);

        // Freshness: date decay
        const freshness = computeFreshness(result.date, now);

        // Depth: snippet/content length
        const depth = computeDepth(result);

        // Diversity: domain uniqueness penalty
        const domainOccurrence = (domainAssigned.get(domain) || 0) + 1;
        domainAssigned.set(domain, domainOccurrence);
        let diversity: number;
        if (domainOccurrence === 1) diversity = 1.0;
        else if (domainOccurrence === 2) diversity = 0.5;
        else diversity = 0.3;

        return { relevance, authority, freshness, depth, diversity };
    }
}

/** Exported for testing */
export { AUTHORITY_TIERS, WEIGHTS, lookupAuthority, computeFreshness, computeDepth };
