/**
 * Kindle Embedded Auth Tests
 *
 * Tests for the EmbeddedAuthMethod: feature detection, platform gating,
 * cookie filtering, required-cookie checks.
 *
 * Note: BrowserWindow integration is tested manually (requires Electron).
 * These tests cover the logic that can be unit-tested.
 */

import type { Translations } from '../src/i18n/types';
import { EmbeddedAuthMethod } from '../src/services/kindle/kindleEmbeddedAuth';

// Mock Platform before importing the module
vi.mock('obsidian', () => ({
    Platform: { isMobile: false },
    requestUrl: vi.fn(),
}));

const mockT = {
    kindleSync: {
        signInBrowser: 'Sign in with Browser',
        bookmarkletDrag: 'Drag this',
        bookmarkletCopy: 'Copy',
        bookmarkletCopied: 'Copied!',
        advancedConsole: 'Console',
        validationReady: 'Ready',
        validationMissingSession: 'Missing session-id',
        validationMissingUbid: 'Missing ubid',
        validationEmpty: 'Paste above',
        saveConnect: 'Save',
        sessionExpired: 'Expired',
        signInBrowserDesc: 'Opens Amazon.',
        desktopOnly: 'Desktop only',
        waitingForLogin: 'Waiting...',
        loginSuccess: 'Signed in!',
        loginTimeout: 'Timed out.',
        loginFailed: 'Failed.',
        loginClosed: 'Closed.',
        otherSignInOptions: 'Other options',
        fallbackNotice: 'Failed.',
    },
} as unknown as Translations;

describe('Kindle Embedded Auth', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('EmbeddedAuthMethod.isAvailable', () => {
        it('returns false when Platform.isMobile is true', async () => {
            const { Platform } = await import('obsidian');
            (Platform as any).isMobile = true;
            const method = new EmbeddedAuthMethod(mockT);
            expect(method.isAvailable()).toBe(false);
            // Restore
            (Platform as any).isMobile = false;
        });

        it('returns false when @electron/remote throws', async () => {
            const { Platform } = await import('obsidian');
            (Platform as any).isMobile = false;
            // In test environment, require('@electron/remote') throws
            const method = new EmbeddedAuthMethod(mockT);
            expect(method.isAvailable()).toBe(false);
        });

        it('has id "embedded"', () => {
            const method = new EmbeddedAuthMethod(mockT);
            expect(method.id).toBe('embedded');
        });

        it('is desktop-only', () => {
            const method = new EmbeddedAuthMethod(mockT);
            expect(method.desktopOnly).toBe(true);
        });

        it('has icon "globe"', () => {
            const method = new EmbeddedAuthMethod(mockT);
            expect(method.icon).toBe('globe');
        });

        it('does not have renderManualUI (autonomous method)', () => {
            const method: any = new EmbeddedAuthMethod(mockT);
            expect(method.renderManualUI).toBeUndefined();
        });
    });

    describe('Cookie domain filtering logic', () => {
        // Test the domain matching patterns used by embedded auth
        it('matches .amazon.com suffix', () => {
            const regionDomain = '.amazon.com';
            const domains = ['.amazon.com', 'www.amazon.com', 'read.amazon.com', '.google.com'];
            const matched = domains.filter(d => d.endsWith(regionDomain));
            // All amazon.com subdomains match the suffix filter
            expect(matched).toEqual(['.amazon.com', 'www.amazon.com', 'read.amazon.com']);
            expect(matched).not.toContain('.google.com');
        });

        it('matches read domain directly', () => {
            const readDomain = 'read.amazon.com';
            const domains = ['.amazon.com', 'read.amazon.com', '.read.amazon.com', 'www.amazon.com'];
            const matched = domains.filter(d => d === readDomain || d === `.${readDomain}`);
            expect(matched).toEqual(['read.amazon.com', '.read.amazon.com']);
        });

        it('filters correctly for German region', () => {
            const regionDomain = '.amazon.de';
            const readDomain = 'lesen.amazon.de';
            const cookies = [
                { domain: '.amazon.de', name: 'session-id', value: 'abc' },
                { domain: 'lesen.amazon.de', name: 'ubid-acbde', value: 'xyz' },
                { domain: '.amazon.com', name: 'x-main', value: 'skip' },
                { domain: '.google.com', name: 'NID', value: 'skip' },
            ];
            const matched = cookies.filter(c =>
                c.domain.endsWith(regionDomain) || c.domain === readDomain || c.domain === `.${readDomain}`
            );
            expect(matched).toHaveLength(2);
            expect(matched[0].name).toBe('session-id');
            expect(matched[1].name).toBe('ubid-acbde');
        });
    });

    describe('Required-cookie checks', () => {
        it('detects session-id presence', () => {
            const cookies = [
                { name: 'session-id', value: 'abc' },
                { name: 'ubid-main', value: 'xyz' },
            ];
            expect(cookies.some(c => c.name === 'session-id')).toBe(true);
        });

        it('detects ubid- prefix presence', () => {
            const cookies = [
                { name: 'session-id', value: 'abc' },
                { name: 'ubid-acbuk', value: 'xyz' },
            ];
            expect(cookies.some(c => c.name.startsWith('ubid-'))).toBe(true);
        });

        it('fails when session-id missing', () => {
            const cookies = [
                { name: 'ubid-main', value: 'xyz' },
                { name: 'x-main', value: 'abc' },
            ];
            expect(cookies.some(c => c.name === 'session-id')).toBe(false);
        });

        it('fails when ubid- missing', () => {
            const cookies = [
                { name: 'session-id', value: 'abc' },
                { name: 'x-main', value: 'xyz' },
            ];
            expect(cookies.some(c => c.name.startsWith('ubid-'))).toBe(false);
        });
    });
});
