/**
 * Shared URL Utilities
 *
 * URL normalization, domain extraction, and source classification.
 * Extracted from resourceSearchService.ts patterns for DRY reuse.
 */

import { ACADEMIC_DOMAINS } from '../services/research/academicUtils';

/** Tracking parameters to strip during normalization */
const TRACKING_PARAMS = new Set([
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'ref', 'fbclid', 'gclid', 'mc_cid', 'mc_eid',
]);

/**
 * Normalize URL for deduplication.
 * Lowercase host, strip trailing slash, remove tracking params.
 */
export function normalizeUrl(url: string): string {
    try {
        const u = new URL(url);
        u.hostname = u.hostname.toLowerCase();
        // Remove tracking params
        for (const key of [...u.searchParams.keys()]) {
            if (TRACKING_PARAMS.has(key)) {
                u.searchParams.delete(key);
            }
        }
        let normalized = u.toString();
        // Strip trailing slash (but not for root paths)
        if (normalized.endsWith('/') && u.pathname !== '/') {
            normalized = normalized.slice(0, -1);
        }
        return normalized;
    } catch {
        return url.toLowerCase().replace(/\/+$/, '');
    }
}

/**
 * Extract display domain from URL.
 * e.g. "https://www.nature.com/articles/x" → "nature.com"
 */
export function extractDomain(url: string): string {
    try {
        const hostname = new URL(url).hostname.toLowerCase();
        return hostname.replace(/^www\./, '');
    } catch {
        return url;
    }
}

/**
 * Classify URL source type from URL patterns.
 */
export function classifyUrlSource(url: string): 'web' | 'youtube' | 'academic' | 'pdf' {
    const lower = url.toLowerCase();

    // YouTube
    if (lower.includes('youtube.com/watch') || lower.includes('youtu.be/')) {
        return 'youtube';
    }

    // PDF
    if (lower.endsWith('.pdf') || lower.includes('.pdf?')) {
        return 'pdf';
    }

    // Academic — uses shared ACADEMIC_DOMAINS list from academicUtils
    if (ACADEMIC_DOMAINS.some(d => lower.includes(d))) {
        return 'academic';
    }

    return 'web';
}
