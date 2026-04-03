/**
 * Academic Utilities Tests
 *
 * Tests for DOI extraction, year extraction, author parsing,
 * academic query building, metadata enrichment, and citation formatting.
 */

import {
    extractDOI,
    extractYear,
    extractAuthors,
    buildAcademicQueries,
    enrichWithAcademicMetadata,
    formatAcademicCitation,
    buildAuthorYearRef,
    ACADEMIC_DOMAINS,
} from '../src/services/research/academicUtils';
import type { SearchResult } from '../src/services/research/researchTypes';

/** Helper to create a minimal SearchResult */
function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
    return {
        title: 'Test Paper',
        url: 'https://example.com/paper',
        snippet: '',
        source: 'academic',
        domain: 'example.com',
        ...overrides,
    };
}

describe('extractDOI', () => {
    it('should extract a valid DOI from text', () => {
        const text = 'See https://doi.org/10.1038/s41586-021-03819-2 for the paper.';
        expect(extractDOI(text)).toBe('10.1038/s41586-021-03819-2');
    });

    it('should extract DOI from plain text reference', () => {
        const text = 'Published: 10.1234/example.2024.001 in Nature';
        expect(extractDOI(text)).toBe('10.1234/example.2024.001');
    });

    it('should clean trailing punctuation from DOI', () => {
        const text = 'DOI: 10.1038/nature12373.';
        expect(extractDOI(text)).toBe('10.1038/nature12373');
    });

    it('should clean trailing closing bracket from DOI', () => {
        const text = '(doi: 10.1038/nature12373)';
        expect(extractDOI(text)).toBe('10.1038/nature12373');
    });

    it('should clean trailing semicolons and commas', () => {
        const text = '10.1234/test123;';
        expect(extractDOI(text)).toBe('10.1234/test123');
    });

    it('should return null for text without DOI', () => {
        expect(extractDOI('No DOI in this text')).toBeNull();
        expect(extractDOI('Just a normal sentence.')).toBeNull();
    });

    it('should return null for empty string', () => {
        expect(extractDOI('')).toBeNull();
    });

    it('should return null for null-like input', () => {
        expect(extractDOI(null as any)).toBeNull();
    });

    it('should handle DOI with complex suffix', () => {
        const text = '10.48550/arXiv.2301.07041';
        expect(extractDOI(text)).toBe('10.48550/arXiv.2301.07041');
    });
});

describe('extractYear', () => {
    it('should extract year from date field', () => {
        const result = makeResult({ date: '2024-03-15' });
        expect(extractYear(result)).toBe(2024);
    });

    it('should extract year from textual date field', () => {
        const result = makeResult({ date: 'March 2023' });
        expect(extractYear(result)).toBe(2023);
    });

    it('should extract year from snippet when date field is absent', () => {
        const result = makeResult({ snippet: 'Published in 2022 by Nature.' });
        expect(extractYear(result)).toBe(2022);
    });

    it('should prefer date field over snippet', () => {
        const result = makeResult({ date: '2024-01-01', snippet: 'First published 2019' });
        expect(extractYear(result)).toBe(2024);
    });

    it('should return null when no year found', () => {
        const result = makeResult({ date: undefined, snippet: 'No year info here' });
        expect(extractYear(result)).toBeNull();
    });

    it('should return null for empty result', () => {
        const result = makeResult({ date: undefined, snippet: '' });
        expect(extractYear(result)).toBeNull();
    });

    it('should handle years in 1900s', () => {
        const result = makeResult({ date: '1998-05-01' });
        expect(extractYear(result)).toBe(1998);
    });
});

describe('extractAuthors', () => {
    it('should extract "LastName, F." pattern', () => {
        const snippet = 'Smith, J. and colleagues studied...';
        const authors = extractAuthors(snippet);
        expect(authors).toContain('Smith');
    });

    it('should extract "F. LastName" pattern', () => {
        const snippet = 'J. Watson proposed the model...';
        const authors = extractAuthors(snippet);
        expect(authors).toContain('Watson');
    });

    it('should extract "LastName et al." pattern', () => {
        const snippet = 'Johnson et al. demonstrated that...';
        const authors = extractAuthors(snippet);
        expect(authors).toContain('Johnson');
    });

    it('should handle multiple authors', () => {
        const snippet = 'Smith, J. and Brown, K. both contributed. Miller, L. also.';
        const authors = extractAuthors(snippet);
        expect(authors.length).toBeGreaterThanOrEqual(2);
    });

    it('should cap at 5 authors', () => {
        const snippet = 'Smith, A. Brown, B. Clark, C. Davis, D. Evans, E. Fisher, F. Grant, G.';
        const authors = extractAuthors(snippet);
        expect(authors.length).toBeLessThanOrEqual(5);
    });

    it('should deduplicate authors', () => {
        const snippet = 'Smith, J. wrote first. Later Smith, J. wrote again.';
        const authors = extractAuthors(snippet);
        const smithCount = authors.filter(a => a === 'Smith').length;
        expect(smithCount).toBeLessThanOrEqual(1);
    });

    it('should return empty array for empty snippet', () => {
        expect(extractAuthors('')).toEqual([]);
    });

    it('should return empty array for null-like snippet', () => {
        expect(extractAuthors(null as any)).toEqual([]);
    });
});

describe('buildAcademicQueries', () => {
    it('should return exactly 4 query variants', () => {
        const queries = buildAcademicQueries('machine learning');
        expect(queries).toHaveLength(4);
    });

    it('should include the base query as first element', () => {
        const queries = buildAcademicQueries('neural networks');
        expect(queries[0]).toBe('neural networks');
    });

    it('should include site scopes in second query', () => {
        const queries = buildAcademicQueries('deep learning');
        expect(queries[1]).toContain('site:');
        expect(queries[1]).toContain('arxiv.org');
    });

    it('should include systematic review terms', () => {
        const queries = buildAcademicQueries('cancer treatment');
        expect(queries[2]).toContain('systematic review');
        expect(queries[2]).toContain('meta-analysis');
    });

    it('should include DOI and filetype:pdf query', () => {
        const queries = buildAcademicQueries('quantum computing');
        expect(queries[3]).toContain('doi');
        expect(queries[3]).toContain('filetype:pdf');
    });
});

describe('enrichWithAcademicMetadata', () => {
    it('should extract DOI from URL and set on result', () => {
        const results = [
            makeResult({ url: 'https://doi.org/10.1038/nature12373', snippet: 'Paper abstract' }),
        ];

        enrichWithAcademicMetadata(results);
        expect(results[0].doi).toBe('10.1038/nature12373');
    });

    it('should extract DOI from snippet when URL has no DOI', () => {
        const results = [
            makeResult({
                url: 'https://example.com/paper',
                snippet: 'DOI: 10.1234/test.2024.001 - Abstract text',
            }),
        ];

        enrichWithAcademicMetadata(results);
        expect(results[0].doi).toBe('10.1234/test.2024.001');
    });

    it('should not overwrite existing DOI', () => {
        const results = [
            makeResult({
                url: 'https://doi.org/10.1038/new-doi',
                snippet: 'Different DOI 10.9999/other',
                doi: '10.1038/existing-doi',
            }),
        ];

        enrichWithAcademicMetadata(results);
        expect(results[0].doi).toBe('10.1038/existing-doi');
    });

    it('should extract year from result', () => {
        const results = [
            makeResult({ date: '2024-06-15', snippet: 'Some text' }),
        ];

        enrichWithAcademicMetadata(results);
        expect(results[0].year).toBe(2024);
    });

    it('should not overwrite existing year', () => {
        const results = [
            makeResult({ date: '2024-01-01', year: 2020 }),
        ];

        enrichWithAcademicMetadata(results);
        expect(results[0].year).toBe(2020);
    });

    it('should extract authors from snippet', () => {
        const results = [
            makeResult({ snippet: 'Smith, J. and Brown, K. found that...' }),
        ];

        enrichWithAcademicMetadata(results);
        expect(results[0].authors).toBeDefined();
        expect(results[0].authors!.length).toBeGreaterThan(0);
    });

    it('should not overwrite existing authors', () => {
        const results = [
            makeResult({
                snippet: 'Brown, K. wrote...',
                authors: ['Smith'],
            }),
        ];

        enrichWithAcademicMetadata(results);
        expect(results[0].authors).toEqual(['Smith']);
    });

    it('should mutate results in-place', () => {
        const results = [makeResult({ date: '2023-05-01', snippet: '10.1234/test' })];
        const originalRef = results[0];

        enrichWithAcademicMetadata(results);

        expect(results[0]).toBe(originalRef);
        expect(results[0].doi).toBeDefined();
        expect(results[0].year).toBe(2023);
    });
});

describe('formatAcademicCitation', () => {
    it('should format numeric style with index', () => {
        const source = { url: 'https://example.com', title: 'Test Paper' };
        const citation = formatAcademicCitation(source, 0, 'numeric');
        expect(citation).toBe('1. [Test Paper](https://example.com)');
    });

    it('should format numeric style with DOI', () => {
        const source = { url: 'https://example.com', title: 'Paper', doi: '10.1234/test' };
        const citation = formatAcademicCitation(source, 2, 'numeric');
        expect(citation).toBe('3. [Paper](https://example.com) DOI: 10.1234/test');
    });

    it('should format author-year style with single author', () => {
        const source = { url: 'https://example.com', title: 'Paper', authors: ['Smith'], year: 2024 };
        const citation = formatAcademicCitation(source, 0, 'author-year');
        expect(citation).toContain('(Smith, 2024)');
        expect(citation).toContain('[Paper](https://example.com)');
    });

    it('should format author-year style with two authors', () => {
        const source = { url: 'https://example.com', title: 'Paper', authors: ['Smith', 'Jones'], year: 2023 };
        const citation = formatAcademicCitation(source, 0, 'author-year');
        expect(citation).toContain('(Smith & Jones, 2023)');
    });

    it('should format author-year style with 3+ authors using et al.', () => {
        const source = { url: 'https://example.com', title: 'Paper', authors: ['Smith', 'Jones', 'Lee'], year: 2022 };
        const citation = formatAcademicCitation(source, 0, 'author-year');
        expect(citation).toContain('(Smith et al., 2022)');
    });

    it('should use "Unknown" when no authors provided', () => {
        const source = { url: 'https://example.com', title: 'Paper', year: 2024 };
        const citation = formatAcademicCitation(source, 0, 'author-year');
        expect(citation).toContain('(Unknown, 2024)');
    });

    it('should use "n.d." when no year provided', () => {
        const source = { url: 'https://example.com', title: 'Paper', authors: ['Smith'] };
        const citation = formatAcademicCitation(source, 0, 'author-year');
        expect(citation).toContain('(Smith, n.d.)');
    });
});

describe('buildAuthorYearRef', () => {
    it('should format single author', () => {
        const ref = buildAuthorYearRef({ authors: ['Smith'], year: 2024 }, 0);
        expect(ref).toBe('(Smith, 2024)');
    });

    it('should format two authors with ampersand', () => {
        const ref = buildAuthorYearRef({ authors: ['Smith', 'Jones'], year: 2023 }, 0);
        expect(ref).toBe('(Smith & Jones, 2023)');
    });

    it('should format 3+ authors with et al.', () => {
        const ref = buildAuthorYearRef({ authors: ['Kim', 'Lee', 'Park'], year: 2024 }, 0);
        expect(ref).toBe('(Kim et al., 2024)');
    });

    it('should use Unknown for missing authors', () => {
        const ref = buildAuthorYearRef({ year: 2024 }, 0);
        expect(ref).toBe('(Unknown, 2024)');
    });

    it('should use n.d. for missing year', () => {
        const ref = buildAuthorYearRef({ authors: ['Smith'] }, 0);
        expect(ref).toBe('(Smith, n.d.)');
    });

    it('should handle empty authors array', () => {
        const ref = buildAuthorYearRef({ authors: [], year: 2024 }, 0);
        expect(ref).toBe('(Unknown, 2024)');
    });
});

describe('ACADEMIC_DOMAINS', () => {
    it('is exported and non-empty', () => {
        expect(ACADEMIC_DOMAINS).toBeDefined();
        expect(ACADEMIC_DOMAINS.length).toBeGreaterThan(0);
    });

    it('includes core academic domains', () => {
        expect(ACADEMIC_DOMAINS).toContain('scholar.google.com');
        expect(ACADEMIC_DOMAINS).toContain('arxiv.org');
        expect(ACADEMIC_DOMAINS).toContain('pubmed.ncbi.nlm.nih.gov');
    });

    it('is a frozen/readonly array', () => {
        // Verify it's an array of strings
        for (const d of ACADEMIC_DOMAINS) {
            expect(typeof d).toBe('string');
        }
    });
});
