/**
 * Web Content Service
 * Fetches and extracts article content from URLs using Readability,
 * with retry on transient failures and Jina Reader fallback for
 * JavaScript-rendered pages (Next.js, SPAs, anti-bot protected sites).
 *
 * Extraction chain:
 * 1. Direct fetch + Readability (static HTML)
 * 2. Retry with modern headers + 1.5s delay (transient 403/429/5xx)
 * 3. Jina Reader fallback via r.jina.ai (JS-rendered, anti-bot)
 * 4. Return requiresPdfFallback (last resort)
 */

import { requestUrl } from 'obsidian';
import { Readability } from '@mozilla/readability';
import { validateUrl, isPdfUrl } from '../utils/urlValidator';
import { htmlToMarkdown, cleanMarkdown, ExtractedLink, extractLinks } from '../utils/htmlToMarkdown';
import { chunkContentSync } from '../utils/textChunker';
import { logger } from '../utils/logger';

export interface WebContent {
    title: string;
    content: string;        // Markdown content with links preserved
    textContent: string;    // Plain text (for token counting)
    excerpt: string;
    byline: string | null;
    siteName: string | null;
    url: string;
    fetchedAt: Date;
    links: ExtractedLink[];
}

export interface WebFetchResult {
    success: boolean;
    content?: WebContent;
    error?: string;
    requiresPdfFallback?: boolean;
    isPdfUrl?: boolean;
}

// =========================================================================
// Headers
// =========================================================================

const DEFAULT_HEADERS: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
};

const MODERN_HEADERS: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
};

// =========================================================================
// HTML Parsing & Extraction
// =========================================================================

/**
 * Parse HTML string into a Document using browser's DOMParser
 */
function parseHTML(html: string, baseUrl: string): Document {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Set base URL for relative links
    const base = doc.createElement('base');
    base.href = baseUrl;
    doc.head.insertBefore(base, doc.head.firstChild);

    return doc;
}

/**
 * Build a successful WebFetchResult
 */
function buildSuccessResult(url: string, opts: {
    title: string; markdown: string; textContent: string;
    excerpt?: string; byline?: string | null; siteName?: string | null;
    links?: ExtractedLink[];
}): WebFetchResult {
    return {
        success: true,
        content: {
            title: opts.title, content: opts.markdown, textContent: opts.textContent,
            excerpt: opts.excerpt || '', byline: opts.byline ?? null,
            siteName: opts.siteName ?? null, url, fetchedAt: new Date(),
            links: opts.links || [],
        },
    };
}

/**
 * Fallback content extraction when Readability fails.
 * Tries <article>, <main>, then stripped <body> text.
 */
function fallbackExtract(doc: Document): { text: string; html: string; method: string } | null {
    // Try semantic containers first
    for (const selector of ['article', 'main', '[role="main"]']) {
        const el = doc.querySelector(selector);
        if (el?.textContent && el.textContent.trim().length >= 100) {
            return { text: el.textContent.trim(), html: el.innerHTML, method: selector };
        }
    }

    // Last resort: strip scripts/styles from body and use raw text
    const clone = doc.body?.cloneNode(true) as HTMLElement | null;
    if (!clone) return null;
    clone.querySelectorAll('script, style, nav, header, footer').forEach(el => el.remove());
    const text = clone.textContent?.trim() || '';
    if (text.length >= 200) {
        return { text, html: clone.innerHTML, method: 'body-stripped' };
    }

    return null;
}

/**
 * Check content-type header and return early failure for non-HTML responses.
 * Returns null if content-type is acceptable (HTML or missing).
 */
function checkContentType(headers: Record<string, string>): WebFetchResult | null {
    const contentType = Object.entries(headers)
        .find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';

    if (contentType.includes('application/pdf')) {
        return { success: false, error: 'URL returns a PDF file', isPdfUrl: true, requiresPdfFallback: true };
    }
    // If content-type is present but not HTML, reject. If missing, try parsing anyway.
    if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
        return { success: false, error: `URL does not return HTML content (got ${contentType})`, requiresPdfFallback: true };
    }
    return null;
}

/**
 * Extract content from a parsed HTML document using Readability with fallback.
 */
function extractContent(doc: Document, validUrl: string): WebFetchResult {
    const reader = new Readability(doc);
    const article = reader.parse();

    logger.debug('Research', 'Readability result:', {
        hasArticle: !!article,
        title: article?.title,
        textContentLength: article?.textContent?.length || 0,
        htmlContentLength: article?.content?.length || 0,
    });

    // Readability succeeded
    if (article?.textContent && article.textContent.length >= 100) {
        const md = article.content ? cleanMarkdown(htmlToMarkdown(article.content)) : article.textContent;
        return buildSuccessResult(validUrl, {
            title: article.title || 'Untitled', markdown: md, textContent: article.textContent,
            excerpt: article.excerpt || '', byline: article.byline, siteName: article.siteName,
            links: article.content ? extractLinks(article.content) : [],
        });
    }

    // Readability failed — try fallback
    const fallback = fallbackExtract(doc);
    logger.debug('Research', 'Fallback extraction:', {
        method: fallback?.method, textLength: fallback?.text.length || 0,
    });

    if (fallback && fallback.text.length >= 100) {
        const title = doc.querySelector('title')?.textContent?.trim()
            || doc.querySelector('meta[property="og:title"]')?.getAttribute('content')
            || 'Untitled';
        const md = fallback.html ? cleanMarkdown(htmlToMarkdown(fallback.html)) : fallback.text;
        return buildSuccessResult(validUrl, {
            title, markdown: md, textContent: fallback.text,
            links: fallback.html ? extractLinks(fallback.html) : [],
        });
    }

    return { success: false, error: 'Could not extract article content (may require JavaScript or login)', requiresPdfFallback: true };
}

// =========================================================================
// Retry & Error Classification
// =========================================================================

/** Error patterns that suggest the URL may work as PDF or in a browser */
const FALLBACK_PATTERNS = ['403', '401', 'paywall', 'blocked', 'CORS', 'timeout', 'net::', 'ECONNREFUSED'];

/**
 * Check if an error is transient and worth retrying with different headers.
 * Uses word-boundary regex to avoid false matches (e.g. "500 chars").
 */
export function isRetryableError(error?: string): boolean {
    if (!error) return false;
    return /\b(403|429|5\d{2})\b/.test(error)
        || /\b(timeout|ECONN|ECONNRESET|ECONNREFUSED|net::)\b/i.test(error);
}

/**
 * Attempt a direct HTTP fetch + Readability extraction with given headers.
 */
async function attemptDirectFetch(url: string, headers: Record<string, string>): Promise<WebFetchResult> {
    try {
        const response = await requestUrl({ url, method: 'GET', headers });

        const ctResult = checkContentType(response.headers);
        if (ctResult) return ctResult;

        const doc = parseHTML(response.text, url);
        return extractContent(doc, url);

    } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        const requiresFallback = FALLBACK_PATTERNS.some(p => msg.includes(p));
        return { success: false, error: `Failed to fetch: ${msg}`, requiresPdfFallback: requiresFallback };
    }
}

// =========================================================================
// Jina Reader Fallback
// =========================================================================

/** Blocker/challenge page patterns — require 2+ matches to avoid false positives */
const BLOCKER_PATTERNS = [
    'enable javascript', 'please enable cookies', 'access denied',
    'checking your browser', 'just a moment', 'verify you are human',
    'captcha', 'bot detection', 'unusual traffic',
];

/**
 * Detect challenge/blocker pages that shouldn't be treated as article content.
 */
export function looksLikeBlockerPage(text: string): boolean {
    const lower = text.toLowerCase().slice(0, 2000);
    const matchCount = BLOCKER_PATTERNS.filter(p => lower.includes(p)).length;
    return matchCount >= 2;
}

/**
 * Parse Jina Reader response format.
 * Jina often returns: Title: ...\nURL Source: ...\nMarkdown Content:\n...
 * Falls back to # heading extraction if no structured headers found.
 */
export function parseJinaResponse(text: string): { title: string; content: string } {
    let title = 'Untitled';
    let content = text;

    // Extract title from Jina header
    const titleMatch = text.match(/^Title:\s*(.+)/m);
    if (titleMatch) title = titleMatch[1].trim();

    // Strip boilerplate header lines before the actual markdown
    const contentStart = text.search(/^Markdown Content:\s*$/m);
    if (contentStart !== -1) {
        content = text.slice(contentStart).replace(/^Markdown Content:\s*\n?/, '');
    } else {
        // Fallback: strip Title:/URL Source: lines
        content = text
            .replace(/^Title:\s*.+\n?/m, '')
            .replace(/^URL Source:\s*.+\n?/m, '')
            .trim();
    }

    // If no Title: header, try # heading from content
    if (title === 'Untitled') {
        const headingMatch = content.match(/^#\s+(.+)/m);
        if (headingMatch) title = headingMatch[1].trim();
    }

    return { title, content: content.trim() };
}

/**
 * Fetch article content via Jina Reader proxy (r.jina.ai).
 * Jina handles JavaScript rendering, anti-bot protection, and returns clean markdown.
 * Free, no API key required.
 */
async function fetchViaJina(url: string): Promise<WebFetchResult> {
    const jinaUrl = `https://r.jina.ai/${url}`;
    const response = await requestUrl({
        url: jinaUrl,
        method: 'GET',
        headers: { 'Accept': 'text/markdown', 'X-No-Cache': 'true' },
    });

    const raw = response.text?.trim();
    if (!raw || raw.length < 100) {
        return { success: false, error: 'Jina Reader returned insufficient content' };
    }

    if (looksLikeBlockerPage(raw)) {
        return { success: false, error: 'Jina Reader returned a blocker/challenge page' };
    }

    const { title, content } = parseJinaResponse(raw);
    if (content.length < 100) {
        return { success: false, error: 'Jina Reader returned insufficient content after parsing' };
    }

    const markdown = cleanMarkdown(content);
    const textContent = content.replace(/[#*\[\]()_`>|-]/g, ' ').replace(/\s+/g, ' ').trim();

    return buildSuccessResult(url, { title, markdown, textContent });
}

// =========================================================================
// Main Entry Point
// =========================================================================

/**
 * Fetch and extract article content from URL.
 *
 * Uses a 3-tier extraction chain:
 * 1. Direct fetch + Readability
 * 2. Retry with modern headers (on transient errors)
 * 3. Jina Reader fallback (handles JS-rendered pages)
 */
export async function fetchArticle(url: string): Promise<WebFetchResult> {
    const validation = validateUrl(url);
    if (!validation.valid) {
        return { success: false, error: validation.error || 'Invalid URL' };
    }

    const validUrl = validation.url!;

    if (isPdfUrl(validUrl)) {
        return { success: false, error: 'URL points to a PDF file', isPdfUrl: true, requiresPdfFallback: true };
    }

    // Attempt 1: Direct fetch with standard headers
    let result = await attemptDirectFetch(validUrl, DEFAULT_HEADERS);
    if (result.success) return result;

    // Attempt 2: Retry with modern headers on retryable errors
    if (isRetryableError(result.error)) {
        logger.debug('Research', 'Retrying fetch with modern headers:', validUrl);
        await new Promise(r => setTimeout(r, 1500));
        result = await attemptDirectFetch(validUrl, MODERN_HEADERS);
        if (result.success) return result;
    }

    // Attempt 3: Jina Reader fallback (handles JS rendering, anti-bot)
    try {
        logger.debug('Research', 'Trying Jina Reader fallback:', validUrl);
        const jinaResult = await fetchViaJina(validUrl);
        if (jinaResult.success) return jinaResult;
    } catch (e) {
        logger.debug('Research', 'Jina Reader failed:', e);
    }

    return result;
}

/**
 * Open URL in default browser (for PDF fallback)
 */
export function openInBrowser(url: string): void {
    if (typeof require !== 'undefined') {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { shell } = require('electron');
            shell.openExternal(url);
            return;
        } catch {
            // Electron not available, fall through to window.open
        }
    }
    window.open(url, '_blank');
}

/**
 * Split content into chunks for map-reduce summarization.
 * Delegates to chunkContentSync which uses paragraph → sentence → word boundary
 * hierarchy (no mid-word splits).
 */
export function chunkContent(content: string, maxCharsPerChunk: number): string[] {
    return chunkContentSync(content, maxCharsPerChunk);
}
