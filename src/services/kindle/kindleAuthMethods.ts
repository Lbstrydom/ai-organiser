/**
 * Kindle Auth Method Strategy Pattern (DD-1)
 *
 * Three implementations of the AuthMethod interface:
 * - EmbeddedAuthMethod: Desktop only, autonomous BrowserWindow login
 * - BookmarkletAuthMethod: Universal, interactive bookmarklet flow
 * - ConsoleAuthMethod: Universal, interactive console paste flow
 *
 * The login modal receives AuthMethod[], renders the first available
 * as the primary CTA. Fallback chain determined by isAvailable() at
 * modal open time — fully testable without mocking modal UI.
 */

import { Notice } from 'obsidian';
import type { Translations } from '../../i18n/types';
import { generateCookieBookmarklet, generateConsoleScript } from './kindleBookmarklet';
import { openAmazonInBrowser, validateCookieFormat } from './kindleAuthService';
import { EmbeddedAuthMethod } from './kindleEmbeddedAuth';

// =========================================================================
// AuthMethod Interface
// =========================================================================

export interface AuthMethodResult {
    success: boolean;
    cookiePayload?: import('./kindleTypes').KindleCookiePayload;
    books?: import('./kindleTypes').KindleScrapedBook[];
    error?: string;
}

export interface AuthMethod {
    readonly id: string;
    readonly label: string;
    readonly icon: string;
    readonly desktopOnly: boolean;
    isAvailable(): boolean;
    /** Autonomous start — only EmbeddedAuthMethod returns cookies. */
    start(
        region: string,
        onProgress?: (phase: string) => void,
        credentials?: { email?: string; password?: string },
    ): Promise<AuthMethodResult>;
    /** Interactive methods render a manual UI instead of autonomous start(). */
    renderManualUI?(
        container: HTMLElement,
        region: string,
        onCookiesCaptured: (cookies: string) => void,
        t: Translations,
    ): void;
}

// =========================================================================
// Shared: render live-validated cookie textarea
// =========================================================================

function renderCookieTextarea(
    container: HTMLElement,
    onCookiesCaptured: (cookies: string) => void,
    t: Translations,
): void {
    const step = container.createDiv({ cls: 'ai-organiser-kindle-step' });
    step.createEl('h4', { text: t.modals.kindle.step3Title });

    const textArea = step.createEl('textarea', {
        cls: 'ai-organiser-kindle-cookie-textarea',
        attr: { rows: '5', placeholder: t.modals.kindle.pasteCookies },
    });

    const validationEl = step.createDiv({ cls: 'ai-organiser-kindle-validation' });

    textArea.addEventListener('input', () => {
        const result = validateCookieFormat(textArea.value);
        validationEl.empty();
        validationEl.removeClass('is-valid', 'is-invalid');

        if (!textArea.value.trim()) {
            validationEl.textContent = t.kindleSync.validationEmpty;
            return;
        }

        if (result.isValid) {
            validationEl.addClass('is-valid');
            validationEl.textContent = `\u2713 ${t.kindleSync.validationReady.replace('{count}', String(result.cookieCount))}`;
        } else {
            validationEl.addClass('is-invalid');
            validationEl.textContent = result.hasSessionId
                ? `\u2717 ${t.kindleSync.validationMissingUbid}`
                : `\u2717 ${t.kindleSync.validationMissingSession}`;
        }

        const saveBtn = container.querySelector<HTMLButtonElement>('[data-kindle-save]');
        if (saveBtn) saveBtn.disabled = !result.isValid;
    });

    textArea.addEventListener('change', () => {
        const result = validateCookieFormat(textArea.value);
        if (result.isValid) {
            onCookiesCaptured(textArea.value.trim());
        }
    });

    (container as HTMLElement & { _kindleTextarea?: HTMLTextAreaElement })._kindleTextarea = textArea;
}

// =========================================================================
// BookmarkletAuthMethod
// =========================================================================

export class BookmarkletAuthMethod implements AuthMethod {
    readonly id = 'bookmarklet';
    readonly label: string;
    readonly icon = 'bookmark';
    readonly desktopOnly = false;

    constructor(t: Translations) {
        this.label = t.kindleSync.bookmarkletDrag;
    }

    isAvailable(): boolean {
        return true;
    }

    start(_region: string, _onProgress?: (phase: string) => void): Promise<AuthMethodResult> {
        return Promise.resolve({ success: false, error: 'interactive' });
    }

    renderManualUI(
        container: HTMLElement,
        region: string,
        onCookiesCaptured: (cookies: string) => void,
        t: Translations,
    ): void {
        // Step 1: Open Amazon
        const step1 = container.createDiv({ cls: 'ai-organiser-kindle-step' });
        step1.createEl('h4', { text: t.modals.kindle.step1Title });
        step1.createEl('p', { text: t.modals.kindle.step1Desc, cls: 'setting-item-description' });

        const openBtn = step1.createEl('button', { cls: 'mod-cta', text: t.modals.kindle.openAmazon });
        openBtn.addEventListener('click', () => openAmazonInBrowser(region));

        // Step 2: Bookmarklet
        const step2 = container.createDiv({ cls: 'ai-organiser-kindle-step' });
        step2.createEl('h4', { text: t.kindleSync.bookmarkletDrag });

        const bookmarkletUrl = generateCookieBookmarklet();

        // Draggable bookmarklet link
        const dragLink = step2.createEl('a', {
            text: 'Copy Kindle cookies',
            cls: 'ai-organiser-kindle-bookmarklet-link',
            href: bookmarkletUrl,
        });
        dragLink.addEventListener('click', (e) => e.preventDefault());

        // Copy bookmarklet button
        const copyBtn = step2.createEl('button', { text: t.kindleSync.bookmarkletCopy });
        copyBtn.addClass('ai-organiser-ml-8');
        copyBtn.addEventListener('click', () => {
            void navigator.clipboard.writeText(bookmarkletUrl);
            new Notice(t.kindleSync.bookmarkletCopied);
        });

        // Collapsed console fallback
        const details = step2.createEl('details');
        details.createEl('summary', { text: t.kindleSync.advancedConsole });
        const consoleScript = generateConsoleScript();
        const codeBlock = details.createEl('code', {
            text: consoleScript,
            cls: 'ai-organiser-kindle-code-snippet',
        });
        codeBlock.addEventListener('click', () => {
            void navigator.clipboard.writeText(consoleScript);
            new Notice(t.modals.kindle.copiedToClipboard);
        });

        // Step 3: Paste cookies with live validation
        renderCookieTextarea(container, onCookiesCaptured, t);
    }
}

// =========================================================================
// ConsoleAuthMethod
// =========================================================================

export class ConsoleAuthMethod implements AuthMethod {
    readonly id = 'console';
    readonly label: string;
    readonly icon = 'terminal';
    readonly desktopOnly = false;

    constructor(t: Translations) {
        this.label = t.kindleSync.advancedConsole;
    }

    isAvailable(): boolean {
        return true;
    }

    start(_region: string, _onProgress?: (phase: string) => void): Promise<AuthMethodResult> {
        return Promise.resolve({ success: false, error: 'interactive' });
    }

    renderManualUI(
        container: HTMLElement,
        region: string,
        onCookiesCaptured: (cookies: string) => void,
        t: Translations,
    ): void {
        // Step 1: Open Amazon
        const step1 = container.createDiv({ cls: 'ai-organiser-kindle-step' });
        step1.createEl('h4', { text: t.modals.kindle.step1Title });
        step1.createEl('p', { text: t.modals.kindle.step1Desc, cls: 'setting-item-description' });

        const openBtn = step1.createEl('button', { cls: 'mod-cta', text: t.modals.kindle.openAmazon });
        openBtn.addEventListener('click', () => openAmazonInBrowser(region));

        // Step 2: Console instructions
        const step2 = container.createDiv({ cls: 'ai-organiser-kindle-step' });
        step2.createEl('h4', { text: t.modals.kindle.step2Title });
        step2.createEl('p', { text: t.modals.kindle.step2Desc, cls: 'setting-item-description' });

        const consoleScript = generateConsoleScript();
        const codeBlock = step2.createEl('code', {
            text: consoleScript,
            cls: 'ai-organiser-kindle-code-snippet',
        });
        codeBlock.addEventListener('click', () => {
            void navigator.clipboard.writeText(consoleScript);
            new Notice(t.modals.kindle.copiedToClipboard);
        });

        // Step 3: Paste cookies with live validation
        renderCookieTextarea(container, onCookiesCaptured, t);
    }
}

// =========================================================================
// Fallback Chain Builder
// =========================================================================

/**
 * Build the ordered auth method list based on runtime availability.
 * The first available method becomes the primary CTA.
 *
 * Order: Embedded → Bookmarklet → Console
 */
export function buildAuthMethodChain(t: Translations): AuthMethod[] {
    const methods: AuthMethod[] = [];

    // Embedded — only added if available. EmbeddedAuthMethod is safe to instantiate
    // on mobile because its constructor is pure; isAvailable() gates all Electron access.
    try {
        const embedded = new EmbeddedAuthMethod(t);
        if (embedded.isAvailable()) {
            methods.push(embedded);
        }
    } catch {
        // Constructor failed (unexpected) — skip embedded
    }

    methods.push(new BookmarkletAuthMethod(t), new ConsoleAuthMethod(t));

    return methods;
}
