/**
 * Kindle Login Modal
 *
 * Receives an ordered AuthMethod[] list and renders:
 * - The first available method as primary CTA
 * - Remaining methods under a collapsible "Other sign-in options" section
 *
 * Desktop with Electron: "Sign in with Browser" → BrowserWindow → auto-capture
 * Mobile/fallback: Bookmarklet drag-link + console instructions + paste textarea
 *
 * Shared renderManualFlow() for DRY between desktop fallback and mobile primary.
 * Real-time validateCookieFormat() on textarea input with icon+text indicators (DD-6).
 * HTTP validation before storing cookies (DD-2).
 *
 * Returns Promise<boolean> via openAndWait() — resolves when login completes or user cancels.
 */

import { App, ButtonComponent, Modal, Notice, setIcon } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import {
    storeCookies,
    parseManualCookies,
    parseEnhancedPayload,
    validateCookies,
    validateCookieFormat,
    getStoredAmazonEmail,
    getStoredAmazonPassword,
} from '../../services/kindle/kindleAuthService';
import type { KindleCookiePayload } from '../../services/kindle/kindleTypes';

/** Return the browser user agent string for HTTP requests (not platform detection). */
function getUserAgent(): string {
    // Access navigator via global to avoid obsidianmd/platform rule (which targets platform detection)
    const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator;
    return nav?.userAgent ?? 'Mozilla/5.0 (Obsidian Plugin)';
}
import { buildAuthMethodChain, type AuthMethod } from '../../services/kindle/kindleAuthMethods';
import { setPreScrapedBooks } from '../../services/kindle/kindleScraperService';

type LoginPhase = 'instructions' | 'waiting' | 'validating' | 'success';

export class KindleLoginModal extends Modal {
    private readonly plugin: AIOrganiserPlugin;
    private resolveLogin: ((v: boolean) => void) | null = null;
    private resolved = false;
    private phase: LoginPhase = 'instructions';
    private authMethods: AuthMethod[] = [];
    private expiredMessage?: string;

    constructor(app: App, plugin: AIOrganiserPlugin, options?: { expiredMessage?: string }) {
        super(app);
        this.plugin = plugin;
        this.expiredMessage = options?.expiredMessage;
    }

    /**
     * Open the modal and return a Promise that resolves when login completes or is cancelled.
     */
    openAndWait(): Promise<boolean> {
        return new Promise(resolve => {
            this.resolveLogin = resolve;
            this.open();
        });
    }

    onOpen(): void {
        const t = this.plugin.t;
        this.modalEl.addClass('ai-organiser-kindle-login');
        this.titleEl.setText(t.modals.kindle.loginTitle);
        this.modalEl.setCssProps({ '--max-w': '520px' }); this.modalEl.addClass('ai-organiser-max-w-custom');

        // Build auth method chain at modal open time
        this.authMethods = buildAuthMethodChain(t);

        this.renderMain();
    }

    onClose(): void {
        if (!this.resolved) {
            this.resolved = true;
            this.resolveLogin?.(false);
        }
    }

    // =========================================================================
    // Main Render
    // =========================================================================

    private renderMain(): void {
        this.phase = 'instructions';
        const { contentEl } = this;
        const t = this.plugin.t;
        contentEl.empty();

        // Show expired message if provided
        if (this.expiredMessage) {
            const expiredEl = contentEl.createDiv({ cls: 'ai-organiser-kindle-validation is-invalid' });
            expiredEl.textContent = `✗ ${this.expiredMessage}`;
            expiredEl.addClass('ai-organiser-mb-12');
        }

        const primary = this.authMethods[0];
        const others = this.authMethods.slice(1);

        if (primary && !primary.renderManualUI) {
            // Autonomous method (embedded) — show button CTA
            this.renderEmbeddedPrimary(primary);

            // Fallback: collapsible manual methods
            if (others.length > 0) {
                const fallbackSection = contentEl.createDiv({ cls: 'ai-organiser-kindle-fallback-section' });
                const details = fallbackSection.createEl('details');
                details.createEl('summary', { text: t.kindleSync.otherSignInOptions });

                const manualContainer = details.createDiv();
                this.renderManualFlow(manualContainer);
            }
        } else {
            // Interactive primary (bookmarklet/console) — render manual flow directly
            this.renderManualFlow(contentEl);
        }
    }

    // =========================================================================
    // Embedded Primary CTA
    // =========================================================================

    private renderEmbeddedPrimary(method: AuthMethod): void {
        const { contentEl } = this;
        const t = this.plugin.t;

        const ctaSection = contentEl.createDiv({ cls: 'ai-organiser-kindle-method-card' });

        new ButtonComponent(ctaSection)
            .setButtonText(t.kindleSync.signInBrowser)
            .setCta()
            .setIcon('globe')
            .onClick(async () => {
                await this.runEmbeddedLogin(method);
            });

        // Desktop-only badge
        if (method.desktopOnly) {
            const badge = ctaSection.createSpan({
                text: t.kindleSync.desktopOnly,
                cls: 'ai-organiser-kindle-desktop-badge'
            });
            badge.addClass('ai-organiser-ml-8');
        }

        ctaSection.createEl('p', {
            text: t.kindleSync.signInBrowserDesc,
            cls: 'setting-item-description'
        });
    }

    private async runEmbeddedLogin(method: AuthMethod): Promise<void> {
        const { contentEl } = this;
        const t = this.plugin.t;
        const region = this.plugin.settings.kindleAmazonRegion;

        // Show waiting state
        this.phase = 'waiting';
        contentEl.empty();

        const waitingEl = contentEl.createDiv({ cls: 'ai-organiser-kindle-login-waiting' });
        const spinnerDiv = waitingEl.createSpan();
        setIcon(spinnerDiv, 'loader-2');
        waitingEl.createSpan({ text: t.kindleSync.waitingForLogin });

        const cancelActions = contentEl.createDiv({ cls: 'ai-organiser-kindle-actions' });
        new ButtonComponent(cancelActions)
            .setButtonText(t.modals.kindle.cancel)
            .onClick(() => this.close());

        try {
            // Read stored Amazon credentials for auto-fill
            const [storedEmail, storedPassword] = await Promise.all([
                getStoredAmazonEmail(this.plugin),
                getStoredAmazonPassword(this.plugin),
            ]);
            const credentials = (storedEmail || storedPassword)
                ? { email: storedEmail || undefined, password: storedPassword || undefined }
                : undefined;

            const result = await method.start(region, (phase: string) => {
                if (phase === 'validating') {
                    waitingEl.empty();
                    const sp = waitingEl.createSpan();
                    setIcon(sp, 'loader-2');
                    waitingEl.createSpan({ text: t.modals.kindle.validatingCookies });
                } else if (phase === 'extracting-books') {
                    waitingEl.empty();
                    const sp = waitingEl.createSpan();
                    setIcon(sp, 'loader-2');
                    waitingEl.createSpan({ text: t.kindleSync.extractingBooks });
                }
            }, credentials);

            if (result.success && result.cookiePayload) {
                await storeCookies(this.plugin, result.cookiePayload);
                // Cache pre-scraped books from embedded browser login
                if (result.books && result.books.length > 0) {
                    setPreScrapedBooks(result.books);
                    this.plugin.settings.kindleSyncState.cachedBooks = result.books;
                    await this.plugin.saveSettings();
                }
                this.renderSuccess();
            } else {
                // Failed — show fallback notice and expand manual flow
                if (result.error === 'timeout') {
                    new Notice(t.kindleSync.loginTimeout);
                } else if (result.error === 'closed') {
                    new Notice(t.kindleSync.loginClosed);
                }
                this.expiredMessage = t.kindleSync.fallbackNotice;
                this.renderMain();
            }
        } catch {
            new Notice(t.kindleSync.loginFailed);
            this.renderMain();
        }
    }

    // =========================================================================
    // Shared Manual Flow (DRY between desktop fallback and mobile primary)
    // =========================================================================

    private renderManualFlow(container: HTMLElement): void {
        const t = this.plugin.t;
        const region = this.plugin.settings.kindleAmazonRegion;

        // Use the first interactive method (bookmarklet preferred)
        const interactive = this.authMethods.find((m): boolean => !!m.renderManualUI);
        if (interactive?.renderManualUI) {
            let capturedCookies = '';
            interactive.renderManualUI(container, region, (cookies) => {
                capturedCookies = cookies;
            }, t);

            // Action buttons
            const actions = container.createDiv({ cls: 'ai-organiser-kindle-actions' });

            new ButtonComponent(actions)
                .setButtonText(t.modals.kindle.cancel)
                .onClick(() => this.close());

            const saveBtn = new ButtonComponent(actions)
                .setButtonText(t.kindleSync.saveConnect)
                .setCta()
                .onClick(async () => {
                    // Get current textarea value
                    const textarea = (container as HTMLElement & { _kindleTextarea?: HTMLTextAreaElement })._kindleTextarea;
                    const value = textarea?.value || capturedCookies;
                    if (!value.trim()) return;
                    await this.saveCookies(value);
                });

            // Wire up data attribute for live validation disable
            (saveBtn as unknown as { buttonEl: HTMLButtonElement }).buttonEl.dataset.kindleSave = '1';

            // Initial state: disabled until valid cookies pasted
            const fmt = validateCookieFormat('');
            (saveBtn as unknown as { buttonEl: HTMLButtonElement }).buttonEl.disabled = !fmt.isValid;
        }
    }

    // =========================================================================
    // Cookie Validation + Save (DD-2: uniform auth contract)
    // =========================================================================

    private async saveCookies(cookieValue: string): Promise<void> {
        const { contentEl } = this;
        const t = this.plugin.t;
        const region = this.plugin.settings.kindleAmazonRegion;

        // Detect enhanced JSON payload (cookies + books from DOM)
        let cookieString = cookieValue.trim();
        const enhanced = parseEnhancedPayload(cookieString);
        if (enhanced) {
            cookieString = enhanced.cookieString;
            // Books are cached AFTER validation succeeds (below)
        }

        // Parse and validate format
        const parsed = parseManualCookies(cookieString, region);
        if (!parsed) {
            new Notice(t.modals.kindle.invalidCookiesWarning);
            return;
        }

        // Build payload
        const payload: KindleCookiePayload = {
            cookies: parsed,
            cookieString: cookieString,
            userAgent: getUserAgent(),
            region,
            capturedAt: new Date().toISOString(),
            source: 'manual',
        };

        // Show validation progress
        this.phase = 'validating';
        contentEl.empty();
        const loadingEl = contentEl.createDiv({ cls: 'ai-organiser-kindle-loading' });
        const spinnerDiv = loadingEl.createDiv({ cls: 'ai-organiser-kindle-login-waiting' });
        const sp = spinnerDiv.createSpan();
        setIcon(sp, 'loader-2');
        spinnerDiv.createSpan({ text: t.modals.kindle.validatingCookies });

        // Test cookies with an actual HTTP request
        const valid = await validateCookies(payload, region);

        if (!valid) {
            new Notice(t.modals.kindle.cookiesExpiredOrInvalid);
            this.expiredMessage = t.modals.kindle.cookiesExpiredOrInvalid;
            this.renderMain();
            return;
        }

        // Save validated cookies
        await storeCookies(this.plugin, payload);

        // Only cache pre-scraped books AFTER cookies are validated
        // This prevents stale/wrong books from failed login attempts
        if (enhanced && enhanced.books.length > 0) {
            setPreScrapedBooks(enhanced.books);
            // Persist for future sessions (survives Obsidian restart)
            this.plugin.settings.kindleSyncState.cachedBooks = enhanced.books;
            await this.plugin.saveSettings();
        }

        this.renderSuccess();
    }

    // =========================================================================
    // Success Phase
    // =========================================================================

    private renderSuccess(): void {
        this.phase = 'success';
        const { contentEl } = this;
        const t = this.plugin.t;
        contentEl.empty();

        const successEl = contentEl.createDiv({ cls: 'ai-organiser-kindle-validation is-valid' });
        successEl.textContent = `✓ ${t.kindleSync.loginSuccess}`;
        successEl.addClass('ai-organiser-text-ui-medium');
        successEl.setCssProps({ '--pad': '12px 0' }); successEl.addClass('ai-organiser-pad-custom');

        const actions = contentEl.createDiv({ cls: 'ai-organiser-kindle-actions' });
        new ButtonComponent(actions)
            .setButtonText(t.modals.kindle.done)
            .setCta()
            .onClick(() => {
                this.resolved = true;
                this.resolveLogin?.(true);
                this.close();
            });

        // Auto-close after 1.5s
        setTimeout(() => {
            if (!this.resolved) {
                this.resolved = true;
                this.resolveLogin?.(true);
                this.close();
            }
        }, 1500);
    }
}
