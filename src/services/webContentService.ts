/**
 * Web Content Service
 * Fetches and extracts article content from URLs using Readability
 */

import { requestUrl } from 'obsidian';
import { Readability } from '@mozilla/readability';
import { validateUrl, isPdfUrl } from '../utils/urlValidator';
import { htmlToMarkdown, cleanMarkdown, ExtractedLink, extractLinks } from '../utils/htmlToMarkdown';

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
 * Fetch and extract article content from URL
 */
export async function fetchArticle(url: string): Promise<WebFetchResult> {
    // Validate URL first (SSRF protection)
    const validation = validateUrl(url);
    if (!validation.valid) {
        return {
            success: false,
            error: validation.error || 'Invalid URL',
        };
    }

    const validUrl = validation.url!;

    // Check if this is a direct PDF URL
    if (isPdfUrl(validUrl)) {
        return {
            success: false,
            error: 'URL points to a PDF file',
            isPdfUrl: true,
            requiresPdfFallback: true,
        };
    }

    try {
        // Fetch HTML via Obsidian's requestUrl (bypasses CORS)
        const response = await requestUrl({
            url: validUrl,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
            },
        });

        // Check for non-HTML responses
        const contentType = response.headers['content-type'] || '';
        if (contentType.includes('application/pdf')) {
            return {
                success: false,
                error: 'URL returns a PDF file',
                isPdfUrl: true,
                requiresPdfFallback: true,
            };
        }

        if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
            return {
                success: false,
                error: `URL does not return HTML content (got ${contentType})`,
                requiresPdfFallback: true,
            };
        }

        // Parse HTML with browser's DOMParser
        const doc = parseHTML(response.text, validUrl);

        // Extract article with Readability
        const reader = new Readability(doc);
        const article = reader.parse();

        if (!article || !article.textContent || article.textContent.length < 100) {
            return {
                success: false,
                error: 'Could not extract article content (may require JavaScript or login)',
                requiresPdfFallback: true,
            };
        }

        // Convert HTML content to Markdown (preserves links)
        const markdownContent = article.content
            ? cleanMarkdown(htmlToMarkdown(article.content))
            : article.textContent;

        // Extract links for reference
        const links = article.content ? extractLinks(article.content) : [];

        return {
            success: true,
            content: {
                title: article.title || 'Untitled',
                content: markdownContent,
                textContent: article.textContent,
                excerpt: article.excerpt || '',
                byline: article.byline ?? null,
                siteName: article.siteName ?? null,
                url: validUrl,
                fetchedAt: new Date(),
                links,
            },
        };

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';

        // Determine if this is a recoverable error that suggests PDF fallback
        const requiresFallback =
            errorMessage.includes('403') ||
            errorMessage.includes('401') ||
            errorMessage.includes('paywall') ||
            errorMessage.includes('blocked') ||
            errorMessage.includes('CORS') ||
            errorMessage.includes('timeout') ||
            errorMessage.includes('net::') ||
            errorMessage.includes('ECONNREFUSED');

        return {
            success: false,
            error: `Failed to fetch: ${errorMessage}`,
            requiresPdfFallback: requiresFallback,
        };
    }
}

/**
 * Open URL in default browser (for PDF fallback)
 */
export function openInBrowser(url: string): void {
    // Use Electron's shell.openExternal if available (Obsidian desktop)
    // Falls back to window.open for other environments
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
 * Split content into chunks for map-reduce summarization
 */
export function chunkContent(content: string, maxCharsPerChunk: number): string[] {
    const chunks: string[] = [];

    // Try to split at paragraph boundaries
    const paragraphs = content.split(/\n\n+/);
    let currentChunk = '';

    for (const paragraph of paragraphs) {
        // If adding this paragraph exceeds the limit
        if (currentChunk.length + paragraph.length + 2 > maxCharsPerChunk) {
            // Save current chunk if not empty
            if (currentChunk.trim()) {
                chunks.push(currentChunk.trim());
            }

            // If paragraph itself is too large, split it further
            if (paragraph.length > maxCharsPerChunk) {
                const sentences = paragraph.split(/(?<=[.!?])\s+/);
                currentChunk = '';

                for (const sentence of sentences) {
                    if (currentChunk.length + sentence.length + 1 > maxCharsPerChunk) {
                        if (currentChunk.trim()) {
                            chunks.push(currentChunk.trim());
                        }
                        // If sentence is still too large, hard split
                        if (sentence.length > maxCharsPerChunk) {
                            for (let i = 0; i < sentence.length; i += maxCharsPerChunk) {
                                chunks.push(sentence.substring(i, i + maxCharsPerChunk));
                            }
                            currentChunk = '';
                        } else {
                            currentChunk = sentence;
                        }
                    } else {
                        currentChunk += (currentChunk ? ' ' : '') + sentence;
                    }
                }
            } else {
                currentChunk = paragraph;
            }
        } else {
            currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
        }
    }

    // Don't forget the last chunk
    if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
    }

    return chunks;
}
