/**
 * WebUnlocker tests
 *
 * Verifies HTML fetch, zone API body format, error handling,
 * missing key error, and configuration checks.
 */

vi.mock('obsidian', async () => {
    const mod = await import('./mocks/obsidian');
    return {
        ...mod,
        requestUrl: vi.fn(),
    };
});

import { requestUrl } from 'obsidian';
import { WebUnlocker } from '../src/services/research/brightdata/webUnlocker';

const mockRequestUrl = requestUrl as unknown as ReturnType<typeof vi.fn>;

describe('WebUnlocker', () => {
    let unlocker: WebUnlocker;
    const mockGetApiKey = vi.fn<() => Promise<string | null>>();

    beforeEach(() => {
        vi.clearAllMocks();
        mockGetApiKey.mockResolvedValue('wu-test-key');
        unlocker = new WebUnlocker(mockGetApiKey);
    });

    describe('fetchHTML()', () => {
        it('sends POST to Bright Data request endpoint with Bearer auth', async () => {
            mockRequestUrl.mockResolvedValue({
                status: 200,
                text: '<html><body>Content</body></html>',
            });

            await unlocker.fetchHTML('https://example.com/page');

            expect(mockRequestUrl).toHaveBeenCalledOnce();
            const call = mockRequestUrl.mock.calls[0][0];
            expect(call.url).toBe('https://api.brightdata.com/request');
            expect(call.method).toBe('POST');
            expect(call.headers).toMatchObject({
                'Authorization': 'Bearer wu-test-key',
                'Content-Type': 'application/json',
            });
        });

        it('includes zone, url, and format in request body', async () => {
            mockRequestUrl.mockResolvedValue({
                status: 200,
                text: '<html></html>',
            });

            await unlocker.fetchHTML('https://example.com/target');

            const call = mockRequestUrl.mock.calls[0][0];
            const body = JSON.parse(call.body as string);
            expect(body.zone).toBe('web_unlocker1');
            expect(body.url).toBe('https://example.com/target');
            expect(body.format).toBe('raw');
        });

        it('passes throw: false to requestUrl so status is checked manually', async () => {
            mockRequestUrl.mockResolvedValue({
                status: 200,
                text: '<html></html>',
            });

            await unlocker.fetchHTML('https://example.com');

            expect(mockRequestUrl.mock.calls[0][0].throw).toBe(false);
        });

        it('returns raw HTML text on success', async () => {
            const html = '<html><body><h1>Hello World</h1></body></html>';
            mockRequestUrl.mockResolvedValue({
                status: 200,
                text: html,
            });

            const result = await unlocker.fetchHTML('https://example.com');

            expect(result).toBe(html);
        });

        it('throws on non-200 status', async () => {
            mockRequestUrl.mockResolvedValue({
                status: 403,
                text: 'Forbidden',
            });

            await expect(unlocker.fetchHTML('https://blocked.com')).rejects.toThrow('Web Unlocker failed (403)');
        });

        it('throws on HTTP error', async () => {
            mockRequestUrl.mockRejectedValue(new Error('Network error'));

            await expect(unlocker.fetchHTML('https://example.com')).rejects.toThrow('Network error');
        });

        it('throws when API key is not configured', async () => {
            mockGetApiKey.mockResolvedValue(null);

            await expect(unlocker.fetchHTML('https://example.com')).rejects.toThrow('Web Unlocker API key not configured');
        });
    });

    describe('isConfigured()', () => {
        it('returns true when key present', async () => {
            mockGetApiKey.mockResolvedValue('wu-key-123');

            expect(await unlocker.isConfigured()).toBe(true);
        });

        it('returns false when key is null', async () => {
            mockGetApiKey.mockResolvedValue(null);

            expect(await unlocker.isConfigured()).toBe(false);
        });
    });
});
