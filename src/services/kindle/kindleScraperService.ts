/**
 * Kindle Scraper Service (v2)
 *
 * HTTP-based scraping for Amazon Kindle notebook pages.
 * Uses Obsidian's requestUrl — no CDP, no WebSocket, no external proxy.
 *
 * IMPORTANT: Amazon's notebook is largely client-side rendered. The book list
 * and highlight content require JavaScript execution to populate the DOM.
 * The HTTP path (`requestUrl`) is a best-effort fallback for mobile; on desktop,
 * prefer the embedded BrowserWindow approach in `kindleEmbeddedAuth.ts` which
 * executes Amazon's JavaScript and extracts from the fully-rendered page.
 *
 * Pagination handled via contentLimitState + token hidden inputs (HTTP path)
 * or scroll+load-more harvesting (embedded path).
 */

import { requestUrl } from 'obsidian';
import { buildRequestHeaders, getNotebookUrl, detectAuthExpiry } from './kindleAuthService';
import { generateAmazonHighlightId } from './kindleTypes';
import { NON_BOOK_IDS } from './kindleBookmarklet';
import type { KindleCookiePayload, KindleScrapedBook, KindleHighlight } from './kindleTypes';
import { logger } from '../../utils/logger';

/** @deprecated Debug mode is now handled by the global logger singleton. */
export function setScraperDebugMode(_enabled: boolean): void {
    // No-op: debug mode controlled by logger.setDebugMode()
}

// =========================================================================
// Pre-Scraped Books Cache
// =========================================================================
// When the user pastes an enhanced payload (cookies + books from the DOM),
// the login modal caches the books here. The sync modal consumes them once,
// bypassing the HTTP-based fetchBookList (which fails because Amazon's book
// list is loaded via client-side JavaScript, not server-rendered HTML).

let _preScrapedBooks: KindleScrapedBook[] | null = null;

/**
 * Store pre-scraped books extracted from the browser DOM.
 * Called by the login modal when an enhanced JSON payload is detected.
 */
export function setPreScrapedBooks(books: KindleScrapedBook[]): void {
    _preScrapedBooks = books;
    logger.debug('Kindle', `Pre-scraped books cached: ${books.length} books`);
}

/**
 * Consume (read and clear) pre-scraped books.
 * Returns null if no books were cached.
 * The cache is cleared after consumption to prevent stale reuse.
 */
export function consumePreScrapedBooks(): KindleScrapedBook[] | null {
    const books = _preScrapedBooks;
    _preScrapedBooks = null;
    if (books) {
        logger.debug('Kindle', `Pre-scraped books consumed: ${books.length} books`);
    }
    return books;
}

// =========================================================================
// Core HTTP Fetching
// =========================================================================

/**
 * Fetch a page's HTML via Obsidian's requestUrl with cookie auth.
 */
async function fetchPageHTML(
    url: string,
    cookiePayload: KindleCookiePayload,
): Promise<{ html: string; authExpired: boolean }> {
    logger.debug('Kindle', 'Fetching URL:', url);
    const response = await requestUrl({
        url,
        headers: buildRequestHeaders(cookiePayload),
        throw: false,
    });

    const html = response.text;
    const authExpired = detectAuthExpiry(html);
    logger.debug('Kindle', `Response length: ${html.length}, authExpired: ${authExpired}`);
    logger.debug('Kindle', 'HTML preview:', html.substring(0, 3000));
    return { html, authExpired };
}

// =========================================================================
// Book List Fetching
// =========================================================================

/**
 * Fetch the list of books from the Amazon Kindle notebook page.
 * Supports server-side pagination via contentLimitState + token hidden inputs.
 * Amazon's notebook library may paginate for users with many books.
 */
export async function fetchBookList(
    cookiePayload: KindleCookiePayload,
    region: string,
    signal?: AbortSignal
): Promise<{ books: KindleScrapedBook[]; authExpired: boolean }> {
    if (signal?.aborted) {
        return { books: [], authExpired: false };
    }

    const notebookUrl = getNotebookUrl(region);
    const allBooks: KindleScrapedBook[] = [];
    const seenAsins = new Set<string>();
    const MAX_PAGES = 50; // Safety limit

    let pageUrl = notebookUrl;

    for (let page = 0; page < MAX_PAGES; page++) {
        if (signal?.aborted) break;

        const { html, authExpired } = await fetchPageHTML(pageUrl, cookiePayload);

        if (authExpired) {
            return { books: allBooks, authExpired: true };
        }

        const pageBooks = parseBookListHTML(html);
        logger.debug('Kindle', `Book list page ${page}: found ${pageBooks.length} books`);

        // Deduplicate by ASIN across pages
        for (const book of pageBooks) {
            if (!seenAsins.has(book.asin)) {
                seenAsins.add(book.asin);
                allBooks.push(book);
            }
        }

        // Check for next page via pagination hidden inputs
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const nextPage = parseLibraryNextPage(doc);

        if (!nextPage) break; // No more pages
        pageUrl = `${notebookUrl}?libraryType=BOOKS&paginationToken=${encodeURIComponent(nextPage)}`;
    }

    logger.debug('Kindle', `Total books found across all pages: ${allBooks.length}`);
    return { books: allBooks, authExpired: false };
}

/**
 * Parse the Amazon notebook page HTML to extract book list.
 * Uses fallback CSS selector chains for resilience.
 *
 * Amazon's notebook HTML structure (as of 2026):
 * - Book containers: `.kp-notebook-library-each-book` OR `div[id^="kp-notebook-library-"]`
 * - Title: `h3` element, possibly with `.kp-notebook-metadata` class
 * - Author: `p` element, often with "by " prefix from `<span class="a-text-italic">`
 * - Cover: `img` element inside cover container
 * - Highlight count: `span` with number + highlight/annotation keyword
 */
export function parseBookListHTML(html: string): KindleScrapedBook[] {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const books: KindleScrapedBook[] = [];

    const candidateElements: Element[] = [];
    const seen = new Set<Element>();

    const collect = (elements: NodeListOf<Element>, source: string): void => {
        logger.debug('Kindle', `${source} selector returned ${elements.length} elements`);
        for (const el of Array.from(elements)) {
            if (!seen.has(el)) {
                seen.add(el);
                candidateElements.push(el);
            }
        }
    };

    // Collect from all known selector families instead of short-circuiting.
    // Amazon can return placeholder IDs while real cards are class-based.
    collect(doc.querySelectorAll('[id^="kp-notebook-library-"]'), 'id-prefix');
    collect(doc.querySelectorAll('.kp-notebook-library-each-book'), 'class');
    collect(doc.querySelectorAll('[data-asin]'), 'data-asin');

    // Fallback: direct children in library container
    if (candidateElements.length === 0) {
        const libraryContainer = doc.querySelector('#kp-notebook-library, .kp-notebook-library');
        if (libraryContainer) {
            collect(libraryContainer.querySelectorAll(':scope > div[id]'), 'library-container');
        }
    }

    // Last-resort fallback: any link carrying asin=
    if (candidateElements.length === 0) {
        collect(doc.querySelectorAll('a[href*="asin="]'), 'asin-link');
    }

    logger.debug('Kindle', `Found ${candidateElements.length} book elements`);

    for (const el of candidateElements) {
        try {
            // Extract ASIN — try ID first, then data-asin, then link href
            let asin = '';
            const id = el.getAttribute('id') || '';
            if (id.startsWith('kp-notebook-library-')) {
                asin = id.replace('kp-notebook-library-', '');
            }
            // Some Kindle DOM variants use raw ASIN as the element id.
            if (!asin && /^[A-Z0-9]{10}$/i.test(id)) {
                asin = id;
            }
            if (!asin) {
                asin = el.getAttribute('data-asin') || '';
            }
            if (!asin) {
                const link = el.querySelector('a[href*="asin="]');
                const hrefMatch = link?.getAttribute('href')?.match(/asin=([A-Z0-9]{10})/i);
                if (hrefMatch) asin = hrefMatch[1];
            }
            if (!asin) continue;

            // Filter out non-book UI placeholder elements
            if (asin.length < 4 || NON_BOOK_IDS.test(asin)) {
                logger.debug('Kindle', `Skipping non-book element: ${id || asin}`);
                continue;
            }

            // Title: fallback selector chain
            const titleEl = el.querySelector('h2.kp-notebook-searchable') ||
                el.querySelector('h3.kp-notebook-metadata') ||
                el.querySelector('.kp-notebook-title') ||
                el.querySelector('h2') ||
                el.querySelector('h3') ||
                el.querySelector('[class*="title"]');
            const title = titleEl?.textContent?.trim() || 'Unknown Title';

            // Author: fallback selector chain + strip "by " prefix
            const authorEl = el.querySelector('p.kp-notebook-searchable') ||
                el.querySelector('p.kp-notebook-metadata.a-spacing-none') ||
                el.querySelector('.kp-notebook-author') ||
                el.querySelector('p:not(.kp-notebook-highlight-count)') ||
                el.querySelector('[class*="author"]');
            let author = authorEl?.textContent?.trim() || 'Unknown Author';
            // Strip common prefixes added by Amazon HTML formatting
            author = stripAuthorPrefix(author);

            // Cover image
            const imgEl = el.querySelector('img');
            const imageUrl = imgEl?.getAttribute('src') || undefined;

            // Last annotated date from data attribute or metadata
            const lastAnnotatedDate = el.getAttribute('data-last-annotation-date') || undefined;

            // Highlight count from metadata - support multiple languages
            const highlightCount = extractHighlightCount(el);

            logger.debug('Kindle', `Book: "${title}" by "${author}" (${asin}) — ${highlightCount} highlights`);

            books.push({
                asin,
                title,
                author,
                imageUrl,
                highlightCount,
                lastAnnotatedDate,
            });
        } catch {
            // Skip malformed book entries
        }
    }

    return books;
}

/**
 * Strip common author prefixes added by Amazon's HTML rendering.
 * Handles "by ", "von ", "de ", "di ", "por " etc.
 */
export function stripAuthorPrefix(raw: string): string {
    // Common prefixes across Amazon locales
    return raw.replace(/^(by|von|de|di|por|da|par)\s+/i, '').trim();
}

/**
 * Extract highlight/annotation count from a book element.
 * Supports multiple languages: English, German, French, Spanish, Italian, etc.
 */
function extractHighlightCount(el: Element): number {
    const attrCandidates = [
        'data-highlight-count',
        'data-highlights-count',
        'data-annotation-count',
        'data-annotations-count',
        'data-count',
    ];

    for (const attr of attrCandidates) {
        const raw = el.getAttribute(attr);
        if (!raw) continue;
        const value = parsePositiveInt(raw);
        if (value !== null) return value;
    }

    const keywordPattern = /(\d+)\s*(highlight|annotation|markierung|hervorhebung|surlignement|subrayado|anotaci(?:o|\u00f3)n|evidenziazion|annotazion|destaque|anotac(?:a|\u00e3)o)/i;

    const textCandidates: string[] = [];
    const pushText = (value: string | null | undefined): void => {
        if (!value) return;
        const normalized = normalizeWhitespace(value);
        if (normalized) textCandidates.push(normalized);
    };

    // Prioritize likely count nodes first.
    const likelyCountNodes = el.querySelectorAll(
        '.kp-notebook-highlight-count, [class*="highlight"], [class*="annotat"], [id*="highlight"], [id*="annotat"]'
    );
    for (const node of Array.from(likelyCountNodes)) {
        pushText(node.textContent);
    }

    // Then fall back to common text containers.
    const metaNodes = el.querySelectorAll('span, p, div, li, strong, em, b');
    for (const node of Array.from(metaNodes)) {
        pushText(node.textContent);
    }
    pushText(el.textContent);

    for (const text of textCandidates) {
        const match = keywordPattern.exec(text);
        if (!match) continue;
        const count = Number.parseInt(match[1], 10);
        if (Number.isFinite(count) && count >= 0) return count;
    }

    // Final fallback: bare number from likely count nodes only.
    for (const node of Array.from(likelyCountNodes)) {
        const text = normalizeWhitespace(node.textContent || '');
        const match = /\b(\d{1,6})\b/.exec(text);
        if (!match) continue;
        const value = Number.parseInt(match[1], 10);
        if (Number.isFinite(value) && value > 0) return value;
    }

    return 0;
}

function parsePositiveInt(value: string): number | null {
    const match = value.match(/\d+/);
    if (!match) return null;
    const parsed = Number.parseInt(match[0], 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeWhitespace(value: string): string {
    return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Extract pagination token for library book list pages.
 * Amazon may use various pagination mechanisms for the library.
 */
function parseLibraryNextPage(doc: Document): string | null {
    // Check for a "next page" link or pagination token
    const nextLink = doc.querySelector('.kp-notebook-library-next-page') as HTMLAnchorElement | null; // eslint-disable-line @typescript-eslint/no-unnecessary-type-assertion
    if (nextLink?.href) {
        const url = new URL(nextLink.href, 'https://placeholder.com');
        return url.searchParams.get('paginationToken');
    }

    // Check for hidden pagination token input
    const tokenEl = doc.querySelector('[name="paginationToken"], .kp-notebook-library-pagination-token') as HTMLInputElement | null; // eslint-disable-line @typescript-eslint/no-unnecessary-type-assertion
    if (tokenEl?.value) return tokenEl.value;

    // Check for a "Show more" or pagination button with data attribute
    const showMore = doc.querySelector('[data-pagination-token]');
    if (showMore) return showMore.getAttribute('data-pagination-token');

    return null;
}

// =========================================================================
// Highlight Fetching (with Pagination)
// =========================================================================

/**
 * Pagination state for highlight pages.
 * Amazon uses hidden inputs for server-side pagination.
 */
interface NextPageState {
    contentLimitState: string;
    token: string;
}

/**
 * Extract pagination state from highlight page HTML.
 * Returns null when there are no more pages.
 */
function parseNextPageState(doc: Document): NextPageState | null {
    let contentLimitState = firstNonEmptyValue(doc, [
        '.kp-notebook-content-limit-state',
        '#kp-notebook-content-limit-state',
        'input[name="contentLimitState"]',
        'input[name="kp-notebook-content-limit-state"]',
        '[data-content-limit-state]',
    ]) || '';

    let token = firstNonEmptyValue(doc, [
        '.kp-notebook-annotations-next-page-start',
        '#kp-notebook-annotations-next-page-start',
        'input[name="token"]',
        'input[name="kp-notebook-annotations-next-page-start"]',
        '[data-token]',
        '[data-next-token]',
        '[data-pagination-token]',
    ]) || '';

    // Next-page links often encode token/contentLimitState as query parameters.
    if (!token) {
        const nextLinkCandidates = doc.querySelectorAll(
            '.kp-notebook-next-page, .kp-notebook-annotations-next-page, a[href*="token="], a[href*="paginationToken="]'
        );
        for (const link of Array.from(nextLinkCandidates)) {
            const href = (link as HTMLAnchorElement).getAttribute('href');
            if (!href) continue;
            const parsed = parsePageStateFromUrl(href);
            if (!parsed) continue;
            if (!contentLimitState && parsed.contentLimitState) {
                contentLimitState = parsed.contentLimitState;
            }
            token = parsed.token;
            break;
        }
    }

    // Some pages store pagination in JSON blobs on data attributes.
    if (!token) {
        const stateNodes = doc.querySelectorAll('[data-a-state], [data-state]');
        for (const node of Array.from(stateNodes)) {
            const raw = node.getAttribute('data-a-state') || node.getAttribute('data-state');
            if (!raw) continue;
            const parsed = parseStateBlob(raw);
            if (!parsed?.token) continue;
            if (!contentLimitState && parsed.contentLimitState) {
                contentLimitState = parsed.contentLimitState;
            }
            token = parsed.token;
            break;
        }
    }

    const normalizedToken = token.trim();
    if (!normalizedToken) return null;

    return {
        contentLimitState: contentLimitState.trim(),
        token: normalizedToken,
    };
}

function firstNonEmptyValue(doc: Document, selectors: string[]): string | null {
    for (const selector of selectors) {
        const element = doc.querySelector(selector);
        if (!element) continue;
        const value = readElementValue(element);
        if (value) return value;
    }
    return null;
}

function readElementValue(element: Element): string {
    const inputLike = element as HTMLInputElement;
    const value = typeof inputLike.value === 'string' ? inputLike.value : '';
    if (value.trim()) return value.trim();

    const attrs = ['value', 'data-token', 'data-next-token', 'data-pagination-token', 'data-content-limit-state'];
    for (const attr of attrs) {
        const attrValue = element.getAttribute(attr);
        if (attrValue?.trim()) return attrValue.trim();
    }

    const text = normalizeWhitespace(element.textContent || '');
    return text;
}

function parsePageStateFromUrl(href: string): NextPageState | null {
    try {
        const url = new URL(href, 'https://placeholder.com');
        const token = url.searchParams.get('token') || url.searchParams.get('paginationToken');
        if (!token) return null;
        return {
            token,
            contentLimitState: url.searchParams.get('contentLimitState') || '',
        };
    } catch {
        return null;
    }
}

function parseStateBlob(raw: string): NextPageState | null {
    try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const rawToken = parsed.token ?? parsed.nextToken ?? parsed.paginationToken ?? parsed.nextPageStart ?? '';
        const token = (typeof rawToken === 'string' ? rawToken : JSON.stringify(rawToken)).trim();
        if (!token) return null;
        const rawLimit = parsed.contentLimitState ?? parsed.contentLimit ?? '';
        const contentLimitState = (typeof rawLimit === 'string' ? rawLimit : JSON.stringify(rawLimit)).trim();
        return { token, contentLimitState };
    } catch {
        return null;
    }
}

/**
 * Build the highlights URL for a specific book with optional pagination.
 */
function buildHighlightsUrl(region: string, asin: string, pageState?: NextPageState): string {
    const notebookUrl = getNotebookUrl(region);
    const contentLimitState = pageState?.contentLimitState ?? '';
    const token = pageState?.token ?? '';
    return `${notebookUrl}?asin=${encodeURIComponent(asin)}&contentLimitState=${encodeURIComponent(contentLimitState)}&token=${encodeURIComponent(token)}`;
}

/**
 * Fetch all highlights for a single book, handling pagination.
 * Follows the contentLimitState + token pattern from Amazon's server-side pagination.
 */
async function fetchHighlightsForBook(
    cookiePayload: KindleCookiePayload,
    region: string,
    asin: string,
    signal?: AbortSignal,
): Promise<{ highlights: KindleHighlight[]; authExpired: boolean }> {
    const allHighlights: KindleHighlight[] = [];
    const seenHighlightIds = new Set<string>();
    const seenPageStates = new Set<string>();
    let pageState: NextPageState | undefined;
    const MAX_PAGES = 50; // Safety limit

    for (let page = 0; page < MAX_PAGES; page++) {
        if (signal?.aborted) break;

        const url = buildHighlightsUrl(region, asin, pageState);
        const { html, authExpired } = await fetchPageHTML(url, cookiePayload);

        if (authExpired) {
            return { highlights: allHighlights, authExpired: true };
        }

        const pageHighlights = parseHighlightsHTML(html, asin);
        for (const highlight of pageHighlights) {
            if (seenHighlightIds.has(highlight.id)) continue;
            seenHighlightIds.add(highlight.id);
            allHighlights.push(highlight);
        }

        logger.debug('Kindle', `ASIN ${asin} page ${page + 1}: parsed ${pageHighlights.length} highlights (running total ${allHighlights.length})`);

        // Check for next page
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const nextPage = parseNextPageState(doc);

        if (!nextPage) break; // No more pages
        const pageKey = `${nextPage.contentLimitState}|${nextPage.token}`;
        if (seenPageStates.has(pageKey)) {
            logger.debug('Kindle', `ASIN ${asin}: repeated pagination state detected, stopping loop`, pageKey);
            break;
        }
        seenPageStates.add(pageKey);
        pageState = nextPage;
    }

    return { highlights: allHighlights, authExpired: false };
}

const HIGHLIGHT_ROW_SELECTORS = [
    '.a-row.a-spacing-base',
    '.a-row.kp-notebook-highlight',
    '.kp-notebook-highlight[id^="highlight-"]',
].join(', ');

const HIGHLIGHT_TEXT_SELECTORS = [
    '.kp-notebook-highlight-text',
    '[id="highlight"]',
    '[id^="highlight-"]:not(.kp-notebook-highlight)',
    '[class*="highlight-text"]',
].join(', ');

const NOTE_SELECTORS = [
    '.kp-notebook-note-text',
    '[id^="note-"]',
    '[id="note"]',
    '.kp-notebook-note',
].join(', ');

const LOCATION_SELECTORS = [
    '#kp-annotation-location',
    '[id*="annotation-location"]',
    'input[name*="location"]',
    '[data-location]',
].join(', ');

const PAGE_SELECTORS = [
    '#annotationNoteHeader',
    '[id*="annotation-note-header"]',
    '.kp-notebook-metadata',
].join(', ');

const COLOR_PATTERN = /kp-notebook-highlight-(pink|blue|yellow|orange)\b/i;
const LOCATION_PATTERN = /(?:Location|Loc\.?|Position|Posizione|Ubicaci(?:o|\u00f3)n|Emplacement)\s*[:#]?\s*([\d,-]+)/i;
const PAGE_PATTERN = /(?:Page|Seite|Pagina|P(?:a|\u00e1)gina)\s*[:#]?\s*(\d+)/i;
const TRAILING_PAGE_PATTERN = /(\d+)\s*$/;

interface ParsedHighlightCandidate {
    text: string;
    note?: string;
    color?: KindleHighlight['color'];
    location?: string;
    page?: number;
    sourceId?: string;
}

function pickLongestText(elements: Element[]): string | undefined {
    let longest = '';
    for (const element of elements) {
        const text = normalizeWhitespace(element.textContent || '');
        if (!text) continue;
        if (text.length > longest.length) longest = text;
    }
    return longest || undefined;
}

function parseLocationFromText(text: string): string | undefined {
    const match = LOCATION_PATTERN.exec(text);
    if (!match?.[1]) return undefined;
    const normalized = match[1].replace(/[\u2013\u2014]/g, '-').replace(/\s+/g, '').trim();
    return normalized || undefined;
}

function parsePageFromText(text: string): number | undefined {
    const direct = PAGE_PATTERN.exec(text);
    if (direct?.[1]) {
        const page = Number.parseInt(direct[1], 10);
        if (Number.isFinite(page)) return page;
    }

    const trailing = TRAILING_PAGE_PATTERN.exec(text);
    if (trailing?.[1]) {
        const page = Number.parseInt(trailing[1], 10);
        if (Number.isFinite(page)) return page;
    }

    return undefined;
}

function extractHighlightText(context: Element, explicitText?: string): string | undefined {
    if (explicitText) {
        const normalized = normalizeWhitespace(explicitText);
        if (normalized) return normalized;
    }

    const textNodes = Array.from(context.querySelectorAll(HIGHLIGHT_TEXT_SELECTORS));
    const longest = pickLongestText(textNodes);
    if (longest) return longest;

    // Row containers occasionally inline the quote text without a dedicated text node.
    if (context.matches('.a-row.a-spacing-base, .a-row.kp-notebook-highlight, .kp-notebook-highlight')) {
        const fallback = normalizeWhitespace(context.textContent || '');
        return fallback || undefined;
    }

    return undefined;
}

function extractNote(context: Element): string | undefined {
    const noteNodes = Array.from(context.querySelectorAll(NOTE_SELECTORS));
    for (const node of noteNodes) {
        const text = normalizeWhitespace(node.textContent || '');
        if (!text) continue;
        const cleaned = text.replace(/^Note:\s*/i, '').trim();
        if (cleaned) return cleaned;
    }
    return undefined;
}

function extractLocation(context: Element): string | undefined {
    const locationNodes = Array.from(context.querySelectorAll(LOCATION_SELECTORS));
    for (const node of locationNodes) {
        const value = readElementValue(node);
        if (!value) continue;
        const parsed = parseLocationFromText(value) || normalizeWhitespace(value);
        if (parsed) return parsed;
    }

    const metadataNodes = Array.from(context.querySelectorAll('.kp-notebook-metadata, [id^="annotationHighlightHeader"], #annotationNoteHeader'));
    for (const node of metadataNodes) {
        const parsed = parseLocationFromText(node.textContent || '');
        if (parsed) return parsed;
    }

    return parseLocationFromText(context.textContent || '');
}

function extractPage(context: Element): number | undefined {
    const pageNodes = Array.from(context.querySelectorAll(PAGE_SELECTORS));
    for (const node of pageNodes) {
        const text = normalizeWhitespace(node.textContent || '');
        if (!text) continue;
        const page = parsePageFromText(text);
        if (page !== undefined) return page;
    }

    return parsePageFromText(context.textContent || '');
}

function extractColor(context: Element): KindleHighlight['color'] | undefined {
    const classCandidates = [
        context.className || '',
        (context.querySelector('.kp-notebook-highlight')?.className || ''),
    ];

    for (const className of classCandidates) {
        const match = COLOR_PATTERN.exec(className);
        if (!match?.[1]) continue;
        const normalized = match[1].toLowerCase();
        if (normalized === 'pink' || normalized === 'blue' || normalized === 'yellow' || normalized === 'orange') {
            return normalized;
        }
    }

    return undefined;
}

function findHighlightContext(textNode: Element): Element | null {
    const rowContext = textNode.closest(HIGHLIGHT_ROW_SELECTORS);
    if (rowContext) return rowContext;

    const broaderContext = textNode.closest('.kp-notebook-highlight, .kp-notebook-annotation, [id^="highlight-"]');
    if (!broaderContext) return textNode.parentElement;

    // Avoid using the text node itself as context when it carries id="highlight-*".
    if (broaderContext === textNode) {
        return textNode.parentElement || broaderContext;
    }

    return broaderContext;
}

function buildHighlightCandidate(context: Element, explicitText?: string): ParsedHighlightCandidate | null {
    const text = extractHighlightText(context, explicitText);
    if (!text) return null;

    const sourceId = context.getAttribute('id') ||
        context.getAttribute('data-annotation-id') ||
        context.querySelector('[id^="highlight-"]')?.getAttribute('id') ||
        undefined;

    return {
        text,
        note: extractNote(context),
        color: extractColor(context),
        location: extractLocation(context),
        page: extractPage(context),
        sourceId,
    };
}

function appendHighlightCandidate(
    highlights: KindleHighlight[],
    seenKeys: Set<string>,
    asin: string,
    candidate: ParsedHighlightCandidate | null,
): void {
    if (!candidate) return;

    const text = normalizeWhitespace(candidate.text || '');
    if (!text) return;

    const location = candidate.location ? normalizeWhitespace(candidate.location) : undefined;
    const note = candidate.note ? normalizeWhitespace(candidate.note) : undefined;
    const locationSeed = location ||
        (candidate.page !== undefined ? `page-${candidate.page}` : (candidate.sourceId || ''));
    const id = generateAmazonHighlightId(asin, locationSeed, text);

    const dedupKey = `${id}|${note || ''}`;
    if (seenKeys.has(dedupKey)) return;
    seenKeys.add(dedupKey);

    const entry: KindleHighlight = {
        id,
        text,
        note,
        color: candidate.color,
        location,
    };
    if (candidate.page !== undefined) {
        entry.page = candidate.page;
    }

    highlights.push(entry);
}

/**
 * Parse highlights from an Amazon book highlights page.
 * Supports both modern notebook markup and legacy row-based markup.
 */
export function parseHighlightsHTML(html: string, asin: string): KindleHighlight[] {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const highlights: KindleHighlight[] = [];
    const seenKeys = new Set<string>();

    const textNodes = Array.from(doc.querySelectorAll(HIGHLIGHT_TEXT_SELECTORS));
    logger.debug('Kindle', `highlight-text selector returned ${textNodes.length} elements`);

    if (textNodes.length > 0) {
        // Primary path: parse one entry per highlight text node.
        for (const textNode of textNodes) {
            const text = normalizeWhitespace(textNode.textContent || '');
            if (!text) continue;

            const context = findHighlightContext(textNode);
            if (!context) continue;

            appendHighlightCandidate(highlights, seenKeys, asin, buildHighlightCandidate(context, text));
        }
    } else {
        // Fallback for pages where quote text is inlined directly in row containers.
        const rowContexts = Array.from(doc.querySelectorAll(HIGHLIGHT_ROW_SELECTORS));
        logger.debug('Kindle', `highlight-rows selector returned ${rowContexts.length} elements`);
        for (const context of rowContexts) {
            appendHighlightCandidate(highlights, seenKeys, asin, buildHighlightCandidate(context));
        }
    }

    logger.debug('Kindle', `Parsed ${highlights.length} unique highlights`);
    return highlights;
}

/**
 * Fetch all highlights for selected books via HTTP requests.
 * One HTTP request per page per book (no batching needed — no session overhead).
 */
export async function fetchAllHighlights(
    cookiePayload: KindleCookiePayload,
    region: string,
    asins: string[],
    signal?: AbortSignal,
    onProgress?: (completed: number, total: number) => void,
): Promise<{ results: Map<string, KindleHighlight[]>; authExpired: boolean }> {
    const allResults = new Map<string, KindleHighlight[]>();
    let completed = 0;

    for (const asin of asins) {
        if (signal?.aborted) break;

        try {
            const { highlights, authExpired } = await fetchHighlightsForBook(
                cookiePayload, region, asin, signal
            );

            allResults.set(asin, highlights);
            completed++;
            onProgress?.(completed, asins.length);

            if (authExpired) {
                return { results: allResults, authExpired: true };
            }
        } catch {
            // Per-book isolation: failed book doesn't block others
            logger.error('Kindle', `Failed to fetch highlights for ASIN ${asin}`);
            allResults.set(asin, []);
            completed++;
            onProgress?.(completed, asins.length);
        }
    }

    return { results: allResults, authExpired: false };
}
