/**
 * Kindle Auth Methods Tests
 *
 * Tests for the AuthMethod strategy pattern: interface compliance,
 * availability checks, fallback chain ordering.
 */

import { BookmarkletAuthMethod, ConsoleAuthMethod, buildAuthMethodChain } from '../src/services/kindle/kindleAuthMethods';
import type { Translations } from '../src/i18n/types';

// Minimal translations stub for auth method constructors
const mockT = {
    kindleSync: {
        bookmarkletDrag: 'Drag this to your bookmarks bar',
        bookmarkletCopy: 'Copy bookmarklet',
        bookmarkletCopied: 'Bookmarklet copied!',
        advancedConsole: 'Advanced: use browser console',
        validationReady: 'Ready — {count} cookies detected',
        validationMissingSession: 'Missing session-id cookie',
        validationMissingUbid: 'Missing ubid cookie',
        validationEmpty: 'Paste your cookies above',
        saveConnect: 'Save & Connect',
        sessionExpired: 'Session expired — please sign in again',
        signInBrowser: 'Sign in with Browser',
        signInBrowserDesc: 'Opens Amazon sign-in page.',
        desktopOnly: 'Desktop only',
        waitingForLogin: 'Waiting for login...',
        loginSuccess: 'Successfully signed in!',
        loginTimeout: 'Login timed out.',
        loginFailed: 'Login failed.',
        loginClosed: 'Sign-in window was closed.',
        otherSignInOptions: 'Other sign-in options',
        fallbackNotice: 'Browser sign-in failed.',
    },
    modals: {
        kindle: {
            step1Title: 'Step 1: Open Amazon Kindle',
            step1Desc: 'Click below to open your Kindle notebook.',
            openAmazon: 'Open Amazon Kindle',
            step2Title: 'Step 2: Copy cookies',
            step2Desc: 'Press F12 to open the browser console.',
            copiedToClipboard: 'Copied to clipboard',
            step3Title: 'Step 3: Paste cookies below',
            pasteCookies: 'session-id=xxx; ubid-main=xxx; ...',
        },
    },
} as unknown as Translations;

describe('Kindle Auth Methods', () => {
    // =====================================================================
    // BookmarkletAuthMethod
    // =====================================================================

    describe('BookmarkletAuthMethod', () => {
        it('has id "bookmarklet"', () => {
            const method = new BookmarkletAuthMethod(mockT);
            expect(method.id).toBe('bookmarklet');
        });

        it('is always available', () => {
            const method = new BookmarkletAuthMethod(mockT);
            expect(method.isAvailable()).toBe(true);
        });

        it('is not desktop-only', () => {
            const method = new BookmarkletAuthMethod(mockT);
            expect(method.desktopOnly).toBe(false);
        });

        it('start() returns interactive (not autonomous)', async () => {
            const method = new BookmarkletAuthMethod(mockT);
            const result = await method.start('com');
            expect(result.success).toBe(false);
            expect(result.error).toBe('interactive');
        });

        it('has renderManualUI method', () => {
            const method = new BookmarkletAuthMethod(mockT);
            expect(method.renderManualUI).toBeDefined();
        });

        it('has icon "bookmark"', () => {
            const method = new BookmarkletAuthMethod(mockT);
            expect(method.icon).toBe('bookmark');
        });
    });

    // =====================================================================
    // ConsoleAuthMethod
    // =====================================================================

    describe('ConsoleAuthMethod', () => {
        it('has id "console"', () => {
            const method = new ConsoleAuthMethod(mockT);
            expect(method.id).toBe('console');
        });

        it('is always available', () => {
            const method = new ConsoleAuthMethod(mockT);
            expect(method.isAvailable()).toBe(true);
        });

        it('is not desktop-only', () => {
            const method = new ConsoleAuthMethod(mockT);
            expect(method.desktopOnly).toBe(false);
        });

        it('start() returns interactive (not autonomous)', async () => {
            const method = new ConsoleAuthMethod(mockT);
            const result = await method.start('com');
            expect(result.success).toBe(false);
            expect(result.error).toBe('interactive');
        });

        it('has renderManualUI method', () => {
            const method = new ConsoleAuthMethod(mockT);
            expect(method.renderManualUI).toBeDefined();
        });

        it('has icon "terminal"', () => {
            const method = new ConsoleAuthMethod(mockT);
            expect(method.icon).toBe('terminal');
        });
    });

    // =====================================================================
    // buildAuthMethodChain
    // =====================================================================

    describe('buildAuthMethodChain', () => {
        it('returns at least bookmarklet and console methods', () => {
            const methods = buildAuthMethodChain(mockT);
            expect(methods.length).toBeGreaterThanOrEqual(2);

            const ids = methods.map(m => m.id);
            expect(ids).toContain('bookmarklet');
            expect(ids).toContain('console');
        });

        it('bookmarklet comes before console in chain', () => {
            const methods = buildAuthMethodChain(mockT);
            const bookmarkletIdx = methods.findIndex(m => m.id === 'bookmarklet');
            const consoleIdx = methods.findIndex(m => m.id === 'console');
            expect(bookmarkletIdx).toBeLessThan(consoleIdx);
        });

        it('all methods implement isAvailable()', () => {
            const methods = buildAuthMethodChain(mockT);
            for (const method of methods) {
                expect(typeof method.isAvailable).toBe('function');
                expect(typeof method.isAvailable()).toBe('boolean');
            }
        });

        it('all methods implement start()', () => {
            const methods = buildAuthMethodChain(mockT);
            for (const method of methods) {
                expect(typeof method.start).toBe('function');
            }
        });

        it('excludes embedded method in test environment (no @electron/remote)', () => {
            const methods = buildAuthMethodChain(mockT);
            const ids = methods.map(m => m.id);
            // In test environment, @electron/remote is not available
            expect(ids).not.toContain('embedded');
        });

        it('first method is always available (bookmarklet or embedded)', () => {
            const methods = buildAuthMethodChain(mockT);
            expect(methods[0].isAvailable()).toBe(true);
        });
    });
});
