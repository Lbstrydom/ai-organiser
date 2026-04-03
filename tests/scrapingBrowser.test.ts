/**
 * ScrapingBrowser tests
 *
 * Verifies fetchHTML end-to-end, always-close guarantee,
 * endpoint validation, error passthrough, and forceClose.
 */

import { ScrapingBrowser } from '../src/services/research/brightdata/scrapingBrowser';

// Mock CDPClient
const mockConnect = vi.fn();
const mockNavigate = vi.fn();
const mockGetPageHTML = vi.fn();
const mockClose = vi.fn();

vi.mock('../src/services/research/brightdata/cdpClient', () => {
    class MockCDPClient {
        connect = (...a: unknown[]) => mockConnect(...a);
        navigate = (...a: unknown[]) => mockNavigate(...a);
        getPageHTML = (...a: unknown[]) => mockGetPageHTML(...a);
        close = (...a: unknown[]) => mockClose(...a);
    }
    return { CDPClient: MockCDPClient };
});

describe('ScrapingBrowser', () => {
    let browser: ScrapingBrowser;
    const mockGetEndpoint = vi.fn<() => Promise<string | null>>();

    beforeEach(() => {
        vi.clearAllMocks();
        mockGetEndpoint.mockResolvedValue('wss://brd-customer-test@brd.superproxy.io:9222');
        mockConnect.mockResolvedValue(undefined);
        mockNavigate.mockResolvedValue(undefined);
        mockGetPageHTML.mockResolvedValue('<html><body>Page content</body></html>');
        mockClose.mockResolvedValue(undefined);
        browser = new ScrapingBrowser(mockGetEndpoint);
    });

    describe('fetchHTML()', () => {
        it('connects, navigates, extracts HTML, and closes', async () => {
            const html = await browser.fetchHTML('https://example.com');

            expect(mockConnect).toHaveBeenCalledWith('wss://brd-customer-test@brd.superproxy.io:9222');
            expect(mockNavigate).toHaveBeenCalledWith('https://example.com');
            expect(mockGetPageHTML).toHaveBeenCalledOnce();
            expect(mockClose).toHaveBeenCalledOnce();
            expect(html).toBe('<html><body>Page content</body></html>');
        });

        it('always closes connection even on navigate error', async () => {
            mockNavigate.mockRejectedValue(new Error('Navigation timeout'));

            await expect(browser.fetchHTML('https://broken.com')).rejects.toThrow('Navigation timeout');

            expect(mockClose).toHaveBeenCalledOnce();
        });

        it('always closes connection even on connect error', async () => {
            mockConnect.mockRejectedValue(new Error('Connection refused'));

            await expect(browser.fetchHTML('https://example.com')).rejects.toThrow('Connection refused');

            expect(mockClose).toHaveBeenCalledOnce();
        });

        it('always closes connection even on getPageHTML error', async () => {
            mockGetPageHTML.mockRejectedValue(new Error('Evaluation failed'));

            await expect(browser.fetchHTML('https://example.com')).rejects.toThrow('Evaluation failed');

            expect(mockClose).toHaveBeenCalledOnce();
        });

        it('throws when endpoint is not configured', async () => {
            mockGetEndpoint.mockResolvedValue(null);

            await expect(browser.fetchHTML('https://example.com')).rejects.toThrow('Scraping Browser endpoint not configured');
        });

        it('passes through HTML content from CDP client', async () => {
            const complex = '<html><head><title>Test</title></head><body><div id="app">Rendered</div></body></html>';
            mockGetPageHTML.mockResolvedValue(complex);

            const html = await browser.fetchHTML('https://spa.example.com');

            expect(html).toBe(complex);
        });
    });

    describe('forceClose()', () => {
        it('does nothing when no active client', async () => {
            await browser.forceClose(); // Should not throw
        });

        it('closes active client during fetchHTML', async () => {
            // Simulate a long-running navigation
            let resolveNav: (value?: unknown) => void;
            mockNavigate.mockImplementation(() => new Promise(resolve => { resolveNav = resolve; }));

            const fetchPromise = browser.fetchHTML('https://slow.com').catch(() => {});

            // Allow fetchHTML to progress past getEndpoint() and connect() to navigate()
            await new Promise(r => setTimeout(r, 10));

            // Force close while navigation is pending
            await browser.forceClose();

            // The active client should have been closed
            expect(mockClose).toHaveBeenCalled();

            // Clean up by resolving the navigation
            resolveNav!();
            await fetchPromise;
        });
    });

    describe('isConfigured()', () => {
        it('returns true when endpoint is present', async () => {
            mockGetEndpoint.mockResolvedValue('wss://endpoint:9222');

            expect(await browser.isConfigured()).toBe(true);
        });

        it('returns false when endpoint is null', async () => {
            mockGetEndpoint.mockResolvedValue(null);

            expect(await browser.isConfigured()).toBe(false);
        });
    });
});
