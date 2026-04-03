/**
 * Source Quality Service Tests
 *
 * Tests for deterministic quality scoring: freshness, depth, authority lookup,
 * diversity penalty, weighted scoring, and quality labels.
 */

import {
    SourceQualityService,
    AUTHORITY_TIERS,
    WEIGHTS,
    lookupAuthority,
    computeFreshness,
    computeDepth,
} from '../src/services/research/sourceQualityService';
import type { SearchResult } from '../src/services/research/researchTypes';

/** Helper to create a minimal SearchResult */
function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
    return {
        title: 'Test Result',
        url: 'https://example.com/article',
        snippet: 'A test snippet about something.',
        source: 'web',
        domain: 'example.com',
        ...overrides,
    };
}

describe('computeFreshness', () => {
    const now = new Date('2026-02-12T00:00:00Z');

    it('should return 1.0 for dates less than 30 days ago', () => {
        const recent = '2026-01-20';
        expect(computeFreshness(recent, now)).toBe(1.0);
    });

    it('should return 0.5 for dates less than 1 year ago', () => {
        const sixMonthsAgo = '2025-08-01';
        expect(computeFreshness(sixMonthsAgo, now)).toBe(0.5);
    });

    it('should return 0.2 for dates less than 3 years ago', () => {
        const twoYearsAgo = '2024-06-01';
        expect(computeFreshness(twoYearsAgo, now)).toBe(0.2);
    });

    it('should return 0.0 for dates older than 3 years', () => {
        const oldDate = '2020-01-01';
        expect(computeFreshness(oldDate, now)).toBe(0.0);
    });

    it('should return 0.3 for unknown date (undefined)', () => {
        expect(computeFreshness(undefined, now)).toBe(0.3);
    });

    it('should return 0.3 for invalid date string', () => {
        expect(computeFreshness('not-a-date', now)).toBe(0.3);
    });

    it('should return 0.3 for empty string', () => {
        expect(computeFreshness('', now)).toBe(0.3);
    });
});

describe('computeDepth', () => {
    it('should return 0 for empty snippet and no extracted content', () => {
        const result = makeResult({ snippet: '', extractedContent: undefined });
        expect(computeDepth(result)).toBe(0);
    });

    it('should scale with content length', () => {
        // 2000 chars / 4 = 500 tokens / 500 = 1.0
        const result = makeResult({ snippet: 'x'.repeat(2000) });
        expect(computeDepth(result)).toBe(1.0);
    });

    it('should be clamped at 1.0 for very long content', () => {
        const result = makeResult({ snippet: 'x'.repeat(5000) });
        expect(computeDepth(result)).toBe(1.0);
    });

    it('should combine snippet and extractedContent length', () => {
        // snippet 1000 chars + extractedContent 1000 chars = 2000 / 4 = 500 tokens / 500 = 1.0
        const result = makeResult({ snippet: 'x'.repeat(1000), extractedContent: 'y'.repeat(1000) });
        expect(computeDepth(result)).toBe(1.0);
    });

    it('should return partial value for moderate content', () => {
        // 400 chars / 4 = 100 tokens / 500 = 0.2
        const result = makeResult({ snippet: 'x'.repeat(400) });
        expect(computeDepth(result)).toBeCloseTo(0.2);
    });

    it('should handle undefined snippet', () => {
        const result = makeResult({ snippet: undefined as any });
        expect(computeDepth(result)).toBe(0);
    });
});

describe('lookupAuthority', () => {
    it('should return correct tier for known domains', () => {
        expect(lookupAuthority('nature.com')).toBe(1.0);
        expect(lookupAuthority('arxiv.org')).toBe(0.95);
        expect(lookupAuthority('stackoverflow.com')).toBe(0.7);
        expect(lookupAuthority('medium.com')).toBe(0.5);
        expect(lookupAuthority('reddit.com')).toBe(0.4);
    });

    it('should handle subdomain lookup (strip leading subdomain)', () => {
        expect(lookupAuthority('blog.nature.com')).toBe(1.0);
        expect(lookupAuthority('news.bbc.com')).toBe(0.8);
    });

    it('should return 0.8 for .gov domains', () => {
        expect(lookupAuthority('data.gov')).toBe(0.8);
        expect(lookupAuthority('whitehouse.gov')).toBe(0.8);
    });

    it('should return 0.8 for .edu domains', () => {
        expect(lookupAuthority('mit.edu')).toBe(0.8);
        expect(lookupAuthority('stanford.edu')).toBe(0.8);
    });

    it('should return 0.75 for .ac.* domains', () => {
        expect(lookupAuthority('ox.ac.uk')).toBe(0.75);
        expect(lookupAuthority('cam.ac.uk')).toBe(0.75);
    });

    it('should return DEFAULT_AUTHORITY (0.3) for unknown domains', () => {
        expect(lookupAuthority('randomsite.xyz')).toBe(0.3);
        expect(lookupAuthority('myblog.io')).toBe(0.3);
    });

    it('should be case insensitive', () => {
        expect(lookupAuthority('Nature.Com')).toBe(1.0);
        expect(lookupAuthority('ARXIV.ORG')).toBe(0.95);
    });

    it('should handle specific known domains from nih.gov', () => {
        expect(lookupAuthority('nih.gov')).toBe(1.0);
    });

    it('should handle gov.uk from the authority tiers', () => {
        expect(lookupAuthority('gov.uk')).toBe(0.9);
    });
});

describe('WEIGHTS', () => {
    it('should sum to 1.0', () => {
        const total = WEIGHTS.relevance + WEIGHTS.authority + WEIGHTS.freshness + WEIGHTS.depth + WEIGHTS.diversity;
        expect(total).toBeCloseTo(1.0);
    });

    it('should have relevance as the highest weight', () => {
        expect(WEIGHTS.relevance).toBeGreaterThan(WEIGHTS.authority);
        expect(WEIGHTS.relevance).toBeGreaterThan(WEIGHTS.freshness);
        expect(WEIGHTS.relevance).toBeGreaterThan(WEIGHTS.depth);
        expect(WEIGHTS.relevance).toBeGreaterThan(WEIGHTS.diversity);
    });
});

describe('AUTHORITY_TIERS', () => {
    it('should contain expected high-authority domains', () => {
        expect(AUTHORITY_TIERS['nature.com']).toBeDefined();
        expect(AUTHORITY_TIERS['science.org']).toBeDefined();
        expect(AUTHORITY_TIERS['nih.gov']).toBeDefined();
    });

    it('should contain expected medium-authority domains', () => {
        expect(AUTHORITY_TIERS['stackoverflow.com']).toBeDefined();
        expect(AUTHORITY_TIERS['github.com']).toBeDefined();
    });
});

describe('SourceQualityService.scoreResults', () => {
    const service = new SourceQualityService();
    const refDate = new Date('2026-02-12T00:00:00Z');

    it('should sort results by qualityScore descending', () => {
        const results: SearchResult[] = [
            makeResult({ url: 'https://random.xyz/low', score: 0.2, domain: 'random.xyz' }),
            makeResult({ url: 'https://nature.com/high', score: 0.9, domain: 'nature.com', date: '2026-02-01' }),
            makeResult({ url: 'https://medium.com/mid', score: 0.5, domain: 'medium.com' }),
        ];

        service.scoreResults(results, refDate);

        expect(results[0].url).toBe('https://nature.com/high');
        expect(results[results.length - 1].qualityScore!).toBeLessThanOrEqual(results[0].qualityScore!);
    });

    it('should populate qualitySignals on each result', () => {
        const results: SearchResult[] = [
            makeResult({ url: 'https://example.com/test', score: 0.7, domain: 'example.com' }),
        ];

        service.scoreResults(results, refDate);

        const signals = results[0].qualitySignals;
        expect(signals).toBeDefined();
        expect(signals!.relevance).toBeDefined();
        expect(signals!.authority).toBeDefined();
        expect(signals!.freshness).toBeDefined();
        expect(signals!.depth).toBeDefined();
        expect(signals!.diversity).toBeDefined();
    });

    it('should populate qualityScore on each result', () => {
        const results: SearchResult[] = [
            makeResult({ url: 'https://example.com/test', score: 0.7, domain: 'example.com' }),
        ];

        service.scoreResults(results, refDate);

        expect(results[0].qualityScore).toBeDefined();
        expect(results[0].qualityScore).toBeGreaterThan(0);
        expect(results[0].qualityScore).toBeLessThanOrEqual(1);
    });

    it('should apply diversity penalty for duplicate domains', () => {
        const results: SearchResult[] = [
            makeResult({ url: 'https://example.com/page1', score: 0.8, domain: 'example.com', date: '2026-02-01' }),
            makeResult({ url: 'https://example.com/page2', score: 0.8, domain: 'example.com', date: '2026-02-01' }),
            makeResult({ url: 'https://other.com/page1', score: 0.8, domain: 'other.com', date: '2026-02-01' }),
        ];

        service.scoreResults(results, refDate);

        // The unique-domain result should have diversity = 1.0
        // The second same-domain result should have diversity = 0.5
        const otherResult = results.find(r => r.url.includes('other.com'));
        const secondExample = results.filter(r => r.url.includes('example.com'));

        expect(otherResult!.qualitySignals!.diversity).toBe(1.0);
        // One of the example.com results should have reduced diversity
        const diversityValues = secondExample.map(r => r.qualitySignals!.diversity);
        expect(diversityValues).toContain(1.0); // First occurrence
        expect(diversityValues).toContain(0.5); // Second occurrence
    });

    it('should apply 0.3 diversity for third+ occurrence of same domain', () => {
        const results: SearchResult[] = [
            makeResult({ url: 'https://example.com/a', score: 0.8, domain: 'example.com' }),
            makeResult({ url: 'https://example.com/b', score: 0.8, domain: 'example.com' }),
            makeResult({ url: 'https://example.com/c', score: 0.8, domain: 'example.com' }),
        ];

        service.scoreResults(results, refDate);

        const diversities = results.map(r => r.qualitySignals!.diversity);
        expect(diversities).toContain(1.0);
        expect(diversities).toContain(0.5);
        expect(diversities).toContain(0.3);
    });

    it('should use score as relevance signal', () => {
        const results: SearchResult[] = [
            makeResult({ url: 'https://example.com/a', score: 0.9, domain: 'example.com' }),
        ];

        service.scoreResults(results, refDate);
        expect(results[0].qualitySignals!.relevance).toBe(0.9);
    });

    it('should default relevance to 0.5 when score is missing', () => {
        const results: SearchResult[] = [
            makeResult({ url: 'https://example.com/a', score: undefined, domain: 'example.com' }),
        ];

        service.scoreResults(results, refDate);
        expect(results[0].qualitySignals!.relevance).toBe(0.5);
    });

    it('should verify weighted formula: score = sum of weighted signals', () => {
        const results: SearchResult[] = [
            makeResult({
                url: 'https://nature.com/paper',
                score: 0.9,
                domain: 'nature.com',
                date: '2026-02-01',
                snippet: 'x'.repeat(1000),
            }),
        ];

        service.scoreResults(results, refDate);

        const s = results[0].qualitySignals!;
        const expected =
            WEIGHTS.relevance * s.relevance +
            WEIGHTS.authority * s.authority +
            WEIGHTS.freshness * s.freshness +
            WEIGHTS.depth * s.depth +
            WEIGHTS.diversity * s.diversity;

        expect(results[0].qualityScore).toBeCloseTo(expected);
    });
});

describe('SourceQualityService.getQualityLabel', () => {
    it('should return High for scores >= 0.7', () => {
        expect(SourceQualityService.getQualityLabel(0.7)).toBe('High');
        expect(SourceQualityService.getQualityLabel(0.85)).toBe('High');
        expect(SourceQualityService.getQualityLabel(1.0)).toBe('High');
    });

    it('should return Medium for scores >= 0.4 and < 0.7', () => {
        expect(SourceQualityService.getQualityLabel(0.4)).toBe('Medium');
        expect(SourceQualityService.getQualityLabel(0.55)).toBe('Medium');
        expect(SourceQualityService.getQualityLabel(0.69)).toBe('Medium');
    });

    it('should return Low for scores < 0.4', () => {
        expect(SourceQualityService.getQualityLabel(0.0)).toBe('Low');
        expect(SourceQualityService.getQualityLabel(0.2)).toBe('Low');
        expect(SourceQualityService.getQualityLabel(0.39)).toBe('Low');
    });
});
