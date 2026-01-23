/**
 * Source Detection Utility
 * Detects URLs, PDFs, YouTube links, and audio files from note content
 */

import { App, TFile } from 'obsidian';

export type SourceType = 'url' | 'youtube' | 'pdf' | 'audio';

export interface DetectedSource {
    type: SourceType;
    value: string;           // URL or file path
    displayName: string;     // Shortened display name
    lineNumber?: number;     // Line where found (1-indexed)
    context?: string;        // e.g., "Pending Integration", "line 12"
    isVaultFile?: boolean;   // True for vault files (PDFs, audio)
}

export interface DetectedSources {
    urls: DetectedSource[];
    youtube: DetectedSource[];
    pdfs: DetectedSource[];
    audio: DetectedSource[];
}

// URL patterns
const URL_PATTERN = /https?:\/\/[^\s\])"'<>]+/gi;
const YOUTUBE_PATTERN = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/gi;
const PDF_URL_PATTERN = /https?:\/\/[^\s\])"'<>]+\.pdf(?:\?[^\s\])"'<>]*)?/gi;

// Vault link patterns
const VAULT_PDF_PATTERN = /\[\[([^\]]+\.pdf)\]\]/gi;
const VAULT_AUDIO_PATTERN = /\[\[([^\]]+\.(mp3|wav|m4a|ogg|flac|webm))\]\]/gi;

// Audio URL pattern
const AUDIO_URL_PATTERN = /https?:\/\/[^\s\])"'<>]+\.(mp3|wav|m4a|ogg|flac|webm)(?:\?[^\s\])"'<>]*)?/gi;

/**
 * Detect all sources from note content
 */
export function detectSourcesFromContent(content: string, app?: App): DetectedSources {
    const lines = content.split('\n');
    const sources: DetectedSources = {
        urls: [],
        youtube: [],
        pdfs: [],
        audio: []
    };

    // Track seen values to avoid duplicates
    const seen = new Set<string>();

    // Check if we're in a "Pending Integration" section
    let inPendingSection = false;
    let pendingSectionName = '';

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNumber = i + 1;

        // Check for section headers
        const headerMatch = line.match(/^#{1,3}\s+(.+)/);
        if (headerMatch) {
            const headerText = headerMatch[1].toLowerCase();
            inPendingSection = headerText.includes('pending') ||
                               headerText.includes('to process') ||
                               headerText.includes('to summarize') ||
                               headerText.includes('inbox');
            pendingSectionName = inPendingSection ? headerMatch[1] : '';
        }

        const context = inPendingSection ? pendingSectionName : `Line ${lineNumber}`;

        // Detect YouTube URLs first (before general URLs)
        const youtubeMatches = line.matchAll(new RegExp(YOUTUBE_PATTERN.source, 'gi'));
        for (const match of youtubeMatches) {
            const url = match[0];
            if (!seen.has(url)) {
                seen.add(url);
                sources.youtube.push({
                    type: 'youtube',
                    value: url,
                    displayName: truncateUrl(url, 40),
                    lineNumber,
                    context
                });
            }
        }

        // Detect PDF URLs
        const pdfUrlMatches = line.matchAll(new RegExp(PDF_URL_PATTERN.source, 'gi'));
        for (const match of pdfUrlMatches) {
            const url = match[0];
            if (!seen.has(url)) {
                seen.add(url);
                sources.pdfs.push({
                    type: 'pdf',
                    value: url,
                    displayName: extractFileName(url) || truncateUrl(url, 40),
                    lineNumber,
                    context,
                    isVaultFile: false
                });
            }
        }

        // Detect audio URLs
        const audioUrlMatches = line.matchAll(new RegExp(AUDIO_URL_PATTERN.source, 'gi'));
        for (const match of audioUrlMatches) {
            const url = match[0];
            if (!seen.has(url)) {
                seen.add(url);
                sources.audio.push({
                    type: 'audio',
                    value: url,
                    displayName: extractFileName(url) || truncateUrl(url, 40),
                    lineNumber,
                    context,
                    isVaultFile: false
                });
            }
        }

        // Detect vault PDF links
        const vaultPdfMatches = line.matchAll(new RegExp(VAULT_PDF_PATTERN.source, 'gi'));
        for (const match of vaultPdfMatches) {
            const filePath = match[1];
            if (!seen.has(filePath)) {
                seen.add(filePath);
                sources.pdfs.push({
                    type: 'pdf',
                    value: filePath,
                    displayName: extractFileName(filePath) || filePath,
                    lineNumber,
                    context,
                    isVaultFile: true
                });
            }
        }

        // Detect vault audio links
        const vaultAudioMatches = line.matchAll(new RegExp(VAULT_AUDIO_PATTERN.source, 'gi'));
        for (const match of vaultAudioMatches) {
            const filePath = match[1];
            if (!seen.has(filePath)) {
                seen.add(filePath);
                sources.audio.push({
                    type: 'audio',
                    value: filePath,
                    displayName: extractFileName(filePath) || filePath,
                    lineNumber,
                    context,
                    isVaultFile: true
                });
            }
        }

        // Detect general URLs (excluding YouTube, PDFs, audio already matched)
        const urlMatches = line.matchAll(new RegExp(URL_PATTERN.source, 'gi'));
        for (const match of urlMatches) {
            const url = match[0];
            // Skip if already seen or if it's a YouTube/PDF/audio URL
            if (seen.has(url)) continue;
            if (isYouTubeUrl(url) || isPdfUrl(url) || isAudioUrl(url)) continue;

            seen.add(url);
            sources.urls.push({
                type: 'url',
                value: url,
                displayName: truncateUrl(url, 40),
                lineNumber,
                context
            });
        }
    }

    return sources;
}

/**
 * Check if URL is a YouTube URL
 */
export function isYouTubeUrl(url: string): boolean {
    return /(?:youtube\.com|youtu\.be)/i.test(url);
}

/**
 * Check if URL is a PDF URL
 */
function isPdfUrl(url: string): boolean {
    return /\.pdf(?:\?|$)/i.test(url);
}

/**
 * Check if URL is an audio URL
 */
function isAudioUrl(url: string): boolean {
    return /\.(mp3|wav|m4a|ogg|flac|webm)(?:\?|$)/i.test(url);
}

/**
 * Extract filename from URL or path
 */
function extractFileName(urlOrPath: string): string | null {
    try {
        // Try URL parsing first
        const url = new URL(urlOrPath);
        const pathname = url.pathname;
        const parts = pathname.split('/');
        const filename = parts[parts.length - 1];
        if (filename) {
            return decodeURIComponent(filename);
        }
    } catch {
        // Not a URL, treat as path
        const parts = urlOrPath.split('/');
        return parts[parts.length - 1] || null;
    }
    return null;
}

/**
 * Truncate URL for display
 */
function truncateUrl(url: string, maxLength: number): string {
    try {
        const parsed = new URL(url);
        const display = parsed.hostname + parsed.pathname;
        if (display.length <= maxLength) {
            return display;
        }
        return display.substring(0, maxLength - 3) + '...';
    } catch {
        if (url.length <= maxLength) {
            return url;
        }
        return url.substring(0, maxLength - 3) + '...';
    }
}

/**
 * Get total count of detected sources
 */
export function getTotalSourceCount(sources: DetectedSources): number {
    return sources.urls.length + sources.youtube.length + sources.pdfs.length + sources.audio.length;
}

/**
 * Check if any sources were detected
 */
export function hasAnySources(sources: DetectedSources): boolean {
    return getTotalSourceCount(sources) > 0;
}

/**
 * Remove processed source URLs from content
 * Removes lines that are primarily URLs (bare URLs or markdown links)
 * Preserves URLs that are embedded in meaningful text context
 *
 * Section handling:
 * - Main content: URLs are removed
 * - ## References: URLs are KEPT (this is where they belong after processing)
 * - ## Pending Integration: URLs are removed (they've been processed)
 *
 * @param content - The note content
 * @param urls - URLs to remove
 * @returns Updated content with URLs removed
 */
export function removeProcessedSources(
    content: string,
    urls: string[]
): string {
    if (urls.length === 0) return content;

    const lines = content.split('\n');
    const result: string[] = [];

    // Only track References section - URLs are kept there, removed everywhere else
    let inReferencesSection = false;

    for (const line of lines) {
        const trimmedLine = line.trim();

        // Check for section headers
        if (trimmedLine === '## References' || trimmedLine.startsWith('## References')) {
            inReferencesSection = true;
            result.push(line);
            continue;
        }

        // Any other ## header ends the References section
        if (trimmedLine.startsWith('## ')) {
            inReferencesSection = false;
        }

        // In References section: keep everything (URLs belong here after processing)
        if (inReferencesSection) {
            result.push(line);
            continue;
        }

        // In main content or Pending Integration: remove URL lines
        const shouldRemove = shouldRemoveLine(line, urls);
        if (!shouldRemove) {
            result.push(line);
        }
    }

    // Clean up: remove multiple consecutive blank lines
    return result.join('\n').replaceAll(/\n{3,}/g, '\n\n');
}

/**
 * Check if a line should be removed because it contains primarily a URL
 */
function shouldRemoveLine(line: string, urls: string[]): boolean {
    for (const url of urls) {
        const escaped = escapeRegex(url);

        // Case 1: Bare URL on its own line (with optional list marker)
        if (new RegExp(String.raw`^\s*[-*]?\s*` + escaped + String.raw`\s*$`).test(line)) {
            return true;
        }

        // Case 2: Markdown link on its own line
        if (new RegExp(String.raw`^\s*[-*]?\s*\[[^\]]*\]\(` + escaped + String.raw`\)\s*$`).test(line)) {
            return true;
        }
    }
    return false;
}

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str: string): string {
    return str.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}
