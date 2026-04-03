/**
 * Kindle Sync Types
 *
 * Type definitions for Kindle highlights import and sync.
 * Supports both Amazon cloud sync (via HTTP) and My Clippings.txt file import.
 */

/**
 * Highlight colors available in Amazon Kindle
 */
export type KindleHighlightColor = 'pink' | 'blue' | 'yellow' | 'orange';

/**
 * Entry type in My Clippings.txt
 */
export type KindleClippingType = 'highlight' | 'note' | 'bookmark';

/**
 * A single highlight or note from a Kindle book
 */
export interface KindleHighlight {
    /** Content hash for deduplication */
    id: string;
    /** Highlighted text */
    text: string;
    /** User's note attached to this highlight */
    note?: string;
    /** Highlight color (available from Amazon cloud sync, not My Clippings.txt) */
    color?: KindleHighlightColor;
    /** Page number (when available) */
    page?: number;
    /** Kindle location string, e.g. "1406-1407" */
    location?: string;
    /** Chapter title (from HTML export only) */
    chapter?: string;
    /** ISO timestamp when highlight was created */
    createdDate?: string;
}

/**
 * A book with its associated highlights
 */
export interface KindleBook {
    /** Amazon Standard Identification Number (from cloud sync only) */
    asin?: string;
    /** Book title */
    title: string;
    /** Author name */
    author: string;
    /** Cover image URL (from cloud sync only) */
    imageUrl?: string;
    /** ISO timestamp of most recent annotation */
    lastAnnotatedDate?: string;
    /** Total number of highlights */
    highlightCount: number;
    /** All highlights for this book */
    highlights: KindleHighlight[];
}

/**
 * Persistent state for differential sync.
 * Stored in plugin settings to track what has already been imported.
 */
export interface KindleSyncState {
    /** Map of book key (title+author hash) → array of imported highlight IDs */
    importedHighlights: Record<string, string[]>;
    /** ASIN → highlight IDs mapping for Amazon sync (more stable than title+author) */
    importedHighlightsByAsin?: Record<string, string[]>;
    /** ISO timestamp of last successful sync */
    lastSyncDate?: string;
    /** Amazon region used for last sync */
    region?: string;
    /** Cached book list from bookmarklet — persists across Obsidian sessions */
    cachedBooks?: KindleScrapedBook[];
}

/**
 * Progress updates during sync operations
 */
export interface KindleSyncProgress {
    phase: 'authenticating' | 'loading-books' | 'scraping' | 'creating-notes' | 'ai-enhancing' | 'done' | 'error';
    current: number;
    total: number;
    bookTitle?: string;
    message?: string;
}

/**
 * Result of a sync operation
 */
export interface KindleSyncResult {
    success: boolean;
    booksProcessed: number;
    highlightsImported: number;
    /** Error messages for failed operations */
    errors: string[];
    /** Book titles that were skipped (already up-to-date) */
    skippedBooks: string[];
    /** Files created or updated during sync */
    createdFiles: { path: string; title: string; book?: KindleBook }[];
    /** Cookies expired mid-sync — prompt re-login */
    authExpired?: boolean;
}

/**
 * Import source type
 */
export type KindleImportSource = 'amazon' | 'clippings';

/**
 * A raw entry parsed from My Clippings.txt before grouping
 */
export interface KindleClippingEntry {
    /** Book title (from header line) */
    bookTitle: string;
    /** Author name (from header line, in parentheses) */
    author: string;
    /** Type of entry */
    type: KindleClippingType;
    /** Page number if present */
    page?: number;
    /** Location string if present */
    location?: string;
    /** Timestamp string as-is from the file */
    dateString?: string;
    /** The actual content text */
    content: string;
}

/**
 * Generate a deterministic hash ID for a highlight based on its text content.
 * Uses a simple string hash — sufficient for deduplication, not for cryptography.
 */
export function generateHighlightId(text: string): string {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        const char = text.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
    }
    // Return as hex, prefixed to avoid collisions with short strings
    return 'kh-' + Math.abs(hash).toString(16).padStart(8, '0');
}

/**
 * Generate a deterministic key for a book (used in sync state tracking).
 * Combines title + author for uniqueness.
 */
export function generateBookKey(title: string, author: string): string {
    const normalized = `${title.trim().toLowerCase()}|${author.trim().toLowerCase()}`;
    return generateHighlightId(normalized).replace('kh-', 'kb-');
}

// === PHASE 3: Amazon Cloud Sync Types ===

/**
 * Result of Amazon authentication attempt
 */
export interface KindleAuthResult {
    success: boolean;
    cookies?: string;
    userAgent?: string;
    needsMFA?: boolean;
    error?: string;
}

/**
 * Structured cookie payload for SecretStorage
 */
export interface KindleCookiePayload {
    /** Structured cookie objects (parsed from cookie string) */
    cookies: KindleCDPCookie[];
    /** Serialized "key=value; ..." for HTTP Cookie header */
    cookieString: string;
    /** UA of the browser that created the session */
    userAgent: string;
    /** Amazon region when cookies were captured */
    region: string;
    /** ISO timestamp */
    capturedAt: string;
    /** How cookies were obtained */
    source: 'browser' | 'manual';
}

/**
 * CDP cookie object (subset of Network.Cookie) for injection
 */
export interface KindleCDPCookie {
    name: string;
    value: string;
    domain: string;
    path: string;
    httpOnly?: boolean;
    secure?: boolean;
}

/**
 * Book info from Amazon notebook page (before fetching highlights)
 */
export interface KindleScrapedBook {
    asin: string;
    title: string;
    author: string;
    imageUrl?: string;
    lastAnnotatedDate?: string;
    /** Count shown on notebook page (not fetched yet) */
    highlightCount: number;
}

/**
 * Generate Amazon-specific highlight ID using ASIN + location + text.
 * Uses 'ka-' prefix to distinguish from clippings-based 'kh-' IDs.
 */
export function generateAmazonHighlightId(asin: string, location: string, text: string): string {
    const normalized = `${asin}|${location}|${text.trim().toLowerCase()}`;
    return generateHighlightId(normalized).replace('kh-', 'ka-');
}

/**
 * Convert scraped book info + fetched highlights → KindleBook for note creation
 */
export function toKindleBook(scraped: KindleScrapedBook, highlights: KindleHighlight[]): KindleBook {
    return {
        asin: scraped.asin,
        title: scraped.title,
        author: scraped.author,
        imageUrl: scraped.imageUrl,
        lastAnnotatedDate: scraped.lastAnnotatedDate,
        highlightCount: highlights.length,
        highlights,
    };
}
