/**
 * Kindle Auth Service (v2)
 *
 * Cookie-based authentication for Amazon Kindle notebook scraping.
 * Uses Obsidian's requestUrl for validation — no external proxies needed.
 *
 * Authentication flow:
 * 1. User opens Amazon notebook in their system browser and logs in
 * 2. User copies cookies (via browser console: copy(document.cookie))
 * 3. Plugin stores cookies in SecretStorage
 * 4. All subsequent scraping uses requestUrl with Cookie header
 *
 * Security:
 * - Cookies stored encrypted in Obsidian SecretStorage
 * - Never logs cookies or auth payloads
 */

import { requestUrl } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { PLUGIN_SECRET_IDS } from '../../core/secretIds';
import type { KindleCookiePayload, KindleCDPCookie, KindleScrapedBook } from './kindleTypes';

// =========================================================================
// HTTP Request Helpers
// =========================================================================

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Region-specific Kindle notebook reading domains.
 * Amazon uses localized subdomains for the notebook reader.
 * Exported for domain-suffix filtering in embedded auth (DD-5).
 */
export const REGION_DOMAINS: Record<string, string> = {
    'com': 'read.amazon.com',
    'co.uk': 'read.amazon.co.uk',
    'co.jp': 'read.amazon.co.jp',
    'de': 'lesen.amazon.de',
    'fr': 'lire.amazon.fr',
    'es': 'leer.amazon.es',
    'it': 'leggi.amazon.it',
    'in': 'read.amazon.in',
    'com.au': 'read.amazon.com.au',
    'ca': 'read.amazon.ca',
    'com.br': 'leitura.amazon.com.br',
};

/**
 * Build the notebook URL for a given Amazon region.
 */
export function getNotebookUrl(region: string): string {
    const domain = REGION_DOMAINS[region] || `read.amazon.${region}`;
    return `https://${domain}/notebook`;
}

/**
 * Build standard HTTP headers for Amazon requests.
 */
export function buildRequestHeaders(cookiePayload: KindleCookiePayload): Record<string, string> {
    const userAgent = cookiePayload.userAgent && cookiePayload.userAgent !== 'manual-paste'
        ? cookiePayload.userAgent
        : DEFAULT_USER_AGENT;

    return {
        'Cookie': cookiePayload.cookieString,
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
    };
}

// =========================================================================
// Cookie Validation
// =========================================================================

/**
 * Validate stored cookies by making a test request to the notebook page.
 * Returns true if cookies are valid, false if expired/invalid.
 */
export async function validateCookies(
    cookiePayload: KindleCookiePayload,
    region: string
): Promise<boolean> {
    const notebookUrl = getNotebookUrl(region);
    try {
        const response = await requestUrl({
            url: notebookUrl,
            headers: buildRequestHeaders(cookiePayload),
            throw: false,
        });
        return !detectAuthExpiry(response.text);
    } catch {
        return false;
    }
}

// =========================================================================
// Auth Expiry Detection
// =========================================================================

/**
 * Detect if Amazon redirected to login page (cookies expired).
 *
 * We check for the actual sign-in FORM (input fields, form action)
 * rather than just `/ap/signin` which may appear in navigation links,
 * scripts, or hrefs on authenticated pages.
 */
export function detectAuthExpiry(html: string): boolean {
    // Strong signals: actual sign-in form elements
    const hasSignInForm = html.includes('name="signIn"') || html.includes('id="ap_signin_form"');
    const hasEmailInput = html.includes('id="ap_email"') || html.includes('name="email"');
    const hasPasswordInput = html.includes('id="ap_password"');
    const hasCreateAccount = html.includes('createAccountSubmit');

    // If the page has the sign-in form with email/password inputs, it's the login page
    if (hasSignInForm || (hasEmailInput && hasPasswordInput) || hasCreateAccount) {
        return true;
    }

    // Weaker signal: /ap/signin in the URL or as a form action (not just any href)
    // Check if it appears as an action attribute or if it's the primary page
    if (html.includes('action="/ap/signin"') || html.includes('action="https://www.amazon.com/ap/signin"')) {
        return true;
    }

    // If the HTML is very short and contains signin, it's likely a redirect stub
    if (html.length < 2000 && html.includes('/ap/signin')) {
        return true;
    }

    return false;
}

// =========================================================================
// Browser Login Helper
// =========================================================================

/**
 * Open the Amazon notebook page in the system browser for the user to log in.
 * Works on both desktop and mobile.
 */
export function openAmazonInBrowser(region: string): void {
    const notebookUrl = getNotebookUrl(region);
    window.open(notebookUrl);
}

// =========================================================================
// Cookie CRUD via SecretStorage
// =========================================================================

/**
 * Check if valid Amazon cookies are stored for the current region.
 */
export async function isAuthenticated(plugin: AIOrganiserPlugin): Promise<boolean> {
    const payload = await getStoredCookies(plugin);
    if (!payload) return false;
    return payload.region === plugin.settings.kindleAmazonRegion;
}

/**
 * Retrieve stored cookie payload from SecretStorage.
 */
export async function getStoredCookies(plugin: AIOrganiserPlugin): Promise<KindleCookiePayload | null> {
    const json = await plugin.secretStorageService.getSecret(PLUGIN_SECRET_IDS.KINDLE_COOKIES);
    if (!json) return null;
    try {
        return JSON.parse(json) as KindleCookiePayload;
    } catch {
        return null;
    }
}

/**
 * Store cookie payload in SecretStorage.
 */
export async function storeCookies(plugin: AIOrganiserPlugin, payload: KindleCookiePayload): Promise<void> {
    await plugin.secretStorageService.setSecret(
        PLUGIN_SECRET_IDS.KINDLE_COOKIES,
        JSON.stringify(payload)
    );
}

/**
 * Clear stored cookies from SecretStorage.
 */
export async function clearCookies(plugin: AIOrganiserPlugin): Promise<void> {
    await plugin.secretStorageService.removeSecret(PLUGIN_SECRET_IDS.KINDLE_COOKIES);
}

// =========================================================================
// Amazon Credentials (email/password) via SecretStorage
// =========================================================================

/**
 * Get stored Amazon email from SecretStorage.
 */
export async function getStoredAmazonEmail(plugin: AIOrganiserPlugin): Promise<string | null> {
    return await plugin.secretStorageService.getSecret(PLUGIN_SECRET_IDS.AMAZON_EMAIL) || null;
}

/**
 * Get stored Amazon password from SecretStorage.
 */
export async function getStoredAmazonPassword(plugin: AIOrganiserPlugin): Promise<string | null> {
    return await plugin.secretStorageService.getSecret(PLUGIN_SECRET_IDS.AMAZON_PASSWORD) || null;
}

/**
 * Store Amazon email in SecretStorage.
 */
export async function storeAmazonEmail(plugin: AIOrganiserPlugin, email: string): Promise<void> {
    if (email.trim()) {
        await plugin.secretStorageService.setSecret(PLUGIN_SECRET_IDS.AMAZON_EMAIL, email.trim());
    } else {
        await plugin.secretStorageService.removeSecret(PLUGIN_SECRET_IDS.AMAZON_EMAIL);
    }
}

/**
 * Store Amazon password in SecretStorage.
 */
export async function storeAmazonPassword(plugin: AIOrganiserPlugin, password: string): Promise<void> {
    if (password) {
        await plugin.secretStorageService.setSecret(PLUGIN_SECRET_IDS.AMAZON_PASSWORD, password);
    } else {
        await plugin.secretStorageService.removeSecret(PLUGIN_SECRET_IDS.AMAZON_PASSWORD);
    }
}

// =========================================================================
// Cookie Format Validation (lightweight, pure — for live textarea feedback)
// =========================================================================

/**
 * Result of a lightweight cookie format check.
 * Used for real-time textarea validation (no HTTP).
 */
export interface CookieFormatResult {
    hasSessionId: boolean;
    hasUbid: boolean;
    cookieCount: number;
    isValid: boolean;
}

/**
 * Pure function for live textarea feedback.
 * Returns a structured result without building a KindleCookiePayload.
 * Called on textarea `input` event for instant UI indicators.
 *
 * Supports both plain cookie strings and enhanced JSON payloads.
 */
export function validateCookieFormat(cookieString: string): CookieFormatResult {
    const trimmed = cookieString.trim();
    if (!trimmed) {
        return { hasSessionId: false, hasUbid: false, cookieCount: 0, isValid: false };
    }

    // If it looks like an enhanced JSON payload, extract the cookie string from .c
    let cookieText = trimmed;
    if (trimmed.startsWith('{')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed.c === 'string') {
                cookieText = parsed.c;
            }
        } catch {
            // Not valid JSON — will fail the normal cookie check below
        }
    }

    const pairs = cookieText.split(/;\s*/);
    let cookieCount = 0;
    let hasSessionId = false;
    let hasUbid = false;

    for (const pair of pairs) {
        const eqIdx = pair.indexOf('=');
        if (eqIdx <= 0) continue;
        const name = pair.substring(0, eqIdx).trim();
        if (!name) continue;
        cookieCount++;
        if (name === 'session-id') hasSessionId = true;
        if (name.startsWith('ubid-')) hasUbid = true;
    }

    return { hasSessionId, hasUbid, cookieCount, isValid: hasSessionId && hasUbid };
}

/**
 * Calculate the age of stored cookies in days from the `capturedAt` timestamp.
 */
export function getCookieAgeDays(payload: KindleCookiePayload): number {
    if (!payload.capturedAt) return -1;
    const ms = Date.now() - new Date(payload.capturedAt).getTime();
    return Math.floor(ms / (1000 * 60 * 60 * 24));
}

// =========================================================================
// Manual Cookie Paste Validation
// =========================================================================

/**
 * Parse a manual cookie string into structured KindleCDPCookie[] format.
 * Validates that required cookies (session-id, ubid-main) are present.
 *
 * @returns parsed cookies or null if validation fails
 */
export function parseManualCookies(
    cookieString: string,
    region: string
): KindleCDPCookie[] | null {
    const trimmed = cookieString.trim();
    if (!trimmed) return null;

    // Delegate required-cookie checks to validateCookieFormat (DRY)
    const fmt = validateCookieFormat(trimmed);
    if (!fmt.isValid) return null;

    const cookies: KindleCDPCookie[] = [];
    const pairs = trimmed.split(/;\s*/);

    for (const pair of pairs) {
        const eqIdx = pair.indexOf('=');
        if (eqIdx <= 0) continue;
        const name = pair.substring(0, eqIdx).trim();
        const value = pair.substring(eqIdx + 1).trim();
        if (!name || !value) continue;

        cookies.push({
            name,
            value,
            domain: `.amazon.${region}`,
            path: '/',
            httpOnly: false,
            secure: true,
        });
    }

    return cookies.length > 0 ? cookies : null;
}

// =========================================================================
// Enhanced Payload Detection (cookies + books from DOM)
// =========================================================================

/**
 * Result of parsing an enhanced payload from the bookmarklet/console script.
 */
export interface EnhancedPayloadResult {
    /** Raw cookie string from document.cookie */
    cookieString: string;
    /** Books extracted from the rendered DOM (may be empty) */
    books: KindleScrapedBook[];
}

/**
 * Try to parse the pasted text as an enhanced JSON payload.
 *
 * Enhanced format: `{"c":"<cookie-string>","b":[{"a":"<asin>","t":"<title>","u":"<author>","h":<count>,"i":"<imageUrl>"},...]}`
 *
 * Returns null if the input is NOT enhanced format (plain cookie string).
 * Backward compatible: callers should try this first, then fall back to
 * parseManualCookies() for plain strings.
 */
export function parseEnhancedPayload(input: string): EnhancedPayloadResult | null {
    const trimmed = input.trim();
    if (!trimmed.startsWith('{')) return null;

    try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed.c !== 'string') return null;

        const cookieString = parsed.c;

        // Parse books array — resilient to malformed entries
        const books: KindleScrapedBook[] = [];
        if (Array.isArray(parsed.b)) {
            for (const item of parsed.b) {
                if (item && typeof item.a === 'string' && item.a.length > 0) {
                    books.push({
                        asin: item.a,
                        title: (typeof item.t === 'string' ? item.t : '') || 'Unknown Title',
                        author: (typeof item.u === 'string' ? item.u : '') || 'Unknown Author',
                        highlightCount: typeof item.h === 'number' ? item.h : 0,
                        imageUrl: typeof item.i === 'string' && item.i ? item.i : undefined,
                    });
                }
            }
        }

        return { cookieString, books };
    } catch {
        return null;
    }
}

/**
 * Detect if the input is an enhanced payload (starts with `{`).
 * Quick check without full parsing.
 */
export function isEnhancedPayload(input: string): boolean {
    return input.trim().startsWith('{');
}
