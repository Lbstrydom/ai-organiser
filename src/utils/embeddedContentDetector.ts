/**
 * Embedded Content Detector
 * Parses markdown content to detect embedded and linked content
 */

import { App, TFile } from 'obsidian';
import { isYouTubeUrl } from '../services/youtubeService';

export type ContentType = 'image' | 'pdf' | 'youtube' | 'web-link' | 'internal-link' | 'document';

export interface DetectedContent {
    type: ContentType;
    originalText: string;
    url: string;
    altText?: string;
    displayName: string;
    isEmbedded: boolean;
    isExternal: boolean;
    resolvedFile?: TFile;
    lineNumber: number;
}

export interface DetectionResult {
    items: DetectedContent[];
    hasImages: boolean;
    hasPdfs: boolean;
    hasYouTube: boolean;
    hasWebLinks: boolean;
    hasInternalLinks: boolean;
}

// Image file extensions
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];

// Document file extensions
const DOCUMENT_EXTENSIONS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.rtf'];

// PDF extension specifically
const PDF_EXTENSION = '.pdf';

/**
 * Detect all embedded and linked content in markdown text
 */
export function detectEmbeddedContent(app: App, content: string, currentFile?: TFile): DetectionResult {
    const items: DetectedContent[] = [];
    const lines = content.split('\n');

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex];
        const lineNumber = lineIndex + 1;

        // Detect embedded content: ![alt](url) or ![[file]]
        detectEmbeddedSyntax(app, line, lineNumber, items, currentFile);

        // Detect links: [text](url) or [[file]]
        detectLinkSyntax(app, line, lineNumber, items, currentFile);

        // Detect bare URLs (YouTube, web links)
        detectBareUrls(line, lineNumber, items);
    }

    // Remove duplicates based on URL
    const uniqueItems = removeDuplicates(items);

    return {
        items: uniqueItems,
        hasImages: uniqueItems.some(i => i.type === 'image'),
        hasPdfs: uniqueItems.some(i => i.type === 'pdf'),
        hasYouTube: uniqueItems.some(i => i.type === 'youtube'),
        hasWebLinks: uniqueItems.some(i => i.type === 'web-link'),
        hasInternalLinks: uniqueItems.some(i => i.type === 'internal-link')
    };
}

/**
 * Detect embedded content with ![alt](url) or ![[file]] syntax
 */
function detectEmbeddedSyntax(
    app: App,
    line: string,
    lineNumber: number,
    items: DetectedContent[],
    currentFile?: TFile
): void {
    // Markdown embedded: ![alt](url)
    const markdownEmbedRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
    let match;

    while ((match = markdownEmbedRegex.exec(line)) !== null) {
        const altText = match[1];
        const url = match[2];

        items.push(createContentItem(app, url, altText, match[0], lineNumber, true, currentFile));
    }

    // Wiki-style embedded: ![[file]] or ![[file|alt]]
    const wikiEmbedRegex = /!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;

    while ((match = wikiEmbedRegex.exec(line)) !== null) {
        const filePath = match[1];
        const altText = match[2] || filePath;

        items.push(createContentItem(app, filePath, altText, match[0], lineNumber, true, currentFile));
    }
}

/**
 * Detect links with [text](url) or [[file]] syntax
 */
function detectLinkSyntax(
    app: App,
    line: string,
    lineNumber: number,
    items: DetectedContent[],
    currentFile?: TFile
): void {
    // Markdown links: [text](url) - but not embedded (no !)
    // Need to exclude already matched embedded syntax
    const markdownLinkRegex = /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g;
    let match;

    while ((match = markdownLinkRegex.exec(line)) !== null) {
        const text = match[1];
        const url = match[2];

        // Skip if this is an image link (starts with !)
        if (match.index > 0 && line[match.index - 1] === '!') {
            continue;
        }

        items.push(createContentItem(app, url, text, match[0], lineNumber, false, currentFile));
    }

    // Wiki-style links: [[file]] or [[file|display]]
    // Need to exclude already matched embedded syntax
    const wikiLinkRegex = /(?<!!)\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;

    while ((match = wikiLinkRegex.exec(line)) !== null) {
        const filePath = match[1];
        const displayText = match[2] || filePath;

        // Skip if preceded by ! (embedded)
        if (match.index > 0 && line[match.index - 1] === '!') {
            continue;
        }

        items.push(createContentItem(app, filePath, displayText, match[0], lineNumber, false, currentFile));
    }
}

/**
 * Detect bare URLs in text (not in markdown syntax)
 */
function detectBareUrls(line: string, lineNumber: number, items: DetectedContent[]): void {
    // Match URLs that are not inside markdown syntax
    // This regex looks for http/https URLs
    const urlRegex = /(?<!\(|"|\[)https?:\/\/[^\s<>\[\]()]+(?=\s|$|[<>\[\]()])/g;
    let match;

    while ((match = urlRegex.exec(line)) !== null) {
        const url = match[0].replace(/[.,;:!?]+$/, ''); // Remove trailing punctuation

        // Check if this URL is already captured by other patterns
        // Skip if URL is part of a markdown link
        const beforeMatch = line.substring(0, match.index);
        if (beforeMatch.includes('](') || beforeMatch.endsWith('(')) {
            continue;
        }

        const item = classifyUrl(url, url, match[0], lineNumber, false);
        items.push(item);
    }
}

/**
 * Create a content item from detected content
 */
function createContentItem(
    app: App,
    url: string,
    altText: string,
    originalText: string,
    lineNumber: number,
    isEmbedded: boolean,
    currentFile?: TFile
): DetectedContent {
    // Check if this is an external URL
    const isExternal = isExternalUrl(url);

    if (isExternal) {
        return classifyUrl(url, altText, originalText, lineNumber, isEmbedded);
    }

    // Internal file reference
    return classifyInternalFile(app, url, altText, originalText, lineNumber, isEmbedded, currentFile);
}

/**
 * Classify an external URL
 */
function classifyUrl(
    url: string,
    altText: string,
    originalText: string,
    lineNumber: number,
    isEmbedded: boolean
): DetectedContent {
    const lowerUrl = url.toLowerCase();

    // Check for YouTube
    if (isYouTubeUrl(url)) {
        return {
            type: 'youtube',
            originalText,
            url,
            altText,
            displayName: altText || 'YouTube Video',
            isEmbedded,
            isExternal: true,
            lineNumber
        };
    }

    // Check for direct image URLs
    if (IMAGE_EXTENSIONS.some(ext => lowerUrl.endsWith(ext))) {
        return {
            type: 'image',
            originalText,
            url,
            altText,
            displayName: altText || getFileNameFromUrl(url),
            isEmbedded,
            isExternal: true,
            lineNumber
        };
    }

    // Check for PDF URLs
    if (lowerUrl.endsWith('.pdf')) {
        return {
            type: 'pdf',
            originalText,
            url,
            altText,
            displayName: altText || getFileNameFromUrl(url),
            isEmbedded,
            isExternal: true,
            lineNumber
        };
    }

    // Default to web link
    return {
        type: 'web-link',
        originalText,
        url,
        altText,
        displayName: altText || url,
        isEmbedded,
        isExternal: true,
        lineNumber
    };
}

/**
 * Classify an internal file reference
 */
function classifyInternalFile(
    app: App,
    filePath: string,
    altText: string,
    originalText: string,
    lineNumber: number,
    isEmbedded: boolean,
    currentFile?: TFile
): DetectedContent {
    // Try to resolve the file
    const resolvedFile = app.metadataCache.getFirstLinkpathDest(filePath, currentFile?.path || '');
    const lowerPath = filePath.toLowerCase();

    // Determine type based on extension
    let type: ContentType = 'internal-link';

    if (IMAGE_EXTENSIONS.some(ext => lowerPath.endsWith(ext))) {
        type = 'image';
    } else if (lowerPath.endsWith(PDF_EXTENSION)) {
        type = 'pdf';
    } else if (DOCUMENT_EXTENSIONS.some(ext => lowerPath.endsWith(ext))) {
        type = 'document';
    }

    return {
        type,
        originalText,
        url: filePath,
        altText,
        displayName: altText || getFileName(filePath),
        isEmbedded,
        isExternal: false,
        resolvedFile: resolvedFile || undefined,
        lineNumber
    };
}

/**
 * Check if a string is an external URL
 */
function isExternalUrl(url: string): boolean {
    return url.startsWith('http://') || url.startsWith('https://');
}

/**
 * Extract filename from URL
 */
function getFileNameFromUrl(url: string): string {
    try {
        const urlObj = new URL(url);
        const pathname = urlObj.pathname;
        const parts = pathname.split('/');
        return decodeURIComponent(parts[parts.length - 1]) || url;
    } catch {
        return url;
    }
}

/**
 * Extract filename from path
 */
function getFileName(path: string): string {
    const parts = path.split('/');
    return parts[parts.length - 1] || path;
}

/**
 * Remove duplicate items based on URL
 */
function removeDuplicates(items: DetectedContent[]): DetectedContent[] {
    const seen = new Set<string>();
    return items.filter(item => {
        const key = `${item.type}:${item.url}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}

/**
 * Filter detected content to only extractable types
 */
export function getExtractableContent(result: DetectionResult): DetectedContent[] {
    return result.items.filter(item => {
        // Can extract from: PDF, YouTube, web links, images (for multimodal)
        return item.type === 'pdf' ||
               item.type === 'youtube' ||
               item.type === 'web-link' ||
               item.type === 'image';
    });
}

/**
 * Get content type display name
 */
export function getContentTypeDisplayName(type: ContentType): string {
    switch (type) {
        case 'image': return 'Image';
        case 'pdf': return 'PDF';
        case 'youtube': return 'YouTube';
        case 'web-link': return 'Web Link';
        case 'internal-link': return 'Internal Link';
        case 'document': return 'Document';
        default: return 'Unknown';
    }
}

/**
 * Get icon name for content type
 */
export function getContentTypeIcon(type: ContentType): string {
    switch (type) {
        case 'image': return 'image';
        case 'pdf': return 'file-text';
        case 'youtube': return 'youtube';
        case 'web-link': return 'link';
        case 'internal-link': return 'file';
        case 'document': return 'file-text';
        default: return 'file';
    }
}
