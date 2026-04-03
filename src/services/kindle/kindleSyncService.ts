/**
 * Kindle Sync Service
 *
 * Orchestrator for the clippings file import path.
 * Handles differential sync, note creation/update, and state tracking.
 */

import { normalizePath, TFile } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import {
    KindleBook,
    KindleHighlight,
    KindleSyncProgress,
    KindleSyncResult,
    KindleSyncState,
    generateBookKey,
    toKindleBook,
} from './kindleTypes';
import type { KindleScrapedBook } from './kindleTypes';
import { getStoredCookies, clearCookies } from './kindleAuthService';
import { fetchAllHighlights } from './kindleScraperService';
import { isEmbeddedAvailable, fetchHighlightsEmbedded } from './kindleEmbeddedAuth';
import { buildBookNote, appendHighlightsToExisting, updateFrontmatterInContent } from './kindleNoteBuilder';
import type { KindleHighlightStyle } from './kindleNoteBuilder';
import { getKindleOutputFullPath } from '../../core/settings';
import { sanitizeFileName, ensureFolderExists, getAvailableFilePath } from '../../utils/minutesUtils';
import { logger } from '../../utils/logger';

/**
 * Build the expected filename for a book note.
 * Includes author to avoid title-only collisions.
 */
function buildBookFileName(title: string, author: string): string {
    const safeTitle = sanitizeFileName(title);
    const safeAuthor = sanitizeFileName(author);
    if (safeAuthor && safeAuthor.toLowerCase() !== 'unknown') {
        return `${safeTitle} - ${safeAuthor}.md`;
    }
    return `${safeTitle}.md`;
}

/**
 * Find the existing note file for a book, checking both current and legacy filename formats.
 * Returns the TFile if found, or null.
 */
export function findExistingBookNote(
    plugin: AIOrganiserPlugin,
    book: KindleBook
): TFile | null {
    const outputFolder = getKindleOutputFullPath(plugin.settings);

    // Try current format: "Title - Author.md"
    const currentName = buildBookFileName(book.title, book.author);
    const currentPath = normalizePath(`${outputFolder}/${currentName}`);
    const currentFile = plugin.app.vault.getAbstractFileByPath(currentPath);
    if (currentFile instanceof TFile) return currentFile;

    // Fallback: legacy format "Title.md" (for backwards compatibility)
    const legacyName = `${sanitizeFileName(book.title)}.md`;
    if (legacyName !== currentName) {
        const legacyPath = normalizePath(`${outputFolder}/${legacyName}`);
        const legacyFile = plugin.app.vault.getAbstractFileByPath(legacyPath);
        if (legacyFile instanceof TFile) return legacyFile;
    }

    return null;
}

/**
 * Import highlights from parsed Kindle books.
 */
export async function syncFromClippings(
    plugin: AIOrganiserPlugin,
    selectedBooks: KindleBook[],
    onProgress: (progress: KindleSyncProgress) => void,
    signal?: AbortSignal
): Promise<KindleSyncResult> {
    const result: KindleSyncResult = {
        success: true,
        booksProcessed: 0,
        highlightsImported: 0,
        errors: [],
        skippedBooks: [],
        createdFiles: [],
    };

    if (selectedBooks.length === 0) {
        return result;
    }

    const total = selectedBooks.length;

    for (let i = 0; i < selectedBooks.length; i++) {
        if (signal?.aborted) break;

        const book = selectedBooks[i];
        onProgress({
            phase: 'creating-notes',
            current: i + 1,
            total,
            bookTitle: book.title,
        });

        try {
            // Check if note file was deleted — if so, clear state for re-import
            const bookKey = generateBookKey(book.title, book.author);
            const existingNote = findExistingBookNote(plugin, book);
            if (!existingNote && (plugin.settings.kindleSyncState.importedHighlights[bookKey]?.length ?? 0) > 0) {
                delete plugin.settings.kindleSyncState.importedHighlights[bookKey];
            }

            const newHighlights = getNewHighlights(book, plugin.settings.kindleSyncState);

            if (newHighlights.length === 0) {
                result.skippedBooks.push(book.title);
                continue;
            }

            const file = await createOrUpdateBookNote(plugin, book, newHighlights);
            updateSyncState(plugin, book, newHighlights);
            result.booksProcessed++;
            result.highlightsImported += newHighlights.length;
            result.createdFiles.push({ path: file.path, title: book.title, book });
        } catch (error) {
            const msg = `Failed to process "${book.title}": ${error instanceof Error ? error.message : 'Unknown error'}`;
            result.errors.push(msg);
            logger.error('Kindle', msg);
        }
    }

    // Save sync state
    plugin.settings.kindleSyncState.lastSyncDate = new Date().toISOString();
    await plugin.saveSettings();

    onProgress({
        phase: 'done',
        current: total,
        total,
        message: `${result.booksProcessed} books, ${result.highlightsImported} highlights`,
    });

    result.success = result.errors.length === 0;
    return result;
}

/**
 * Filter highlights to only those not yet imported (differential sync).
 * When `asin` is provided, uses ASIN-keyed state lookup (Amazon path).
 */
export function getNewHighlights(book: KindleBook, state: KindleSyncState, asin?: string): KindleHighlight[] {
    let imported: string[];
    if (asin && state.importedHighlightsByAsin) {
        imported = state.importedHighlightsByAsin[asin] || [];
    } else {
        const bookKey = generateBookKey(book.title, book.author);
        imported = state.importedHighlights[bookKey] || [];
    }
    const importedSet = new Set(imported);

    return book.highlights.filter(h => !importedSet.has(h.id));
}

/**
 * Create a new book note or append new highlights to an existing one.
 */
export async function createOrUpdateBookNote(
    plugin: AIOrganiserPlugin,
    book: KindleBook,
    newHighlights: KindleHighlight[]
): Promise<TFile> {
    const outputFolder = getKindleOutputFullPath(plugin.settings);
    await ensureFolderExists(plugin.app.vault, outputFolder);

    const style: KindleHighlightStyle = plugin.settings.kindleHighlightStyle;

    // Check for existing note (current + legacy filename)
    const existingFile = findExistingBookNote(plugin, book);

    if (existingFile) {
        // Append new highlights and update frontmatter
        const existingContent = await plugin.app.vault.read(existingFile);
        const appended = appendHighlightsToExisting(existingContent, newHighlights, style);

        // Update highlights_count and last_synced in frontmatter
        const countMatch = /highlights_count:\s*(\d+)/.exec(existingContent);
        const oldCount = countMatch ? Number.parseInt(countMatch[1], 10) : 0;
        const updated = updateFrontmatterInContent(appended, {
            highlights_count: oldCount + newHighlights.length,
            last_synced: new Date().toISOString(),
        });

        await plugin.app.vault.modify(existingFile, updated);
        return existingFile;
    }

    // Create new note
    const bookForNote: KindleBook = {
        ...book,
        highlights: newHighlights,
        highlightCount: newHighlights.length,
    };

    const noteContent = buildBookNote(bookForNote, {
        highlightStyle: style,
        groupByColor: plugin.settings.kindleGroupByColor,
        includeCoverImage: plugin.settings.kindleIncludeCoverImage,
    });

    const fileName = buildBookFileName(book.title, book.author);
    const filePath = await getAvailableFilePath(
        plugin.app.vault,
        outputFolder,
        fileName
    );

    return plugin.app.vault.create(filePath, noteContent);
}

/**
 * Update the persistent sync state after importing highlights for a book.
 * When `asin` is provided, also writes to ASIN-keyed state (dual-write for backward compat).
 */
export function updateSyncState(
    plugin: AIOrganiserPlugin,
    book: KindleBook,
    importedHighlights: KindleHighlight[],
    asin?: string
): void {
    const bookKey = generateBookKey(book.title, book.author);
    const existing = plugin.settings.kindleSyncState.importedHighlights[bookKey] || [];
    const newIds = importedHighlights.map(h => h.id);
    plugin.settings.kindleSyncState.importedHighlights[bookKey] = [...existing, ...newIds];

    if (asin) {
        plugin.settings.kindleSyncState.importedHighlightsByAsin ??= {};
        const existingAsin = plugin.settings.kindleSyncState.importedHighlightsByAsin[asin] || [];
        plugin.settings.kindleSyncState.importedHighlightsByAsin[asin] = [...existingAsin, ...newIds];
    }
}

// =========================================================================
// Amazon Cloud Sync (Phase 3)
// =========================================================================

/**
 * Sync highlights from Amazon cloud via Scraping Browser CDP sessions.
 * Fetches highlights for selected books, creates/updates notes, tracks state.
 */
export async function syncFromAmazon(
    plugin: AIOrganiserPlugin,
    selectedBooks: KindleScrapedBook[],
    onProgress: (progress: KindleSyncProgress) => void,
    signal?: AbortSignal
): Promise<KindleSyncResult> {
    const result: KindleSyncResult = {
        success: true,
        booksProcessed: 0,
        highlightsImported: 0,
        errors: [],
        skippedBooks: [],
        createdFiles: [],
    };

    if (selectedBooks.length === 0) return result;

    // Get stored cookies
    const cookiePayload = await getStoredCookies(plugin);
    if (!cookiePayload) {
        result.errors.push('No stored Amazon cookies — please log in first');
        result.success = false;
        return result;
    }

    const region = plugin.settings.kindleAmazonRegion;
    const asins = selectedBooks.map(b => b.asin);
    const asinToBook = new Map(selectedBooks.map(b => [b.asin, b]));

    onProgress({
        phase: 'scraping',
        current: 0,
        total: selectedBooks.length,
        message: 'Fetching highlights from Amazon...',
    });

    // Fetch highlights — prefer embedded BrowserWindow on desktop (full JS rendering),
    // fall back to plain HTTP for mobile or if Electron is unavailable.
    const progressCb = (completed: number, total: number) => {
        onProgress({
            phase: 'scraping',
            current: completed,
            total,
            message: 'Fetching highlights from Amazon...',
        });
    };

    let highlightsByAsin: Map<string, KindleHighlight[]>;
    let authExpired = false;

    if (isEmbeddedAvailable()) {
        try {
            const embeddedResult = await fetchHighlightsEmbedded(
                region, asins, signal, progressCb
            );
            highlightsByAsin = embeddedResult.results;
            authExpired = embeddedResult.authExpired;
        } catch (err) {
            logger.debug('Kindle', 'Embedded highlight fetch failed, falling back to HTTP:', err);
            const httpResult = await fetchAllHighlights(
                cookiePayload, region, asins, signal, progressCb
            );
            highlightsByAsin = httpResult.results;
            authExpired = httpResult.authExpired;
        }
    } else {
        const httpResult = await fetchAllHighlights(
            cookiePayload, region, asins, signal, progressCb
        );
        highlightsByAsin = httpResult.results;
        authExpired = httpResult.authExpired;
    }

    if (authExpired) {
        await clearCookies(plugin);
        result.authExpired = true;
        result.success = false;
        return result;
    }

    // Create/update notes for each book
    const total = selectedBooks.length;
    let processed = 0;

    for (const [asin, highlights] of highlightsByAsin) {
        if (signal?.aborted) break;

        const scraped = asinToBook.get(asin);
        if (!scraped) continue;

        processed++;
        onProgress({
            phase: 'creating-notes',
            current: processed,
            total,
            bookTitle: scraped.title,
        });

        await processAmazonBook(plugin, scraped, highlights, asin, result);
    }

    // Save sync state
    plugin.settings.kindleSyncState.lastSyncDate = new Date().toISOString();
    plugin.settings.kindleSyncState.region = region;
    await plugin.saveSettings();

    onProgress({
        phase: 'done',
        current: total,
        total,
        message: `${result.booksProcessed} books, ${result.highlightsImported} highlights`,
    });

    result.success = result.errors.length === 0;
    return result;
}

/**
 * Process a single Amazon book: convert, diff, create/update note, track state.
 */
async function processAmazonBook(
    plugin: AIOrganiserPlugin,
    scraped: KindleScrapedBook,
    highlights: KindleHighlight[],
    asin: string,
    result: KindleSyncResult,
): Promise<void> {
    try {
        const book = toKindleBook(scraped, highlights);
        const newHighlights = getNewHighlights(book, plugin.settings.kindleSyncState, asin);

        if (newHighlights.length === 0) {
            result.skippedBooks.push(book.title);
            return;
        }

        const file = await createOrUpdateBookNote(plugin, book, newHighlights);
        updateSyncState(plugin, book, newHighlights, asin);
        result.booksProcessed++;
        result.highlightsImported += newHighlights.length;
        result.createdFiles.push({ path: file.path, title: book.title, book });
    } catch (error) {
        const msg = `Failed to process "${scraped.title}": ${error instanceof Error ? error.message : 'Unknown error'}`;
        result.errors.push(msg);
    }
}
