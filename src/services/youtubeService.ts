/**
 * YouTube Transcript Service
 * Fetches captions/transcripts from YouTube videos
 */

import { requestUrl } from 'obsidian';

export interface YouTubeVideoInfo {
    videoId: string;
    title: string;
    channelName: string;
    duration?: string;
}

export interface YouTubeTranscriptResult {
    success: boolean;
    transcript?: string;
    videoInfo?: YouTubeVideoInfo;
    error?: string;
}

interface TranscriptSegment {
    text: string;
    start: number;
    duration: number;
}

/**
 * Extract video ID from various YouTube URL formats
 */
export function extractYouTubeVideoId(url: string): string | null {
    const patterns = [
        // Standard watch URL: https://www.youtube.com/watch?v=VIDEO_ID
        /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
        // Short URL: https://youtu.be/VIDEO_ID
        /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
        // Embed URL: https://www.youtube.com/embed/VIDEO_ID
        /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
        // Mobile URL: https://m.youtube.com/watch?v=VIDEO_ID
        /(?:m\.youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
        // Shorts URL: https://www.youtube.com/shorts/VIDEO_ID
        /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    ];

    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match && match[1]) {
            return match[1];
        }
    }

    return null;
}

/**
 * Check if URL is a YouTube URL
 */
export function isYouTubeUrl(url: string): boolean {
    return extractYouTubeVideoId(url) !== null;
}

/**
 * Fetch video info from YouTube page
 */
async function fetchVideoInfo(videoId: string): Promise<YouTubeVideoInfo> {
    try {
        const response = await requestUrl({
            url: `https://www.youtube.com/watch?v=${videoId}`,
            method: 'GET',
        });

        const html = response.text;

        // Extract title from meta tag or title element
        let title = 'Unknown Title';
        const titleMatch = html.match(/<meta name="title" content="([^"]+)"/) ||
                          html.match(/<title>([^<]+)<\/title>/);
        if (titleMatch) {
            title = titleMatch[1]
                .replace(' - YouTube', '')
                .replace(/&amp;/g, '&')
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'");
        }

        // Extract channel name
        let channelName = 'Unknown Channel';
        const channelMatch = html.match(/"ownerChannelName":"([^"]+)"/) ||
                            html.match(/<link itemprop="name" content="([^"]+)">/);
        if (channelMatch) {
            channelName = channelMatch[1];
        }

        return {
            videoId,
            title,
            channelName,
        };
    } catch (error) {
        return {
            videoId,
            title: 'Unknown Title',
            channelName: 'Unknown Channel',
        };
    }
}

/**
 * Fetch transcript from YouTube
 * Uses the innertube API to get captions
 */
export async function fetchYouTubeTranscript(url: string): Promise<YouTubeTranscriptResult> {
    const videoId = extractYouTubeVideoId(url);

    if (!videoId) {
        return {
            success: false,
            error: 'Invalid YouTube URL. Could not extract video ID.',
        };
    }

    try {
        // Fetch the video page to get caption track info
        const response = await requestUrl({
            url: `https://www.youtube.com/watch?v=${videoId}`,
            method: 'GET',
        });

        const html = response.text;

        // Look for captions in the page data
        const captionTracksMatch = html.match(/"captionTracks":\s*(\[.*?\])/);

        if (!captionTracksMatch) {
            return {
                success: false,
                error: 'No captions available for this video. YouTube captions must be enabled.',
            };
        }

        let captionTracks: any[];
        try {
            captionTracks = JSON.parse(captionTracksMatch[1]);
        } catch {
            return {
                success: false,
                error: 'Failed to parse caption data.',
            };
        }

        if (!captionTracks || captionTracks.length === 0) {
            return {
                success: false,
                error: 'No captions available for this video.',
            };
        }

        // Prefer English captions, fall back to first available
        let captionTrack = captionTracks.find((t: any) =>
            t.languageCode === 'en' || t.languageCode?.startsWith('en')
        );

        if (!captionTrack) {
            // Try to find auto-generated captions
            captionTrack = captionTracks.find((t: any) =>
                t.kind === 'asr' || t.name?.simpleText?.includes('auto')
            );
        }

        if (!captionTrack) {
            captionTrack = captionTracks[0];
        }

        const captionUrl = captionTrack.baseUrl;

        if (!captionUrl) {
            return {
                success: false,
                error: 'Caption URL not found.',
            };
        }

        // Fetch the actual transcript
        const transcriptResponse = await requestUrl({
            url: captionUrl,
            method: 'GET',
        });

        const transcriptXml = transcriptResponse.text;

        // Parse XML transcript
        const segments = parseTranscriptXml(transcriptXml);

        if (segments.length === 0) {
            return {
                success: false,
                error: 'Failed to parse transcript.',
            };
        }

        // Convert segments to readable text
        const transcript = formatTranscript(segments);

        // Get video info
        const videoInfo = await fetchVideoInfo(videoId);

        return {
            success: true,
            transcript,
            videoInfo,
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return {
            success: false,
            error: `Failed to fetch transcript: ${errorMessage}`,
        };
    }
}

/**
 * Parse YouTube transcript XML format
 */
function parseTranscriptXml(xml: string): TranscriptSegment[] {
    const segments: TranscriptSegment[] = [];

    // Match <text> elements with start and dur attributes
    const textRegex = /<text start="([^"]+)" dur="([^"]+)"[^>]*>([^<]*)<\/text>/g;
    let match;

    while ((match = textRegex.exec(xml)) !== null) {
        const start = parseFloat(match[1]);
        const duration = parseFloat(match[2]);
        let text = match[3];

        // Decode HTML entities
        text = text
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&apos;/g, "'")
            .replace(/\n/g, ' ')
            .trim();

        if (text) {
            segments.push({ text, start, duration });
        }
    }

    return segments;
}

/**
 * Format transcript segments into readable text
 */
function formatTranscript(segments: TranscriptSegment[]): string {
    // Group segments into paragraphs (roughly every 30 seconds or on natural breaks)
    const paragraphs: string[] = [];
    let currentParagraph: string[] = [];
    let lastEnd = 0;

    for (const segment of segments) {
        // Start new paragraph if there's a significant gap (>2 seconds) or every ~30 seconds
        if (segment.start - lastEnd > 2 || (currentParagraph.length > 0 && segment.start > lastEnd + 30)) {
            if (currentParagraph.length > 0) {
                paragraphs.push(currentParagraph.join(' '));
                currentParagraph = [];
            }
        }

        currentParagraph.push(segment.text);
        lastEnd = segment.start + segment.duration;
    }

    // Add remaining text
    if (currentParagraph.length > 0) {
        paragraphs.push(currentParagraph.join(' '));
    }

    return paragraphs.join('\n\n');
}

/**
 * Get YouTube video URL from video ID
 */
export function getYouTubeUrl(videoId: string): string {
    return `https://www.youtube.com/watch?v=${videoId}`;
}

/**
 * Summarize YouTube video using Gemini's native YouTube understanding
 * This is more reliable than transcript scraping as Gemini can process videos directly
 */
export async function summarizeYouTubeWithGemini(
    url: string,
    apiKey: string,
    prompt: string,
    model: string = 'gemini-2.0-flash',
    timeoutMs: number = 120000
): Promise<{ success: boolean; content?: string; videoInfo?: YouTubeVideoInfo; error?: string }> {
    const videoId = extractYouTubeVideoId(url);

    if (!videoId) {
        return {
            success: false,
            error: 'Invalid YouTube URL. Could not extract video ID.',
        };
    }

    if (!apiKey) {
        return {
            success: false,
            error: 'Gemini API key required for YouTube processing. Configure in settings.',
        };
    }

    try {
        // Fetch video info for metadata
        const videoInfo = await fetchVideoInfo(videoId);

        // Build Gemini request with YouTube URL
        // Gemini can process YouTube URLs directly via its File API or inline
        const requestBody = {
            contents: [
                {
                    parts: [
                        {
                            fileData: {
                                mimeType: 'video/youtube',
                                fileUri: url
                            }
                        },
                        {
                            text: prompt
                        }
                    ]
                }
            ],
            generationConfig: {
                maxOutputTokens: 4096
            }
        };

        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

        // Create timeout promise
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('Request timeout')), timeoutMs);
        });

        // Make request with timeout
        const responsePromise = requestUrl({
            url: endpoint,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody),
            throw: false
        });

        const response = await Promise.race([responsePromise, timeoutPromise]);

        if (response.status < 200 || response.status >= 300) {
            const errorText = response.text;
            try {
                const errorJson = JSON.parse(errorText);
                throw new Error(errorJson.error?.message || `API error: ${response.status}`);
            } catch {
                throw new Error(`Gemini API error: ${response.status}`);
            }
        }

        const data = JSON.parse(response.text);

        // Extract content from Gemini response
        const content = data.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!content) {
            throw new Error('No content in Gemini response');
        }

        return {
            success: true,
            content,
            videoInfo,
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return {
            success: false,
            error: `Gemini YouTube processing failed: ${errorMessage}`,
        };
    }
}
