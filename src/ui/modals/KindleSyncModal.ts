/**
 * Kindle Sync Modal
 *
 * Four-phase modal for importing Kindle highlights:
 * Phase 1: Source selection (Import File / Sync from Amazon)
 * Phase 2: Book selection with checkboxes
 * Phase 3: Import progress with cancel support
 * Phase 4: Results with "Open" links
 *
 * Phase 2 only implements "Import File" mode. Amazon sync is deferred to Phase 3.
 */

import { App, ButtonComponent, FuzzySuggestModal, Modal, Notice, Platform, Setting, setIcon, TFile } from 'obsidian';
import { logger } from '../../utils/logger';
import type AIOrganiserPlugin from '../../main';
import { parseClippings } from '../../services/kindle/kindleClippingsParser';
import { syncFromClippings, syncFromAmazon, getNewHighlights } from '../../services/kindle/kindleSyncService';
import type { KindleBook, KindleSyncProgress, KindleScrapedBook } from '../../services/kindle/kindleTypes';
import { generateBookKey } from '../../services/kindle/kindleTypes';
import { getStoredCookies, clearCookies, validateCookies } from '../../services/kindle/kindleAuthService';
import { consumePreScrapedBooks } from '../../services/kindle/kindleScraperService';
import { ensurePrivacyConsent } from '../../services/privacyNotice';
import { KindleLoginModal } from './KindleLoginModal';
import { summarizeText, pluginContext } from '../../services/llmFacade';
import { buildBookSummaryPrompt } from '../../services/prompts/kindlePrompts';
import { updateAIOMetadata, createSummaryHook } from '../../utils/frontmatterUtils';
import { getLanguageNameForPrompt } from '../../services/languages';
import { listen } from '../utils/domUtils';

type ModalPhase = 'source' | 'books' | 'progress' | 'results';

/**
 * Simple vault file picker for mobile — shows .txt files from the vault.
 */
class VaultTextFilePicker extends FuzzySuggestModal<TFile> {
    private readonly onChooseFile: (file: TFile) => void;
    private readonly textFiles: TFile[];

    constructor(app: App, textFiles: TFile[], onChoose: (file: TFile) => void) {
        super(app);
        this.textFiles = textFiles;
        this.onChooseFile = onChoose;
        this.setPlaceholder('Select a text file');
    }

    getItems(): TFile[] {
        return this.textFiles;
    }

    getItemText(item: TFile): string {
        return item.path;
    }

    onChooseItem(item: TFile): void {
        this.onChooseFile(item);
    }
}

export class KindleSyncModal extends Modal {
    private readonly plugin: AIOrganiserPlugin;
    private phase: ModalPhase = 'source';

    // Book selection state
    private books: KindleBook[] = [];
    private amazonBooks: KindleScrapedBook[] = [];
    private readonly selectedBooks: Set<string> = new Set(); // book keys
    private autoTag = true;

    // Abort support
    private abortController: AbortController | null = null;
    private cleanups: (() => void)[] = [];

    // Result state
    private createdFiles: { path: string; title: string; book?: KindleBook }[] = [];
    private resultErrors: string[] = [];
    private resultStats = { booksProcessed: 0, highlightsImported: 0 };

    constructor(app: App, plugin: AIOrganiserPlugin) {
        super(app);
        this.plugin = plugin;
        this.autoTag = plugin.settings.kindleAutoTag;
    }

    onOpen(): void {
        const t = this.plugin.t;
        this.modalEl.addClass('ai-organiser-kindle-sync');
        this.titleEl.setText(t.modals.kindle.title);
        this.modalEl.setCssProps({ '--max-w': '650px' }); this.modalEl.addClass('ai-organiser-max-w-custom');
        this.renderSource();
    }

    onClose(): void {
        for (const cleanup of this.cleanups) cleanup();
        this.cleanups = [];
        this.abortController?.abort();
    }

    // =========================================================================
    // Phase 1 — Source Selection
    // =========================================================================

    private renderSource(): void {
        this.phase = 'source';
        const { contentEl } = this;
        const t = this.plugin.t;
        contentEl.empty();

        // Last sync info
        const lastSync = this.plugin.settings.kindleSyncState.lastSyncDate;
        if (lastSync) {
            const ago = this.formatTimeAgo(lastSync);
            contentEl.createEl('p', {
                text: t.modals.kindle.lastSynced.replace('{time}', ago),
                cls: 'setting-item-description'
            });
        }

        // Description
        contentEl.createEl('p', {
            text: t.modals.kindle.description,
            cls: 'setting-item-description'
        });

        // Button row
        const actions = contentEl.createDiv({ cls: 'ai-organiser-kindle-actions' });

        // Import File button
        new ButtonComponent(actions)
            .setButtonText(t.modals.kindle.importFile)
            .setCta()
            .setIcon('file-up')
            .onClick(() => {
                this.pickClippingsFile();
            });

        // Sync from Amazon button (desktop CDP login; mobile uses manual cookie paste)
        new ButtonComponent(actions)
            .setButtonText(t.modals.kindle.syncFromAmazon)
            .setIcon('cloud-download')
            .onClick(() => this.startAmazonSync());
    }

    // =========================================================================
    // File Picker (platform-aware)
    // =========================================================================

    private pickClippingsFile(): void {
        if (Platform.isMobile) {
            this.pickClippingsFromVault();
        } else {
            this.pickClippingsFromSystem();
        }
    }

    private pickClippingsFromSystem(): void {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.txt';
        this.cleanups.push(listen(input, 'change', () => { void (async () => {
            const file = input.files?.[0];
            if (!file) return;
            try {
                const content = await file.text();
                this.handleClippingsContent(content);
            } catch (error) {
                new Notice(`Failed to read file: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
        })(); }));
        input.click();
    }

    private pickClippingsFromVault(): void {
        const textFiles = this.app.vault.getFiles().filter(f => f.extension === 'txt');
        if (textFiles.length === 0) {
            new Notice(this.plugin.t.modals.kindle.noTxtFiles);
            return;
        }
        new VaultTextFilePicker(this.app, textFiles, (file) => { void (async () => {
            try {
                const content = await this.app.vault.read(file);
                this.handleClippingsContent(content);
            } catch (error) {
                new Notice(`Failed to read file: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
        })(); }).open();
    }

    private handleClippingsContent(content: string): void {
        this.books = parseClippings(content);

        if (this.books.length === 0) {
            new Notice(this.plugin.t.modals.kindle.noBooks);
            return;
        }

        // Pre-select books with new highlights
        for (const book of this.books) {
            const bookKey = generateBookKey(book.title, book.author);
            const newCount = getNewHighlights(book, this.plugin.settings.kindleSyncState).length;
            if (newCount > 0) {
                this.selectedBooks.add(bookKey);
            }
        }

        this.renderBooks();
    }

    // =========================================================================
    // Phase 2 — Book Selection
    // =========================================================================

    private renderBooks(): void {
        this.phase = 'books';
        const { contentEl } = this;
        const t = this.plugin.t;
        contentEl.empty();

        // Header with badge + select all / new only
        const header = contentEl.createDiv({ cls: 'ai-organiser-kindle-header' });
        const badgeEl = header.createSpan({ cls: 'ai-organiser-kindle-badge' });

        const updateBadge = () => {
            const count = this.selectedBooks.size;
            badgeEl.textContent = count > 0
                ? `${count} ${t.modals.kindle.selected}`
                : t.modals.kindle.selectBooksPrompt;
        };

        // Select All / Deselect All
        const selectAllBtn = new ButtonComponent(header)
            .setButtonText(t.modals.kindle.selectAll)
            .onClick(() => {
                const allSelected = this.selectedBooks.size === this.books.length;
                this.selectedBooks.clear();
                if (!allSelected) {
                    for (const book of this.books) {
                        this.selectedBooks.add(generateBookKey(book.title, book.author));
                    }
                }
                syncUI();
            });

        // New Only filter
        new ButtonComponent(header)
            .setButtonText(t.modals.kindle.newOnly)
            .onClick(() => {
                this.selectedBooks.clear();
                for (const book of this.books) {
                    const newCount = getNewHighlights(book, this.plugin.settings.kindleSyncState).length;
                    if (newCount > 0) {
                        this.selectedBooks.add(generateBookKey(book.title, book.author));
                    }
                }
                syncUI();
            });

        // Scrollable book list
        const listEl = contentEl.createDiv({ cls: 'ai-organiser-kindle-list' });

        // Sort: books with new highlights first, then alphabetical
        const sortedBooks = [...this.books].sort((a, b) => {
            const aNew = getNewHighlights(a, this.plugin.settings.kindleSyncState).length;
            const bNew = getNewHighlights(b, this.plugin.settings.kindleSyncState).length;
            if (aNew > 0 && bNew === 0) return -1;
            if (aNew === 0 && bNew > 0) return 1;
            return a.title.localeCompare(b.title);
        });

        const checkboxMap = new Map<string, HTMLInputElement>();

        for (const book of sortedBooks) {
            const bookKey = generateBookKey(book.title, book.author);
            const newCount = getNewHighlights(book, this.plugin.settings.kindleSyncState).length;
            const isUpToDate = newCount === 0;

            const card = listEl.createDiv({ cls: 'ai-organiser-kindle-card' });
            if (isUpToDate) card.addClass('ai-organiser-kindle-card-dimmed');
            if (this.selectedBooks.has(bookKey)) card.addClass('ai-organiser-kindle-card-selected');

            // Click anywhere to toggle
            this.cleanups.push(listen(card, 'click', () => {
                if (this.selectedBooks.has(bookKey)) {
                    this.selectedBooks.delete(bookKey);
                } else {
                    this.selectedBooks.add(bookKey);
                }
                syncUI();
            }));

            // Row: checkbox + book info
            const row = card.createDiv({ cls: 'ai-organiser-kindle-card-row' });

            const checkbox = row.createEl('input', { type: 'checkbox' });
            checkbox.checked = this.selectedBooks.has(bookKey);
            this.cleanups.push(listen(checkbox, 'click', (e) => e.stopPropagation()));
            this.cleanups.push(listen(checkbox, 'change', () => {
                if (checkbox.checked) {
                    this.selectedBooks.add(bookKey);
                } else {
                    this.selectedBooks.delete(bookKey);
                }
                syncUI();
            }));
            checkboxMap.set(bookKey, checkbox);

            const info = row.createDiv({ cls: 'ai-organiser-kindle-card-info' });
            info.createEl('strong', { text: book.title });
            const meta = info.createDiv({ cls: 'ai-organiser-kindle-card-meta' });
            meta.createSpan({ text: book.author });
            meta.createSpan({ text: ` · ${book.highlightCount} ${t.modals.kindle.highlights}` });

            if (newCount > 0) {
                meta.createSpan({
                    text: ` · ${newCount} ${t.modals.kindle.newHighlights}`,
                    cls: 'ai-organiser-kindle-new-badge'
                });
            } else {
                meta.createSpan({
                    text: ` · ${t.modals.kindle.upToDate}`,
                    cls: 'ai-organiser-kindle-uptodate'
                });
            }
        }

        // Auto-tag toggle
        new Setting(contentEl)
            .setName(t.modals.kindle.autoTagToggle)
            .addToggle(toggle => toggle
                .setValue(this.autoTag)
                .onChange(val => { this.autoTag = val; }));

        // Action buttons
        const actions = contentEl.createDiv({ cls: 'ai-organiser-kindle-actions' });

        new ButtonComponent(actions)
            .setButtonText(t.common.cancel)
            .onClick(() => this.close());

        const importBtn = new ButtonComponent(actions)
            .setButtonText(t.modals.kindle.importButton.replace('{count}', String(this.selectedBooks.size)))
            .setCta()
            .onClick(() => {
                const selected = this.books.filter(b =>
                    this.selectedBooks.has(generateBookKey(b.title, b.author))
                );
                void this.runImport(selected);
            });

        // UI sync helpers
        const refreshAll = this.buildRefreshAll(checkboxMap, importBtn, selectAllBtn, this.books.length, updateBadge);
        const syncUI = refreshAll;

        refreshAll();
    }

    // =========================================================================
    // Phase 3 — Progress
    // =========================================================================

    private async runImport(selectedBooks: KindleBook[]): Promise<void> {
        this.phase = 'progress';
        const { contentEl } = this;
        const t = this.plugin.t;
        contentEl.empty();

        this.abortController = new AbortController();

        // Progress UI
        const headingEl = contentEl.createEl('p', { text: t.modals.kindle.importing });

        const progressBar = contentEl.createDiv({ cls: 'ai-organiser-kindle-progress' });
        const progressFill = progressBar.createDiv({ cls: 'ai-organiser-kindle-progress-fill' });
        progressFill.setCssProps({ '--progress-width': '0%' }); progressFill.addClass('ai-organiser-dynamic-width');

        const statusEl = contentEl.createDiv({ cls: 'ai-organiser-kindle-status' });
        const bookCountEl = contentEl.createDiv({ cls: 'ai-organiser-kindle-status' });

        // Cancel button
        const cancelActions = contentEl.createDiv({ cls: 'ai-organiser-kindle-actions' });
        new ButtonComponent(cancelActions)
            .setButtonText(t.common.cancel)
            .onClick(() => {
                this.abortController?.abort();
            });

        const onProgress = (p: KindleSyncProgress) => {
            if (p.phase === 'ai-enhancing') {
                headingEl.textContent = t.modals.kindle.enhancing;
            }
            const pct = p.total > 0 ? Math.round((p.current / p.total) * 100) : 0;
            progressFill.setCssProps({ '--dynamic-width': `${pct}%` });
            if (p.bookTitle) {
                statusEl.textContent = p.bookTitle;
            }
            bookCountEl.textContent = t.modals.kindle.progress
                .replace('{current}', String(p.current))
                .replace('{total}', String(p.total));
        };

        try {
            const result = await syncFromClippings(
                this.plugin,
                selectedBooks,
                onProgress,
                this.abortController.signal
            );

            this.resultStats = {
                booksProcessed: result.booksProcessed,
                highlightsImported: result.highlightsImported,
            };
            this.resultErrors = result.errors;
            this.createdFiles = result.createdFiles;

            // AI enhancement: auto-tag + Bases summary hook
            if ((this.autoTag || this.plugin.settings.enableStructuredMetadata) && this.createdFiles.length > 0 && !this.abortController.signal.aborted) {
                await this.runAIEnhancement(onProgress);
            }

            this.renderResults();
        } catch (error) {
            new Notice(`Kindle import failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
            this.close();
        }
    }

    private async runAIEnhancement(onProgress: (p: KindleSyncProgress) => void): Promise<void> {
        const doTag = this.autoTag;
        const doSummary = this.plugin.settings.enableStructuredMetadata;

        if (!doTag && !doSummary) return;

        // Privacy consent for ALL LLM calls (both tagging and summary use the LLM).
        const consent = await ensurePrivacyConsent(this.plugin, this.plugin.settings.serviceType);
        if (!consent) return;

        const total = this.createdFiles.length;
        for (let i = 0; i < total; i++) {
            if (this.abortController?.signal.aborted) break;
            const cf = this.createdFiles[i];
            const file = this.app.vault.getAbstractFileByPath(cf.path);
            if (!(file instanceof TFile)) continue;

            onProgress({
                phase: 'ai-enhancing',
                current: i + 1,
                total,
                bookTitle: cf.title,
            });

            try {
                const content = await this.app.vault.read(file);

                // 1. Auto-tag (existing behaviour)
                if (doTag) {
                    await this.plugin.analyzeAndTagNote(file, content);
                }

                // 2. Generate summary hook and write Bases metadata
                if (doSummary) {
                    await this.generateAndWriteSummary(file, cf);
                }
            } catch {
                // Non-fatal: AI enhancement failure shouldn't block results
            }
        }
    }

    private async generateAndWriteSummary(
        file: TFile,
        cf: { book?: KindleBook }
    ): Promise<void> {
        if (!this.plugin.llmService) return;

        const book = cf.book;
        if (!book || book.highlights.length === 0) return;

        const language = getLanguageNameForPrompt(this.plugin.settings.summaryLanguage) || 'English';
        const prompt = buildBookSummaryPrompt(book, book.highlights, language);

        const response = await summarizeText(pluginContext(this.plugin), prompt);
        if (!response.success || !response.content) return;

        const hook = createSummaryHook(response.content);
        if (!hook) return;

        await updateAIOMetadata(this.app, file, {
            summary: hook,
            source: 'kindle',
            type: 'reference',
        });
    }

    // =========================================================================
    // Phase 4 — Results
    // =========================================================================

    private renderResults(): void {
        this.phase = 'results';
        const { contentEl } = this;
        const t = this.plugin.t;
        contentEl.empty();

        const wrapper = contentEl.createDiv({ cls: 'ai-organiser-kindle-results' });
        wrapper.createEl('h3', { text: t.modals.kindle.complete });

        wrapper.createEl('p', {
            text: t.modals.kindle.booksImported
                .replace('{books}', String(this.resultStats.booksProcessed))
                .replace('{highlights}', String(this.resultStats.highlightsImported))
        });

        if (this.resultErrors.length > 0) {
            const errorEl = wrapper.createDiv({ cls: 'ai-organiser-kindle-errors' });
            for (const err of this.resultErrors) {
                errorEl.createEl('p', { text: err, cls: 'ai-organiser-kindle-error' });
            }
        }

        // Open links for created files
        if (this.createdFiles.length > 0) {
            const list = wrapper.createEl('ul', { cls: 'ai-organiser-kindle-results-list' });
            for (const cf of this.createdFiles) {
                const li = list.createEl('li');
                const link = li.createEl('a', {
                    text: `${cf.title} — ${t.modals.kindle.openNote}`,
                    cls: 'internal-link'
                });
                this.cleanups.push(listen(link, 'click', (e) => {
                    e.preventDefault();
                    const file = this.app.vault.getAbstractFileByPath(cf.path);
                    if (file instanceof TFile) {
                        void this.app.workspace.getLeaf(true).openFile(file);
                    }
                }));
            }
        }

        new ButtonComponent(wrapper)
            .setButtonText(t.modals.kindle.done)
            .setCta()
            .onClick(() => this.close());
    }

    // =========================================================================
    // Amazon Cloud Sync
    // =========================================================================

    /**
     * Acquire valid Amazon cookies — prompts login if missing/expired.
     * Returns null if user cancels or cookies cannot be obtained.
     *
     * Skips HTTP re-validation for recently captured cookies (< 1 hour)
     * since they were already validated during the login flow.
     */
    private async acquireValidCookies(): Promise<import('../../services/kindle/kindleTypes').KindleCookiePayload | null> {
        const t = this.plugin.t;
        const region = this.plugin.settings.kindleAmazonRegion;

        let payload = await getStoredCookies(this.plugin);
        if (payload?.region !== region) {
            const loggedIn = await new KindleLoginModal(this.app, this.plugin).openAndWait();
            if (!loggedIn) return null;
            payload = await getStoredCookies(this.plugin);
            if (!payload) return null;
        }

        // Skip HTTP validation for recently captured cookies (< 1 hour).
        // Cookies were already validated during the embedded login flow via
        // validateCookies() — re-validating immediately causes false negatives
        // because Amazon's notebook SPA shell may contain sign-in references
        // in scripts/navigation even when the user IS authenticated.
        const FRESH_COOKIE_MS = 60 * 60 * 1000; // 1 hour
        const capturedAt = payload.capturedAt ? new Date(payload.capturedAt).getTime() : 0;
        if (Date.now() - capturedAt < FRESH_COOKIE_MS) {
            return payload;
        }

        // DD-3: Pre-validate before loading UI (UX polish — avoids spinner→error flash)
        const valid = await validateCookies(payload, region);
        if (!valid) {
            await clearCookies(this.plugin);
            const loggedIn = await new KindleLoginModal(this.app, this.plugin, {
                expiredMessage: t.kindleSync.sessionExpired,
            }).openAndWait();
            if (!loggedIn) return null;
            payload = await getStoredCookies(this.plugin);
        }

        return payload;
    }

    private async startAmazonSync(): Promise<void> {
        // Debug mode is handled by global logger singleton (no-op retained here)

        // Privacy gate
        const proceed = await ensurePrivacyConsent(this.plugin, 'cloud');
        if (!proceed) return;

        const cookiePayload = await this.acquireValidCookies();
        if (!cookiePayload) return;

        // Create AbortController for the Amazon flow
        this.abortController = new AbortController();

        // Show loading phase
        this.renderAmazonBookLoading();

        try {
            // 1. Module-level cache (from login in this session)
            const preScraped = consumePreScrapedBooks();
            if (preScraped && preScraped.length > 0) {
                logger.debug('Kindle', `Using ${preScraped.length} pre-scraped books from login payload`);
                // Also persist for future sessions
                this.plugin.settings.kindleSyncState.cachedBooks = preScraped;
                await this.plugin.saveSettings();
                this.amazonBooks = preScraped;
                this.renderAmazonBookSelection();
                return;
            }

            // 2. Persisted cache from previous session
            const cachedBooks = this.plugin.settings.kindleSyncState.cachedBooks;
            if (cachedBooks && cachedBooks.length > 0) {
                logger.debug('Kindle', `Using ${cachedBooks.length} persisted books from previous session`);
                this.amazonBooks = cachedBooks;
                this.renderAmazonBookSelection();
                return;
            }

            // 3. No book list available — Amazon renders books via JavaScript,
            //    so HTTP fetch will only find placeholder divs.
            //    Show a helpful re-auth prompt instead of a confusing "0 books" notice.
            this.renderLibraryRefreshNeeded();
        } catch (error) {
            if (!this.abortController?.signal.aborted) {
                new Notice(`Amazon sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
                this.renderSource();
            }
        }
    }

    private renderAmazonBookLoading(): void {
        const { contentEl } = this;
        const t = this.plugin.t;
        contentEl.empty();

        const loading = contentEl.createDiv({ cls: 'ai-organiser-kindle-loading' });
        loading.createEl('p', { text: t.modals.kindle.fetchingLibrary });
        const spinnerDiv = loading.createDiv({ cls: 'ai-organiser-kindle-spinner' });
        setIcon(spinnerDiv, 'loader-2');

        // Cancel button
        const actions = loading.createDiv({ cls: 'ai-organiser-kindle-actions' });
        new ButtonComponent(actions)
            .setButtonText(t.common.cancel)
            .onClick(() => {
                this.abortController?.abort();
                this.close();
            });
    }

    /**
     * Show when no book list is available (neither module cache nor persisted).
     * Amazon renders books via JavaScript so HTTP fetch won't work.
     * Guide the user to re-authenticate with the bookmarklet to get fresh book data.
     */
    private renderLibraryRefreshNeeded(): void {
        const { contentEl } = this;
        const t = this.plugin.t;
        contentEl.empty();

        const container = contentEl.createDiv({ cls: 'ai-organiser-kindle-loading' });

        const iconDiv = container.createDiv({ cls: 'ai-organiser-kindle-spinner' });
        setIcon(iconDiv, 'refresh-cw');

        container.createEl('h3', { text: t.modals.kindle.libraryRefreshTitle });
        container.createEl('p', {
            text: t.modals.kindle.libraryRefreshDesc,
            cls: 'setting-item-description',
        });

        const actions = container.createDiv({ cls: 'ai-organiser-kindle-actions' });

        new ButtonComponent(actions)
            .setButtonText(t.common.cancel)
            .onClick(() => this.close());

        new ButtonComponent(actions)
            .setButtonText(t.modals.kindle.refreshLibrary)
            .setCta()
            .setIcon('log-in')
            .onClick(async () => {
                const loggedIn = await new KindleLoginModal(this.app, this.plugin).openAndWait();
                if (!loggedIn) {
                    this.renderSource();
                    return;
                }
                // After re-login, pre-scraped books should be cached
                const preScraped = consumePreScrapedBooks();
                if (preScraped && preScraped.length > 0) {
                    this.plugin.settings.kindleSyncState.cachedBooks = preScraped;
                    await this.plugin.saveSettings();
                    this.amazonBooks = preScraped;
                    this.renderAmazonBookSelection();
                } else {
                    new Notice(t.modals.kindle.noBooks);
                    this.renderSource();
                }
            });
    }

    private renderAmazonBookSelection(): void {
        this.phase = 'books';
        const { contentEl } = this;
        const t = this.plugin.t;
        contentEl.empty();
        this.selectedBooks.clear();

        const state = this.plugin.settings.kindleSyncState;

        // Pre-select books never synced before
        for (const book of this.amazonBooks) {
            const hasAsinState = state.importedHighlightsByAsin?.[book.asin];
            if (!hasAsinState || hasAsinState.length === 0) {
                this.selectedBooks.add(book.asin);
            }
        }

        // Header with badge
        const header = contentEl.createDiv({ cls: 'ai-organiser-kindle-header' });
        const badgeEl = header.createSpan({ cls: 'ai-organiser-kindle-badge' });

        const updateBadge = () => {
            const count = this.selectedBooks.size;
            badgeEl.textContent = count > 0
                ? `${count} ${t.modals.kindle.selected}`
                : t.modals.kindle.selectBooksPrompt;
        };

        // Select All
        const selectAllBtn = new ButtonComponent(header)
            .setButtonText(t.modals.kindle.selectAll)
            .onClick(() => {
                const allSelected = this.selectedBooks.size === this.amazonBooks.length;
                this.selectedBooks.clear();
                if (!allSelected) {
                    for (const book of this.amazonBooks) {
                        this.selectedBooks.add(book.asin);
                    }
                }
                syncUI();
            });

        // Refresh Library button — re-scrape book list via bookmarklet
        new ButtonComponent(header)
            .setButtonText(t.modals.kindle.refreshLibrary)
            .setIcon('refresh-cw')
            .onClick(async () => {
                const loggedIn = await new KindleLoginModal(this.app, this.plugin).openAndWait();
                if (!loggedIn) return;
                const preScraped = consumePreScrapedBooks();
                if (preScraped && preScraped.length > 0) {
                    this.plugin.settings.kindleSyncState.cachedBooks = preScraped;
                    await this.plugin.saveSettings();
                    this.amazonBooks = preScraped;
                    this.renderAmazonBookSelection();
                }
            });

        // Scrollable book list
        const listEl = contentEl.createDiv({ cls: 'ai-organiser-kindle-list' });

        // Sort: never-synced first, then alphabetical
        const sortedBooks = [...this.amazonBooks].sort((a, b) => {
            const aNew = !state.importedHighlightsByAsin?.[a.asin]?.length;
            const bNew = !state.importedHighlightsByAsin?.[b.asin]?.length;
            if (aNew && !bNew) return -1;
            if (!aNew && bNew) return 1;
            return a.title.localeCompare(b.title);
        });

        const checkboxMap = new Map<string, HTMLInputElement>();

        for (const book of sortedBooks) {
            const neverSynced = !state.importedHighlightsByAsin?.[book.asin]?.length;
            const syncedCount = state.importedHighlightsByAsin?.[book.asin]?.length ?? 0;

            const card = listEl.createDiv({ cls: 'ai-organiser-kindle-card' });
            if (!neverSynced) card.addClass('ai-organiser-kindle-card-dimmed');
            if (this.selectedBooks.has(book.asin)) card.addClass('ai-organiser-kindle-card-selected');

            this.cleanups.push(listen(card, 'click', () => {
                if (this.selectedBooks.has(book.asin)) {
                    this.selectedBooks.delete(book.asin);
                } else {
                    this.selectedBooks.add(book.asin);
                }
                syncUI();
            }));

            const row = card.createDiv({ cls: 'ai-organiser-kindle-card-row' });
            const checkbox = row.createEl('input', { type: 'checkbox' });
            checkbox.checked = this.selectedBooks.has(book.asin);
            this.cleanups.push(listen(checkbox, 'click', (e) => e.stopPropagation()));
            this.cleanups.push(listen(checkbox, 'change', () => {
                if (checkbox.checked) {
                    this.selectedBooks.add(book.asin);
                } else {
                    this.selectedBooks.delete(book.asin);
                }
                syncUI();
            }));
            checkboxMap.set(book.asin, checkbox);

            const info = row.createDiv({ cls: 'ai-organiser-kindle-card-info' });
            info.createEl('strong', { text: book.title });
            const meta = info.createDiv({ cls: 'ai-organiser-kindle-card-meta' });
            meta.createSpan({ text: book.author });
            meta.createSpan({ text: ` · ${book.highlightCount} ${t.modals.kindle.highlights}` });

            if (neverSynced) {
                meta.createSpan({
                    text: ` · ${t.modals.kindle.neverSynced}`,
                    cls: 'ai-organiser-kindle-new-badge'
                });
            } else {
                // Show synced count so user knows differential sync state
                meta.createSpan({
                    text: ` · ${syncedCount} ${t.modals.kindle.synced}`,
                    cls: 'ai-organiser-kindle-uptodate'
                });
            }
        }

        // Auto-tag toggle
        new Setting(contentEl)
            .setName(t.modals.kindle.autoTagToggle)
            .addToggle(toggle => toggle
                .setValue(this.autoTag)
                .onChange(val => { this.autoTag = val; }));

        // Action buttons
        const actions = contentEl.createDiv({ cls: 'ai-organiser-kindle-actions' });

        new ButtonComponent(actions)
            .setButtonText(t.common.cancel)
            .onClick(() => this.close());

        const importBtn = new ButtonComponent(actions)
            .setButtonText(t.modals.kindle.importButton.replace('{count}', String(this.selectedBooks.size)))
            .setCta()
            .onClick(() => {
                const selected = this.amazonBooks.filter(b => this.selectedBooks.has(b.asin));
                void this.runAmazonImport(selected);
            });

        // UI sync helpers
        const refreshAll = this.buildRefreshAll(checkboxMap, importBtn, selectAllBtn, this.amazonBooks.length, updateBadge);
        const syncUI = refreshAll;

        refreshAll();
    }

    private async runAmazonImport(selectedBooks: KindleScrapedBook[]): Promise<void> {
        this.phase = 'progress';
        const { contentEl } = this;
        const t = this.plugin.t;
        contentEl.empty();

        this.abortController = new AbortController();

        // Progress UI
        const headingEl = contentEl.createEl('p', { text: t.modals.kindle.importing });

        const progressBar = contentEl.createDiv({ cls: 'ai-organiser-kindle-progress' });
        const progressFill = progressBar.createDiv({ cls: 'ai-organiser-kindle-progress-fill' });
        progressFill.setCssProps({ '--progress-width': '0%' }); progressFill.addClass('ai-organiser-dynamic-width');

        const statusEl = contentEl.createDiv({ cls: 'ai-organiser-kindle-status' });
        const bookCountEl = contentEl.createDiv({ cls: 'ai-organiser-kindle-status' });

        const cancelActions = contentEl.createDiv({ cls: 'ai-organiser-kindle-actions' });
        new ButtonComponent(cancelActions)
            .setButtonText(t.common.cancel)
            .onClick(() => { this.abortController?.abort(); });

        const onProgress = (p: KindleSyncProgress) => {
            if (p.phase === 'ai-enhancing') {
                headingEl.textContent = t.modals.kindle.enhancing;
            }
            const pct = p.total > 0 ? Math.round((p.current / p.total) * 100) : 0;
            progressFill.setCssProps({ '--dynamic-width': `${pct}%` });
            if (p.bookTitle) statusEl.textContent = p.bookTitle;
            bookCountEl.textContent = t.modals.kindle.progress
                .replace('{current}', String(p.current))
                .replace('{total}', String(p.total));
        };

        try {
            const result = await syncFromAmazon(
                this.plugin,
                selectedBooks,
                onProgress,
                this.abortController.signal
            );

            if (result.authExpired) {
                new Notice(t.modals.kindle.amazonLoginExpired);
                this.renderSource();
                return;
            }

            this.resultStats = {
                booksProcessed: result.booksProcessed,
                highlightsImported: result.highlightsImported,
            };
            this.resultErrors = result.errors;
            this.createdFiles = result.createdFiles;

            // AI enhancement: auto-tag + Bases summary hook
            if ((this.autoTag || this.plugin.settings.enableStructuredMetadata) && this.createdFiles.length > 0 && !this.abortController.signal.aborted) {
                await this.runAIEnhancement(onProgress);
            }

            this.renderResults();
        } catch (error) {
            new Notice(`Amazon import failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
            this.close();
        }
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    /** Shared: update the import button text and disabled state */
    private updateImportBtnUI(btn: ButtonComponent): void {
        const count = this.selectedBooks.size;
        btn.setButtonText(this.plugin.t.modals.kindle.importButton.replace('{count}', String(count)));
        btn.setDisabled(count === 0);
    }

    /** Shared: update select-all button text */
    private updateSelectAllBtnUI(btn: ButtonComponent, totalCount: number): void {
        const t = this.plugin.t;
        const allSelected = this.selectedBooks.size === totalCount && totalCount > 0;
        btn.setButtonText(allSelected ? t.modals.kindle.deselectAll : t.modals.kindle.selectAll);
    }

    /** Shared: sync checkbox checked state with selectedBooks set */
    private syncCheckboxUI(checkboxMap: Map<string, HTMLInputElement>): void {
        for (const [key, cb] of checkboxMap) {
            cb.checked = this.selectedBooks.has(key);
            const card = cb.closest('.ai-organiser-kindle-card') as HTMLElement;
            if (card) {
                card.toggleClass('ai-organiser-kindle-card-selected', this.selectedBooks.has(key));
            }
        }
    }

    /** Build a closure that refreshes all UI elements (badge, import btn, select-all btn, checkboxes) */
    private buildRefreshAll(
        checkboxMap: Map<string, HTMLInputElement>,
        importBtn: ButtonComponent,
        selectAllBtn: ButtonComponent,
        totalCount: number,
        updateBadge: () => void,
    ): () => void {
        return () => {
            this.syncCheckboxUI(checkboxMap);
            updateBadge();
            this.updateImportBtnUI(importBtn);
            this.updateSelectAllBtnUI(selectAllBtn, totalCount);
        };
    }

    private formatTimeAgo(isoDate: string): string {
        const ms = Date.now() - new Date(isoDate).getTime();
        const minutes = Math.floor(ms / 60000);
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        return `${days}d ago`;
    }
}
