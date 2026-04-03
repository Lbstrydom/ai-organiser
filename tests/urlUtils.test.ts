/**
 * URL Utilities Tests
 * Covers normalizeUrl, extractDomain, and classifyUrlSource.
 */

import { normalizeUrl, extractDomain, classifyUrlSource } from '../src/utils/urlUtils';

describe('normalizeUrl', () => {
    it('lowercases the hostname', () => {
        expect(normalizeUrl('https://WWW.Example.COM/page')).toBe('https://www.example.com/page');
    });

    it('strips trailing slash from non-root paths', () => {
        expect(normalizeUrl('https://example.com/page/')).toBe('https://example.com/page');
    });

    it('preserves trailing slash for root path', () => {
        expect(normalizeUrl('https://example.com/')).toBe('https://example.com/');
    });

    it('removes utm tracking parameters', () => {
        const url = 'https://example.com/article?utm_source=twitter&utm_medium=social&id=42';
        expect(normalizeUrl(url)).toBe('https://example.com/article?id=42');
    });

    it('removes fbclid and gclid parameters', () => {
        const url = 'https://example.com/page?fbclid=abc123&gclid=xyz789&keep=yes';
        expect(normalizeUrl(url)).toBe('https://example.com/page?keep=yes');
    });

    it('returns lowercased fallback for invalid URLs', () => {
        expect(normalizeUrl('not a url')).toBe('not a url');
    });

    it('returns empty string for empty input', () => {
        expect(normalizeUrl('')).toBe('');
    });
});

describe('extractDomain', () => {
    it('extracts domain without www prefix', () => {
        expect(extractDomain('https://www.nature.com/articles/x')).toBe('nature.com');
    });

    it('returns domain as-is when no www prefix', () => {
        expect(extractDomain('https://arxiv.org/abs/1234')).toBe('arxiv.org');
    });

    it('lowercases the domain', () => {
        expect(extractDomain('https://WWW.GitHub.COM/repo')).toBe('github.com');
    });

    it('returns raw string for invalid URLs', () => {
        expect(extractDomain('bad-url')).toBe('bad-url');
    });
});

describe('classifyUrlSource', () => {
    it('classifies youtube.com/watch as youtube', () => {
        expect(classifyUrlSource('https://www.youtube.com/watch?v=abc')).toBe('youtube');
    });

    it('classifies youtu.be short links as youtube', () => {
        expect(classifyUrlSource('https://youtu.be/abc123')).toBe('youtube');
    });

    it('classifies arxiv.org as academic', () => {
        expect(classifyUrlSource('https://arxiv.org/abs/2301.12345')).toBe('academic');
    });

    it('classifies scholar.google as academic', () => {
        expect(classifyUrlSource('https://scholar.google.com/scholar?q=test')).toBe('academic');
    });

    it('classifies pubmed as academic', () => {
        expect(classifyUrlSource('https://pubmed.ncbi.nlm.nih.gov/12345678/')).toBe('academic');
    });

    it('classifies .pdf extension as pdf', () => {
        expect(classifyUrlSource('https://example.com/paper.pdf')).toBe('pdf');
    });

    it('classifies .pdf with query string as pdf', () => {
        expect(classifyUrlSource('https://example.com/doc.pdf?dl=1')).toBe('pdf');
    });

    it('classifies regular URLs as web', () => {
        expect(classifyUrlSource('https://example.com/article')).toBe('web');
    });

    it('classifies nature.com as academic (shared domain list)', () => {
        expect(classifyUrlSource('https://www.nature.com/articles/s12345')).toBe('academic');
    });

    it('classifies sciencedirect.com as academic', () => {
        expect(classifyUrlSource('https://www.sciencedirect.com/science/article/pii/1234')).toBe('academic');
    });

    it('classifies ieee.org as academic', () => {
        expect(classifyUrlSource('https://ieeexplore.ieee.org/document/12345')).toBe('academic');
    });
});
