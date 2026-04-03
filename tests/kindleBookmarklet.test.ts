/**
 * Kindle Bookmarklet Tests
 *
 * Tests for the enhanced bookmarklet generator: valid JavaScript output,
 * clipboard call, window.prompt fallback, banner creation, book extraction,
 * console script variant.
 */

import { generateCookieBookmarklet, generateConsoleScript, NON_BOOK_IDS } from '../src/services/kindle/kindleBookmarklet';

describe('Kindle Bookmarklet', () => {
    describe('generateCookieBookmarklet', () => {
        it('returns a javascript: URL', () => {
            const url = generateCookieBookmarklet();
            expect(url.startsWith('javascript:')).toBe(true);
        });

        it('is URL-encoded', () => {
            const url = generateCookieBookmarklet();
            const jsBody = url.slice('javascript:'.length);
            expect(jsBody).not.toContain(' ');
        });

        it('decodes to valid JavaScript with IIFE wrapper', () => {
            const url = generateCookieBookmarklet();
            const jsBody = decodeURIComponent(url.slice('javascript:'.length));
            expect(jsBody).toMatch(/^\(function\(\)\{/);
            expect(jsBody).toMatch(/\}\)\(\);$/);
        });

        it('contains navigator.clipboard.writeText call', () => {
            const url = generateCookieBookmarklet();
            const jsBody = decodeURIComponent(url.slice('javascript:'.length));
            expect(jsBody).toContain('navigator.clipboard.writeText');
        });

        it('contains window.prompt fallback for clipboard failure', () => {
            const url = generateCookieBookmarklet();
            const jsBody = decodeURIComponent(url.slice('javascript:'.length));
            expect(jsBody).toContain('window.prompt');
        });

        it('reads document.cookie', () => {
            const url = generateCookieBookmarklet();
            const jsBody = decodeURIComponent(url.slice('javascript:'.length));
            expect(jsBody).toContain('document.cookie');
        });

        it('creates a banner element', () => {
            const url = generateCookieBookmarklet();
            const jsBody = decodeURIComponent(url.slice('javascript:'.length));
            expect(jsBody).toContain('createElement');
            expect(jsBody).toContain('appendChild');
        });

        it('auto-removes banner after timeout', () => {
            const url = generateCookieBookmarklet();
            const jsBody = decodeURIComponent(url.slice('javascript:'.length));
            expect(jsBody).toContain('setTimeout');
            expect(jsBody).toContain('.remove()');
        });

        it('contains success message text', () => {
            const url = generateCookieBookmarklet();
            const jsBody = decodeURIComponent(url.slice('javascript:'.length));
            expect(jsBody).toContain('Copied!');
        });

        it('has green background color in banner style', () => {
            const url = generateCookieBookmarklet();
            const jsBody = decodeURIComponent(url.slice('javascript:'.length));
            expect(jsBody).toContain('#22c55e');
        });

        it('returns identical output on multiple calls', () => {
            const url1 = generateCookieBookmarklet();
            const url2 = generateCookieBookmarklet();
            expect(url1).toBe(url2);
        });

        it('outputs JSON format with c and b keys', () => {
            const url = generateCookieBookmarklet();
            const jsBody = decodeURIComponent(url.slice('javascript:'.length));
            expect(jsBody).toContain('JSON.stringify');
            expect(jsBody).toContain('{c:document.cookie,b:');
        });

        it('filters out non-book element IDs', () => {
            const url = generateCookieBookmarklet();
            const jsBody = decodeURIComponent(url.slice('javascript:'.length));
            expect(jsBody).toContain('spinner');
            expect(jsBody).toContain('load-error');
            expect(jsBody).toContain('no-results');
        });

        it('has multi-strategy book extraction (ID, data-asin, link)', () => {
            const url = generateCookieBookmarklet();
            const jsBody = decodeURIComponent(url.slice('javascript:'.length));
            expect(jsBody).toContain('kp-notebook-library-');
            expect(jsBody).toContain('data-asin');
            expect(jsBody).toContain('asin=');
        });

        it('strips author prefixes', () => {
            const url = generateCookieBookmarklet();
            const jsBody = decodeURIComponent(url.slice('javascript:'.length));
            expect(jsBody).toMatch(/by\|von\|de\|di\|por\|da\|par/i);
        });
    });

    describe('generateConsoleScript', () => {
        it('returns a string (not a URL)', () => {
            const script = generateConsoleScript();
            expect(typeof script).toBe('string');
            expect(script.startsWith('javascript:')).toBe(false);
        });

        it('reads document.cookie', () => {
            const script = generateConsoleScript();
            expect(script).toContain('document.cookie');
        });

        it('uses copy() for DevTools clipboard', () => {
            const script = generateConsoleScript();
            expect(script).toContain('copy(R)');
        });

        it('outputs JSON format with c and b keys', () => {
            const script = generateConsoleScript();
            expect(script).toContain('JSON.stringify');
            expect(script).toContain('{c:document.cookie,b:');
        });

        it('does not produce IIFE wrapper', () => {
            const script = generateConsoleScript();
            expect(script).not.toMatch(/^\(function\(\)\{/);
        });

        it('returns book count message', () => {
            const script = generateConsoleScript();
            expect(script).toContain('books');
        });
    });

    describe('NON_BOOK_IDS', () => {
        it('matches "spinner"', () => {
            expect(NON_BOOK_IDS.test('spinner')).toBe(true);
        });

        it('matches "load-error"', () => {
            expect(NON_BOOK_IDS.test('load-error')).toBe(true);
        });

        it('matches "no-results"', () => {
            expect(NON_BOOK_IDS.test('no-results')).toBe(true);
        });

        it('is case-insensitive', () => {
            expect(NON_BOOK_IDS.test('SPINNER')).toBe(true);
            expect(NON_BOOK_IDS.test('Load-Error')).toBe(true);
        });

        it('does not match valid ASINs', () => {
            expect(NON_BOOK_IDS.test('B08N5WRWNW')).toBe(false);
            expect(NON_BOOK_IDS.test('B0AAAAAAAA')).toBe(false);
        });

        it('matches additional UI element IDs', () => {
            expect(NON_BOOK_IDS.test('loading')).toBe(true);
            expect(NON_BOOK_IDS.test('placeholder')).toBe(true);
            expect(NON_BOOK_IDS.test('container')).toBe(true);
            expect(NON_BOOK_IDS.test('header')).toBe(true);
            expect(NON_BOOK_IDS.test('footer')).toBe(true);
            expect(NON_BOOK_IDS.test('wrapper')).toBe(true);
            expect(NON_BOOK_IDS.test('error')).toBe(true);
        });
    });
});

