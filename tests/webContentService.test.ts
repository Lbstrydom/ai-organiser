// @vitest-environment happy-dom

/**
 * WebContentService tests
 * Tests fetchArticle() retry logic, Jina Reader fallback, blocker-text filter,
 * isRetryableError(), and parseJinaResponse() with mocked HTTP and Readability.
 */

// Mock obsidian requestUrl
const mockRequestUrl = vi.fn();
vi.mock('obsidian', async () => {
    const actual = await vi.importActual('./mocks/obsidian');
    return {
        ...actual,
        requestUrl: (...args: unknown[]) => mockRequestUrl(...args),
    };
});

// Mock @mozilla/readability — Readability.parse() returns article or null
const mockReadabilityParse = vi.fn();
vi.mock('@mozilla/readability', () => ({
    Readability: class MockReadability {
        constructor() {}
        parse() { return mockReadabilityParse(); }
    },
}));

// Mock urlValidator — pass through by default
vi.mock('../src/utils/urlValidator', () => ({
    validateUrl: (url: string) => ({ valid: true, url }),
    isPdfUrl: (url: string) => url.endsWith('.pdf'),
}));

// Mock htmlToMarkdown — pass through
vi.mock('../src/utils/htmlToMarkdown', () => ({
    htmlToMarkdown: (html: string) => html,
    cleanMarkdown: (md: string) => md.trim(),
    extractLinks: () => [],
}));

// Mock textChunker
vi.mock('../src/utils/textChunker', () => ({
    chunkContentSync: (text: string, size: number) => [text.slice(0, size)],
}));

import { fetchArticle, isRetryableError, looksLikeBlockerPage, parseJinaResponse } from '../src/services/webContentService';

// Helper to make requestUrl return HTML with text content
function makeHtmlResponse(textContent: string, headers: Record<string, string> = {}): { text: string; headers: Record<string, string> } {
    return {
        text: `<html><body><article><p>${textContent}</p></article></body></html>`,
        headers: { 'content-type': 'text/html', ...headers },
    };
}

// Helper: article object that Readability returns
function makeArticle(text: string) {
    return {
        title: 'Test Article',
        content: `<p>${text}</p>`,
        textContent: text,
        excerpt: 'An excerpt',
        byline: 'Author',
        siteName: 'TestSite',
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    // Default: Readability returns good content
    mockReadabilityParse.mockReturnValue(makeArticle('A'.repeat(200)));
});

// =========================================================================
// isRetryableError()
// =========================================================================

describe('isRetryableError', () => {
    it('returns true for "status 403"', () => {
        expect(isRetryableError('Failed to fetch: status 403')).toBe(true);
    });

    it('returns true for "429"', () => {
        expect(isRetryableError('Failed to fetch: 429 Too Many Requests')).toBe(true);
    });

    it('returns true for "status 503"', () => {
        expect(isRetryableError('Failed to fetch: status 503')).toBe(true);
    });

    it('returns true for "timeout"', () => {
        expect(isRetryableError('Failed to fetch: timeout')).toBe(true);
    });

    it('returns true for "ECONNREFUSED"', () => {
        expect(isRetryableError('Failed to fetch: ECONNREFUSED')).toBe(true);
    });

    it('returns false for "404 not found"', () => {
        expect(isRetryableError('Failed to fetch: 404 not found')).toBe(false);
    });

    it('returns false for undefined', () => {
        expect(isRetryableError(undefined)).toBe(false);
    });

    it('returns false for empty string', () => {
        expect(isRetryableError('')).toBe(false);
    });
});

// =========================================================================
// looksLikeBlockerPage()
// =========================================================================

describe('looksLikeBlockerPage', () => {
    it('returns true when 2+ blocker patterns match', () => {
        const text = 'Please enable JavaScript. Checking your browser before proceeding.';
        expect(looksLikeBlockerPage(text)).toBe(true);
    });

    it('returns false when only 1 pattern matches (no false positive)', () => {
        const text = 'This article discusses captcha technology in modern web applications.';
        expect(looksLikeBlockerPage(text)).toBe(false);
    });

    it('returns false for normal article text', () => {
        const text = 'PostgreSQL best practices for AI agents include proper indexing and connection pooling.';
        expect(looksLikeBlockerPage(text)).toBe(false);
    });
});

// =========================================================================
// parseJinaResponse()
// =========================================================================

describe('parseJinaResponse', () => {
    it('parses Title: and Markdown Content: headers', () => {
        const text = 'Title: My Article\nURL Source: https://example.com\nMarkdown Content:\n# Introduction\nSome content here.';
        const result = parseJinaResponse(text);
        expect(result.title).toBe('My Article');
        expect(result.content).toContain('# Introduction');
        expect(result.content).toContain('Some content here.');
        expect(result.content).not.toContain('Title:');
        expect(result.content).not.toContain('URL Source:');
    });

    it('strips Title: and URL Source: lines when no Markdown Content: header', () => {
        const text = 'Title: Fallback Article\nURL Source: https://example.com\n# Heading\nBody text.';
        const result = parseJinaResponse(text);
        expect(result.title).toBe('Fallback Article');
        expect(result.content).toContain('# Heading');
        expect(result.content).not.toContain('Title:');
    });

    it('falls back to # heading when no Title: header', () => {
        const text = '# My Heading\nSome paragraph text here.';
        const result = parseJinaResponse(text);
        expect(result.title).toBe('My Heading');
    });

    it('returns Untitled when no title found', () => {
        const text = 'Just some plain text without any heading or title.';
        const result = parseJinaResponse(text);
        expect(result.title).toBe('Untitled');
        expect(result.content).toBe(text);
    });
});

// =========================================================================
// fetchArticle() — Direct fetch success
// =========================================================================

describe('fetchArticle — direct fetch success', () => {
    it('returns content when Readability succeeds', async () => {
        mockRequestUrl.mockResolvedValueOnce(makeHtmlResponse('content'));
        mockReadabilityParse.mockReturnValueOnce(makeArticle('A'.repeat(200)));

        const result = await fetchArticle('https://example.com/article');

        expect(result.success).toBe(true);
        expect(result.content?.title).toBe('Test Article');
        // Only 1 requestUrl call (no retry, no Jina)
        expect(mockRequestUrl).toHaveBeenCalledTimes(1);
    });

    it('returns early for PDF URLs', async () => {
        const result = await fetchArticle('https://example.com/doc.pdf');

        expect(result.success).toBe(false);
        expect(result.isPdfUrl).toBe(true);
        expect(mockRequestUrl).not.toHaveBeenCalled();
    });

    it('returns early for PDF content-type', async () => {
        mockRequestUrl.mockResolvedValueOnce({
            text: '%PDF-1.4',
            headers: { 'content-type': 'application/pdf' },
        });

        const result = await fetchArticle('https://example.com/document');

        expect(result.success).toBe(false);
        expect(result.isPdfUrl).toBe(true);
    });
});

// =========================================================================
// fetchArticle() — Retry logic
// =========================================================================

describe('fetchArticle — retry on transient errors', () => {
    it('retries with modern headers on 403', async () => {
        // First call: 403 error
        mockRequestUrl.mockRejectedValueOnce(new Error('status 403'));
        // Second call: succeeds
        mockRequestUrl.mockResolvedValueOnce(makeHtmlResponse('content'));
        mockReadabilityParse.mockReturnValue(makeArticle('B'.repeat(200)));

        const result = await fetchArticle('https://example.com/article');

        expect(result.success).toBe(true);
        expect(mockRequestUrl).toHaveBeenCalledTimes(2);
        // Verify second call uses modern headers
        const secondCallHeaders = mockRequestUrl.mock.calls[1][0].headers;
        expect(secondCallHeaders['Sec-Fetch-Dest']).toBe('document');
    });

    it('retries with modern headers on 429', async () => {
        mockRequestUrl.mockRejectedValueOnce(new Error('429 Too Many Requests'));
        mockRequestUrl.mockResolvedValueOnce(makeHtmlResponse('content'));
        mockReadabilityParse.mockReturnValue(makeArticle('B'.repeat(200)));

        const result = await fetchArticle('https://example.com/article');

        expect(result.success).toBe(true);
        expect(mockRequestUrl).toHaveBeenCalledTimes(2);
    });

    it('does NOT retry on 404 (goes to Jina)', async () => {
        // 404 — not retryable
        mockRequestUrl.mockRejectedValueOnce(new Error('404 not found'));
        // Next call should be Jina, not a retry
        mockRequestUrl.mockResolvedValueOnce({
            text: 'Title: Jina Article\nURL Source: https://example.com\nMarkdown Content:\n' + 'C'.repeat(200),
            headers: {},
        });

        const result = await fetchArticle('https://example.com/article');

        expect(result.success).toBe(true);
        expect(mockRequestUrl).toHaveBeenCalledTimes(2);
        // Second call should be to Jina
        expect(mockRequestUrl.mock.calls[1][0].url).toContain('r.jina.ai');
    });
});

// =========================================================================
// fetchArticle() — Jina Reader fallback
// =========================================================================

describe('fetchArticle — Jina Reader fallback', () => {
    it('uses Jina when Readability extraction fails', async () => {
        // Direct fetch succeeds but Readability returns too little
        mockRequestUrl.mockResolvedValueOnce(makeHtmlResponse('tiny'));
        mockReadabilityParse.mockReturnValueOnce(null);
        // Jina returns good content
        mockRequestUrl.mockResolvedValueOnce({
            text: 'Title: Jina Result\nURL Source: https://example.com\nMarkdown Content:\n' + 'D'.repeat(200),
            headers: {},
        });

        const result = await fetchArticle('https://example.com/spa-page');

        expect(result.success).toBe(true);
        expect(result.content?.title).toBe('Jina Result');
        // 1 direct + 1 Jina (no retry since extraction failure is not retryable HTTP error)
        expect(mockRequestUrl).toHaveBeenCalledTimes(2);
        expect(mockRequestUrl.mock.calls[1][0].url).toBe('https://r.jina.ai/https://example.com/spa-page');
    });

    it('returns requiresPdfFallback when both direct and Jina fail', async () => {
        // Direct: 403
        mockRequestUrl.mockRejectedValueOnce(new Error('status 403'));
        // Retry: also 403
        mockRequestUrl.mockRejectedValueOnce(new Error('status 403'));
        // Jina: also fails
        mockRequestUrl.mockRejectedValueOnce(new Error('Jina timeout'));

        const result = await fetchArticle('https://example.com/blocked');

        expect(result.success).toBe(false);
        expect(result.requiresPdfFallback).toBe(true);
    });

    it('rejects Jina result that looks like a blocker page', async () => {
        // Direct: extraction fails
        mockRequestUrl.mockResolvedValueOnce(makeHtmlResponse('tiny'));
        mockReadabilityParse.mockReturnValueOnce(null);
        // Jina: returns blocker page
        mockRequestUrl.mockResolvedValueOnce({
            text: 'Please enable JavaScript. Checking your browser before accessing this page. Access denied for automated requests.',
            headers: {},
        });

        const result = await fetchArticle('https://example.com/protected');

        expect(result.success).toBe(false);
    });

    it('rejects Jina result with insufficient content after parsing', async () => {
        // Direct: extraction fails
        mockRequestUrl.mockResolvedValueOnce(makeHtmlResponse('tiny'));
        mockReadabilityParse.mockReturnValueOnce(null);
        // Jina: returns content but after stripping headers, too short
        mockRequestUrl.mockResolvedValueOnce({
            text: 'Title: Short\nURL Source: https://example.com\nMarkdown Content:\nHi',
            headers: {},
        });

        const result = await fetchArticle('https://example.com/empty');

        expect(result.success).toBe(false);
    });
});
