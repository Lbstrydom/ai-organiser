/**
 * Academic Utilities
 *
 * DOI extraction, author/year parsing, academic query expansion,
 * and citation formatting helpers for Academic Mode (AD-14).
 *
 * All extraction is regex-based (local only). No CrossRef or Semantic Scholar API calls.
 */

import type { SearchResult } from './researchTypes';

// DOI regex: 10.XXXX/any-non-whitespace (case insensitive)
const DOI_REGEX = /10\.\d{4,9}\/[^\s]+/i;

// Year extraction patterns
const YEAR_REGEX = /\b(19|20)\d{2}\b/;

// Author patterns: "LastName, F." or "F. LastName" or "LastName et al."
const AUTHOR_PATTERN = /(?:([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s+et\s+al\.?)|(?:([A-Z][a-z]+),\s*[A-Z]\.)|(?:[A-Z]\.\s*([A-Z][a-z]+))/g;

/** Known academic domain prefixes for query expansion and URL classification. */
export const ACADEMIC_DOMAINS = [
    'arxiv.org',
    'pubmed.ncbi.nlm.nih.gov',
    'scholar.google.com',
    'semanticscholar.org',
    'jstor.org',
    'ncbi.nlm.nih.gov',
    'ieee.org',
    'acm.org',
    'sciencedirect.com',
    'springer.com',
    'wiley.com',
    'nature.com',
    'science.org',
];

/** Extract DOI from text if present. Returns null if not found. */
export function extractDOI(text: string): string | null {
    if (!text) return null;
    const match = text.match(DOI_REGEX);
    if (!match) return null;
    // Clean trailing punctuation that may have been captured
    let doi = match[0];
    doi = doi.replace(/[.,;:)\]}>]+$/, '');
    return doi;
}

/** Extract year from search result date field or snippet. Returns null if not found. */
export function extractYear(result: SearchResult): number | null {
    // Try date field first
    if (result.date) {
        const dateMatch = result.date.match(YEAR_REGEX);
        if (dateMatch) return parseInt(dateMatch[0]);
    }
    // Try snippet
    if (result.snippet) {
        const snippetMatch = result.snippet.match(YEAR_REGEX);
        if (snippetMatch) return parseInt(snippetMatch[0]);
    }
    return null;
}

/** Extract author-like patterns from snippet. Returns empty array if none found. */
export function extractAuthors(snippet: string): string[] {
    if (!snippet) return [];
    const authors: string[] = [];
    const matches = snippet.matchAll(AUTHOR_PATTERN);
    for (const match of matches) {
        // Pick the non-null capture group
        const name = match[1] || match[2] || match[3];
        if (name && !authors.includes(name)) {
            authors.push(name);
        }
    }
    return authors.slice(0, 5); // Cap at 5 authors
}

/** Build academic-enhanced search queries from a base query. */
export function buildAcademicQueries(baseQuery: string): string[] {
    const siteScope = ACADEMIC_DOMAINS.slice(0, 3)
        .map(d => `site:${d}`)
        .join(' OR ');

    return [
        baseQuery,
        `${baseQuery} ${siteScope}`,
        `${baseQuery} "systematic review" OR "meta-analysis"`,
        `${baseQuery} "doi" filetype:pdf`,
    ];
}

/**
 * Enrich search results with academic metadata (DOI, year, authors).
 * Mutates results in-place.
 */
export function enrichWithAcademicMetadata(results: SearchResult[]): void {
    for (const result of results) {
        // DOI from URL or snippet
        if (!result.doi) {
            result.doi = extractDOI(result.url) || extractDOI(result.snippet) || undefined;
        }
        // Year
        if (!result.year) {
            result.year = extractYear(result) ?? undefined;
        }
        // Authors
        if (!result.authors || result.authors.length === 0) {
            const authors = extractAuthors(result.snippet);
            if (authors.length > 0) result.authors = authors;
        }
    }
}

/**
 * Format a source as academic citation.
 * @param style 'numeric' → [1] Title. URL
 *              'author-year' → (Author, Year) Title. URL
 */
export function formatAcademicCitation(
    source: { url: string; title: string; authors?: string[]; year?: number; doi?: string },
    index: number,
    style: 'numeric' | 'author-year',
): string {
    if (style === 'author-year') {
        const authorStr = source.authors?.length
            ? (source.authors.length === 1
                ? source.authors[0]
                : source.authors.length === 2
                    ? `${source.authors[0]} & ${source.authors[1]}`
                    : `${source.authors[0]} et al.`)
            : 'Unknown';
        const yearStr = source.year ? String(source.year) : 'n.d.';
        const doiStr = source.doi ? ` DOI: ${source.doi}` : '';
        return `(${authorStr}, ${yearStr}) [${source.title}](${source.url})${doiStr}`;
    }
    // numeric style
    const doiStr = source.doi ? ` DOI: ${source.doi}` : '';
    return `${index + 1}. [${source.title}](${source.url})${doiStr}`;
}

/**
 * Build inline citation reference for author-year style.
 * Returns e.g. "(Smith et al., 2024)" or "(Jones & Lee, 2023)"
 */
export function buildAuthorYearRef(
    source: { authors?: string[]; year?: number },
    _index: number,
): string {
    const authorStr = source.authors?.length
        ? (source.authors.length === 1
            ? source.authors[0]
            : source.authors.length === 2
                ? `${source.authors[0]} & ${source.authors[1]}`
                : `${source.authors[0]} et al.`)
        : 'Unknown';
    const yearStr = source.year ? String(source.year) : 'n.d.';
    return `(${authorStr}, ${yearStr})`;
}
