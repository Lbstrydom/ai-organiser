/**
 * YouTube Service
 * Unified service for YouTube video processing with Gemini
 * Supports transcription and summarization with consistent interface
 */

import { requestUrl } from 'obsidian';
import { logger } from '../utils/logger';

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface YouTubeVideoInfo {
    videoId: string;
    title: string;
    channelName: string;
    duration?: string;
}

export interface TranscriptSegment {
    text: string;
    start: number;
    duration: number;
}

export interface YouTubeTranscriptResult {
    success: boolean;
    transcript?: string;
    segments?: TranscriptSegment[];
    videoInfo?: YouTubeVideoInfo;
    error?: string;
}

export interface YouTubeSummaryResult {
    success: boolean;
    content?: string;
    videoInfo?: YouTubeVideoInfo;
    error?: string;
}

/**
 * Unified result type for all YouTube+Gemini operations
 */
export interface YouTubeGeminiResult {
    success: boolean;
    content?: string;           // Summary content (for summarize mode)
    transcript?: string;        // Formatted transcript text
    segments?: TranscriptSegment[];  // Raw transcript segments with timestamps
    videoInfo?: YouTubeVideoInfo;
    error?: string;
}

/**
 * Configuration for YouTube+Gemini operations
 * Use this interface throughout the codebase for consistency
 */
export interface YouTubeGeminiConfig {
    url: string;
    apiKey: string;
    model?: string;
    timeoutMs?: number;
}

/**
 * Mode-specific options for YouTube processing
 */
export interface YouTubeProcessOptions {
    mode: 'transcribe' | 'summarize';
    prompt?: string;  // Required for summarize mode, ignored for transcribe
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MODEL = 'gemini-3-flash-preview';
const DEFAULT_TIMEOUT_MS = 180000;  // 3 minutes
const TRANSCRIBE_MAX_TOKENS = 16384;  // High for full transcripts
const SUMMARIZE_MAX_TOKENS = 8192;    // Moderate for summaries

const TRANSCRIPTION_PROMPT = `You are a professional transcription assistant. Watch this YouTube video carefully and generate a complete, accurate transcript.

IMPORTANT INSTRUCTIONS:
1. Transcribe ALL spoken content from the video
2. Include timestamps for each segment (approximate times are fine)
3. Output ONLY valid JSON - no markdown, no explanation, no extra text
4. Use this exact JSON format:

[
  {"text": "First spoken segment here", "start": 0, "duration": 5},
  {"text": "Second spoken segment here", "start": 5, "duration": 4}
]

Where:
- "text" is the transcribed speech (clean, readable text)
- "start" is the approximate start time in seconds
- "duration" is the approximate duration in seconds

Transcribe the complete video now. Output ONLY the JSON array, nothing else.`;

// ============================================================================
// URL Utilities
// ============================================================================

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
        // Live URL: https://www.youtube.com/live/VIDEO_ID
        /(?:youtube\.com\/live\/)([a-zA-Z0-9_-]{11})/,
    ];

    for (const pattern of patterns) {
        const result = pattern.exec(url);
        if (result?.[1]) {
            return result[1];
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
 * Get YouTube video URL from video ID
 */
export function getYouTubeUrl(videoId: string): string {
    return `https://www.youtube.com/watch?v=${videoId}`;
}

// ============================================================================
// Video Info Fetching
// ============================================================================

/**
 * Fetch video info from YouTube page (title, channel name)
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
        const titlePattern = /<meta name="title" content="([^"]+)"|<title>([^<]+)<\/title>/;
        const titleMatch = titlePattern.exec(html);
        if (titleMatch) {
            title = (titleMatch[1] || titleMatch[2])
                .replace(' - YouTube', '')
                .replaceAll('&amp;', '&')
                .replaceAll('&quot;', '"')
                .replaceAll('&#39;', "'");
        }

        // Extract channel name
        let channelName = 'Unknown Channel';
        const channelPattern = /"ownerChannelName":"([^"]+)"|<link itemprop="name" content="([^"]+)">/;
        const channelMatch = channelPattern.exec(html);
        if (channelMatch) {
            channelName = channelMatch[1] || channelMatch[2];
        }

        return { videoId, title, channelName };
    } catch {
        return { videoId, title: 'Unknown Title', channelName: 'Unknown Channel' };
    }
}

// ============================================================================
// Transcript Parsing
// ============================================================================

/**
 * Parse Gemini's JSON transcript response
 */
function parseGeminiTranscriptResponse(content: string): TranscriptSegment[] {
    try {
        let jsonStr = content.trim();

        // Remove markdown code fences if present
        if (jsonStr.startsWith('```json')) {
            jsonStr = jsonStr.replace(/^```json\s*/, '').replace(/\s*```$/, '');
        } else if (jsonStr.startsWith('```')) {
            jsonStr = jsonStr.replace(/^```\s*/, '').replace(/\s*```$/, '');
        }

        // Find JSON array in the content
        const jsonPattern = /\[[\s\S]*\]/;
        const jsonMatch = jsonPattern.exec(jsonStr);
        if (jsonMatch) {
            jsonStr = jsonMatch[0];
        }

        const parsed = JSON.parse(jsonStr);

        if (!Array.isArray(parsed)) {
            logger.debug('Core', 'Gemini response is not an array');
            return [];
        }

        // Validate and convert to TranscriptSegment format
        const segments: TranscriptSegment[] = [];
        for (const item of parsed) {
            if (item.text && typeof item.text === 'string') {
                segments.push({
                    text: item.text.trim(),
                    start: typeof item.start === 'number' ? item.start : 0,
                    duration: typeof item.duration === 'number' ? item.duration : 5
                });
            }
        }

        return segments;
    } catch (error) {
        logger.error('Core', 'Failed to parse Gemini transcript JSON:', error);
        return [];
    }
}

/**
 * Parse YouTube transcript XML format (legacy, for caption scraping fallback)
 */
function parseTranscriptXml(xml: string): TranscriptSegment[] {
    const segments: TranscriptSegment[] = [];
    const textRegex = /<text start="([^"]+)" dur="([^"]+)"[^>]*>([^<]*)<\/text>/g;
    let match;

    while ((match = textRegex.exec(xml)) !== null) {
        const start = Number.parseFloat(match[1]);
        const duration = Number.parseFloat(match[2]);
        let text = match[3];

        // Decode HTML entities
        text = text
            .replaceAll('&amp;', '&')
            .replaceAll('&lt;', '<')
            .replaceAll('&gt;', '>')
            .replaceAll('&quot;', '"')
            .replaceAll('&#39;', "'")
            .replaceAll('&apos;', "'")
            .replaceAll('\n', ' ')
            .trim();

        if (text) {
            segments.push({ text, start, duration });
        }
    }

    return segments;
}

/**
 * Format transcript segments into readable paragraphed text
 */
function formatTranscript(segments: TranscriptSegment[]): string {
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

// ============================================================================
// Core Gemini API
// ============================================================================

/**
 * Make a request to Gemini API with video content
 * Internal function - use processYouTubeWithGemini for public API
 */
async function callGeminiWithVideo(
    videoUrl: string,
    prompt: string,
    apiKey: string,
    model: string,
    maxOutputTokens: number,
    timeoutMs: number
): Promise<{ success: boolean; content?: string; error?: string }> {
    const requestBody = {
        contents: [
            {
                parts: [
                    {
                        fileData: {
                            mimeType: 'video/mp4',
                            fileUri: videoUrl
                        }
                    },
                    {
                        text: prompt
                    }
                ]
            }
        ],
        generationConfig: {
            maxOutputTokens
        }
    };

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Request timeout')), timeoutMs);
    });

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
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!content) {
        throw new Error('No content in Gemini response');
    }

    return { success: true, content };
}

// ============================================================================
// Public API - Unified Processing
// ============================================================================

/**
 * Process YouTube video with Gemini - unified function for transcription and summarization
 *
 * Use this function throughout the codebase for consistent YouTube+Gemini operations.
 *
 * @example
 * // Transcription
 * const result = await processYouTubeWithGemini(
 *   { url, apiKey, model },
 *   { mode: 'transcribe' }
 * );
 *
 * @example
 * // Summarization
 * const result = await processYouTubeWithGemini(
 *   { url, apiKey, model },
 *   { mode: 'summarize', prompt: 'Summarize this video...' }
 * );
 */
export async function processYouTubeWithGemini(
    config: YouTubeGeminiConfig,
    options: YouTubeProcessOptions
): Promise<YouTubeGeminiResult> {
    const { url, apiKey, model = DEFAULT_MODEL, timeoutMs = DEFAULT_TIMEOUT_MS } = config;
    const { mode, prompt } = options;

    // Validate inputs
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
            error: `Gemini API key required for YouTube ${mode}. Configure in settings.`,
        };
    }

    if (mode === 'summarize' && !prompt) {
        return {
            success: false,
            error: 'Prompt is required for summarization mode.',
        };
    }

    try {
        logger.debug('Core', `${mode === 'transcribe' ? 'Transcribing' : 'Summarizing'} YouTube video with Gemini, videoId: ${videoId}`);

        // Fetch video info for metadata
        const videoInfo = await fetchVideoInfo(videoId);

        // Determine prompt and token limit based on mode
        const effectivePrompt = mode === 'transcribe' ? TRANSCRIPTION_PROMPT : prompt!;
        const maxTokens = mode === 'transcribe' ? TRANSCRIBE_MAX_TOKENS : SUMMARIZE_MAX_TOKENS;

        // Call Gemini API
        const geminiResult = await callGeminiWithVideo(
            url,
            effectivePrompt,
            apiKey,
            model,
            maxTokens,
            timeoutMs
        );

        if (!geminiResult.success || !geminiResult.content) {
            return {
                success: false,
                error: geminiResult.error || 'No content from Gemini',
            };
        }

        // Process result based on mode
        if (mode === 'transcribe') {
            const segments = parseGeminiTranscriptResponse(geminiResult.content);

            if (segments.length === 0) {
                logger.debug('Core', 'Failed to parse transcript segments from Gemini response');
                return {
                    success: false,
                    error: 'Failed to parse transcript from Gemini response',
                };
            }

            logger.debug('Core', `Parsed ${segments.length} transcript segments from Gemini`);

            return {
                success: true,
                transcript: formatTranscript(segments),
                segments,
                videoInfo,
            };
        } else {
            // Summarize mode
            return {
                success: true,
                content: geminiResult.content,
                videoInfo,
            };
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error('Core', `processYouTubeWithGemini (${mode}) error: ${errorMessage}`);
        return {
            success: false,
            error: `Gemini YouTube ${mode} failed: ${errorMessage}`,
        };
    }
}

// ============================================================================
// Public API - Convenience Functions
// ============================================================================

/**
 * Transcribe YouTube video using Gemini
 * Convenience wrapper around processYouTubeWithGemini
 */
export async function transcribeYouTubeWithGemini(
    url: string,
    apiKey: string,
    model: string = DEFAULT_MODEL,
    timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<YouTubeGeminiResult> {
    return processYouTubeWithGemini(
        { url, apiKey, model, timeoutMs },
        { mode: 'transcribe' }
    );
}

/**
 * Summarize YouTube video using Gemini
 * Convenience wrapper around processYouTubeWithGemini
 */
export async function summarizeYouTubeWithGemini(
    url: string,
    apiKey: string,
    prompt: string,
    model: string = DEFAULT_MODEL,
    timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<YouTubeSummaryResult> {
    const result = await processYouTubeWithGemini(
        { url, apiKey, model, timeoutMs },
        { mode: 'summarize', prompt }
    );

    // Map to legacy return type for backwards compatibility
    return {
        success: result.success,
        content: result.content,
        videoInfo: result.videoInfo,
        error: result.error,
    };
}

// ============================================================================
// Legacy API - YouTube Caption Scraping (Fallback)
// ============================================================================

/**
 * Extract caption tracks from YouTube page HTML using multiple patterns
 */
interface YouTubeCaptionTrack {
    baseUrl?: string;
    languageCode?: string;
    kind?: string;
    name?: { simpleText?: string };
}

function extractCaptionTracksFromHtml(html: string): YouTubeCaptionTrack[] | null {
    // Pattern 1: Standard captionTracks in ytInitialPlayerResponse
    const pattern1 = /"captionTracks"\s*:\s*(\[[\s\S]*?\])(?=\s*[,}])/;
    const match1 = pattern1.exec(html);
    if (match1) {
        try {
            const tracks = JSON.parse(match1[1]);
            logger.debug('Core', 'Found captions via pattern 1');
            return tracks;
        } catch {
            logger.debug('Core', 'Pattern 1 matched but failed to parse');
        }
    }

    // Pattern 2: Look for playerCaptionsTracklistRenderer
    const pattern2 = /"playerCaptionsTracklistRenderer"\s*:\s*\{[^}]*"captionTracks"\s*:\s*(\[[^\]]+\])/;
    const match2 = pattern2.exec(html);
    if (match2) {
        try {
            const tracks = JSON.parse(match2[1]);
            logger.debug('Core', 'Found captions via pattern 2');
            return tracks;
        } catch {
            logger.debug('Core', 'Pattern 2 matched but failed to parse');
        }
    }

    // Pattern 3: Extract from ytInitialPlayerResponse JSON blob
    const pattern3 = /ytInitialPlayerResponse\s*=\s*(\{[\s\S]*?\});/;
    const match3 = pattern3.exec(html);
    if (match3) {
        try {
            const playerResponse = JSON.parse(match3[1]);
            const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
            if (tracks) {
                logger.debug('Core', 'Found captions via ytInitialPlayerResponse');
                return tracks;
            }
        } catch {
            logger.debug('Core', 'ytInitialPlayerResponse parse failed');
        }
    }

    return null;
}

/**
 * Select the best caption track from available tracks
 * Prefers English, then auto-generated, then first available
 */
function selectBestCaptionTrack(captionTracks: YouTubeCaptionTrack[]): YouTubeCaptionTrack {
    // Prefer English captions
    let track = captionTracks.find((t: YouTubeCaptionTrack) =>
        t.languageCode === 'en' || t.languageCode?.startsWith('en')
    );

    // Fall back to auto-generated captions
    if (!track) {
        track = captionTracks.find((t: YouTubeCaptionTrack) =>
            t.kind === 'asr' || t.name?.simpleText?.includes('auto')
        );
    }

    // Fall back to first available
    return track || captionTracks[0];
}

/**
 * Fetch transcript from YouTube by scraping captions.
 * Active fallback method used when a Gemini API key is unavailable.
 * Prefer using transcribeYouTubeWithGemini when Gemini is configured.
 */
export async function fetchYouTubeTranscript(url: string): Promise<YouTubeTranscriptResult> {
    const videoId = extractYouTubeVideoId(url);

    if (!videoId) {
        return { success: false, error: 'Invalid YouTube URL. Could not extract video ID.' };
    }

    try {
        logger.debug('Core', `Fetching YouTube page for transcript extraction, videoId: ${videoId}`);

        const response = await requestUrl({
            url: `https://www.youtube.com/watch?v=${videoId}`,
            method: 'GET',
        });

        const captionTracks = extractCaptionTracksFromHtml(response.text);

        if (!captionTracks || captionTracks.length === 0) {
            logger.debug('Core', 'No caption tracks found in page');
            return { success: false, error: 'No captions available for this video. YouTube captions must be enabled.' };
        }

        logger.debug('Core', `Found ${captionTracks.length} caption tracks`);

        const captionTrack = selectBestCaptionTrack(captionTracks);
        const captionUrl = captionTrack?.baseUrl;

        if (!captionUrl) {
            logger.debug('Core', 'Caption track found but no baseUrl:', captionTrack);
            return { success: false, error: 'Caption URL not found.' };
        }

        logger.debug('Core', `Fetching transcript from: ${captionUrl.substring(0, 80)}...`);

        const transcriptResponse = await requestUrl({ url: captionUrl, method: 'GET' });
        const segments = parseTranscriptXml(transcriptResponse.text);

        if (segments.length === 0) {
            logger.debug('Core', 'Transcript XML parsed but no segments found');
            return { success: false, error: 'Failed to parse transcript.' };
        }

        logger.debug('Core', `Parsed ${segments.length} transcript segments`);
        const videoInfo = await fetchVideoInfo(videoId);

        return {
            success: true,
            transcript: formatTranscript(segments),
            segments,
            videoInfo,
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error('Core', `fetchYouTubeTranscript error: ${errorMessage}`);
        return { success: false, error: `Failed to fetch transcript: ${errorMessage}` };
    }
}
