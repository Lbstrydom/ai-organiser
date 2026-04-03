/**
 * Web Reader Modal
 * Two-phase modal: Phase 1 (progress) → Phase 2 (triage selection list)
 */

import { App, ButtonComponent, Modal, Notice, Setting, TFile } from 'obsidian';
import { logger } from '../../utils/logger';
import type AIOrganiserPlugin from '../../main';
import {
    fetchAndTriageArticles,
    createNoteFromArticles,
    TriagedArticle,
    TriageProgress
} from '../../services/webReaderService';

export class WebReaderModal extends Modal {
    private plugin: AIOrganiserPlugin;
    private urls: string[];
    private articles: TriagedArticle[] = [];
    private selectedUrls: Set<string> = new Set();
    private abortController: AbortController = new AbortController();
    private phase: 'loading' | 'triage' = 'loading';
    private createdNotes: { path: string; title: string }[] = [];

    // Phase 2 DOM references for in-place updates
    private badgeEl: HTMLElement | null = null;
    private createBtn: ButtonComponent | null = null;
    private discardBtn: ButtonComponent | null = null;
    private selectAllBtn: ButtonComponent | null = null;
    private noteTitleInput: HTMLInputElement | null = null;

    constructor(app: App, plugin: AIOrganiserPlugin, urls: string[]) {
        super(app);
        this.plugin = plugin;
        this.urls = urls;
    }

    onOpen(): void {
        const t = this.plugin.t;
        this.modalEl.addClass('ai-organiser-web-reader');
        this.titleEl.setText(t.modals.webReader.title);
        this.modalEl.style.maxWidth = '700px';
        this.renderLoading();
    }

    onClose(): void {
        this.abortController.abort();
    }

    // =========================================================================
    // Phase 1 — Loading
    // =========================================================================

    private renderLoading(): void {
        this.phase = 'loading';
        const { contentEl } = this;
        const t = this.plugin.t;
        contentEl.empty();

        const desc = contentEl.createEl('p', {
            text: t.modals.webReader.loadingDescription.replace('{count}', String(this.urls.length))
        });

        // Progress bar
        const progressBar = contentEl.createDiv({ cls: 'ai-organiser-web-reader-progress' });
        const progressFill = progressBar.createDiv({ cls: 'ai-organiser-web-reader-progress-fill' });
        progressFill.style.width = '0%';

        // Status text
        const statusEl = contentEl.createDiv({ cls: 'ai-organiser-web-reader-status' });

        // Cancel button
        new ButtonComponent(contentEl)
            .setButtonText(t.modals.webReader.cancelButton)
            .onClick(() => {
                this.abortController.abort();
            });

        // Start fetching
        const onProgress = (p: TriageProgress) => {
            const pct = Math.round((p.current / p.total) * 100);
            progressFill.style.width = `${pct}%`;

            const truncUrl = p.url.length > 60 ? p.url.substring(0, 57) + '...' : p.url;
            if (p.phase === 'fetching') {
                statusEl.textContent = `${t.modals.webReader.fetchingArticle
                    .replace('{current}', String(p.current))
                    .replace('{total}', String(p.total))}: ${truncUrl}`;
            } else if (p.phase === 'summarizing') {
                statusEl.textContent = `${t.modals.webReader.summarizingArticle
                    .replace('{current}', String(p.current))
                    .replace('{total}', String(p.total))}: ${truncUrl}`;
            }
        };

        fetchAndTriageArticles(
            this.urls,
            this.plugin,
            onProgress,
            this.abortController.signal
        ).then(articles => {
            this.articles = articles;
            this.renderTriage();
        }).catch(error => {
            logger.error('UI', 'Web Reader error:', error);
            new Notice(`Web Reader failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
            this.close();
        });
    }

    // =========================================================================
    // Phase 2 — Triage
    // =========================================================================

    private renderTriage(): void {
        this.phase = 'triage';
        const { contentEl } = this;
        const t = this.plugin.t;
        contentEl.empty();

        if (this.articles.length === 0) {
            this.renderCompletion();
            return;
        }

        // (a) Header: badge + select all
        const header = contentEl.createDiv({ cls: 'ai-organiser-web-reader-header' });
        this.badgeEl = header.createSpan({ cls: 'ai-organiser-web-reader-badge' });
        this.updateBadge();

        this.selectAllBtn = new ButtonComponent(header);
        this.updateSelectAllButton();
        this.selectAllBtn.onClick(() => {
            if (this.selectedUrls.size === this.articles.length) {
                this.selectedUrls.clear();
            } else {
                for (const a of this.articles) {
                    this.selectedUrls.add(a.url);
                }
            }
            this.syncCheckboxes();
            this.updateBadge();
            this.updateButtons();
        });

        // (b) Note title input
        const titleSetting = new Setting(contentEl)
            .setName(t.modals.webReader.noteTitleLabel)
            .addText(text => {
                text.setPlaceholder(t.modals.webReader.noteTitlePlaceholder);
                this.noteTitleInput = text.inputEl;
            });

        // (c) Scrollable article list
        const listEl = contentEl.createDiv({ cls: 'ai-organiser-web-reader-list' });

        for (const article of this.articles) {
            const card = listEl.createDiv({ cls: 'ai-organiser-web-reader-card' });
            if (article.fetchError) card.addClass('ai-organiser-web-reader-card-error');
            if (this.selectedUrls.has(article.url)) card.addClass('ai-organiser-web-reader-card-selected');

            // Card click toggles selection
            card.addEventListener('click', (e) => {
                this.toggleSelection(article.url);
                card.toggleClass('ai-organiser-web-reader-card-selected', this.selectedUrls.has(article.url));
                const cb = card.querySelector('input[type="checkbox"]') as HTMLInputElement;
                if (cb) cb.checked = this.selectedUrls.has(article.url);
                this.updateBadge();
                this.updateButtons();
            });

            // Row 1: checkbox + title link + site badge
            const headerRow = card.createDiv({ cls: 'ai-organiser-web-reader-card-header' });

            const checkbox = headerRow.createEl('input', { type: 'checkbox' });
            checkbox.checked = this.selectedUrls.has(article.url);
            checkbox.addEventListener('click', (e) => e.stopPropagation());
            checkbox.addEventListener('change', () => {
                this.toggleSelection(article.url);
                card.toggleClass('ai-organiser-web-reader-card-selected', this.selectedUrls.has(article.url));
                this.updateBadge();
                this.updateButtons();
            });

            const titleLink = headerRow.createEl('a', {
                cls: 'ai-organiser-web-reader-card-title external-link',
                text: article.title,
                href: article.url,
            });
            titleLink.addEventListener('click', (e) => e.stopPropagation());

            if (article.siteName) {
                headerRow.createSpan({
                    cls: 'ai-organiser-web-reader-site',
                    text: article.siteName
                });
            }

            // Row 2: byline
            if (article.byline) {
                card.createDiv({
                    cls: 'ai-organiser-web-reader-byline',
                    text: article.byline
                });
            }

            // Row 3: summary
            const summaryEl = card.createEl('p', {
                cls: 'ai-organiser-web-reader-summary',
                text: article.briefSummary
            });

            if (article.llmFailed && !article.fetchError) {
                summaryEl.createSpan({
                    cls: 'ai-organiser-web-reader-site',
                    text: ` ${t.modals.webReader.excerpt}`
                });
            }
        }

        // (d) Action buttons
        const actions = contentEl.createDiv({ cls: 'ai-organiser-web-reader-actions' });

        // Discard All & Close
        new ButtonComponent(actions)
            .setButtonText(t.modals.webReader.discardAllClose)
            .setWarning()
            .onClick(() => this.close());

        // Discard Selected
        this.discardBtn = new ButtonComponent(actions)
            .setButtonText(t.modals.webReader.discardSelected)
            .onClick(() => {
                this.articles = this.articles.filter(a => !this.selectedUrls.has(a.url));
                this.selectedUrls.clear();
                this.renderTriage();
            });

        // Create Note
        this.createBtn = new ButtonComponent(actions)
            .setButtonText(t.modals.webReader.createNote)
            .setCta()
            .onClick(async () => {
                const selected = this.articles.filter(a => this.selectedUrls.has(a.url));
                if (selected.length === 0) return;

                const titleValue = this.noteTitleInput?.value?.trim() || undefined;
                const file = await createNoteFromArticles(
                    this.app,
                    this.plugin.settings,
                    selected,
                    titleValue
                );

                // Open in new tab (SRP: UI navigation in modal, not service)
                this.app.workspace.getLeaf(true).openFile(file);

                new Notice(t.modals.webReader.createdNote.replace('{filename}', file.basename));
                this.createdNotes.push({ path: file.path, title: file.basename });

                // Remove selected from list
                this.articles = this.articles.filter(a => !this.selectedUrls.has(a.url));
                this.selectedUrls.clear();

                this.renderTriage();
            });

        this.updateButtons();
    }

    // =========================================================================
    // Phase 3 — Completion
    // =========================================================================

    private renderCompletion(): void {
        const { contentEl } = this;
        const t = this.plugin.t;
        contentEl.empty();

        const wrapper = contentEl.createDiv({ cls: 'ai-organiser-web-reader-completion' });
        wrapper.createEl('h3', { text: t.modals.webReader.completionTitle });

        if (this.createdNotes.length > 0) {
            wrapper.createEl('p', {
                text: t.modals.webReader.completionMessage.replace('{count}', String(this.createdNotes.length))
            });
            const list = wrapper.createEl('ul');
            for (const note of this.createdNotes) {
                const li = list.createEl('li');
                const link = li.createEl('a', { text: note.title, cls: 'internal-link' });
                link.addEventListener('click', (e) => {
                    e.preventDefault();
                    const file = this.app.vault.getAbstractFileByPath(note.path);
                    if (file instanceof TFile) {
                        this.app.workspace.getLeaf(true).openFile(file);
                    }
                });
            }
        }

        new ButtonComponent(wrapper)
            .setButtonText(t.modals.webReader.closeButton)
            .setCta()
            .onClick(() => this.close());
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    private toggleSelection(url: string): void {
        if (this.selectedUrls.has(url)) {
            this.selectedUrls.delete(url);
        } else {
            this.selectedUrls.add(url);
        }
    }

    private updateBadge(): void {
        if (!this.badgeEl) return;
        const t = this.plugin.t;
        if (this.selectedUrls.size > 0) {
            this.badgeEl.textContent = `${this.selectedUrls.size} ${t.modals.webReader.selected}`;
        } else {
            this.badgeEl.textContent = t.modals.webReader.selectToKeep;
        }
    }

    private updateButtons(): void {
        const hasSelection = this.selectedUrls.size > 0;
        if (this.createBtn) this.createBtn.setDisabled(!hasSelection);
        if (this.discardBtn) this.discardBtn.setDisabled(!hasSelection);
        this.updateSelectAllButton();
    }

    private updateSelectAllButton(): void {
        if (!this.selectAllBtn) return;
        const t = this.plugin.t;
        const allSelected = this.selectedUrls.size === this.articles.length && this.articles.length > 0;
        this.selectAllBtn.setButtonText(allSelected ? t.modals.webReader.deselectAll : t.modals.webReader.selectAll);
    }

    private syncCheckboxes(): void {
        const checkboxes = this.contentEl.querySelectorAll('.ai-organiser-web-reader-card input[type="checkbox"]');
        const cards = this.contentEl.querySelectorAll('.ai-organiser-web-reader-card');
        checkboxes.forEach((cb, idx) => {
            const input = cb as HTMLInputElement;
            const article = this.articles[idx];
            if (article) {
                input.checked = this.selectedUrls.has(article.url);
                cards[idx]?.toggleClass('ai-organiser-web-reader-card-selected', this.selectedUrls.has(article.url));
            }
        });
    }
}
