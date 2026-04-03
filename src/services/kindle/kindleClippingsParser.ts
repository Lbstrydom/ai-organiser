/**
 * Kindle My Clippings.txt Parser
 *
 * Parses the standard Kindle clippings file format into structured book/highlight data.
 * Handles highlights, notes, and bookmarks. Groups entries by book.
 *
 * Format:
 * ```
 * Book Title (Author Name)
 * - Your Highlight on page 42 | location 1406-1407 | Added on Saturday, 26 March 2016 14:59:39
 *
 * The actual highlighted text goes here.
 * ==========
 * ```
 */

import {
    KindleBook,
    KindleHighlight,
    KindleClippingEntry,
    KindleClippingType,
    generateHighlightId,
    generateBookKey,
} from './kindleTypes';

/** Delimiter between clipping entries (10 equals signs + newline) */
const ENTRY_DELIMITER = '==========';

/**
 * Regex to parse the metadata line.
 * Captures: type (Highlight|Note|Bookmark), page number, location range, date string.
 *
 * Examples matched:
 * - Your Highlight on page 42 | location 1406-1407 | Added on Saturday, 26 March 2016 14:59:39
 * - Your Note on location 500 | Added on Monday, 1 January 2024 09:00:00
 * - Your Bookmark on page 10 | Added on Tuesday, 2 February 2025 12:00:00
 */
const METADATA_REGEX = /^-\s*Your\s+(Highlight|Note|Bookmark)\s+(?:on\s+)?(?:page\s+(\d+)\s*\|?\s*)?(?:(?:on\s+)?location\s+([\d-]+)\s*\|?\s*)?.*?Added\s+on\s+(.+)$/i;

/**
 * Regex to extract title and author from the first line of a clipping entry.
 * Author is in parentheses at the end: "Book Title (Author Name)"
 * Handles nested parentheses by matching the last parenthetical group.
 */
const TITLE_AUTHOR_REGEX = /^(.+?)\s*\(([^)]+)\)\s*$/;

/**
 * Parse a My Clippings.txt file content into an array of KindleBook objects.
 * Groups highlights and notes by book, deduplicates by content hash.
 */
export function parseClippings(content: string): KindleBook[] {
    if (!content || !content.trim()) {
        return [];
    }

    const entries = splitIntoEntries(content);
    const parsed = entries
        .map(parseEntry)
        .filter((e): e is KindleClippingEntry => e !== null);

    return groupEntriesByBook(parsed);
}

/**
 * Split raw file content into individual clipping entries.
 */
function splitIntoEntries(content: string): string[] {
    // Normalize line endings
    const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    return normalized
        .split(ENTRY_DELIMITER)
        .map(entry => entry.trim())
        .filter(entry => entry.length > 0);
}

/**
 * Parse a single clipping entry into a structured object.
 * Returns null for malformed entries.
 */
function parseEntry(entryText: string): KindleClippingEntry | null {
    const lines = entryText.split('\n').map(l => l.trim());

    // Need at least 2 lines: title line + metadata line
    if (lines.length < 2) {
        return null;
    }

    // Line 1: Book title and author
    const titleLine = lines[0];
    const titleMatch = titleLine.match(TITLE_AUTHOR_REGEX);

    let bookTitle: string;
    let author: string;

    if (titleMatch) {
        bookTitle = titleMatch[1].trim();
        author = titleMatch[2].trim();
    } else {
        // No author in parentheses — use entire line as title
        bookTitle = titleLine.trim();
        author = 'Unknown';
    }

    // Line 2: Metadata (type, page, location, date)
    const metadataLine = lines[1];
    const metaMatch = metadataLine.match(METADATA_REGEX);

    if (!metaMatch) {
        return null;
    }

    const typeStr = metaMatch[1].toLowerCase() as KindleClippingType;
    const page = metaMatch[2] ? parseInt(metaMatch[2], 10) : undefined;
    const location = metaMatch[3] || undefined;
    const dateString = metaMatch[4]?.trim() || undefined;

    // Lines 3+: Content (skip empty line after metadata)
    const contentLines = lines.slice(2).filter(l => l.length > 0);
    const content = contentLines.join('\n').trim();

    // Bookmarks have no content — still valid entries
    if (typeStr !== 'bookmark' && !content) {
        return null;
    }

    return {
        bookTitle,
        author,
        type: typeStr,
        page,
        location,
        dateString,
        content,
    };
}

/**
 * Group parsed clipping entries by book and convert to KindleBook/KindleHighlight structures.
 * Deduplicates highlights by content hash.
 * Notes are attached to the nearest preceding highlight when possible.
 */
function groupEntriesByBook(entries: KindleClippingEntry[]): KindleBook[] {
    const bookMap = new Map<string, {
        title: string;
        author: string;
        highlights: Map<string, KindleHighlight>;
        lastDate?: string;
    }>();

    for (const entry of entries) {
        // Skip bookmarks — they have no useful content
        if (entry.type === 'bookmark') {
            continue;
        }

        const bookKey = generateBookKey(entry.bookTitle, entry.author);

        if (!bookMap.has(bookKey)) {
            bookMap.set(bookKey, {
                title: entry.bookTitle,
                author: entry.author,
                highlights: new Map(),
                lastDate: entry.dateString,
            });
        }

        const book = bookMap.get(bookKey)!;

        if (entry.type === 'highlight') {
            const id = generateHighlightId(entry.content);

            // Only add if not already present (dedup)
            if (!book.highlights.has(id)) {
                book.highlights.set(id, {
                    id,
                    text: entry.content,
                    page: entry.page,
                    location: entry.location,
                    createdDate: entry.dateString,
                });
            }

            // Track latest date (compare to keep the true latest)
            if (entry.dateString) {
                if (!book.lastDate || isLaterDate(entry.dateString, book.lastDate)) {
                    book.lastDate = entry.dateString;
                }
            }
        } else if (entry.type === 'note') {
            // Try to attach note to a highlight at the same location
            const attached = attachNoteToHighlight(book.highlights, entry);
            if (!attached) {
                // Standalone note — create as a highlight with note text
                const id = generateHighlightId(`note:${entry.content}`);
                if (!book.highlights.has(id)) {
                    book.highlights.set(id, {
                        id,
                        text: '',
                        note: entry.content,
                        page: entry.page,
                        location: entry.location,
                        createdDate: entry.dateString,
                    });
                }
            }
        }
    }

    // Convert map to array
    const books: KindleBook[] = [];
    for (const [, bookData] of bookMap) {
        const highlights = Array.from(bookData.highlights.values());
        books.push({
            title: bookData.title,
            author: bookData.author,
            highlightCount: highlights.length,
            highlights,
            lastAnnotatedDate: bookData.lastDate,
        });
    }

    // Sort by title for consistent output
    books.sort((a, b) => a.title.localeCompare(b.title));

    return books;
}

/**
 * Try to attach a note entry to an existing highlight at the same location.
 * Returns true if successfully attached, false otherwise.
 */
/**
 * Compare two date strings, returning true if dateA is later than dateB.
 * Falls back gracefully: if dateA can't be parsed, returns false (keep existing).
 */
function isLaterDate(dateA: string, dateB: string): boolean {
    const a = new Date(dateA).getTime();
    const b = new Date(dateB).getTime();
    if (Number.isNaN(a)) return false;
    if (Number.isNaN(b)) return true;
    return a > b;
}

function attachNoteToHighlight(
    highlights: Map<string, KindleHighlight>,
    noteEntry: KindleClippingEntry
): boolean {
    if (!noteEntry.location && !noteEntry.page) {
        return false;
    }

    for (const [, highlight] of highlights) {
        const locationMatch = noteEntry.location && highlight.location === noteEntry.location;
        const pageMatch = noteEntry.page && highlight.page === noteEntry.page;

        if (locationMatch || pageMatch) {
            highlight.note = noteEntry.content;
            return true;
        }
    }

    return false;
}
