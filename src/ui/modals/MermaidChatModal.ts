/**
 * Mermaid Chat Modal
 * Conversational diagram editing with live preview and in-place note replacement.
 *
 * Desktop: split-pane (chat left, preview right)
 * Mobile: tabbed toggle (Preview | Chat) with action bar pinned at bottom
 *
 * Phase 3 additions:
 *  - Version history navigation (prev/next within session)
 *  - Line-level diff view between consecutive versions
 *  - Edit coalescing: rapid applies within 5 s reuse tracked range
 */

import { Modal, MarkdownRenderer, Platform, Component, Notice, Editor, App, FuzzySuggestModal, Menu, TFile } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { MermaidContextService } from '../../services/mermaidContextService';
import { MermaidTemplateService } from '../../services/mermaidTemplateService';
import { MermaidExportService } from '../../services/mermaidExportService';
import { MermaidChangeDetector } from '../../services/mermaidChangeDetector';
import { MermaidTemplatePickerModal } from './MermaidTemplatePickerModal';
import {
    MermaidBlock,
    resolveBlockByFingerprint,
    buildBlockFingerprint,
    validateMermaidSyntax,
} from '../../utils/mermaidUtils';
import {
    buildMermaidChatSystemPrompt,
    buildMermaidChatUserPrompt,
    formatConversationTurn,
    buildTypeConversionInstruction,
    buildDiagramAltTextPrompt,
    MermaidChatPromptOptions,
} from '../../services/prompts/mermaidChatPrompts';
import { computeLineDiff, getDiffStats, hasMeaningfulChanges } from '../../utils/mermaidDiff';
import { cleanMermaidOutput } from '../../services/prompts/diagramPrompts';
import { ensurePrivacyConsent } from '../../services/privacyNotice';
import { getServiceType, summarizeText, summarizeTextStream, pluginContext } from '../../services/llmFacade';

interface ConversationTurn {
    role: 'user' | 'assistant';
    content: string;
}

const CONVERT_DIAGRAM_TYPES: { type: string; label: string }[] = [
    { type: 'flowchart TD', label: 'Flowchart (top-down)' },
    { type: 'flowchart LR', label: 'Flowchart (left-right)' },
    { type: 'sequenceDiagram', label: 'Sequence' },
    { type: 'classDiagram', label: 'Class' },
    { type: 'stateDiagram-v2', label: 'State' },
    { type: 'erDiagram', label: 'Entity Relationship' },
    { type: 'gantt', label: 'Gantt' },
    { type: 'mindmap', label: 'Mindmap' },
    { type: 'timeline', label: 'Timeline' },
    { type: 'pie title Chart', label: 'Pie Chart' },
    { type: 'quadrantChart', label: 'Quadrant' },
    { type: 'gitGraph', label: 'Git Graph' },
];

class DiagramTypePickerModal extends FuzzySuggestModal<{ type: string; label: string }> {
    constructor(
        app: App,
        private readonly items: { type: string; label: string }[],
        private readonly onSelect: (item: { type: string; label: string }) => void,
        placeholder: string,
    ) {
        super(app);
        this.setPlaceholder(placeholder);
    }

    getItems(): { type: string; label: string }[] {
        return this.items;
    }

    getItemText(item: { type: string; label: string }): string {
        return item.label;
    }

    onChooseItem(item: { type: string; label: string }): void {
        this.onSelect(item);
    }
}

export class MermaidChatModal extends Modal {
    private currentDiagram: string;
    private readonly originalBlock: MermaidBlock | null;
    private blockFingerprint: string;
    private originalStartLine: number;
    private readonly conversationHistory: ConversationTurn[] = [];
    private isProcessing = false;
    private consentGranted = false;
    private readonly component: Component;
    private streamAbortController: AbortController | null = null;

    // Phase 3: version history
    private readonly diagramHistory: string[] = [];
    private historyIndex = -1;

    // Phase 3: edit coalescing
    private lastApplyMs = 0;
    private lastApplyFrom: { line: number; ch: number } | null = null;
    private lastApplyTo: { line: number; ch: number } | null = null;
    private static readonly COALESCE_WINDOW_MS = 5000;

    // UI elements
    private previewEl!: HTMLElement;
    private chatContainer!: HTMLElement;
    private inputEl!: HTMLTextAreaElement;
    private sendBtn!: HTMLButtonElement;
    private cancelBtn!: HTMLButtonElement;
    private applyBtn!: HTMLButtonElement;
    private historyNavEl!: HTMLElement;
    private exportBtn!: HTMLButtonElement;
    private saveTemplateBtn!: HTMLButtonElement;

    // Phase 4 services
    private readonly contextService: MermaidContextService;
    private readonly templateService: MermaidTemplateService;
    private readonly exportService: MermaidExportService;
    private readonly changeDetector: MermaidChangeDetector;

    // Mobile tabs
    private activeTab: 'preview' | 'chat' = 'chat';

    constructor(
        private readonly plugin: AIOrganiserPlugin,
        private readonly editor: Editor,
        initialBlock: MermaidBlock | null,
    ) {
        super(plugin.app);
        this.component = new Component();
        this.originalBlock = initialBlock;
        this.currentDiagram = initialBlock?.code ?? '';
        this.blockFingerprint = initialBlock ? buildBlockFingerprint(initialBlock) : '';
        this.originalStartLine = initialBlock?.startLine ?? 0;

        // Phase 4: service initialisation
        this.contextService = new MermaidContextService(plugin.app, plugin);
        this.templateService = new MermaidTemplateService(plugin.app, plugin);
        this.exportService = new MermaidExportService(plugin.app, plugin);
        // Use shared detector so snapshots persist across modal sessions (§4.4.2)
        this.changeDetector = plugin.mermaidChangeDetector;
    }

    onOpen() {
        const { contentEl } = this;
        const t = this.plugin.t.modals.mermaidChat;

        contentEl.empty();
        contentEl.addClass('ai-organiser-mermaid-chat');

        contentEl.createEl('h2', { cls: 'ai-organiser-mermaid-chat-title', text: t.title });

        if (Platform.isMobile) {
            this.buildMobileLayout(contentEl);
        } else {
            this.buildDesktopLayout(contentEl);
        }

        this.buildHistoryNav(contentEl);
        this.buildActionBar(contentEl);

        if (this.currentDiagram) {
            this.renderPreview(this.currentDiagram);
        }

        // Phase 4: staleness check
        if (this.currentDiagram && this.plugin.settings.mermaidChatStalenessNotice) {
            const { isStale } = this.changeDetector.checkStaleness(
                this.blockFingerprint,
                this.editor.getValue(),
            );
            if (isStale) {
                this.showStalenessNotice();
            }
        }

        setTimeout(() => this.inputEl?.focus(), 50);
    }

    // ── Desktop layout ──────────────────────────────────────────────────────

    private buildDesktopLayout(parent: HTMLElement): void {
        const t = this.plugin.t.modals.mermaidChat;
        const layout = parent.createEl('div', { cls: 'ai-organiser-mermaid-chat-layout' });

        const chatPane = layout.createEl('div', { cls: 'ai-organiser-mermaid-chat-panel' });
        this.chatContainer = chatPane.createEl('div', { cls: 'ai-organiser-mermaid-chat-history' });
        this.buildInputRow(chatPane);

        const previewPane = layout.createEl('div', { cls: 'ai-organiser-mermaid-preview-panel' });
        if (!this.currentDiagram) {
            previewPane.createEl('div', {
                cls: 'ai-organiser-mermaid-preview-label',
                text: t.noBlockFound,
            });
        }
        this.previewEl = previewPane.createEl('div', { cls: 'ai-organiser-mermaid-preview' });
    }

    // ── Mobile layout ───────────────────────────────────────────────────────

    private buildMobileLayout(parent: HTMLElement): void {
        const t = this.plugin.t.modals.mermaidChat;

        const tabBar = parent.createEl('div', { cls: 'ai-organiser-mermaid-tabs' });
        const previewTab = tabBar.createEl('button', {
            cls: 'ai-organiser-mermaid-tab',
            text: t.previewTab,
        });
        const chatTab = tabBar.createEl('button', {
            cls: 'ai-organiser-mermaid-tab ai-organiser-mermaid-tab-active',
            text: t.chatTab,
        });

        const contentArea = parent.createEl('div', { cls: 'ai-organiser-mermaid-tab-content' });

        const previewTabContent = contentArea.createEl('div', { cls: 'ai-organiser-mermaid-tab-pane' });
        previewTabContent.dataset.tab = 'preview';
        previewTabContent.addClass('ai-organiser-hidden');
        this.previewEl = previewTabContent.createEl('div', { cls: 'ai-organiser-mermaid-preview' });

        const chatTabContent = contentArea.createEl('div', { cls: 'ai-organiser-mermaid-tab-pane' });
        chatTabContent.dataset.tab = 'chat';
        this.chatContainer = chatTabContent.createEl('div', { cls: 'ai-organiser-mermaid-chat-history' });
        this.buildInputRow(chatTabContent);

        const switchTab = (tab: 'preview' | 'chat') => {
            this.activeTab = tab;
            previewTabContent.toggleClass('ai-organiser-hidden', tab !== 'preview');
            chatTabContent.toggleClass('ai-organiser-hidden', tab !== 'chat');
            previewTab.classList.toggle('ai-organiser-mermaid-tab-active', tab === 'preview');
            chatTab.classList.toggle('ai-organiser-mermaid-tab-active', tab === 'chat');
        };

        previewTab.onclick = () => switchTab('preview');
        chatTab.onclick = () => switchTab('chat');
        switchTab('chat');
    }

    // ── Input row ───────────────────────────────────────────────────────────

    private buildInputRow(parent: HTMLElement): void {
        const t = this.plugin.t.modals.mermaidChat;
        const row = parent.createEl('div', { cls: 'ai-organiser-mermaid-input-row' });

        this.inputEl = row.createEl('textarea', {
            cls: 'ai-organiser-mermaid-input',
            attr: {
                placeholder: this.currentDiagram ? t.placeholder : t.placeholderNew,
                rows: '2',
            },
        });

        this.inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void this.handleSend();
            }
        });

        this.sendBtn = row.createEl('button', {
            cls: 'mod-cta ai-organiser-mermaid-send',
            text: t.sendButton,
        });
        this.sendBtn.onclick = () => { void this.handleSend(); };

        this.cancelBtn = row.createEl('button', {
            cls: 'ai-organiser-mermaid-cancel',
            text: t.cancelButton,
        });
        this.cancelBtn.addClass('ai-organiser-hidden');
        this.cancelBtn.onclick = () => this.streamAbortController?.abort();
    }

    // ── History navigation row ──────────────────────────────────────────────

    private buildHistoryNav(parent: HTMLElement): void {
        this.historyNavEl = parent.createEl('div', { cls: 'ai-organiser-mermaid-history-nav' });
        this.historyNavEl.addClass('ai-organiser-hidden');
    }

    private updateHistoryNav(): void {
        if (this.diagramHistory.length < 2) {
            this.historyNavEl.addClass('ai-organiser-hidden');
            return;
        }
        this.historyNavEl.removeClass('ai-organiser-hidden');
        this.historyNavEl.empty();

        const t = this.plugin.t.modals.mermaidChat;

        const prevBtn = this.historyNavEl.createEl('button', {
            cls: 'ai-organiser-mermaid-history-btn',
            text: '←',
            attr: { 'aria-label': t.historyPrev, title: t.historyPrev },
        });
        prevBtn.disabled = this.historyIndex === 0;
        prevBtn.onclick = () => this.navigateHistory(-1);

        this.historyNavEl.createEl('span', {
            cls: 'ai-organiser-mermaid-history-counter',
            text: `${t.historyLabel} ${this.historyIndex + 1} / ${this.diagramHistory.length}`,
        });

        const nextBtn = this.historyNavEl.createEl('button', {
            cls: 'ai-organiser-mermaid-history-btn',
            text: '→',
            attr: { 'aria-label': t.historyNext, title: t.historyNext },
        });
        nextBtn.disabled = this.historyIndex === this.diagramHistory.length - 1;
        nextBtn.onclick = () => this.navigateHistory(1);
    }

    private navigateHistory(direction: -1 | 1): void {
        const newIndex = this.historyIndex + direction;
        if (newIndex < 0 || newIndex >= this.diagramHistory.length) return;
        this.historyIndex = newIndex;
        this.currentDiagram = this.diagramHistory[newIndex];
        this.renderPreview(this.currentDiagram);
        this.updateHistoryNav();
    }

    // ── Action bar ──────────────────────────────────────────────────────────

    private buildActionBar(parent: HTMLElement): void {
        const t = this.plugin.t.modals.mermaidChat;
        const bar = parent.createEl('div', { cls: 'ai-organiser-mermaid-actions' });

        this.applyBtn = bar.createEl('button', {
            cls: 'mod-cta ai-organiser-mermaid-apply',
            text: t.applyButton,
        });
        this.applyBtn.disabled = !this.currentDiagram;
        this.applyBtn.onclick = () => { void this.applyToNote(); };

        const convertBtn = bar.createEl('button', {
            cls: 'ai-organiser-mermaid-convert',
            text: t.convertTo,
            attr: { 'data-role': 'convert' },
        });
        convertBtn.disabled = !this.currentDiagram;
        convertBtn.onclick = () => this.promptTypeConversion();

        const copyBtn = bar.createEl('button', {
            cls: 'ai-organiser-mermaid-copy',
            text: t.copyButton,
        });
        copyBtn.onclick = () => this.copyCode();

        // Phase 4 buttons
        const templateBtn = bar.createEl('button', {
            cls: 'ai-organiser-mermaid-templates',
            text: t.templateButton,
        });
        templateBtn.onclick = () => { void this.openTemplatePicker(); };

        this.exportBtn = bar.createEl('button', {
            cls: 'ai-organiser-mermaid-export',
            text: t.exportButton,
        });
        this.exportBtn.disabled = !this.currentDiagram;
        this.exportBtn.onclick = (e: MouseEvent) => { this.showExportMenu(e); };

        this.saveTemplateBtn = bar.createEl('button', {
            cls: 'ai-organiser-mermaid-save-template',
            text: t.saveAsTemplate,
        });
        this.saveTemplateBtn.disabled = !this.currentDiagram;
        this.saveTemplateBtn.onclick = () => { void this.promptSaveAsTemplate(); };

        const discardBtn = bar.createEl('button', {
            cls: 'ai-organiser-mermaid-discard',
            text: t.discardButton,
        });
        discardBtn.onclick = () => this.close();
    }

    // ── Core: send message ──────────────────────────────────────────────────

    private async handleSend(overrideInstruction?: string): Promise<void> {
        const userInput = overrideInstruction ?? this.inputEl.value.trim();
        if (!userInput || this.isProcessing) return;

        if (!this.consentGranted) {
            const { provider: serviceType } = getServiceType(pluginContext(this.plugin));
            const proceed = await ensurePrivacyConsent(this.plugin, serviceType);
            if (!proceed) {
                new Notice(this.plugin.t.modals.mermaidChat.privacyRequired);
                return;
            }
            this.consentGranted = true;
        }

        if (!overrideInstruction) {
            this.inputEl.value = '';
        }
        this.setProcessing(true);
        this.addChatMessage('user', userInput);

        const t = this.plugin.t.modals.mermaidChat;
        const thinkingMsg = this.addChatMessage('assistant', t.generating);

        const controller = new AbortController();
        this.streamAbortController = controller;

        try {
            const historyText = this.conversationHistory
                .slice(0, -1)
                .map(turn => formatConversationTurn(turn.role, turn.content))
                .join('\n');

            const { provider } = getServiceType(pluginContext(this.plugin));
            const model = this.plugin.settings.cloudModel;

            const contextData = await this.gatherContextData();

            const promptOptions: MermaidChatPromptOptions = {
                currentDiagram: this.currentDiagram,
                noteContent: this.plugin.settings.mermaidChatIncludeNoteContext ? this.editor.getValue() : '',
                userMessage: userInput,
                conversationHistory: historyText,
                outputLanguage: this.plugin.settings.summaryLanguage || 'en',
                provider,
                model,
                ...contextData,
            };

            const systemPrompt = buildMermaidChatSystemPrompt(promptOptions);
            const userPrompt = buildMermaidChatUserPrompt(promptOptions);
            const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

            let accumulated = '';

            const response = await summarizeTextStream(
                pluginContext(this.plugin),
                fullPrompt,
                (chunk: string) => {
                    accumulated += chunk;
                    this.showStreamingPreview(accumulated);
                },
                controller.signal,
            );

            this.applyStreamResult(controller.signal, response, accumulated, thinkingMsg, t);
        } catch (err) {
            thinkingMsg.textContent = '✗ ' + this.formatStreamError(err, controller.signal, t);
            this.conversationHistory.pop();
        } finally {
            this.streamAbortController = null;
            this.setProcessing(false);
        }
    }

    /** Gather enriched context (siblings, backlinks, RAG) based on user settings. */
    private async gatherContextData(): Promise<{ siblingDiagrams?: string[]; backlinkContext?: string; ragContext?: string }> {
        const {
            mermaidChatIncludeNoteContext,
            mermaidChatIncludeBacklinks,
            mermaidChatIncludeRAG,
        } = this.plugin.settings;
        const activeFile = this.plugin.app.workspace.getActiveFile();
        if (!activeFile || (!mermaidChatIncludeNoteContext && !mermaidChatIncludeBacklinks && !mermaidChatIncludeRAG)) {
            return {};
        }
        try {
            const gathered = await this.contextService.gatherContext(activeFile, this.currentDiagram);
            const result: { siblingDiagrams?: string[]; backlinkContext?: string; ragContext?: string } = {};
            if (mermaidChatIncludeNoteContext && gathered.siblingDiagrams.length > 0) {
                result.siblingDiagrams = gathered.siblingDiagrams;
            }
            if (mermaidChatIncludeBacklinks && gathered.backlinkContext) {
                result.backlinkContext = gathered.backlinkContext;
            }
            if (mermaidChatIncludeRAG && gathered.ragContext) {
                result.ragContext = gathered.ragContext;
            }
            return result;
        } catch {
            return {}; // Context gathering failures are non-fatal
        }
    }

    private formatStreamError(
        err: unknown,
        signal: AbortSignal,
        t: typeof this.plugin.t.modals.mermaidChat,
    ): string {
        if (signal.aborted) return t.cancelled;
        if (err instanceof Error) return err.message;
        return String(err);
    }

    private applyStreamResult(
        signal: AbortSignal,
        response: { success: boolean; content?: string; error?: string } | null,
        accumulated: string,
        thinkingMsg: HTMLElement,
        t: typeof this.plugin.t.modals.mermaidChat,
    ): void {
        if (signal.aborted) {
            thinkingMsg.textContent = '✗ ' + t.cancelled;
            this.conversationHistory.pop();
            return;
        }

        const raw = response?.content || (accumulated.trim() ? accumulated : null);

        if (response?.success && raw) {
            const cleaned = cleanMermaidOutput(raw);

            // Push to version history; if navigated away, truncate future versions
            const insertAt = this.historyIndex + 1;
            this.diagramHistory.splice(insertAt, this.diagramHistory.length - insertAt, cleaned);
            this.historyIndex = this.diagramHistory.length - 1;

            this.currentDiagram = cleaned;
            this.applyBtn.disabled = false;

            const convertBtn = this.contentEl.querySelector<HTMLButtonElement>('[data-role="convert"]');
            if (convertBtn) convertBtn.disabled = false;

            // Phase 4: enable export + save template
            if (this.exportBtn) this.exportBtn.disabled = false;
            if (this.saveTemplateBtn) this.saveTemplateBtn.disabled = false;

            thinkingMsg.textContent = '✓ ' + t.generated;
            this.conversationHistory.push({ role: 'assistant', content: cleaned });
            this.renderPreview(cleaned);
            this.updateHistoryNav();

            if (Platform.isMobile) {
                this.switchToPreviewTab();
            }
        } else {
            thinkingMsg.textContent = '✗ ' + (response?.error ?? t.generating);
            this.conversationHistory.pop();
        }
    }

    // ── Core: streaming preview ─────────────────────────────────────────────

    private showStreamingPreview(code: string): void {
        if (!this.previewEl) return;
        let streamEl = this.previewEl.querySelector<HTMLElement>('.ai-organiser-mermaid-streaming');
        if (!streamEl) {
            this.previewEl.empty();
            streamEl = this.previewEl.createEl('pre', { cls: 'ai-organiser-mermaid-streaming' });
        }
        streamEl.textContent = code;
    }

    // ── Core: render preview ────────────────────────────────────────────────

    private renderPreview(mermaidCode: string): void {
        if (!this.previewEl) return;

        this.previewEl.empty();

        const { valid, warnings } = validateMermaidSyntax(mermaidCode);
        if (!valid && warnings.length > 0) {
            const warningEl = this.previewEl.createEl('div', { cls: 'ai-organiser-mermaid-warning' });
            warningEl.createEl('strong', { text: this.plugin.t.modals.mermaidChat.syntaxErrors });
            const ul = warningEl.createEl('ul');
            for (const w of warnings) {
                ul.createEl('li', { text: w });
            }
        }

        const renderContainer = this.previewEl.createEl('div', { cls: 'ai-organiser-mermaid-render' });
        const markdown = '```mermaid\n' + mermaidCode + '\n```';
        MarkdownRenderer.render(this.app, markdown, renderContainer, '', this.component).catch(() => {
            renderContainer.empty();
            renderContainer.createEl('pre', { cls: 'ai-organiser-mermaid-fallback', text: mermaidCode });
        });

        // Collapsible raw code
        const details = this.previewEl.createEl('details', { cls: 'ai-organiser-mermaid-raw-code' });
        details.createEl('summary', { text: this.plugin.t.modals.mermaidChat.rawCodeToggle });
        details.createEl('pre').createEl('code', { text: mermaidCode });

        // Phase 3: diff view against previous history version
        if (this.historyIndex > 0) {
            const prevCode = this.diagramHistory[this.historyIndex - 1];
            this.renderDiffView(prevCode, mermaidCode);
        }
    }

    // ── Core: diff view ─────────────────────────────────────────────────────

    private renderDiffView(oldCode: string, newCode: string): void {
        const diff = computeLineDiff(oldCode, newCode);
        if (!hasMeaningfulChanges(diff)) return;

        const stats = getDiffStats(diff);
        const t = this.plugin.t.modals.mermaidChat;

        const details = this.previewEl.createEl('details', { cls: 'ai-organiser-mermaid-diff' });
        const summary = details.createEl('summary', { cls: 'ai-organiser-mermaid-diff-summary' });

        summary.createEl('span', { cls: 'ai-organiser-mermaid-diff-label', text: t.diffChanges + ': ' });
        if (stats.added > 0) {
            summary.createEl('span', {
                cls: 'ai-organiser-mermaid-diff-added-count',
                text: `+${stats.added} ${t.diffAdded}  `,
            });
        }
        if (stats.removed > 0) {
            summary.createEl('span', {
                cls: 'ai-organiser-mermaid-diff-removed-count',
                text: `-${stats.removed} ${t.diffRemoved}`,
            });
        }

        const pre = details.createEl('pre', { cls: 'ai-organiser-mermaid-diff-view' });
        for (const line of diff) {
            const lineEl = pre.createEl('div', {
                cls: `ai-organiser-mermaid-diff-line ai-organiser-mermaid-diff-${line.type}`,
            });
            let prefix: string;
            if (line.type === 'added') {
                prefix = '+ ';
            } else if (line.type === 'removed') {
                prefix = '- ';
            } else {
                prefix = '  ';
            }
            lineEl.createEl('span', { cls: 'ai-organiser-mermaid-diff-prefix', text: prefix });
            lineEl.createEl('span', { text: line.content || ' ' });
        }
    }

    // ── Core: apply to note ─────────────────────────────────────────────────

    /** Generate alt-text prefix if setting is on and consent has been granted. Best-effort. */
    private async generateAltPrefix(): Promise<string> {
        if (!this.plugin.settings.mermaidChatGenerateAltText || !this.consentGranted || !this.currentDiagram) {
            return '';
        }
        try {
            const altPrompt = buildDiagramAltTextPrompt(this.currentDiagram, this.plugin.settings.summaryLanguage);
            const altResult = await summarizeText(pluginContext(this.plugin), altPrompt);
            const alt = altResult.success ? altResult.content?.trim() : '';
            return alt ? `<!-- alt: ${alt} -->\n` : '';
        } catch {
            return '';
        }
    }

    private async applyToNote(): Promise<void> {
        if (!this.currentDiagram) return;

        const altPrefix = await this.generateAltPrefix();
        const t = this.plugin.t.modals.mermaidChat;
        const now = Date.now();
        const newFenceContent = altPrefix + '```mermaid\n' + this.currentDiagram + '\n```';

        // Edit coalescing: if within window and we know the last applied range, apply directly
        const withinWindow = this.lastApplyMs > 0 &&
            (now - this.lastApplyMs) < MermaidChatModal.COALESCE_WINDOW_MS;

        if (withinWindow && this.lastApplyFrom && this.lastApplyTo) {
            this.editor.replaceRange(newFenceContent, this.lastApplyFrom, this.lastApplyTo);
            this.trackApplyRange(this.lastApplyFrom.line, newFenceContent, now);
            this.changeDetector.captureSnapshot(this.blockFingerprint, this.editor.getValue());
            new Notice(t.applied, 2500);
            return;
        }

        // Fingerprint-based re-resolution
        if (this.blockFingerprint && this.tryResolveAndReplace(newFenceContent, now, t)) {
            return;
        }

        // No fingerprint or block not found — insert at cursor
        if (this.blockFingerprint) {
            new Notice(t.blockNotFound, 4000);
        }
        this.insertAtCursor();
        this.changeDetector.captureSnapshot(this.blockFingerprint, this.editor.getValue());
        new Notice(t.applied, 2500);
    }

    /** Attempt in-place replacement via fingerprint resolution. Returns true if block was found and replaced. */
    private tryResolveAndReplace(
        newFenceContent: string,
        now: number,
        t: typeof this.plugin.t.modals.mermaidChat,
    ): boolean {
        const content = this.editor.getValue();
        const resolved = resolveBlockByFingerprint(content, this.blockFingerprint, this.originalStartLine);
        if (!resolved) return false;

        this.editor.replaceRange(
            newFenceContent,
            { line: resolved.startLine, ch: 0 },
            { line: resolved.endLine, ch: this.editor.getLine(resolved.endLine).length },
        );
        this.originalStartLine = resolved.startLine;
        this.blockFingerprint = this.currentDiagram.slice(0, 80);
        this.trackApplyRange(resolved.startLine, newFenceContent, now);
        this.changeDetector.captureSnapshot(this.blockFingerprint, this.editor.getValue());
        new Notice(t.applied, 2500);
        return true;
    }

    /** Store the range of the just-applied fence for coalescing on next apply. */
    private trackApplyRange(startLine: number, fenceContent: string, applyMs: number): void {
        const fenceLines = fenceContent.split('\n');
        const endLine = startLine + fenceLines.length - 1;
        this.lastApplyFrom = { line: startLine, ch: 0 };
        this.lastApplyTo = { line: endLine, ch: fenceLines.at(-1)!.length };
        this.lastApplyMs = applyMs;
    }

    private insertAtCursor(): void {
        const cursor = this.editor.getCursor();
        const fenceContent = '\n\n```mermaid\n' + this.currentDiagram + '\n```\n\n';
        this.editor.replaceRange(fenceContent, cursor);

        // Track the inserted block so subsequent applies update in-place (not duplicate)
        const insertStartLine = cursor.line + 2; // skip the two leading newlines
        this.blockFingerprint = this.currentDiagram.slice(0, 80);
        this.originalStartLine = insertStartLine;
        this.trackApplyRange(insertStartLine, '```mermaid\n' + this.currentDiagram + '\n```', Date.now());
    }

    // ── Core: copy code ─────────────────────────────────────────────────────

    private copyCode(): void {
        if (!this.currentDiagram) return;
        navigator.clipboard.writeText(this.currentDiagram).then(() => {
            new Notice(this.plugin.t.modals.mermaidChat.copied, 2000);
        }).catch(() => {
            new Notice('Failed to copy to clipboard');
        });
    }

    // ── Core: type conversion ───────────────────────────────────────────────

    private promptTypeConversion(): void {
        if (!this.currentDiagram || this.isProcessing) return;
        const t = this.plugin.t.modals.mermaidChat;

        new DiagramTypePickerModal(
            this.app,
            CONVERT_DIAGRAM_TYPES,
            (item) => {
                const instruction = buildTypeConversionInstruction(
                    this.currentDiagram,
                    item.type,
                    item.label,
                );
                void this.handleSend(instruction);
            },
            t.selectDiagramType,
        ).open();
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    private addChatMessage(role: 'user' | 'assistant', text: string): HTMLElement {
        const msgEl = this.chatContainer.createEl('div', {
            cls: `ai-organiser-mermaid-message ai-organiser-mermaid-message-${role}`,
        });
        msgEl.textContent = text;
        this.chatContainer.scrollTop = this.chatContainer.scrollHeight;

        if (role === 'user') {
            this.conversationHistory.push({ role: 'user', content: text });
        }

        return msgEl;
    }

    private setProcessing(processing: boolean): void {
        this.isProcessing = processing;
        this.inputEl.disabled = processing;
        this.sendBtn.toggleClass('ai-organiser-hidden', processing);
        this.cancelBtn.toggleClass('ai-organiser-hidden', !processing);
    }

    private switchToPreviewTab(): void {
        const panes = this.contentEl.querySelectorAll<HTMLElement>('.ai-organiser-mermaid-tab-pane');
        const tabs = this.contentEl.querySelectorAll<HTMLElement>('.ai-organiser-mermaid-tab');
        const previewLabel = this.plugin.t.modals.mermaidChat.previewTab;
        panes.forEach(p => { p.toggleClass('ai-organiser-hidden', p.dataset.tab !== 'preview'); });
        tabs.forEach(tab => {
            tab.classList.toggle('ai-organiser-mermaid-tab-active', tab.textContent === previewLabel);
        });
        this.activeTab = 'preview';
    }

    // ── Phase 4: staleness notice ────────────────────────────────────────────

    private showStalenessNotice(): void {
        const t = this.plugin.t.modals.mermaidChat;
        const noticeEl = this.chatContainer.createEl('div', {
            cls: 'ai-organiser-mermaid-stale-notice',
        });
        noticeEl.createEl('span', { text: t.stalenessNotice });
        const snoozeBtn = noticeEl.createEl('button', {
            cls: 'ai-organiser-mermaid-stale-snooze',
            text: t.stalenessSnooze,
        });
        snoozeBtn.onclick = () => {
            this.changeDetector.snooze(this.blockFingerprint);
            noticeEl.remove();
        };
    }

    // ── Phase 4: templates ───────────────────────────────────────────────────

    private async openTemplatePicker(): Promise<void> {
        const t = this.plugin.t.modals.mermaidChat;
        const templates = await this.templateService.loadTemplates();
        if (templates.length === 0) {
            new Notice(t.templateNoTemplates);
            return;
        }
        new MermaidTemplatePickerModal(this.app, this.plugin, templates, (template) => {
            this.currentDiagram = template.code;

            // Push to history
            const insertAt = this.historyIndex + 1;
            this.diagramHistory.splice(insertAt, this.diagramHistory.length - insertAt, template.code);
            this.historyIndex = this.diagramHistory.length - 1;
            this.updateHistoryNav();

            this.renderPreview(template.code);
            this.applyBtn.disabled = false;
            if (this.exportBtn) this.exportBtn.disabled = false;
            if (this.saveTemplateBtn) this.saveTemplateBtn.disabled = false;
            new Notice(t.templateApplied, 2000);
        }).open();
    }

    // ── Phase 4: export ──────────────────────────────────────────────────────

    private showExportMenu(e: MouseEvent): void {
        if (!this.currentDiagram) return;
        const t = this.plugin.t.modals.mermaidChat;
        const activeFile = this.plugin.app.workspace.getActiveFile();
        const name = this.getSafeDiagramName();

        // Helper: generate alt text when the setting is enabled and consent was granted (§4.3.5)
        const getAltText = async (): Promise<string | undefined> => {
            if (!this.plugin.settings.mermaidChatGenerateAltText || !this.currentDiagram || !this.consentGranted) return undefined;
            try {
                const prompt = buildDiagramAltTextPrompt(this.currentDiagram, this.plugin.settings.summaryLanguage);
                const result = await summarizeText(pluginContext(this.plugin), prompt);
                return result.success ? result.content?.trim() || undefined : undefined;
            } catch { return undefined; }
        };

        const menu = new Menu();
        menu.addItem(item =>
            item.setTitle(t.exportSVG).setIcon('file-code').onClick(() => {
                void (async () => {
                    const altText = await getAltText();
                    await this.exportService.exportSVG(this.previewEl, name, altText);
                })();
            }),
        );
        menu.addItem(item =>
            item.setTitle(t.exportPNG).setIcon('image').onClick(() => {
                void (async () => {
                    const altText = await getAltText();
                    await this.exportService.exportPNG(
                        this.previewEl,
                        this.plugin.settings.mermaidChatExportScale,
                        name,
                        altText,
                    );
                })();
            }),
        );
        menu.addItem(item =>
            item.setTitle(t.exportFile).setIcon('file-text').onClick(() => {
                void this.exportService.exportMermaidFile(this.currentDiagram, name);
            }),
        );
        menu.addItem(item =>
            item.setTitle(t.exportCanvas).setIcon('layout-grid').onClick(() => {
                void this.exportService.exportToCanvas(this.currentDiagram, activeFile, name);
            }),
        );
        menu.addItem(item =>
            item.setTitle(t.exportAppendCanvas).setIcon('layout-dashboard').onClick(() => {
                void this.promptAppendToCanvas();
            }),
        );
        menu.showAtMouseEvent(e);
    }

    /** Prompt user to pick an existing .canvas file and append the diagram to it. */
    private promptAppendToCanvas(): void {
        if (!this.currentDiagram) return;
        const canvasFiles = this.app.vault.getFiles().filter(f => f.extension === 'canvas');
        if (canvasFiles.length === 0) {
            new Notice(this.plugin.t.modals.mermaidChat.exportFailed);
            return;
        }
        new CanvasPickerModal(this.app, canvasFiles, (file) => {
            void this.exportService.appendToCanvas(this.currentDiagram, file);
        }).open();
    }

    private getSafeDiagramName(): string {
        const activeFile = this.plugin.app.workspace.getActiveFile();
        const base = activeFile?.basename ?? 'diagram';
        return base.replace(/[/\\:*?"<>|]/g, '-');
    }

    // ── Phase 4: save as template ────────────────────────────────────────────

    private async promptSaveAsTemplate(): Promise<void> {
        if (!this.currentDiagram) return;
        const t = this.plugin.t.modals.mermaidChat;
        const name = await this.promptForTemplateName(t.saveAsTemplatePrompt);
        if (!name) return;
        await this.templateService.saveAsTemplate({
            name,
            description: '',
            type: this.detectDiagramType(this.currentDiagram),
            code: this.currentDiagram,
        });
        new Notice(t.saveAsTemplateSuccess, 2000);
    }

    private detectDiagramType(code: string): string {
        const first = code.trim().split('\n')[0].toLowerCase();
        if (first.startsWith('flowchart') || first.startsWith('graph')) return 'flowchart';
        if (first.startsWith('sequencediagram')) return 'sequence';
        if (first.startsWith('classdiagram')) return 'class';
        if (first.startsWith('statediagram')) return 'state';
        if (first.startsWith('erdiagram')) return 'er';
        if (first.startsWith('gantt')) return 'gantt';
        if (first.startsWith('mindmap')) return 'mindmap';
        if (first.startsWith('timeline')) return 'timeline';
        if (first.startsWith('pie')) return 'pie';
        return 'flowchart';
    }

    private promptForTemplateName(promptText: string): Promise<string | null> {
        return new Promise(resolve => {
            new TemplateNameModal(this.app, promptText, (name) => {
                resolve(name || null);
            }).open();
        });
    }

    onClose() {
        this.streamAbortController?.abort();
        this.component.unload();
        this.contentEl.empty();
    }
}

// ── TemplateNameModal ────────────────────────────────────────────────────────

/**
 * Minimal modal for requesting a template name from the user.
 */
class TemplateNameModal extends Modal {
    private submitted = false;

    constructor(
        app: App,
        private readonly promptText: string,
        private readonly onSubmit: (name: string) => void,
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.createEl('p', { text: this.promptText });

        const input = contentEl.createEl('input', {
            attr: { type: 'text', placeholder: 'My template' },
        });
        input.addClass('ai-organiser-template-name-input');
        input.addClass('ai-organiser-w-full');
        setTimeout(() => input.focus(), 30);

        const submit = () => {
            const val = input.value.trim();
            if (!val) return;
            this.submitted = true;
            this.onSubmit(val);
            this.close();
        };

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') submit();
        });

        contentEl.createEl('button', {
            text: 'Save',
            cls: 'mod-cta ai-organiser-template-name-save',
        }).onclick = () => submit();
    }

    onClose(): void {
        if (!this.submitted) this.onSubmit('');
        this.contentEl.empty();
    }
}

// ── CanvasPickerModal ────────────────────────────────────────────────────────

/**
 * FuzzySuggestModal for selecting an existing .canvas file to append to.
 */
class CanvasPickerModal extends FuzzySuggestModal<TFile> {
    constructor(
        app: App,
        private readonly canvasFiles: TFile[],
        private readonly onSelect: (file: TFile) => void,
    ) {
        super(app);
        this.setPlaceholder('Select a canvas file…');
    }

    getItems(): TFile[] {
        return this.canvasFiles;
    }

    getItemText(file: TFile): string {
        return file.path;
    }

    onChooseItem(file: TFile): void {
        this.onSelect(file);
    }
}
