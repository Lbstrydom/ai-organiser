/**
 * Source Detection Utility
 * Detects URLs, PDFs, YouTube links, and audio files from note content
 */

import { App, TFile } from 'obsidian';
import { EXTRACTABLE_DOCUMENT_EXTENSIONS, IMAGE_EXTENSIONS } from '../core/constants';
import { isYouTubeUrl as isYouTubeUrlCanonical } from '../services/youtubeService';

export type DetectedSourceType = 'url' | 'youtube' | 'pdf' | 'audio' | 'document' | 'image';

/** @deprecated Use DetectedSourceType */
export type SourceType = DetectedSourceType;

export interface DetectedSource {
    type: DetectedSourceType;
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
    documents: DetectedSource[];
    images: DetectedSource[];
}

// URL patterns
const URL_PATTERN = /https?:\/\/[^\s\])"'<>]+/gi;
// YouTube URL pattern - supports standard, shorts, live, mobile, and embed formats
const YOUTUBE_PATTERN = /(?:https?:\/\/)?(?:(?:www|m)\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/|live\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/gi;
const PDF_URL_PATTERN = /https?:\/\/[^\s\])"'<>]+\.pdf(?:\?[^\s\])"'<>]*)?/gi;
const DOCUMENT_URL_PATTERN = new RegExp(
    `https?:\\/\\/[^\\s\\])"'<>]+\\.(${EXTRACTABLE_DOCUMENT_EXTENSIONS.join('|')})(?:\\?[^\\s\\])"'<>]*)?`,
    'gi'
);

// Vault link patterns
const VAULT_PDF_PATTERN = /\[\[([^\]]+\.pdf)\]\]/gi;
const VAULT_AUDIO_PATTERN = /\[\[([^\]]+\.(mp3|wav|m4a|ogg|flac|webm))\]\]/gi;
const VAULT_DOCUMENT_PATTERN = new RegExp(
    `\\[\\[([^\\]]+\\.(${EXTRACTABLE_DOCUMENT_EXTENSIONS.join('|')}))\\]\\]`,
    'gi'
);

// Audio URL pattern
const AUDIO_URL_PATTERN = /https?:\/\/[^\s\])"'<>]+\.(mp3|wav|m4a|ogg|flac|webm)(?:\?[^\s\])"'<>]*)?/gi;

// Vault image link pattern — built from shared IMAGE_EXTENSIONS constant (vault-only, no external URLs in v1)
const imageExts = IMAGE_EXTENSIONS.map(ext => ext.replace('.', '')).join('|');
const VAULT_IMAGE_PATTERN = new RegExp(String.raw`!?\[\[([^\]|]+\.(${imageExts}))(?:\|[^\]]*)?\]\]`, 'gi');

/**
 * Detect all sources from note content
 */
export function detectSourcesFromContent(content: string, app?: App): DetectedSources {
    const lines = content.split('\n');
    const sources: DetectedSources = {
        urls: [],
        youtube: [],
        pdfs: [],
        audio: [],
        documents: [],
        images: []
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

        // Detect document URLs
        const documentUrlMatches = line.matchAll(new RegExp(DOCUMENT_URL_PATTERN.source, 'gi'));
        for (const match of documentUrlMatches) {
            const url = match[0];
            if (!seen.has(url)) {
                seen.add(url);
                sources.documents.push({
                    type: 'document',
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

        // Detect vault document links
        const vaultDocumentMatches = line.matchAll(new RegExp(VAULT_DOCUMENT_PATTERN.source, 'gi'));
        for (const match of vaultDocumentMatches) {
            const filePath = match[1];
            if (!seen.has(filePath)) {
                seen.add(filePath);
                sources.documents.push({
                    type: 'document',
                    value: filePath,
                    displayName: extractFileName(filePath) || filePath,
                    lineNumber,
                    context,
                    isVaultFile: true
                });
            }
        }

        // Detect vault image links (vault-only; external image URLs deferred to v2)
        const vaultImageMatches = line.matchAll(new RegExp(VAULT_IMAGE_PATTERN.source, 'gi'));
        for (const match of vaultImageMatches) {
            const filePath = match[1];
            if (!seen.has(filePath)) {
                seen.add(filePath);
                sources.images.push({
                    type: 'image',
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
            if (isYouTubeUrl(url) || isPdfUrl(url) || isAudioUrl(url) || isDocumentUrl(url)) continue;

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
 * Check if URL is a YouTube URL (standard, shorts, live, mobile, embed).
 * Delegates to the canonical implementation in youtubeService.
 */
export function isYouTubeUrl(url: string): boolean {
    return isYouTubeUrlCanonical(url);
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
 * Check if URL is a document URL
 */
function isDocumentUrl(url: string): boolean {
    return new RegExp(`\\.(${EXTRACTABLE_DOCUMENT_EXTENSIONS.join('|')})(?:\\?|$)`, 'i').test(url);
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
    return sources.urls.length + sources.youtube.length + sources.pdfs.length + sources.audio.length + sources.documents.length + sources.images.length;
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
 * @param vaultFiles - Optional vault file paths to remove (e.g., ['meeting.pdf', 'recording.mp3'])
 * @returns Updated content with URLs and vault file references removed
 */
export function removeProcessedSources(
    content: string,
    urls: string[],
    vaultFiles?: string[]
): string {
    if (urls.length === 0 && (!vaultFiles || vaultFiles.length === 0)) return content;

    const lines = content.split('\n');
    const result: string[] = [];

    // Only track References section - URLs/wikilinks are kept there, removed everywhere else
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

        // In References section: keep everything (URLs/wikilinks belong here after processing)
        if (inReferencesSection) {
            result.push(line);
            continue;
        }

        // In main content or Pending Integration: remove URL and wikilink lines
        const shouldRemove = shouldRemoveLine(line, urls, vaultFiles);
        if (!shouldRemove) {
            result.push(line);
        }
    }

    // Clean up: remove multiple consecutive blank lines
    return result.join('\n').replaceAll(/\n{3,}/g, '\n\n');
}

/**
 * Check if a line should be removed because it contains primarily a URL or wikilink
 */
function shouldRemoveLine(line: string, urls: string[], vaultFiles?: string[]): boolean {
    // Check URL patterns
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

    // Check vault file wikilink patterns
    if (vaultFiles) {
        for (const filePath of vaultFiles) {
            const escaped = escapeRegex(filePath);
            // Combined: optional list marker, optional embed !, [[path optionally |display text]]
            if (new RegExp(String.raw`^\s*[-*]?\s*!?\[\[` + escaped + String.raw`(?:\|[^\]]*)?]]\s*$`).test(line)) {
                return true;
            }
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

// --- Functions moved from contentDetection.ts (retired) ---

/** Check if text contains a URL */
export function isUrl(text: string): boolean {
    if (!text) return false;
    return /https?:\/\/\S+/i.test(text);
}

/** Extract first URL from text */
export function extractUrl(text: string): string | null {
    if (!text) return null;
    const match = /https?:\/\/\S+/i.exec(text);
    return match ? match[0] : null;
}

/** Check if text contains a PDF link (wikilink or URL) */
export function isPdfLink(text: string): boolean {
    if (!text) return false;
    if (/\[\[[^\]]+\.pdf(?:\|[^\]]*)?\]\]/i.test(text)) return true;
    if (/!\[\[[^\]]+\.pdf(?:\|[^\]]*)?\]\]/i.test(text)) return true;
    return /https?:\/\/\S+\.pdf(?:\?\S+)?/i.test(text);
}

/** Extract PDF path from wikilink or URL */
export function extractPdfPath(text: string): string | null {
    if (!text) return null;
    const wikiMatch = /!?\[\[([^\]|]+\.pdf)(?:\|[^\]]*)?\]\]/i.exec(text);
    if (wikiMatch) {
        return wikiMatch[1];
    }
    const urlMatch = /https?:\/\/\S+\.pdf(?:\?\S+)?/i.exec(text);
    if (urlMatch) {
        return urlMatch[0];
    }
    return null;
}
