/**
 * Resource Search Service
 * Searches for resources using DuckDuckGo and YouTube APIs
 */

import { requestUrl } from 'obsidian';
import { normalizeUrl } from '../utils/urlUtils';
import { logger } from '../utils/logger';

export interface ResourceSearchResult {
    title: string;
    url: string;
    description: string;
    source: 'youtube' | 'web';
    thumbnail?: string;
}

/**
 * Search for resources across multiple sources
 */
export async function searchResources(
    searchTerms: string[],
    userQuery: string
): Promise<ResourceSearchResult[]> {
    const results: ResourceSearchResult[] = [];

    // Determine if user specifically wants YouTube or web content
    const wantsYouTube = userQuery.toLowerCase().includes('youtube') ||
        userQuery.toLowerCase().includes('video') ||
        userQuery.toLowerCase().includes('tutorial');

    const wantsArticles = userQuery.toLowerCase().includes('article') ||
        userQuery.toLowerCase().includes('blog') ||
        userQuery.toLowerCase().includes('read');

    // Search YouTube if user wants videos or didn't specify
    if (wantsYouTube || !wantsArticles) {
        for (const term of searchTerms.slice(0, 2)) {
            try {
                const youtubeResults = await searchYouTube(term);
                results.push(...youtubeResults);
            } catch (error) {
                logger.warn('Research', `YouTube search failed for term: ${term}`, error);
            }
        }
    }

    // Search web if user wants articles or didn't specify
    if (wantsArticles || !wantsYouTube) {
        for (const term of searchTerms.slice(0, 2)) {
            try {
                const webResults = await searchDuckDuckGo(term);
                results.push(...webResults);
            } catch (error) {
                logger.warn('Research', `DuckDuckGo search failed for term: ${term}`, error);
            }
        }
    }

    // Remove duplicates based on URL
    const uniqueResults = removeDuplicates(results);

    // Limit total results
    return uniqueResults.slice(0, 10);
}

/**
 * Search YouTube using the public search page (no API key needed)
 * This scrapes the search results page
 */
async function searchYouTube(query: string): Promise<ResourceSearchResult[]> {
    const results: ResourceSearchResult[] = [];

    try {
        const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;

        const response = await requestUrl({
            url: searchUrl,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
            },
        });

        const html = response.text;

        // Extract video data from the page's initial data
        // YouTube embeds video data in a script tag as JSON
        const dataMatch = html.match(/var ytInitialData = ({.*?});/s);

        if (dataMatch) {
            try {
                const data = JSON.parse(dataMatch[1]);
                const contents = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents;

                if (contents) {
                    for (const section of contents) {
                        const items = section?.itemSectionRenderer?.contents;
                        if (items) {
                            for (const item of items) {
                                const videoRenderer = item?.videoRenderer;
                                if (videoRenderer) {
                                    const videoId = videoRenderer.videoId;
                                    const title = videoRenderer.title?.runs?.[0]?.text;
                                    const description = videoRenderer.descriptionSnippet?.runs?.map((r: { text: string }) => r.text).join('') || '';

                                    if (videoId && title) {
                                        results.push({
                                            title,
                                            url: `https://www.youtube.com/watch?v=${videoId}`,
                                            description: description.substring(0, 200),
                                            source: 'youtube',
                                            thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`
                                        });
                                    }

                                    if (results.length >= 3) break;
                                }
                            }
                        }
                        if (results.length >= 3) break;
                    }
                }
            } catch (parseError) {
                logger.warn('Research', 'Failed to parse YouTube data:', parseError);
            }
        }

        // Fallback: Try regex extraction if JSON parsing fails
        if (results.length === 0) {
            const videoIdMatches = html.matchAll(/watch\?v=([a-zA-Z0-9_-]{11})/g);
            const seenIds = new Set<string>();

            for (const match of videoIdMatches) {
                const videoId = match[1];
                if (!seenIds.has(videoId)) {
                    seenIds.add(videoId);

                    // Try to find the title near this video ID
                    const titleMatch = html.match(new RegExp(`"videoId":"${videoId}"[^}]*"title":\\{"runs":\\[\\{"text":"([^"]+)"`));
                    const title = titleMatch ? titleMatch[1] : `YouTube Video (${videoId})`;

                    results.push({
                        title,
                        url: `https://www.youtube.com/watch?v=${videoId}`,
                        description: '',
                        source: 'youtube',
                        thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`
                    });

                    if (results.length >= 3) break;
                }
            }
        }
    } catch (error) {
        logger.warn('Research', 'YouTube search error:', error);
    }

    return results;
}

/**
 * Search using DuckDuckGo HTML (no API key needed)
 */
async function searchDuckDuckGo(query: string): Promise<ResourceSearchResult[]> {
    const results: ResourceSearchResult[] = [];

    try {
        // Use DuckDuckGo's HTML search
        const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

        const response = await requestUrl({
            url: searchUrl,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
        });

        const html = response.text;

        // Parse DuckDuckGo HTML results
        // Results are in <a class="result__a"> tags
        const resultMatches = html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g);

        for (const match of resultMatches) {
            let url = match[1];
            const title = match[2].trim();

            // DuckDuckGo uses redirect URLs, need to extract actual URL
            if (url.includes('uddg=')) {
                const uddgMatch = url.match(/uddg=([^&]+)/);
                if (uddgMatch) {
                    url = decodeURIComponent(uddgMatch[1]);
                }
            }

            // Skip if it's a YouTube result (we handle those separately)
            if (url.includes('youtube.com') || url.includes('youtu.be')) {
                continue;
            }

            // Try to find description
            const descMatch = html.match(new RegExp(`${escapeRegex(title)}[^<]*</a>[^<]*<[^>]+class="result__snippet"[^>]*>([^<]+)`));
            const description = descMatch ? descMatch[1].trim() : '';

            if (url && title && url.startsWith('http')) {
                results.push({
                    title,
                    url,
                    description: description.substring(0, 200),
                    source: 'web'
                });
            }

            if (results.length >= 5) break;
        }
    } catch (error) {
        logger.warn('Research', 'DuckDuckGo search error:', error);
    }

    return results;
}

/**
 * Escape special regex characters
 */
function escapeRegex(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Remove duplicate results based on URL (uses shared normalizeUrl from urlUtils)
 */
function removeDuplicates(results: ResourceSearchResult[]): ResourceSearchResult[] {
    const seen = new Set<string>();
    return results.filter(result => {
        const normalized = normalizeUrl(result.url);
        if (seen.has(normalized)) return false;
        seen.add(normalized);
        return true;
    });
}
