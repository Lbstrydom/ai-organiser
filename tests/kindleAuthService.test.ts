/**
 * Kindle Auth Service Tests (v2)
 *
 * Tests for cookie-based auth: getNotebookUrl, buildRequestHeaders,
 * detectAuthExpiry, cookie CRUD, parseManualCookies.
 */

import {
    isAuthenticated,
    getStoredCookies,
    storeCookies,
    clearCookies,
    parseManualCookies,
    validateCookieFormat,
    getCookieAgeDays,
    getNotebookUrl,
    buildRequestHeaders,
    detectAuthExpiry,
    parseEnhancedPayload,
    isEnhancedPayload,
} from '../src/services/kindle/kindleAuthService';
import { PLUGIN_SECRET_IDS } from '../src/core/secretIds';
import type { KindleCookiePayload } from '../src/services/kindle/kindleTypes';

// =========================================================================
// Mock plugin for cookie management tests
// =========================================================================

function makeMockPlugin(secrets: Record<string, string> = {}, settings: Record<string, unknown> = {}) {
    const store = { ...secrets };
    return {
        settings: {
            kindleAmazonRegion: 'com',
            ...settings,
        },
        secretStorageService: {
            getSecret: vi.fn(async (key: string) => store[key] ?? null),
            setSecret: vi.fn(async (key: string, value: string) => { store[key] = value; }),
            removeSecret: vi.fn(async (key: string) => { delete store[key]; }),
        },
    } as any;
}

describe('Kindle Auth Service', () => {
    // =====================================================================
    // getNotebookUrl
    // =====================================================================

    describe('getNotebookUrl', () => {
        it('returns read.amazon.com for "com" region', () => {
            expect(getNotebookUrl('com')).toBe('https://read.amazon.com/notebook');
        });

        it('returns read.amazon.co.uk for "co.uk" region', () => {
            expect(getNotebookUrl('co.uk')).toBe('https://read.amazon.co.uk/notebook');
        });

        it('returns lesen.amazon.de for "de" region', () => {
            expect(getNotebookUrl('de')).toBe('https://lesen.amazon.de/notebook');
        });

        it('falls back to read.amazon.{region} for unknown region', () => {
            expect(getNotebookUrl('zz')).toBe('https://read.amazon.zz/notebook');
        });
    });

    // =====================================================================
    // buildRequestHeaders
    // =====================================================================

    describe('buildRequestHeaders', () => {
        const payload: KindleCookiePayload = {
            cookies: [
                { name: 'session-id', value: 'abc', domain: '.amazon.com', path: '/' },
            ],
            cookieString: 'session-id=abc; ubid-main=xyz',
            userAgent: 'TestAgent/1.0',
            region: 'com',
            capturedAt: '2026-01-01T00:00:00Z',
            source: 'browser',
        };

        it('includes Cookie header from cookieString', () => {
            const headers = buildRequestHeaders(payload);
            expect(headers['Cookie']).toBe('session-id=abc; ubid-main=xyz');
        });

        it('includes User-Agent from payload', () => {
            const headers = buildRequestHeaders(payload);
            expect(headers['User-Agent']).toBe('TestAgent/1.0');
        });

        it('uses default User-Agent when payload has no userAgent', () => {
            const noUaPayload = { ...payload, userAgent: '' };
            const headers = buildRequestHeaders(noUaPayload);
            expect(headers['User-Agent']).toBeTruthy();
            expect(headers['User-Agent']).toContain('Mozilla');
        });
    });

    // =====================================================================
    // detectAuthExpiry
    // =====================================================================

    describe('detectAuthExpiry', () => {
        it('returns true for HTML containing signIn form', () => {
            const html = '<html><body><form name="signIn"><input id="ap_email" /></form></body></html>';
            expect(detectAuthExpiry(html)).toBe(true);
        });

        it('returns true for HTML containing ap_email and ap_password inputs', () => {
            const html = '<html><body><input id="ap_email" /><input id="ap_password" /></body></html>';
            expect(detectAuthExpiry(html)).toBe(true);
        });

        it('returns false for HTML containing only ap_email input (no password)', () => {
            const html = '<html><body><input id="ap_email" /></body></html>';
            expect(detectAuthExpiry(html)).toBe(false);
        });

        it('returns false for normal notebook HTML', () => {
            const html = '<html><body><div class="kp-notebook-library">books here</div></body></html>';
            expect(detectAuthExpiry(html)).toBe(false);
        });

        it('returns false for empty HTML', () => {
            expect(detectAuthExpiry('')).toBe(false);
        });
    });

    // =====================================================================
    // Cookie Management (SecretStorage CRUD)
    // =====================================================================

    describe('Cookie management', () => {
        const samplePayload: KindleCookiePayload = {
            cookies: [
                { name: 'session-id', value: 'abc123', domain: '.amazon.com', path: '/' },
                { name: 'ubid-main', value: 'xyz789', domain: '.amazon.com', path: '/' },
            ],
            cookieString: 'session-id=abc123; ubid-main=xyz789',
            userAgent: 'Mozilla/5.0 Test',
            region: 'com',
            capturedAt: '2026-01-01T00:00:00Z',
            source: 'browser',
        };

        it('isAuthenticated() returns true when cookies exist and region matches', async () => {
            const plugin = makeMockPlugin({
                [PLUGIN_SECRET_IDS.KINDLE_COOKIES]: JSON.stringify(samplePayload),
            });
            const result = await isAuthenticated(plugin);
            expect(result).toBe(true);
        });

        it('isAuthenticated() returns false when no cookies stored', async () => {
            const plugin = makeMockPlugin();
            const result = await isAuthenticated(plugin);
            expect(result).toBe(false);
        });

        it('isAuthenticated() returns false when region does not match', async () => {
            const ukPayload = { ...samplePayload, region: 'co.uk' };
            const plugin = makeMockPlugin({
                [PLUGIN_SECRET_IDS.KINDLE_COOKIES]: JSON.stringify(ukPayload),
            });
            const result = await isAuthenticated(plugin);
            expect(result).toBe(false);
        });

        it('getStoredCookies() parses valid JSON from SecretStorage', async () => {
            const plugin = makeMockPlugin({
                [PLUGIN_SECRET_IDS.KINDLE_COOKIES]: JSON.stringify(samplePayload),
            });
            const result = await getStoredCookies(plugin);
            expect(result).not.toBeNull();
            expect(result!.cookies).toHaveLength(2);
            expect(result!.region).toBe('com');
            expect(result!.userAgent).toBe('Mozilla/5.0 Test');
        });

        it('getStoredCookies() returns null for missing secret', async () => {
            const plugin = makeMockPlugin();
            const result = await getStoredCookies(plugin);
            expect(result).toBeNull();
        });

        it('getStoredCookies() returns null for invalid JSON', async () => {
            const plugin = makeMockPlugin({
                [PLUGIN_SECRET_IDS.KINDLE_COOKIES]: 'not-valid-json{{{',
            });
            const result = await getStoredCookies(plugin);
            expect(result).toBeNull();
        });

        it('storeCookies() stringifies payload and stores it', async () => {
            const plugin = makeMockPlugin();
            await storeCookies(plugin, samplePayload);
            expect(plugin.secretStorageService.setSecret).toHaveBeenCalledWith(
                PLUGIN_SECRET_IDS.KINDLE_COOKIES,
                JSON.stringify(samplePayload)
            );
        });

        it('clearCookies() removes the secret', async () => {
            const plugin = makeMockPlugin({
                [PLUGIN_SECRET_IDS.KINDLE_COOKIES]: JSON.stringify(samplePayload),
            });
            await clearCookies(plugin);
            expect(plugin.secretStorageService.removeSecret).toHaveBeenCalledWith(
                PLUGIN_SECRET_IDS.KINDLE_COOKIES
            );
        });
    });

    // =====================================================================
    // parseManualCookies
    // =====================================================================

    describe('parseManualCookies', () => {
        it('returns null for empty string', () => {
            expect(parseManualCookies('', 'com')).toBeNull();
            expect(parseManualCookies('   ', 'com')).toBeNull();
        });

        it('returns null when session-id is missing', () => {
            const cookieStr = 'ubid-main=131-1234567-1234567; x-main=abcdef';
            expect(parseManualCookies(cookieStr, 'com')).toBeNull();
        });

        it('returns null when ubid is missing', () => {
            const cookieStr = 'session-id=123-456-789; x-main=abcdef';
            expect(parseManualCookies(cookieStr, 'com')).toBeNull();
        });

        it('parses valid cookie string into KindleCDPCookie[]', () => {
            const cookieStr = 'session-id=123-456-789; ubid-main=131-1234567-1234567; x-main=abcdef';
            const result = parseManualCookies(cookieStr, 'com');

            expect(result).not.toBeNull();
            expect(result!).toHaveLength(3);
            expect(result![0].name).toBe('session-id');
            expect(result![0].value).toBe('123-456-789');
            expect(result![1].name).toBe('ubid-main');
            expect(result![1].value).toBe('131-1234567-1234567');
            expect(result![2].name).toBe('x-main');
        });

        it('sets correct domain from region', () => {
            const cookieStr = 'session-id=abc; ubid-acbuk=xyz';
            const result = parseManualCookies(cookieStr, 'co.uk');

            expect(result).not.toBeNull();
            for (const cookie of result!) {
                expect(cookie.domain).toBe('.amazon.co.uk');
                expect(cookie.path).toBe('/');
                expect(cookie.secure).toBe(true);
            }
        });

        it('handles extra whitespace in cookie pairs', () => {
            const cookieStr = '  session-id = abc123 ;  ubid-main = xyz789 ;  x-main = def  ';
            const result = parseManualCookies(cookieStr, 'com');

            expect(result).not.toBeNull();
            expect(result!).toHaveLength(3);
            expect(result![0].name).toBe('session-id');
            expect(result![0].value).toBe('abc123');
        });
    });

    // =====================================================================
    // validateCookieFormat
    // =====================================================================

    describe('validateCookieFormat', () => {
        it('returns invalid for empty string', () => {
            const result = validateCookieFormat('');
            expect(result).toEqual({ hasSessionId: false, hasUbid: false, cookieCount: 0, isValid: false });
        });

        it('returns invalid for whitespace-only string', () => {
            const result = validateCookieFormat('   ');
            expect(result).toEqual({ hasSessionId: false, hasUbid: false, cookieCount: 0, isValid: false });
        });

        it('returns valid for complete cookie string', () => {
            const result = validateCookieFormat('session-id=abc; ubid-main=xyz; x-main=foo');
            expect(result).toEqual({ hasSessionId: true, hasUbid: true, cookieCount: 3, isValid: true });
        });

        it('returns invalid when session-id is missing', () => {
            const result = validateCookieFormat('ubid-main=xyz; x-main=foo');
            expect(result.isValid).toBe(false);
            expect(result.hasSessionId).toBe(false);
            expect(result.hasUbid).toBe(true);
        });

        it('returns invalid when ubid is missing', () => {
            const result = validateCookieFormat('session-id=abc; x-main=foo');
            expect(result.isValid).toBe(false);
            expect(result.hasSessionId).toBe(true);
            expect(result.hasUbid).toBe(false);
        });

        it('detects ubid with regional suffix', () => {
            const result = validateCookieFormat('session-id=abc; ubid-acbuk=xyz');
            expect(result.isValid).toBe(true);
            expect(result.hasUbid).toBe(true);
        });

        it('counts cookies correctly', () => {
            const result = validateCookieFormat('a=1; b=2; session-id=x; ubid-main=y; e=5');
            expect(result.cookieCount).toBe(5);
            expect(result.isValid).toBe(true);
        });

        it('skips malformed pairs without equals sign', () => {
            const result = validateCookieFormat('session-id=abc; badcookie; ubid-main=xyz');
            expect(result.cookieCount).toBe(2);
            expect(result.isValid).toBe(true);
        });
    });

    // =====================================================================
    // getCookieAgeDays
    // =====================================================================

    describe('getCookieAgeDays', () => {
        it('returns 0 for a cookie captured today', () => {
            const payload: KindleCookiePayload = {
                cookies: [],
                cookieString: '',
                userAgent: '',
                region: 'com',
                capturedAt: new Date().toISOString(),
                source: 'manual',
            };
            expect(getCookieAgeDays(payload)).toBe(0);
        });

        it('returns correct days for a 3-day old cookie', () => {
            const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
            const payload: KindleCookiePayload = {
                cookies: [],
                cookieString: '',
                userAgent: '',
                region: 'com',
                capturedAt: threeDaysAgo,
                source: 'manual',
            };
            expect(getCookieAgeDays(payload)).toBe(3);
        });

        it('returns correct days for a 14-day old cookie', () => {
            const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
            const payload: KindleCookiePayload = {
                cookies: [],
                cookieString: '',
                userAgent: '',
                region: 'com',
                capturedAt: fourteenDaysAgo,
                source: 'manual',
            };
            expect(getCookieAgeDays(payload)).toBe(14);
        });

        it('returns -1 when capturedAt is missing', () => {
            const payload: KindleCookiePayload = {
                cookies: [],
                cookieString: '',
                userAgent: '',
                region: 'com',
                capturedAt: '',
                source: 'manual',
            };
            expect(getCookieAgeDays(payload)).toBe(-1);
        });
    });

    // =====================================================================
    // validateCookieFormat — Enhanced JSON payload support
    // =====================================================================

    describe('validateCookieFormat (JSON payloads)', () => {
        it('validates an enhanced JSON payload with valid cookies in .c', () => {
            const json = JSON.stringify({ c: 'session-id=abc; ubid-main=xyz', b: [] });
            const result = validateCookieFormat(json);
            expect(result.isValid).toBe(true);
            expect(result.hasSessionId).toBe(true);
            expect(result.hasUbid).toBe(true);
        });

        it('rejects an enhanced JSON payload with missing session-id', () => {
            const json = JSON.stringify({ c: 'ubid-main=xyz; other=123', b: [] });
            const result = validateCookieFormat(json);
            expect(result.isValid).toBe(false);
            expect(result.hasSessionId).toBe(false);
        });

        it('rejects an enhanced JSON payload with missing ubid', () => {
            const json = JSON.stringify({ c: 'session-id=abc; other=123', b: [] });
            const result = validateCookieFormat(json);
            expect(result.isValid).toBe(false);
            expect(result.hasUbid).toBe(false);
        });

        it('handles malformed JSON gracefully (falls back to plain check)', () => {
            const badJson = '{ not valid json }';
            const result = validateCookieFormat(badJson);
            expect(result.isValid).toBe(false);
        });
    });

    // =====================================================================
    // parseEnhancedPayload
    // =====================================================================

    describe('parseEnhancedPayload', () => {
        it('returns null for plain cookie strings', () => {
            expect(parseEnhancedPayload('session-id=abc; ubid-main=xyz')).toBeNull();
        });

        it('parses a valid enhanced payload with books', () => {
            const payload = JSON.stringify({
                c: 'session-id=abc; ubid-main=xyz',
                b: [
                    { a: 'B08N5WRWNW', t: 'Atomic Habits', u: 'James Clear', h: 42, i: 'https://img.com/cover.jpg' },
                    { a: 'B07MBRX7VC', t: 'Deep Work', u: 'Cal Newport', h: 15 },
                ],
            });
            const result = parseEnhancedPayload(payload);
            expect(result).not.toBeNull();
            expect(result!.cookieString).toBe('session-id=abc; ubid-main=xyz');
            expect(result!.books).toHaveLength(2);
            expect(result!.books[0].asin).toBe('B08N5WRWNW');
            expect(result!.books[0].title).toBe('Atomic Habits');
            expect(result!.books[0].author).toBe('James Clear');
            expect(result!.books[0].highlightCount).toBe(42);
            expect(result!.books[0].imageUrl).toBe('https://img.com/cover.jpg');
            expect(result!.books[1].imageUrl).toBeUndefined();
        });

        it('parses a payload with empty book list', () => {
            const payload = JSON.stringify({ c: 'session-id=abc; ubid-main=xyz', b: [] });
            const result = parseEnhancedPayload(payload);
            expect(result).not.toBeNull();
            expect(result!.cookieString).toBe('session-id=abc; ubid-main=xyz');
            expect(result!.books).toHaveLength(0);
        });

        it('parses a payload with no b field (books array empty)', () => {
            const payload = JSON.stringify({ c: 'session-id=abc; ubid-main=xyz' });
            const result = parseEnhancedPayload(payload);
            expect(result).not.toBeNull();
            expect(result!.books).toHaveLength(0);
        });

        it('returns null for JSON without c field', () => {
            const payload = JSON.stringify({ b: [{ a: 'B123' }] });
            expect(parseEnhancedPayload(payload)).toBeNull();
        });

        it('returns null for JSON with non-string c field', () => {
            const payload = JSON.stringify({ c: 123, b: [] });
            expect(parseEnhancedPayload(payload)).toBeNull();
        });

        it('skips malformed book entries (missing asin)', () => {
            const payload = JSON.stringify({
                c: 'session-id=abc; ubid-main=xyz',
                b: [
                    { t: 'No ASIN', u: 'Author' },
                    { a: 'B08N5WRWNW', t: 'Valid Book', u: 'Author', h: 5 },
                ],
            });
            const result = parseEnhancedPayload(payload);
            expect(result!.books).toHaveLength(1);
            expect(result!.books[0].asin).toBe('B08N5WRWNW');
        });

        it('provides defaults for missing book fields', () => {
            const payload = JSON.stringify({
                c: 'session-id=abc; ubid-main=xyz',
                b: [{ a: 'B123456789' }],
            });
            const result = parseEnhancedPayload(payload);
            expect(result!.books[0].title).toBe('Unknown Title');
            expect(result!.books[0].author).toBe('Unknown Author');
            expect(result!.books[0].highlightCount).toBe(0);
            expect(result!.books[0].imageUrl).toBeUndefined();
        });

        it('returns null for invalid JSON', () => {
            expect(parseEnhancedPayload('{ not json }')).toBeNull();
        });

        it('handles whitespace around the payload', () => {
            const payload = '  ' + JSON.stringify({ c: 'session-id=abc; ubid-main=xyz', b: [] }) + '  ';
            const result = parseEnhancedPayload(payload);
            expect(result).not.toBeNull();
        });
    });

    // =====================================================================
    // isEnhancedPayload
    // =====================================================================

    describe('isEnhancedPayload', () => {
        it('returns true for JSON-looking strings', () => {
            expect(isEnhancedPayload('{"c":"cookies"}')).toBe(true);
        });

        it('returns true with leading whitespace', () => {
            expect(isEnhancedPayload('  {"c":"cookies"}')).toBe(true);
        });

        it('returns false for plain cookie strings', () => {
            expect(isEnhancedPayload('session-id=abc; ubid-main=xyz')).toBe(false);
        });

        it('returns false for empty string', () => {
            expect(isEnhancedPayload('')).toBe(false);
        });
    });
});
