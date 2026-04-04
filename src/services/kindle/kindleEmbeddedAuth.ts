/* eslint-disable @typescript-eslint/no-require-imports -- Electron desktop-only: dynamic require for BrowserWindow */
/**
 * Kindle Embedded Auth Method (Desktop Only)
 *
 * Uses Electron's BrowserWindow via @electron/remote to open
 * Amazon's login page in a secure embedded window. The user logs in
 * normally (MFA, CAPTCHA etc. handled natively by Amazon), and cookies
 * are captured automatically on successful navigation.
 *
 * Architecture follows the proven pattern from hadynz/obsidian-kindle-plugin:
 * - Login happens in a VISIBLE BrowserWindow with a persistent partition
 * - Book scraping happens in a SEPARATE HIDDEN BrowserWindow sharing the
 *   same partition, which gets the rendered HTML after `did-finish-load`
 *   + a rendering timeout.
 *
 * Desktop-only: requires @electron/remote and !Platform.isMobile (DD-4).
 * Hidden on mobile; silently drops from the AuthMethod[] list when unavailable.
 */

import { Platform } from 'obsidian';
import type { AuthMethod, AuthMethodResult } from './kindleAuthMethods';
import type { KindleCookiePayload, KindleHighlight, KindleScrapedBook } from './kindleTypes';
import type { Translations } from '../../i18n/types';
import { getNotebookUrl, REGION_DOMAINS, validateCookies } from './kindleAuthService';
import { parseBookListHTML, parseHighlightsHTML } from './kindleScraperService';
import { logger } from '../../utils/logger';

const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes for overall login flow
const BOOK_RENDER_WAIT_MS = 30 * 1000; // 30 seconds for JS rendering after page load
const BOOK_RENDER_POLL_MS = 500; // 0.5s polling interval
const METADATA_SETTLE_MS = 3000; // 3 seconds for metadata (highlight counts) to populate after books appear
const SCRAPE_SAFETY_TIMEOUT_MS = 90 * 1000; // 90 seconds safety net per scrape attempt
const LIBRARY_HARVEST_TIMEOUT_MS = 45 * 1000; // 45 seconds max for scroll+harvest expansion
const LIBRARY_HARVEST_STEP_MS = 900; // Delay between scroll/load-more harvest rounds
const LIBRARY_HARVEST_STABLE_ROUNDS = 5; // Stop once count is stable for this many rounds
const BOOK_COUNT_RETRY_THRESHOLD = 60; // Retry BOOKS view when embedded scrape returns suspiciously low count

/**
 * Persistent session partition shared between login and scraping windows.
 * The `persist:` prefix ensures cookies survive across BrowserWindow instances.
 * This is the key insight from hadynz/obsidian-kindle-plugin.
 */
const PARTITION = 'persist:kindle-highlights';

const PLACEHOLDER_IDS = [
    'spinner', 'load-error', 'no-results', 'loading', 'empty', 'placeholder',
    'error', 'container', 'header', 'footer', 'wrapper', 'content', 'section', 'nav', 'menu',
];

interface LibraryReadiness {
    ready: boolean;
    count: number;
    loading: boolean;
    elapsedMs: number;
}

interface LibraryHarvestMetrics {
    books: KindleScrapedBook[];
    rounds: number;
    clicks: number;
    elapsedMs: number;
}

interface PageSnapshot {
    html: string;
    domBooks: KindleScrapedBook[];
}

/**
 * Wait for Kindle library cards to render in a BrowserWindow.
 * Polls for actual book candidates (`.kp-notebook-library-each-book`,
 * `[data-asin]`, non-placeholder `[id^="kp-notebook-library-"]`)
 * and loading indicator visibility.
 */
async function waitForLibraryRender(win: any): Promise<LibraryReadiness> {
    const placeholdersJson = JSON.stringify(PLACEHOLDER_IDS);
    const script = `
        (() => new Promise(resolve => {
            const started = Date.now();
            const timeoutMs = ${BOOK_RENDER_WAIT_MS};
            const pollMs = ${BOOK_RENDER_POLL_MS};
            const placeholders = ${placeholdersJson};

            const isPlaceholder = (value) => placeholders.includes((value || '').toLowerCase());

            const countCandidates = () => {
                const nodes = new Set();
                document.querySelectorAll('.kp-notebook-library-each-book').forEach(el => nodes.add(el));
                document.querySelectorAll('[data-asin]').forEach(el => nodes.add(el));
                document.querySelectorAll('[id^="kp-notebook-library-"]').forEach(el => {
                    const id = (el.id || '').replace('kp-notebook-library-', '').trim();
                    if (id && !isPlaceholder(id)) nodes.add(el);
                });
                return nodes.size;
            };

            const isLoadingVisible = () => {
                return !!document.querySelector(
                    '.libraries-loadingStatus:not([style*="display: none"]), ' +
                    '.kp-notebook-library-loading:not([style*="display: none"])'
                );
            };

            const tick = () => {
                const count = countCandidates();
                const loading = isLoadingVisible();
                const elapsedMs = Date.now() - started;

                if (count > 0 && !loading) {
                    resolve({ ready: true, count, loading, elapsedMs });
                    return;
                }

                if (elapsedMs >= timeoutMs) {
                    resolve({ ready: false, count, loading, elapsedMs });
                    return;
                }

                setTimeout(tick, pollMs);
            };

            tick();
        }))();
    `;

    return await win.webContents.executeJavaScript(script);
}

function mergeBookLists(...lists: KindleScrapedBook[][]): KindleScrapedBook[] {
    const merged = new Map<string, KindleScrapedBook>();

    for (const list of lists) {
        for (const book of list) {
            if (!book.asin) continue;
            const existing = merged.get(book.asin);
            if (!existing) {
                merged.set(book.asin, book);
                continue;
            }

            merged.set(book.asin, {
                asin: book.asin,
                title: book.title || existing.title,
                author: book.author || existing.author,
                imageUrl: book.imageUrl || existing.imageUrl,
                highlightCount: Math.max(book.highlightCount || 0, existing.highlightCount || 0),
                lastAnnotatedDate: book.lastAnnotatedDate || existing.lastAnnotatedDate,
            });
        }
    }

    return Array.from(merged.values());
}

function booksFromSnapshot(snapshot: PageSnapshot): KindleScrapedBook[] {
    if (snapshot.domBooks.length > 0) return snapshot.domBooks;
    return parseBookListHTML(snapshot.html);
}

/**
 * Harvest books directly in the rendered DOM.
 * This handles virtualized/infinite-scroll libraries where not all cards are
 * present in the initial HTML snapshot.
 */
async function harvestBooksFromDom(win: any): Promise<LibraryHarvestMetrics> {
    const placeholdersJson = JSON.stringify(PLACEHOLDER_IDS);
    const script = `
        (async () => {
            const placeholders = ${placeholdersJson};
            const timeoutMs = ${LIBRARY_HARVEST_TIMEOUT_MS};
            const stepMs = ${LIBRARY_HARVEST_STEP_MS};
            const stableTarget = ${LIBRARY_HARVEST_STABLE_ROUNDS};
            const started = Date.now();

            const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
            const normalize = (value) => (value || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
            const isPlaceholder = (value) => placeholders.includes((value || '').toLowerCase());
            const stripAuthorPrefix = (value) => normalize(value).replace(/^(by|von|de|di|por|da|par)\\s+/i, '');

            const parseCount = (root) => {
                const attrKeys = ['data-highlight-count', 'data-highlights-count', 'data-annotation-count', 'data-annotations-count', 'data-count'];
                for (const key of attrKeys) {
                    const raw = root.getAttribute(key);
                    if (!raw) continue;
                    const match = raw.match(/\\d+/);
                    if (match) return Number.parseInt(match[0], 10) || 0;
                }

                const nodes = root.querySelectorAll('.kp-notebook-highlight-count, [class*="highlight"], [class*="annotat"], [id*="highlight"], [id*="annotat"], span, p, div');
                const keyword = /(\\d+)\\s*(highlight|annotation|markierung|hervorhebung|surlignement|subrayado|anotaci(?:o|\\u00f3)n|evidenziazion|annotazion|destaque|anotac(?:a|\\u00e3)o)/i;
                for (const node of Array.from(nodes)) {
                    const text = normalize(node.textContent || '');
                    if (!text) continue;
                    const match = keyword.exec(text);
                    if (match) return Number.parseInt(match[1], 10) || 0;
                }

                return 0;
            };

            const extractAsin = (el) => {
                const id = (el.getAttribute('id') || '').trim();
                if (id.startsWith('kp-notebook-library-')) {
                    const parsed = id.replace('kp-notebook-library-', '').trim();
                    if (parsed) return parsed;
                }
                if (/^[A-Z0-9]{10}$/i.test(id)) return id;

                const dataAsin = (el.getAttribute('data-asin') || '').trim();
                if (dataAsin) return dataAsin;

                const link = el.querySelector('a[href*="asin="]');
                if (link) {
                    const href = link.getAttribute('href') || '';
                    const match = /asin=([A-Z0-9]{10})/i.exec(href);
                    if (match && match[1]) return match[1];
                }

                return '';
            };

            const getCandidates = () => {
                const set = new Set();
                document.querySelectorAll('.kp-notebook-library-each-book').forEach(el => set.add(el));
                document.querySelectorAll('[data-asin]').forEach(el => set.add(el));
                document.querySelectorAll('[id^="kp-notebook-library-"]').forEach(el => set.add(el));
                document.querySelectorAll('a[href*="asin="]').forEach(el => {
                    const container = el.closest('.kp-notebook-library-each-book, [id^="kp-notebook-library-"], [data-asin]') || el.parentElement;
                    if (container) set.add(container);
                });
                return Array.from(set);
            };

            const extractBook = (el) => {
                const asin = extractAsin(el);
                if (!asin || asin.length < 4 || isPlaceholder(asin)) return null;

                const titleEl =
                    el.querySelector('h2.kp-notebook-searchable') ||
                    el.querySelector('h3.kp-notebook-metadata') ||
                    el.querySelector('.kp-notebook-title') ||
                    el.querySelector('h2') ||
                    el.querySelector('h3') ||
                    el.querySelector('[class*="title"]');
                const authorEl =
                    el.querySelector('p.kp-notebook-searchable') ||
                    el.querySelector('p.kp-notebook-metadata.a-spacing-none') ||
                    el.querySelector('.kp-notebook-author') ||
                    el.querySelector('p:not(.kp-notebook-highlight-count)') ||
                    el.querySelector('[class*="author"]');
                const imageEl = el.querySelector('img');

                return {
                    asin,
                    title: normalize(titleEl && titleEl.textContent) || 'Unknown Title',
                    author: stripAuthorPrefix(authorEl && authorEl.textContent) || 'Unknown Author',
                    imageUrl: (imageEl && imageEl.getAttribute('src')) || undefined,
                    highlightCount: parseCount(el),
                    lastAnnotatedDate: el.getAttribute('data-last-annotation-date') || undefined,
                };
            };

            const isVisible = (el) => {
                if (!el) return false;
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden') return false;
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            };

            const clickLoadMore = () => {
                let clicks = 0;
                const controls = document.querySelectorAll('button, a, [role="button"], div[role="button"], span[role="button"], [data-pagination-token]');
                for (const control of Array.from(controls)) {
                    if (!isVisible(control)) continue;
                    const text = normalize(control.textContent || '');
                    const aria = normalize(control.getAttribute('aria-label') || '');
                    const dataToken = normalize(control.getAttribute('data-pagination-token') || control.getAttribute('data-next-token') || '');
                    const shouldClick =
                        !!dataToken ||
                        /load\\s+more|show\\s+more|see\\s+more|more\\s+results|mehr\\s+anzeigen|mostrar\\s+m[aá]s|ver\\s+m[aá]s/i.test(text) ||
                        /load\\s+more|show\\s+more|see\\s+more|more\\s+results/i.test(aria);
                    if (!shouldClick) continue;
                    const disabled = control.hasAttribute('disabled') || control.getAttribute('aria-disabled') === 'true';
                    if (disabled) continue;
                    control.click();
                    clicks += 1;
                }
                return clicks;
            };

            const isLoadingVisible = () => !!document.querySelector(
                '.libraries-loadingStatus:not([style*="display: none"]), .kp-notebook-library-loading:not([style*="display: none"])'
            );

            const booksByAsin = new Map();
            const mergeBook = (book) => {
                const existing = booksByAsin.get(book.asin);
                if (!existing) {
                    booksByAsin.set(book.asin, book);
                    return;
                }
                booksByAsin.set(book.asin, {
                    asin: book.asin,
                    title: book.title || existing.title,
                    author: book.author || existing.author,
                    imageUrl: book.imageUrl || existing.imageUrl,
                    highlightCount: Math.max(book.highlightCount || 0, existing.highlightCount || 0),
                    lastAnnotatedDate: book.lastAnnotatedDate || existing.lastAnnotatedDate,
                });
            };

            const harvest = () => {
                const candidates = getCandidates();
                for (const candidate of candidates) {
                    const book = extractBook(candidate);
                    if (book) mergeBook(book);
                }
            };

            let rounds = 0;
            let totalClicks = 0;
            let stableRounds = 0;
            let lastCount = 0;

            harvest();
            lastCount = booksByAsin.size;

            while (Date.now() - started < timeoutMs) {
                rounds += 1;

                totalClicks += clickLoadMore();

                const scrollTarget = Math.max(
                    document.body ? document.body.scrollHeight : 0,
                    document.documentElement ? document.documentElement.scrollHeight : 0
                );
                window.scrollTo(0, scrollTarget);
                await sleep(stepMs);
                harvest();

                const nextCount = booksByAsin.size;
                if (nextCount > lastCount) {
                    lastCount = nextCount;
                    stableRounds = 0;
                } else {
                    stableRounds += 1;
                }

                if (!isLoadingVisible() && stableRounds >= stableTarget) break;
            }

            // Final sweep from top in case virtualized rows only populate metadata on revisit.
            window.scrollTo(0, 0);
            await sleep(250);
            harvest();

            return {
                books: Array.from(booksByAsin.values()),
                rounds,
                clicks: totalClicks,
                elapsedMs: Date.now() - started,
            };
        })();
    `;

    return await win.webContents.executeJavaScript(script);
}

/**
 * Check if a URL indicates login is complete (user is on Amazon reader/notebook).
 */
function isPostLoginUrl(url: string, readDomain: string): boolean {
    if (url.includes('/ap/signin') || url.includes('/ap/oa')) return false;
    if (url.includes('/notebook')) return true;
    // Also accept the reader base URL (hadynz checks for kindleReaderUrl)
    if (url.includes(`://${readDomain}`)) return true;
    return false;
}

export class EmbeddedAuthMethod implements AuthMethod {
    readonly id = 'embedded';
    readonly label: string;
    readonly icon = 'globe';
    readonly desktopOnly = true;

    constructor(t: Translations) {
        this.label = t.kindleSync.signInBrowser;
    }

    isAvailable(): boolean {
        // DD-4: Platform.isDesktop does not exist — use !Platform.isMobile
        if (Platform.isMobile) return false;
        try {
            require('@electron/remote');
            return true;
        } catch {
            return false;
        }
    }

    async start(
        region: string,
        onProgress?: (phase: string) => void,
        credentials?: { email?: string; password?: string },
    ): Promise<AuthMethodResult> {
        return performEmbeddedLogin(region, onProgress, credentials);
    }
}

/**
 * Open a VISIBLE Electron BrowserWindow for login, then a HIDDEN one for scraping.
 *
 * Architecture (matching hadynz/obsidian-kindle-plugin):
 * 1. Login window: Opens with persistent partition → user logs in → cookies saved
 * 2. Scrape window: Hidden window with SAME partition loads notebook page →
 *    waits for `did-finish-load` + rendering poll → extracts rendered HTML
 */
async function performEmbeddedLogin(
    region: string,
    onProgress?: (phase: string) => void,
    credentials?: { email?: string; password?: string },
): Promise<AuthMethodResult> {
     
    const remote = require('@electron/remote');
    const BrowserWindow = remote.BrowserWindow;

    // Login window uses the persistent partition so cookies are shared
    // with the subsequent scraping window
    const loginWin = new BrowserWindow({
        width: 900,
        height: 700,
        title: 'Sign in to Amazon Kindle',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            partition: PARTITION,
        },
    });

    const notebookUrl = getNotebookUrl(region);
    const readDomain = REGION_DOMAINS[region] || `read.amazon.${region}`;

    return new Promise<AuthMethodResult>((resolve) => {
        let resolved = false;
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        let processingNotebook = false;

        const destroyLoginWin = () => {
            try {
                if (!loginWin.isDestroyed()) {
                    loginWin.destroy();
                }
            } catch {
                // Window already destroyed
            }
        };

        const finish = (result: AuthMethodResult) => {
            if (resolved) return;
            resolved = true;
            if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
            destroyLoginWin();
            resolve(result);
        };

        // Timeout after 5 minutes
        timeoutId = setTimeout(() => {
            finish({ success: false, error: 'timeout' });
        }, TIMEOUT_MS);

        // User closed window manually
        loginWin.on('closed', () => {
            finish({ success: false, error: 'closed' });
        });

        // Monitor navigation for successful login
        loginWin.webContents.on('did-navigate', async (_event: unknown, url: string) => {
            if (resolved) return;

            // Detect when user lands on the notebook or reader page (login complete)
            if (!isPostLoginUrl(url, readDomain)) return;
            if (processingNotebook) return;
            processingNotebook = true;

            onProgress?.('capturing');

            try {
                // DD-5: Broad cookie retrieval — get ALL cookies from shared session
                const allCookies = await loginWin.webContents.session.cookies.get({});

                // Filter to Amazon domain cookies for this region
                const regionDomain = `.amazon.${region}`;

                const matchedCookies = allCookies.filter((c: { domain: string }) => {
                    const d = c.domain;
                    return d.endsWith(regionDomain) || d === readDomain || d === `.${readDomain}`;
                });

                // Required-cookie check
                const hasSessionId = matchedCookies.some((c: { name: string }) => c.name === 'session-id');
                const hasUbid = matchedCookies.some((c: { name: string }) => c.name.startsWith('ubid-'));

                if (!hasSessionId || !hasUbid) {
                    // Cookies incomplete — don't close window, let user try again
                    onProgress?.('incomplete');
                    processingNotebook = false;
                    return;
                }

                // Assemble cookie string from ALL matched cookies
                const cookieString = matchedCookies
                    .map((c: { name: string; value: string }) => `${c.name}=${c.value}`)
                    .join('; ');

                const payload: KindleCookiePayload = {
                    cookies: matchedCookies.map((c: { name: string; value: string; domain: string; path: string; httpOnly: boolean; secure: boolean }) => ({
                        name: c.name,
                        value: c.value,
                        domain: c.domain,
                        path: c.path || '/',
                        httpOnly: c.httpOnly || false,
                        secure: c.secure || true,
                    })),
                    cookieString,
                    userAgent: loginWin.webContents.getUserAgent(),
                    region,
                    capturedAt: new Date().toISOString(),
                    source: 'browser',
                };

                onProgress?.('validating');

                // DD-2: HTTP validation before proceeding
                const valid = await validateCookies(payload, region);
                if (!valid) {
                    onProgress?.('validation-failed');
                    processingNotebook = false;
                    return; // Don't close — let user retry
                }

                // Prevent the 'closed' event from triggering a failure when we
                // intentionally close the login window before scraping.
                resolved = true;
                if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
                destroyLoginWin();

                // Scrape books from a SEPARATE HIDDEN BrowserWindow that shares
                // the same persistent session (cookies already stored in partition).
                onProgress?.('extracting-books');
                let scrapedBooks: KindleScrapedBook[] = [];
                try {
                    scrapedBooks = await scrapeBookListHidden(
                        BrowserWindow, notebookUrl
                    );
                    logger.debug('Kindle', `Extracted ${scrapedBooks.length} books from hidden scrape window`);
                } catch (err) {
                    // Non-fatal — user can fall back to bookmarklet
                    logger.debug('Kindle', 'Book extraction from scrape window failed:', err);
                }

                resolve({ success: true, cookiePayload: payload, books: scrapedBooks });
            } catch {
                // Cookie extraction failed — don't close window
                processingNotebook = false;
                onProgress?.('error');
            }
        });

        // Load the notebook URL to start the login flow.
        // If session cookies exist in the partition, the page loads directly.
        // Otherwise Amazon redirects to the login page.
        loginWin.loadURL(notebookUrl);

        // Auto-fill Amazon credentials when the login form loads.
        // Uses dom-ready event which fires for each page navigation,
        // covering both the email page and the password page.
        if (credentials?.email || credentials?.password) {
            loginWin.webContents.on('dom-ready', () => {
                if (resolved) return;
                const email = credentials.email || '';
                const password = credentials.password || '';
                // Inject auto-fill script — Amazon's login uses #ap_email and #ap_password
                loginWin.webContents.executeJavaScript(`
                    (function() {
                        var emailField = document.querySelector('#ap_email');
                        if (emailField && !emailField.value && ${JSON.stringify(email)}) {
                            emailField.value = ${JSON.stringify(email)};
                            emailField.dispatchEvent(new Event('input', { bubbles: true }));
                            emailField.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                        var passField = document.querySelector('#ap_password');
                        if (passField && !passField.value && ${JSON.stringify(password)}) {
                            passField.value = ${JSON.stringify(password)};
                            passField.dispatchEvent(new Event('input', { bubbles: true }));
                            passField.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                    })();
                `).catch(() => { /* ignore errors on non-login pages */ });
            });
        }
    });
}

/**
 * Open a hidden BrowserWindow with the shared persistent session to
 * scrape the notebook page. Waits for page load + element rendering.
 * Retries with `?libraryType=BOOKS` if first attempt returns 0 books.
 *
 * This matches the proven architecture from hadynz/obsidian-kindle-plugin:
 * - `webSecurity: false` enables cross-origin requests Amazon's JS needs
 * - Shared `persist:kindle-highlights` partition supplies auth cookies
 * - `did-finish-load` event + polling wait ensures JS has rendered books
 */
async function scrapeBookListHidden(
    BrowserWindow: any,
    notebookUrl: string,
): Promise<KindleScrapedBook[]> {
    const first = await loadPageSnapshot(BrowserWindow, notebookUrl);
    let books = booksFromSnapshot(first);
    logger.debug('Kindle', `First pass books: dom=${first.domBooks.length}, final=${books.length}`);

    if (books.length === 0 || books.length < BOOK_COUNT_RETRY_THRESHOLD) {
        // Retry with explicit BOOKS library type parameter and merge results.
        const retryUrl = notebookUrl.includes('?')
            ? `${notebookUrl}&libraryType=BOOKS`
            : `${notebookUrl}?libraryType=BOOKS`;
        logger.debug('Kindle', `Retrying BOOKS view due to low count (${books.length})`);
        const retry = await loadPageSnapshot(BrowserWindow, retryUrl);
        const retryBooks = booksFromSnapshot(retry);
        books = mergeBookLists(books, retryBooks);
        logger.debug('Kindle', `Retry pass books: dom=${retry.domBooks.length}, final=${retryBooks.length}, merged=${books.length}`);
    }

    return mergeBookLists(books);
}

/**
 * Load a URL in a HIDDEN BrowserWindow with the shared persistent session
 * and return the fully-rendered page HTML.
 *
 * Waits for the `did-finish-load` Electron event (page + resources loaded),
 * then polls for library elements to appear (up to 30s) before extracting.
 */
function loadPageSnapshot(
    BrowserWindow: any,
    url: string,
): Promise<PageSnapshot> {
    return new Promise((resolve, reject) => {
        const scrapeWin = new BrowserWindow({
            width: 1000,
            height: 600,
            show: false,
            webPreferences: {
                webSecurity: false,
                nodeIntegration: false,
                partition: PARTITION,
            },
        });

        // Safety: reject if the whole operation takes too long
        const safetyTimeout = setTimeout(() => {
            logger.debug('Kindle', 'Scrape window safety timeout reached');
            try { scrapeWin.destroy(); } catch { /* already destroyed */ }
            reject(new Error('Page scrape timed out'));
        }, SCRAPE_SAFETY_TIMEOUT_MS);

        // Wait for the page to fully load (including subresources)
        scrapeWin.webContents.once('did-finish-load', async () => {
            try {
                logger.debug('Kindle', 'Scrape page loaded, polling for book elements…');

                // Poll for book elements to appear (Amazon's JS renders asynchronously)
                const readiness = await waitForLibraryRender(scrapeWin);
                logger.debug('Kindle', `Scrape window readiness: ready=${readiness.ready}, count=${readiness.count}, loading=${readiness.loading}, elapsed=${readiness.elapsedMs}ms`);

                // Extra wait for metadata (highlight counts, dates) to populate.
                // Book cards appear in the DOM first; metadata fills asynchronously.
                if (readiness.ready) {
                    await new Promise(r => setTimeout(r, METADATA_SETTLE_MS));
                }

                let harvested: LibraryHarvestMetrics = {
                    books: [],
                    rounds: 0,
                    clicks: 0,
                    elapsedMs: 0,
                };
                try {
                    harvested = await harvestBooksFromDom(scrapeWin);
                    logger.debug('Kindle', `DOM harvest: books=${harvested.books.length}, rounds=${harvested.rounds}, clicks=${harvested.clicks}, elapsed=${harvested.elapsedMs}ms`);
                } catch (harvestErr) {
                    logger.debug('Kindle', 'DOM harvest failed, falling back to HTML parse:', harvestErr);
                }

                // Extract the fully-rendered HTML
                const html: string = await scrapeWin.webContents.executeJavaScript(
                    `document.querySelector('body').innerHTML`
                );

                clearTimeout(safetyTimeout);
                scrapeWin.destroy();
                resolve({
                    html,
                    domBooks: harvested.books,
                });
            } catch (err) {
                clearTimeout(safetyTimeout);
                try { scrapeWin.destroy(); } catch { /* already destroyed */ }
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        });

        // Navigate to the target URL. Since the partition has auth cookies,
        // the page should load authenticated without a login redirect.
        scrapeWin.loadURL(url);
    });
}

// =========================================================================
// Embedded Highlight Fetching (Desktop Only)
// =========================================================================
// Uses a HIDDEN BrowserWindow with the shared persistent session to fetch
// highlight pages for each book. Amazon renders highlight content via
// client-side JavaScript, so plain HTTP requests return an empty shell.
// This approach executes Amazon's JS and extracts from the rendered DOM.
// =========================================================================

const HIGHLIGHT_RENDER_WAIT_MS = 15_000;   // 15s for initial highlights to appear
const HIGHLIGHT_RENDER_POLL_MS = 500;      // 500ms polling interval
const HIGHLIGHT_HARVEST_TIMEOUT_MS = 30_000; // 30s for scroll+load-more expansion
const HIGHLIGHT_HARVEST_STEP_MS = 800;     // Delay between harvest rounds
const HIGHLIGHT_HARVEST_STABLE_ROUNDS = 3; // Stop when count stable for N rounds
const HIGHLIGHT_PAGE_LOAD_TIMEOUT_MS = 30_000; // 30s per page navigation

interface HighlightReadiness {
    ready: boolean;
    count: number;
    loading: boolean;
    authRedirect: boolean;
    elapsedMs: number;
}

/**
 * Check whether the embedded BrowserWindow approach is available.
 * Desktop-only: requires Electron's @electron/remote module.
 */
export function isEmbeddedAvailable(): boolean {
    if (Platform.isMobile) return false;
    try {
        require('@electron/remote');
        return true;
    } catch {
        return false;
    }
}

/**
 * Navigate a BrowserWindow to a URL and wait for did-finish-load.
 */
function navigateAndWait(win: any, url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error('Highlight page load timeout'));
        }, HIGHLIGHT_PAGE_LOAD_TIMEOUT_MS);

        win.webContents.once('did-finish-load', () => {
            clearTimeout(timer);
            resolve();
        });

        win.loadURL(url);
    });
}

/**
 * Poll for highlight text elements to appear in the rendered DOM.
 * Returns readiness info including auth redirect detection and element count.
 */
async function waitForHighlightRender(win: any): Promise<HighlightReadiness> {
    const script = `
        (() => new Promise(resolve => {
            const started = Date.now();
            const timeoutMs = ${HIGHLIGHT_RENDER_WAIT_MS};
            const pollMs = ${HIGHLIGHT_RENDER_POLL_MS};

            const countHighlights = () => {
                const nodes = new Set();
                document.querySelectorAll('.kp-notebook-highlight-text').forEach(el => nodes.add(el));
                document.querySelectorAll('[id="highlight"]').forEach(el => nodes.add(el));
                document.querySelectorAll('[id^="highlight-"]:not(.kp-notebook-highlight)').forEach(el => nodes.add(el));
                document.querySelectorAll('[class*="highlight-text"]').forEach(el => nodes.add(el));
                return nodes.size;
            };

            const isAuthRedirect = () => {
                const url = window.location.href;
                return url.includes('/ap/signin') || url.includes('/ap/oa');
            };

            const isLoading = () => {
                return !!document.querySelector(
                    '.kp-notebook-annotations-loading:not([style*="display: none"]), ' +
                    '.a-spinner:not([style*="display: none"])'
                );
            };

            const isEmptyState = () => {
                return !!document.querySelector(
                    '.kp-notebook-annotations-empty, .kp-notebook-no-annotations, ' +
                    '[class*="no-highlights"], [class*="empty-annotations"]'
                );
            };

            const tick = () => {
                if (isAuthRedirect()) {
                    resolve({ ready: false, count: 0, loading: false, authRedirect: true, elapsedMs: Date.now() - started });
                    return;
                }

                const count = countHighlights();
                const loading = isLoading();
                const elapsedMs = Date.now() - started;

                // Highlights found and not loading — ready
                if (count > 0 && !loading) {
                    resolve({ ready: true, count, loading, authRedirect: false, elapsedMs });
                    return;
                }

                // Empty state detected — book genuinely has no highlights
                if (!loading && isEmptyState()) {
                    resolve({ ready: true, count: 0, loading: false, authRedirect: false, elapsedMs });
                    return;
                }

                // Annotations container present but still no highlights after 5s — likely empty
                if (!loading && elapsedMs > 5000 && count === 0) {
                    const hasContainer = !!document.querySelector(
                        '#kp-notebook-annotations, .kp-notebook-annotations, [id*="annotation"]'
                    );
                    if (hasContainer) {
                        resolve({ ready: true, count: 0, loading: false, authRedirect: false, elapsedMs });
                        return;
                    }
                }

                if (elapsedMs >= timeoutMs) {
                    resolve({ ready: false, count, loading, authRedirect: false, elapsedMs });
                    return;
                }

                setTimeout(tick, pollMs);
            };

            tick();
        }))();
    `;

    return await win.webContents.executeJavaScript(script);
}

/**
 * Scroll and click "load more" to expand all highlights on the page.
 * Mirrors the harvestBooksFromDom pattern but for highlight elements.
 */
async function expandAllHighlights(win: any): Promise<{ rounds: number; finalCount: number }> {
    const script = `
        (async () => {
            const timeoutMs = ${HIGHLIGHT_HARVEST_TIMEOUT_MS};
            const stepMs = ${HIGHLIGHT_HARVEST_STEP_MS};
            const stableTarget = ${HIGHLIGHT_HARVEST_STABLE_ROUNDS};
            const started = Date.now();

            const sleep = (ms) => new Promise(r => setTimeout(r, ms));

            const countHighlights = () => {
                const nodes = new Set();
                document.querySelectorAll('.kp-notebook-highlight-text').forEach(el => nodes.add(el));
                document.querySelectorAll('[id="highlight"]').forEach(el => nodes.add(el));
                document.querySelectorAll('[id^="highlight-"]:not(.kp-notebook-highlight)').forEach(el => nodes.add(el));
                document.querySelectorAll('[class*="highlight-text"]').forEach(el => nodes.add(el));
                return nodes.size;
            };

            const isVisible = (el) => {
                if (!el) return false;
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden') return false;
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            };

            const clickLoadMore = () => {
                let clicks = 0;
                const controls = document.querySelectorAll(
                    'button, a, [role="button"], div[role="button"], span[role="button"], [data-pagination-token]'
                );
                for (const control of Array.from(controls)) {
                    if (!isVisible(control)) continue;
                    const text = (control.textContent || '').replace(/\\s+/g, ' ').trim();
                    const aria = (control.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
                    const dataToken = control.getAttribute('data-pagination-token') ||
                        control.getAttribute('data-next-token') || '';
                    const shouldClick =
                        !!dataToken ||
                        /load\\s+more|show\\s+more|see\\s+more|next\\s+page|mehr\\s+anzeigen|mostrar\\s+m[aá]s|voir\\s+plus/i.test(text) ||
                        /load\\s+more|show\\s+more|next/i.test(aria);
                    if (!shouldClick) continue;
                    if (control.hasAttribute('disabled') || control.getAttribute('aria-disabled') === 'true') continue;
                    control.click();
                    clicks++;
                }
                return clicks;
            };

            let lastCount = countHighlights();
            let stableRounds = 0;
            let rounds = 0;

            while (Date.now() - started < timeoutMs) {
                rounds++;

                // Scroll to bottom to trigger any lazy loading
                const scrollTarget = Math.max(
                    document.body ? document.body.scrollHeight : 0,
                    document.documentElement ? document.documentElement.scrollHeight : 0
                );
                window.scrollTo(0, scrollTarget);

                clickLoadMore();
                await sleep(stepMs);

                const count = countHighlights();
                if (count > lastCount) {
                    lastCount = count;
                    stableRounds = 0;
                } else {
                    stableRounds++;
                }

                if (stableRounds >= stableTarget) break;
            }

            return { rounds, finalCount: lastCount };
        })();
    `;

    return await win.webContents.executeJavaScript(script);
}

/**
 * Fetch highlights for multiple books using an embedded BrowserWindow.
 * Desktop-only — requires @electron/remote.
 *
 * Uses the same persistent partition as login, so auth cookies are shared.
 * For each ASIN, navigates to the highlight page, waits for Amazon's JS
 * to render highlights, expands all via scroll+load-more, then extracts
 * the rendered HTML and parses it with the existing parseHighlightsHTML().
 */
export async function fetchHighlightsEmbedded(
    region: string,
    asins: string[],
    signal?: AbortSignal,
    onProgress?: (completed: number, total: number) => void,
): Promise<{ results: Map<string, KindleHighlight[]>; authExpired: boolean }> {
    if (Platform.isMobile) {
        throw new Error('Embedded highlight fetching is desktop-only');
    }

     
    const remote = require('@electron/remote');
    const BrowserWindow = remote.BrowserWindow;
    const notebookUrl = getNotebookUrl(region);

    const results = new Map<string, KindleHighlight[]>();
    let completed = 0;

    // Create a single hidden BrowserWindow and reuse it for all ASINs.
    // The shared persistent partition supplies auth cookies automatically.
    const win = new BrowserWindow({
        width: 1000,
        height: 800,
        show: false,
        webPreferences: {
            webSecurity: false,
            nodeIntegration: false,
            partition: PARTITION,
        },
    });

    try {
        for (const asin of asins) {
            if (signal?.aborted) break;

            const url = `${notebookUrl}?asin=${encodeURIComponent(asin)}`;
            logger.debug('Kindle', `Embedded highlight fetch: ${asin}`);

            try {
                // Navigate to the book's highlight page
                await navigateAndWait(win, url);

                // Wait for highlight elements to render
                const readiness = await waitForHighlightRender(win);
                logger.debug('Kindle', `Highlight readiness for ${asin}: ready=${readiness.ready}, count=${readiness.count}, authRedirect=${readiness.authRedirect}, elapsed=${readiness.elapsedMs}ms`);

                if (readiness.authRedirect) {
                    logger.debug('Kindle', 'Auth redirect detected during highlight fetch');
                    return { results, authExpired: true };
                }

                // Expand all highlights via scroll + load-more
                if (readiness.ready && readiness.count > 0) {
                    const harvest = await expandAllHighlights(win);
                    logger.debug('Kindle', `Highlight expansion for ${asin}: rounds=${harvest.rounds}, finalCount=${harvest.finalCount}`);
                }

                // Extract the fully-rendered HTML
                const html: string = await win.webContents.executeJavaScript(
                    `document.querySelector('body').innerHTML`
                );

                // Parse with the existing highlight parser
                const highlights = parseHighlightsHTML(html, asin);
                results.set(asin, highlights);
                logger.debug('Kindle', `Parsed ${highlights.length} highlights for ${asin}`);
            } catch (err) {
                // Per-book isolation: failed book doesn't block others
                logger.error('Kindle', `Embedded fetch failed for ${asin}:`, err);
                results.set(asin, []);
            }

            completed++;
            onProgress?.(completed, asins.length);
        }
    } finally {
        try {
            if (!win.isDestroyed()) win.destroy();
        } catch { /* already destroyed */ }
    }

    return { results, authExpired: false };
}
