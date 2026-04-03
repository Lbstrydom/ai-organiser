/**
 * Kindle Sync Module
 * Re-exports all public types and functions for the Kindle highlights sync feature.
 */

export type {
    KindleHighlight,
    KindleHighlightColor,
    KindleBook,
    KindleSyncState,
    KindleSyncProgress,
    KindleSyncResult,
    KindleImportSource,
    KindleClippingEntry,
    KindleClippingType,
    // Phase 3: Amazon cloud sync types
    KindleAuthResult,
    KindleCookiePayload,
    KindleCDPCookie,
    KindleScrapedBook,
} from './kindleTypes';

export {
    generateHighlightId,
    generateBookKey,
    generateAmazonHighlightId,
    toKindleBook,
} from './kindleTypes';

export { parseClippings } from './kindleClippingsParser';

export type { KindleHighlightStyle, KindleNoteOptions } from './kindleNoteBuilder';
export {
    buildBookNote,
    buildFrontmatter,
    formatHighlight,
    appendHighlightsToExisting,
    updateFrontmatterInContent,
} from './kindleNoteBuilder';

export {
    syncFromClippings,
    syncFromAmazon,
    createOrUpdateBookNote,
    getNewHighlights,
    updateSyncState,
    findExistingBookNote,
} from './kindleSyncService';

// Phase 3: Amazon cloud sync services
export {
    isAuthenticated,
    getStoredCookies,
    storeCookies,
    clearCookies,
    validateCookies,
    validateCookieFormat,
    getCookieAgeDays,
    openAmazonInBrowser,
    getNotebookUrl,
    buildRequestHeaders,
    detectAuthExpiry,
    parseManualCookies,
    getStoredAmazonEmail,
    getStoredAmazonPassword,
    storeAmazonEmail,
    storeAmazonPassword,
    REGION_DOMAINS,
} from './kindleAuthService';

export type { CookieFormatResult } from './kindleAuthService';

export {
    fetchBookList,
    fetchAllHighlights,
    parseBookListHTML,
    parseHighlightsHTML,
} from './kindleScraperService';

// Phase 4: Auth methods & bookmarklet
export type { AuthMethod, AuthMethodResult } from './kindleAuthMethods';
export { BookmarkletAuthMethod, ConsoleAuthMethod, buildAuthMethodChain } from './kindleAuthMethods';
export { generateCookieBookmarklet } from './kindleBookmarklet';
export { EmbeddedAuthMethod } from './kindleEmbeddedAuth';
