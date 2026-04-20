import { App, ButtonComponent, Component, Editor, MarkdownRenderer, Modal, Notice, TFile, TextAreaComponent, setIcon } from 'obsidian';
import { logger } from '../../utils/logger';
import { enableAutoExpand } from '../../utils/uiUtils';
import { ensureNoteStructureIfEnabled } from '../../utils/noteStructure';
import { formatConversationHistory, formatExportMarkdown } from '../../utils/chatExportUtils';
import { getChatExportFullPath, resolveOutputPath } from '../../core/settings';
import { ensureFolderExists, getAvailableFilePath } from '../../utils/minutesUtils';
import { summarizeText, pluginContext } from '../../services/llmFacade';
import { buildInsertSummaryPrompt, HighlightChatMessage } from '../../services/prompts/highlightChatPrompts';
import { buildChatFileNamePrompt } from '../../services/prompts/chatPrompts';
import { splitIntoBlocks } from '../../utils/highlightExtractor';
import type { ChatMode, ChatModeHandler, ChatPluginContext, ModalContext, UnifiedChatOptions, ActionCallbacks } from '../chat/ChatModeHandler';
import { NoteModeHandler } from '../chat/NoteModeHandler';
import { VaultModeHandler } from '../chat/VaultModeHandler';
import { HighlightModeHandler } from '../chat/HighlightModeHandler';
import { ResearchModeHandler } from '../chat/ResearchModeHandler';
import { FreeChatModeHandler } from '../chat/FreeChatModeHandler';
import { PresentationModeHandler } from '../chat/PresentationModeHandler';
import { getExtendDisplayMs } from '../../services/chat/presentationConstants';
import { ConversationCompactionService } from '../../services/chat/conversationCompactionService';
import { ConversationPersistenceService } from '../../services/chat/conversationPersistenceService';
import { ProjectService } from '../../services/chat/projectService';
import { GlobalMemoryService } from '../../services/chat/globalMemoryService';
import { ChatResumePickerModal } from './ChatResumePickerModal';
import { ChatSearchModal } from './ChatSearchModal';
import { ProjectTreePickerModal } from './ProjectTreePickerModal';
import { ChatSearchService } from '../../services/chat/chatSearchService';
import type { ConversationState } from '../../utils/chatExportUtils';


interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: number;
    sources?: string[];
}

export function createHistoryMap(): Map<ChatMode, ChatMessage[]> {
    return new Map<ChatMode, ChatMessage[]>([
        ['note', []],
        ['vault', []],
        ['highlight', []],
        ['research', []],
        ['free', []],
        ['presentation', []],
    ]);
}

export function firstAvailableMode(
    ctx: ModalContext,
    handlers: Map<ChatMode, ChatModeHandler>
): ChatMode | null {
    const order: ChatMode[] = ['note', 'highlight', 'vault', 'research', 'free'];
    for (const mode of order) {
        const handler = handlers.get(mode);
        if (handler?.isAvailable(ctx)) return mode;
    }
    return null;
}

export function selectInitialMode(
    ctx: ModalContext,
    handlers: Map<ChatMode, ChatModeHandler>
): ChatMode | null {
    if (ctx.options.initialMode) {
        const handler = handlers.get(ctx.options.initialMode);
        if (handler?.isAvailable(ctx)) return ctx.options.initialMode;
    }

    if (ctx.options.editorSelection?.trim()) {
        return 'highlight';
    }

    if (ctx.options.noteContent) {
        const blocks = splitIntoBlocks(ctx.options.noteContent);
        if (blocks.some(b => b.hasHighlight)) return 'highlight';
    }

    if (handlers.get('vault')?.isAvailable(ctx)) return 'vault';

    if (handlers.get('note')?.isAvailable(ctx)) return 'note';

    if (handlers.get('free')?.isAvailable(ctx)) return 'free';

    return firstAvailableMode(ctx, handlers);
}

export function nextGeneration(current: number): number {
    return current + 1;
}

export function isStaleGeneration(expected: number, current: number): boolean {
    return expected !== current;
}

export class UnifiedChatModal extends Modal {
    private readonly plugin: ChatPluginContext;
    private readonly options: UnifiedChatOptions;

    private handlers = new Map<ChatMode, ChatModeHandler>();
    private activeMode: ChatMode | null = null;
    private readonly historyMap = createHistoryMap();
    private ctx!: ModalContext;

    private requestGeneration = 0;
    private isProcessing = false;

    private modeBarEl?: HTMLElement;
    private contextEl?: HTMLElement;
    private chatContainer?: HTMLElement;
    private inputArea?: TextAreaComponent;
    private sendButton?: ButtonComponent;
    private actionsEl?: HTMLElement;
    private thinkingEl?: HTMLElement;
    private thinkingSlideEl?: HTMLElement;
    private thinkingElapsedEl?: HTMLElement;
    private thinkingCancelBtn?: HTMLButtonElement;

    private component?: Component;
    private cachedEditor?: Editor;

    private compactionService?: ConversationCompactionService;
    private persistenceService?: ConversationPersistenceService;
    private projectService?: ProjectService;
    private globalMemoryService?: GlobalMemoryService;
    private activeProjectId?: string;
    private modeCreatedAt = new Map<ChatMode, string>();
    private freeChatHandler?: FreeChatModeHandler;
    private presentationHandler?: PresentationModeHandler;
    /** User-defined conversation title — overrides auto-derived first-message title. */
    private customTitle?: string;

    constructor(app: App, plugin: ChatPluginContext, options: UnifiedChatOptions) {
        super(app);
        this.plugin = plugin;
        this.options = options;
        this.titleEl.setText(this.plugin.t.modals.unifiedChat.title);
    }

    private notify(message: string, duration?: number): Notice {
        return new Notice(message, duration);
    }

    async onOpen(): Promise<void> {
        this.contentEl.empty();
        this.modalEl.addClass('ai-organiser-chat-modal');
        this.contentEl.addClass('ai-organiser-chat-modal-content');

        // Add rename icon in the modal header alongside the title (persistence only)
        if (this.plugin.settings.enableChatPersistence) {
            this.addRenameTitleButton();
        }

        // Cache editor reference before modal takes focus
        this.cachedEditor = this.app.workspace.activeEditor?.editor;

        // Initialize persistence and project services
        // Audit R1 H4: serialize pruning BEFORE the resume picker reads
        // `listRecent()` — otherwise a just-expired conversation could be
        // deleted mid-read and produce a phantom entry in the picker, or
        // worse be "resumed" onto a file that was just unlinked.
        let prunePromise: Promise<unknown> | null = null;
        if (this.plugin.settings.enableChatPersistence) {
            this.persistenceService = new ConversationPersistenceService(this.app, this.plugin.settings);
            prunePromise = this.persistenceService
                .pruneOldConversations(this.plugin.settings.chatRetentionDays)
                .catch((e: unknown) => {
                    // Don't block bootstrap on prune failure; log + continue.
                    logger.warn('UnifiedChat', 'pruneOldConversations failed', e);
                });
        }
        this.projectService = new ProjectService(this.app, this.plugin.settings);
        this.globalMemoryService = new GlobalMemoryService(this.app, this.plugin.settings);

        this.ctx = await this.buildContext();
        const researchHandler = new ResearchModeHandler(this.plugin as unknown as import('../../main').default);
        researchHandler.setFillInputCallback((text: string) => {
            if (this.inputArea) {
                this.inputArea.setValue(text);
                this.inputArea.inputEl.focus();
            }
        });
        this.freeChatHandler = new FreeChatModeHandler(this.app, {
            onModelChange: (model: string) => {
                this.compactionService?.updateModel(model);
            },
            onProjectIndexRequest: (req) => { void this.handleProjectIndexRequest(req); },
        });
        if (this.plugin.embeddingService) {
            this.freeChatHandler.setEmbeddingService(this.plugin.embeddingService);
        }
        this.freeChatHandler.setProjectService(this.projectService);
        this.handlers = new Map<ChatMode, ChatModeHandler>([
            ['note', new NoteModeHandler()],
            ['vault', new VaultModeHandler()],
            ['highlight', new HighlightModeHandler(() => this.updateInputAndActions())],
            ['research', researchHandler],
            ['free', this.freeChatHandler],
            ['presentation', new PresentationModeHandler()],
        ]);
        this.presentationHandler = this.handlers.get('presentation') as PresentationModeHandler;

        // Load global memory
        if (this.globalMemoryService) {
            const globalMemory = await this.globalMemoryService.loadMemory();
            this.freeChatHandler?.setGlobalMemory(globalMemory);
        }

        // Initialize compaction service
        if (this.plugin.settings.chatAutoCompaction) {
            this.compactionService = new ConversationCompactionService({
                provider: this.plugin.settings.cloudServiceType,
                model: this.plugin.settings.cloudModel,
                summarize: async (prompt: string) => summarizeText(pluginContext(this.plugin), prompt),
            });
        }

        // Show resume picker if persistence is enabled and data exists.
        // H4: await pruning first so the picker's listRecent() never races
        // with a concurrent delete of an expired conversation.
        if (prunePromise) await prunePromise;
        let resumedMode: ChatMode | null = null;
        if (this.persistenceService && this.projectService) {
            const resumeResult = await this.showResumePicker();
            if (resumeResult?.action === 'resume') {
                resumedMode = await this.resumeConversation(resumeResult.filePath);
            } else if (resumeResult?.action === 'new' && resumeResult.initialMode) {
                resumedMode = resumeResult.initialMode;
            } else if (resumeResult?.action === 'new-in-project' && resumeResult.projectId) {
                await this.loadProjectContext(resumeResult.projectId);
                resumedMode = 'free';
            } else if (resumeResult?.action === 'create-project' && resumeResult.name) {
                const id = await this.projectService.createProject(resumeResult.name);
                this.persistenceService?.startNew('free');
                await this.loadProjectContext(id);
                resumedMode = 'free';
            }
        }

        const initialMode = resumedMode ?? selectInitialMode(this.ctx, this.handlers);
        if (!initialMode) {
            this.renderEmptyState();
            return;
        }

        const requested = this.options.initialMode;
        if (requested && requested !== initialMode) {
            this.showFallbackNotice(requested);
        }

        this.activeMode = initialMode;
        this.ensureIntroMessage(initialMode);
        this.renderShell();
        this.renderAll();
    }

    onClose(): void {
        if (this.plugin.settings.enableChatPersistence && this.persistenceService) {
            void this.persistenceService.saveNow(this.buildConversationState());
        }
        this.persistenceService?.cancelAllPending();
        this.compactionService?.resetAll();
        this.requestGeneration = nextGeneration(this.requestGeneration);
        this.component?.unload();
        for (const handler of this.handlers.values()) {
            handler.dispose();
        }
        this.contentEl.empty();
    }

    private async buildContext(): Promise<ModalContext> {
        const metadata = await this.plugin.vectorStore?.getMetadata();
        const activeFile = this.app.workspace.getActiveFile();
        return {
            app: this.app,
            plugin: this.plugin,
            fullPlugin: this.plugin as unknown as import('../../main').default, // Cast to full plugin type
            options: {
                ...this.options,
                noteFile: activeFile || undefined
            },
            vaultDocCount: metadata?.totalDocuments ?? 0,
            vaultIndexVersion: metadata?.version ?? 'unknown',
            hasEmbeddingService: !!this.plugin.embeddingService,
            semanticSearchEnabled: this.plugin.settings.enableSemanticSearch
        };
    }

    private renderShell(): void {
        this.modeBarEl = this.contentEl.createDiv({ cls: 'ai-organiser-chat-mode-bar' });
        this.contextEl = this.contentEl.createDiv({ cls: 'ai-organiser-chat-context' });
        this.chatContainer = this.contentEl.createDiv({ cls: 'ai-organiser-chat-area' });

        const inputRow = this.contentEl.createDiv({ cls: 'ai-organiser-chat-input-row' });
        this.inputArea = new TextAreaComponent(inputRow);
        this.inputArea.setPlaceholder(this.getActiveHandler().getPlaceholder(this.plugin.t));
        this.inputArea.inputEl.rows = 4;
        this.inputArea.inputEl.spellcheck = true;

        // Auto-expand textarea as user types (up to max-height in CSS)
        enableAutoExpand(this.inputArea.inputEl);

        this.inputArea.inputEl.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void this.handleSend();
            }
        });

        this.sendButton = new ButtonComponent(inputRow)
            .setIcon('arrow-up')
            .setTooltip(this.plugin.t.modals.unifiedChat.send)
            .onClick(() => void this.handleSend());

        this.actionsEl = this.contentEl.createDiv({ cls: 'ai-organiser-chat-actions' });
    }

    private renderAll(): void {
        this.renderModeBar();
        this.renderContextPanel();
        this.renderMessages();
        this.renderActionsBar();
        this.updateInputState();
    }

    private renderModeBar(): void {
        if (!this.modeBarEl || !this.activeMode) return;
        this.modeBarEl.empty();

        const t = this.plugin.t.modals.unifiedChat;
        const modes: Array<{ mode: ChatMode; label: string }> = [
            { mode: 'note', label: t.modeNote },
            { mode: 'vault', label: t.modeVault },
            { mode: 'highlight', label: t.modeHighlight },
            { mode: 'research', label: (t as Record<string, string>).modeResearch || 'Research' },
            { mode: 'free', label: t.modeFree },
            { mode: 'presentation', label: t.modePresentation },
        ];

        for (const { mode, label } of modes) {
            const handler = this.handlers.get(mode);
            if (!handler) continue;

            const available = handler.isAvailable(this.ctx);
            const button = this.modeBarEl.createEl('button', {
                cls: 'ai-organiser-chat-mode-tab',
                text: label
            });

            if (mode === this.activeMode) {
                button.addClass('ai-organiser-chat-mode-tab-active');
            }

            if (available) {
                button.addEventListener('click', () => this.switchMode(mode));
            } else {
                button.addClass('ai-organiser-chat-mode-tab-disabled');
                button.setAttr('title', handler.unavailableReason(this.plugin.t));
                button.setAttr('disabled', 'true');
            }
        }

        // Search button
        const searchBtn = this.modeBarEl.createEl('button', {
            cls: 'ai-organiser-chat-mode-tab',
            attr: { 'aria-label': 'Search conversations' },
        });
        setIcon(searchBtn, 'search');
        searchBtn.addEventListener('click', () => this.openChatSearch());
    }

    private openChatSearch(): void {
        const searchService = new ChatSearchService(this.app, this.plugin.settings);
        const modal = new ChatSearchModal(this.app, this.plugin.t, searchService, {
            onSelect: (filePath, projectId) => {
                void this.loadConversationFromSearch(filePath, projectId);
            },
        });
        modal.open();
    }

    private async loadConversationFromSearch(filePath: string, projectId?: string): Promise<void> {
        if (projectId) {
            await this.loadProjectContext(projectId);
        }
        const mode = await this.resumeConversation(filePath);
        if (mode && mode !== this.activeMode) {
            this.switchMode(mode);
        }
        this.renderAll();
    }

    private renderContextPanel(): void {
        if (!this.contextEl || !this.activeMode) return;
        this.contextEl.empty();

        const handler = this.getActiveHandler();
        handler.renderContextPanel(this.contextEl, this.ctx);
    }

    private renderMessages(): void {
        if (!this.chatContainer || !this.activeMode) return;
        this.chatContainer.empty();

        this.component?.unload();
        this.component = new Component();
        this.component.load();

        const messages = this.historyMap.get(this.activeMode) || [];

        if (messages.length === 0) {
            this.chatContainer.createDiv({
                cls: 'ai-organiser-chat-empty-state',
                text: this.plugin.t.modals.unifiedChat.startChat
            });
            return;
        }

        for (const message of messages) {
            const messageEl = this.chatContainer.createDiv({
                cls: `ai-organiser-chat-msg ai-organiser-chat-msg-${message.role}`
            });

            const contentEl = messageEl.createDiv({ cls: 'ai-organiser-chat-msg-content' });
            if (message.role === 'assistant') {
                void MarkdownRenderer.render(this.app, message.content, contentEl, '', this.component);
            } else {
                contentEl.textContent = message.content;
            }

            if (message.sources && message.sources.length > 0) {
                const sourcesEl = messageEl.createDiv({ cls: 'ai-organiser-chat-msg-sources' });
                sourcesEl.createEl('strong', { text: this.plugin.t.modals.unifiedChat.sourcesLabel });
                const listEl = sourcesEl.createEl('ul');
                for (const source of message.sources) {
                    const itemEl = listEl.createEl('li');
                    const linkEl = itemEl.createEl('a', {
                        text: source,
                        cls: 'internal-link'
                    });
                    linkEl.addEventListener('click', (event) => {
                        event.preventDefault();
                        const file = this.app.vault.getFileByPath(source);
                        if (file) {
                            void this.app.workspace.getLeaf().openFile(file);
                        }
                    });
                }
            }

            messageEl.createDiv({
                cls: 'ai-organiser-chat-msg-time',
                text: new Date(message.timestamp).toLocaleTimeString()
            });
        }

        if (this.thinkingEl) {
            this.chatContainer.appendChild(this.thinkingEl);
        }

        this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
    }

    private renderActionsBar(): void {
        if (!this.actionsEl || !this.activeMode) return;
        this.actionsEl.empty();

        const t = this.plugin.t.modals.unifiedChat;
        const hasEditor = !!this.cachedEditor;
        const lastAnswer = this.getLastAssistantMessage();

        const clearButton = new ButtonComponent(this.actionsEl)
            .setButtonText(t.clear)
            .onClick(() => this.handleClear());

        const insertAnswerButton = new ButtonComponent(this.actionsEl)
            .setButtonText(t.insertLastAnswer)
            .onClick(() => void this.handleInsertLastAnswer());

        if (!hasEditor || !lastAnswer || this.isProcessing) {
            insertAnswerButton.setDisabled(true);
            insertAnswerButton.setTooltip(hasEditor ? t.noAnswerYet : t.noEditor);
        }

        const descriptors = this.getActiveHandler().getActionDescriptors(this.plugin.t);
        for (const descriptor of descriptors) {
            const label = (t as Record<string, string>)[descriptor.labelKey] || descriptor.labelKey;
            const tooltip = (t as Record<string, string>)[descriptor.tooltipKey] || '';
            const button = new ButtonComponent(this.actionsEl)
                .setButtonText(label)
                .setTooltip(tooltip)
                .onClick(() => void this.handleAction(descriptor.id));

            if (descriptor.isDefault) {
                button.setCta();
            }

            const needsEditor = descriptor.requiresEditor !== false; // default true
            if (!descriptor.isEnabled || (needsEditor && !hasEditor) || this.isProcessing) {
                button.setDisabled(true);
                button.setTooltip(needsEditor && !hasEditor ? t.noEditor : tooltip);
            }
        }

        const exportButton = new ButtonComponent(this.actionsEl)
            .setButtonText(t.export)
            .onClick(() => void this.handleExport());

        if (this.isProcessing) {
            clearButton.setDisabled(true);
            exportButton.setDisabled(true);
        }

        // Project dropdown (Free Chat and Presentation modes)
        if ((this.activeMode === 'free' || this.activeMode === 'presentation') && this.projectService) {
            this.renderProjectDropdown(this.actionsEl);
        }
    }

    /** Append a pencil rename icon to the modal title element. */
    private addRenameTitleButton(): void {
        const t = this.plugin.t.modals.unifiedChat;
        const btn = this.titleEl.createSpan({
            cls: 'ai-organiser-chat-rename-btn',
            attr: { 'aria-label': t.resumeRename },
        });
        setIcon(btn, 'pencil');
        btn.addEventListener('click', () => { void this.showRenamePrompt(); });
    }

    /** Show an inline rename prompt below the modal title. */
    private showRenamePrompt(): void {
        const t = this.plugin.t.modals.unifiedChat;
        // Build a small inline form anchored to the title element
        const overlay = this.modalEl.createDiv({ cls: 'ai-organiser-chat-rename-overlay' });
        const input = overlay.createEl('input', { type: 'text' });
        input.placeholder = t.resumeRenamePlaceholder;
        input.value = this.customTitle ?? '';
        const saveBtn = overlay.createEl('button', { text: t.resumeRenameSave, cls: 'mod-cta' });
        const cancelBtn = overlay.createEl('button', { text: t.resumeRenameCancel });

        const commit = async () => {
            const newTitle = input.value.trim() || undefined;
            this.customTitle = newTitle;
            this.titleEl.childNodes.forEach(n => { if (n.nodeType === Node.TEXT_NODE) n.textContent = newTitle ?? t.title; });
            overlay.remove();
            // Persist immediately if file already exists
            const filePath = this.activeMode ? this.persistenceService?.getCurrentFilePath(this.activeMode) : null;
            if (filePath) {
                await this.persistenceService!.renameConversation(filePath, newTitle ?? '');
            } else {
                this.triggerAutosave();
            }
        };

        const cancel = () => overlay.remove();

        saveBtn.addEventListener('click', () => { void commit(); });
        cancelBtn.addEventListener('click', cancel);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); void commit(); }
            if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        });
        input.focus();
        input.select();
    }

    private renderProjectDropdown(container: HTMLElement): void {
        const t = this.plugin.t.modals.unifiedChat;
        const btn = container.createEl('button', {
            cls: 'ai-organiser-project-dropdown-btn' + (this.activeProjectId ? ' is-active' : ''),
        });
        setIcon(btn, 'folder');
        btn.createSpan({ text: ` ${this.activeProjectId ? (this.freeChatHandler?.getProjectName() ?? t.projectDropdownLabel) : t.projectDropdownLabel} ▾` });
        btn.addEventListener('click', () => this.openProjectTreePicker());
    }

    private openProjectTreePicker(): void {
        if (!this.projectService) return;
        const modal = new ProjectTreePickerModal(
            this.app,
            this.plugin.t,
            this.projectService,
            {
                onSelectProject: (projectId: string) => {
                    void this.switchToProject(projectId);
                },
                onLeaveProject: () => {
                    this.leaveProject();
                },
            },
            this.activeProjectId,
        );
        modal.open();
    }

    private async switchToProject(projectId: string): Promise<void> {
        if (this.plugin.settings.enableChatPersistence && this.persistenceService) {
            void this.persistenceService.saveNow(this.buildConversationState());
            // Clear file handle so next save goes into the new project's folder
            this.persistenceService.startNew(this.activeMode!);
        }
        await this.loadProjectContext(projectId);
        this.renderActionsBar();
        this.renderContextPanel();
    }

    private leaveProject(): void {
        this.activeProjectId = undefined;
        this.freeChatHandler?.clearProjectContext();
        this.presentationHandler?.clearProjectContext();
        // Clear file handle so leaving a project starts a fresh inbox conversation
        this.persistenceService?.startNew(this.activeMode!);
        this.renderActionsBar();
        this.renderContextPanel();
    }

    private async promptProjectName(): Promise<string | null> {
        return new Promise(resolve => {
            const input = document.createElement('input');
            input.type = 'text';
            input.placeholder = this.plugin.t.modals.unifiedChat.resumeProjectName;
            const modal = document.createElement('div');
            modal.className = 'ai-organiser-inline-prompt';
            modal.appendChild(input);
            const ok = document.createElement('button');
            ok.textContent = this.plugin.t.modals.unifiedChat.resumeProjectCreate;
            ok.className = 'mod-cta';
            const cancel = document.createElement('button');
            cancel.textContent = this.plugin.t.modals.unifiedChat.resumeProjectCancel;
            modal.appendChild(ok);
            modal.appendChild(cancel);
            this.contentEl.appendChild(modal);
            const done = (v: string | null) => { modal.remove(); resolve(v); };
            ok.addEventListener('click', () => done(input.value.trim() || null));
            cancel.addEventListener('click', () => done(null));
            input.addEventListener('keydown', e => {
                if (e.key === 'Enter') done(input.value.trim() || null);
                if (e.key === 'Escape') done(null);
            });
            input.focus();
        });
    }

    private async loadProjectContext(projectId: string): Promise<void> {
        if (!this.projectService) return;
        const config = await this.projectService.findProject(projectId);
        if (!config) return;

        this.activeProjectId = projectId;
        this.freeChatHandler?.clearProjectContext();
        this.freeChatHandler?.setProjectContext(config);
        this.presentationHandler?.clearProjectContext();
        this.presentationHandler?.setProjectContext(config);

        // Rehydrate persisted indexed documents — use plugin service OR handler-level
        // auto-bootstrapped service (set during a prior large-file attachment session)
        const embSvc = this.plugin.embeddingService ?? this.freeChatHandler?.getEmbeddingService() ?? null;
        if (embSvc && this.freeChatHandler) {
            const docs = await this.projectService.loadIndexedDocuments(config);
            for (const doc of docs) {
                await this.freeChatHandler.rehydrateIndexedDocument(doc, embSvc);
            }
        }
    }

    private async handleProjectIndexRequest(req: { fileName: string; extractedText: string; chunkCount: number }): Promise<void> {
        if (!this.projectService) return;

        if (!this.activeProjectId) {
            const name = await this.promptProjectName();
            if (!name) return;
            this.activeProjectId = await this.projectService.createProject(name);
            this.persistenceService?.startNew('free');
            this.freeChatHandler?.setProjectContext(
                (await this.projectService.findProject(this.activeProjectId))
            );
            this.renderActionsBar();
        }

        await this.projectService.saveIndexedDocument(
            this.activeProjectId,
            req.fileName,
            req.extractedText,
            req.chunkCount,
        );
    }

    private updateInputState(): void {
        if (!this.inputArea || !this.sendButton) return;
        const placeholder = this.getActiveHandler().getPlaceholder(this.plugin.t);
        this.inputArea.setPlaceholder(placeholder);

        const canSend = this.canSend();
        this.inputArea.setDisabled(this.isProcessing || !canSend);
        this.sendButton.setDisabled(this.isProcessing || !canSend);
    }

    private updateInputAndActions(): void {
        this.updateInputState();
        this.renderActionsBar();
    }

    private canSend(): boolean {
        if (this.activeMode !== 'highlight') return true;
        const handler = this.handlers.get('highlight');
        if (handler instanceof HighlightModeHandler) {
            return handler.getSelectedPassageTexts().length > 0;
        }
        return true;
    }

    private getActiveHandler(): ChatModeHandler {
        if (!this.activeMode) throw new Error('Active mode not set');
        const handler = this.handlers.get(this.activeMode);
        if (!handler) throw new Error('Mode handler not available');
        return handler;
    }

    private getActiveHistory(): ChatMessage[] {
        if (!this.activeMode) return [];
        return this.historyMap.get(this.activeMode) || [];
    }

    private ensureIntroMessage(mode: ChatMode): void {
        const history = this.historyMap.get(mode);
        if (!history || history.length > 0) return;
        const handler = this.handlers.get(mode);
        if (!handler) return;
        history.push({
            role: 'system',
            content: handler.getIntroMessage(this.plugin.t),
            timestamp: Date.now()
        });
    }

    private addMessage(message: ChatMessage): void {
        if (!this.activeMode) return;
        const history = this.historyMap.get(this.activeMode);
        if (!history) return;
        history.push(message);
        this.renderMessages();
        this.renderActionsBar();
    }

    /** Update last assistant message content in-place (for streaming). */
    private updateLastAssistantMessageContent(content: string): void {
        if (!this.activeMode || !this.chatContainer) return;
        const history = this.historyMap.get(this.activeMode);
        if (!history) return;

        // Find last assistant message in history
        const lastAssistant = [...history].reverse().find(m => m.role === 'assistant');
        if (lastAssistant) {
            lastAssistant.content = content;
        } else {
            // No assistant message yet — add one
            history.push({ role: 'assistant', content, timestamp: Date.now() });
        }

        // Find last assistant message element in DOM and re-render its content
        const msgEls = this.chatContainer.querySelectorAll('.ai-organiser-chat-msg-assistant');
        const lastEl = msgEls[msgEls.length - 1];
        if (lastEl) {
            const contentEl = lastEl.querySelector('.ai-organiser-chat-msg-content');
            if (contentEl) {
                contentEl.empty();
                void MarkdownRenderer.render(this.app, content, contentEl as HTMLElement, '', this.component!);
            }
        } else {
            // No DOM element yet — full re-render
            this.renderMessages();
        }
    }

    private switchMode(mode: ChatMode): void {
        if (this.activeMode === mode) return;

        // Persist outgoing mode immediately (bypass debounce)
        if (this.activeMode && this.plugin.settings.enableChatPersistence && this.persistenceService) {
            void this.persistenceService.saveNow(this.buildConversationState());
        }

        if (this.isProcessing) {
            // Abort any in-flight streaming on the current handler before switching
            const prevHandler = this.activeMode ? this.handlers.get(this.activeMode) : null;
            prevHandler?.dispose();

            this.requestGeneration = nextGeneration(this.requestGeneration);
            this.hideThinkingIndicator();
            this.isProcessing = false;
            this.notify(this.plugin.t.modals.unifiedChat.requestCancelled);
        }

        this.activeMode = mode;
        this.ensureIntroMessage(mode);
        this.renderAll();
    }

    private async handleSend(): Promise<void> {
        if (this.isProcessing || !this.activeMode || !this.inputArea) return;
        const query = this.inputArea.getValue().trim();
        if (!query) return;

        this.inputArea.setValue('');
        // Reset textarea height after clearing
        this.inputArea.inputEl.addClass('ai-organiser-h-auto');

        this.isProcessing = true;
        this.updateInputState();
        this.showThinkingIndicator();

        this.addMessage({
            role: 'user',
            content: query,
            timestamp: Date.now()
        });

        const gen = this.requestGeneration = nextGeneration(this.requestGeneration);
        let history: string;
        if (this.compactionService && this.plugin.settings.chatAutoCompaction && this.activeMode) {
            history = await this.compactionService.formatHistory(this.activeMode, this.getActiveHistory());
            if (isStaleGeneration(gen, this.requestGeneration)) return;
        } else {
            history = formatConversationHistory(this.getActiveHistory());
        }

        try {
            const result = await this.getActiveHandler().buildPrompt(query, history, this.ctx);

            if (isStaleGeneration(gen, this.requestGeneration)) return;

            // Streaming: handler provides a setup callback for progressive updates
            if (result.streamingSetup) {
                await this.handleStreamingResult(result.streamingSetup, gen);
                return;
            }

            // AD-1: directResponse — handler owns LLM orchestration, skip summarizeText
            if (result.directResponse) {
                const cleanedDirectResponse = this.processMemoryMarkers(result.directResponse);
                this.addMessage({
                    role: 'assistant',
                    content: cleanedDirectResponse,
                    timestamp: Date.now(),
                    sources: result.sources,
                });
                this.triggerAutosave();
                return;
            }

            if (!result.prompt) {
                if (result.systemNotice) {
                    this.addMessage({
                        role: 'system',
                        content: result.systemNotice,
                        timestamp: Date.now()
                    });
                }
                return;
            }

            if (result.systemNotice) {
                this.addMessage({
                    role: 'system',
                    content: result.systemNotice,
                    timestamp: Date.now()
                });
            }

            const response = await summarizeText(pluginContext(this.plugin), result.prompt);

            if (isStaleGeneration(gen, this.requestGeneration)) return;

            if (response.success && response.content) {
                const cleanedContent = this.processMemoryMarkers(response.content);
                this.addMessage({
                    role: 'assistant',
                    content: cleanedContent,
                    timestamp: Date.now(),
                    sources: result.sources
                });
                this.triggerAutosave();
            } else {
                this.addMessage({
                    role: 'assistant',
                    content: this.plugin.t.modals.unifiedChat.responseFailed,
                    timestamp: Date.now()
                });
                this.triggerAutosave();
            }
        } catch (error) {
            if (isStaleGeneration(gen, this.requestGeneration)) return;
            const errorMsg = this.plugin.t.modals.unifiedChat.errorOccurred
                .replace('{error}', (error as Error).message);
            this.addMessage({
                role: 'assistant',
                content: errorMsg,
                timestamp: Date.now()
            });
            this.triggerAutosave();
        } finally {
            if (!isStaleGeneration(gen, this.requestGeneration)) {
                this.isProcessing = false;
                this.hideThinkingIndicator();
                this.updateInputState();
                this.renderActionsBar();
                // Phase 1B F11: re-render the context panel so handlers can
                // surface new state (e.g. presentation mode's iframe preview
                // after generation completes). Without this, the deck exists
                // on the handler but is never rendered until the modal
                // closes + reopens.
                this.renderContextPanel();
            }
        }
    }

    private async handleStreamingResult(
        setup: { start: (callbacks: import('../chat/ChatModeHandler').StreamingCallbacks) => Promise<import('../chat/ChatModeHandler').StreamingResult> },
        gen: number,
    ): Promise<void> {
        // Keep the thinking indicator visible until the first real content chunk
        // arrives so handlers can bubble phase transitions during the pre-stream
        // wait (e.g. Claude Web Search runs multiple searches before any token
        // streams; Dr. Chen persona was staring at "Thinking…" for 150s+).
        this.addMessage({ role: 'assistant', content: '', timestamp: Date.now() });
        let firstChunkArrived = false;
        const streamResult = await setup.start({
            updateMessage: (c) => {
                if (isStaleGeneration(gen, this.requestGeneration)) return;
                if (!firstChunkArrived) {
                    firstChunkArrived = true;
                    this.hideThinkingIndicator();
                }
                this.updateLastAssistantMessageContent(c);
            },
            addSystemNotice: (c) => {
                if (!isStaleGeneration(gen, this.requestGeneration)) {
                    this.addMessage({ role: 'system', content: c, timestamp: Date.now() });
                }
            },
            updateThinking: (msg) => {
                if (!isStaleGeneration(gen, this.requestGeneration) && !firstChunkArrived) {
                    this.showThinkingIndicator(msg);
                }
            },
            updateProgressSplit: (slideFragment, elapsedFragment) => {
                if (!isStaleGeneration(gen, this.requestGeneration) && !firstChunkArrived) {
                    this.updateThinkingProgressSplit(slideFragment, elapsedFragment);
                }
            },
            showCancelButton: (onCancel) => {
                if (!isStaleGeneration(gen, this.requestGeneration) && !firstChunkArrived) {
                    this.setThinkingCancel(onCancel);
                }
            },
            requestBudgetExtension: (context) => {
                if (isStaleGeneration(gen, this.requestGeneration)) {
                    // Stale generation: no user-facing cancel notice needed —
                    // the mode switch itself already superseded this stream.
                    return Promise.resolve('auto-dismiss');
                }
                return this.renderBudgetExtendCard({
                    elapsedMs: context.elapsedMs,
                    softBudgetMs: context.softBudgetMs,
                    hardBudgetMs: context.hardBudgetMs,
                    title: context.title,
                    body: context.body,
                    onRegisterCancelHook: context.onRegisterCancelHook,
                });
            },
        });
        if (!firstChunkArrived) this.hideThinkingIndicator();
        // Guard: if mode was switched mid-stream, discard the result
        if (isStaleGeneration(gen, this.requestGeneration)) return;
        this.updateLastAssistantMessageContent(streamResult.finalContent);
        const activeHistory = this.getActiveHistory();
        const lastMsg = activeHistory.at(-1);
        if (lastMsg && streamResult.sources) lastMsg.sources = streamResult.sources;
        this.triggerAutosave();
    }

    private handleClear(): void {
        if (!this.activeMode) return;

        // Persist current state before clearing
        if (this.plugin.settings.enableChatPersistence && this.persistenceService) {
            void this.persistenceService.saveNow(this.buildConversationState());
        }

        const history = this.historyMap.get(this.activeMode);
        if (!history) return;
        history.length = 0;
        history.push({
            role: 'system',
            content: this.plugin.t.modals.unifiedChat.chatCleared,
            timestamp: Date.now()
        });
        const handler = this.handlers.get(this.activeMode);
        handler?.onClear?.();

        // Start new conversation file
        this.persistenceService?.startNew(this.activeMode);
        this.compactionService?.reset(this.activeMode);
        this.modeCreatedAt.delete(this.activeMode);

        this.renderMessages();
        this.renderActionsBar();
    }

    private async handleExport(): Promise<void> {
        if (!this.activeMode) return;

        const messages = this.getActiveHistory();
        const nonSystemMessages = messages.filter(m => m.role !== 'system');
        if (nonSystemMessages.length === 0) {
            this.notify(this.plugin.t.modals.unifiedChat.exportEmpty);
            return;
        }

        const folder = await this.promptExportFolder();
        if (!folder) return;

        const resolvedFolder = resolveOutputPath(this.plugin.settings, folder, 'Chats');
        try {
            await ensureFolderExists(this.app.vault, resolvedFolder);

            const dateStr = new Date().toISOString().slice(0, 10);
            const fileName = await this.generateChatFileName(nonSystemMessages, dateStr);
            const filePath = await getAvailableFilePath(this.app.vault, resolvedFolder, fileName);

            const title = this.buildExportTitle();
            const markdown = formatExportMarkdown(messages, title);

            await this.app.vault.create(filePath, markdown);
            this.notify(this.plugin.t.modals.unifiedChat.exportSuccess.replace('{path}', filePath));
        } catch (error) {
            logger.error('Chat', 'Chat export error:', error);
            this.notify(this.plugin.t.modals.unifiedChat.exportFailed.replace('{error}', (error as Error).message));
        }
    }

    private buildExportTitle(): string {
        const t = this.plugin.t.modals.unifiedChat;
        const dateLabel = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
        const noteTitle = this.options.noteTitle || t.modeNote;

        switch (this.activeMode) {
            case 'vault':
                return t.exportTitleVault.replace('{date}', dateLabel);
            case 'highlight':
                return t.exportTitleHighlight.replace('{date}', dateLabel);
            case 'note':
            default:
                return t.exportTitleNote
                    .replace('{noteTitle}', noteTitle)
                    .replace('{date}', dateLabel);
        }
    }

    private async generateChatFileName(messages: ChatMessage[], dateStr: string): Promise<string> {
        const fallback = `Chat-${dateStr}.md`;
        try {
            const firstUserMsg = messages.find(m => m.role === 'user');
            if (!firstUserMsg) return fallback;

            const prompt = buildChatFileNamePrompt(
                firstUserMsg.content,
                this.activeMode || 'note',
                this.options.noteTitle
            );
            const ctx = pluginContext(this.plugin);
            const result = await summarizeText(ctx, prompt);

            if (result.success && result.content) {
                const slug = result.content
                    .trim()
                    .replaceAll(/[`'"\n\r]/g, '')
                    .toLowerCase()
                    .replaceAll(/[^a-z0-9-]/g, '-')
                    .replaceAll(/-+/g, '-')
                    .replaceAll(/(^-)|(-$)/g, '')
                    .slice(0, 40);
                if (slug.length > 0) return `${slug}_${dateStr}.md`;
            }
        } catch {
            // Silent fallback
        }
        return fallback;
    }

    private async promptExportFolder(): Promise<string | null> {
        const t = this.plugin.t.modals.unifiedChat;
        const { FolderScopePickerModal } = await import('./FolderScopePickerModal');

        // Default to current note's folder, fallback to settings folder
        const activeFile = this.app.workspace.getActiveFile();
        const defaultFolder = activeFile?.parent?.path || getChatExportFullPath(this.plugin.settings);

        return new Promise((resolve) => {
            let resolved = false;
            const modal = new FolderScopePickerModal(
                this.app,
                this.plugin as unknown as import('../../main').default,
                {
                    title: t.exportTitle,
                    allowSkip: false,
                    allowNewFolder: true,
                    confirmButtonText: t.export,
                    defaultFolder,
                    resolvePreview: (path) => resolveOutputPath(this.plugin.settings, path, 'Chats'),
                    onSelect: (folder) => {
                        resolved = true;
                        resolve(folder);
                    }
                }
            );

            const origOnClose = modal.onClose.bind(modal);
            modal.onClose = () => {
                origOnClose();
                if (!resolved) resolve(null);
            };

            modal.open();
        });
    }

    private handleInsertLastAnswer(): void {
        const editor = this.app.workspace.activeEditor?.editor;
        if (!editor) {
            this.notify(this.plugin.t.modals.unifiedChat.noEditor);
            return;
        }

        const lastAnswer = this.getLastAssistantMessage();
        if (!lastAnswer) {
            this.notify(this.plugin.t.modals.unifiedChat.noAnswerYet);
            return;
        }

        editor.replaceSelection(lastAnswer.content);
        ensureNoteStructureIfEnabled(editor, this.plugin.settings);
        this.notify(this.plugin.t.modals.unifiedChat.answerInserted);
    }

    private async handleAction(actionId: string): Promise<void> {
        // AD-2: delegate to handler if it owns actions
        const handler = this.getActiveHandler();
        if (handler.handleAction) {
            // Sync modal processing state to prevent concurrent sends/clears during handler actions
            this.isProcessing = true;
            this.updateInputState();
            this.renderActionsBar();
            const callbacks: ActionCallbacks = {
                addAssistantMessage: (content) => this.addMessage({
                    role: 'assistant', content, timestamp: Date.now(),
                }),
                updateAssistantMessage: (content) => this.updateLastAssistantMessageContent(content),
                addSystemNotice: (content) => this.addMessage({
                    role: 'system', content, timestamp: Date.now(),
                }),
                showThinking: (msg) => this.showThinkingIndicator(msg),
                hideThinking: () => this.hideThinkingIndicator(),
                rerenderActions: () => this.renderActionsBar(),
                getEditor: () => this.cachedEditor ?? null,
                notify: (msg) => this.notify(msg),
            };
            try {
                await handler.handleAction(actionId, this.ctx, callbacks);
            } finally {
                this.isProcessing = false;
                this.updateInputState();
                this.renderActionsBar();
                this.triggerAutosave();
            }
            return;
        }
        // Legacy fallback for highlight mode
        if (actionId !== 'insert-summary') return;
        await this.handleInsertSummary();
    }

    private async handleInsertSummary(): Promise<void> {
        const editor = this.app.workspace.activeEditor?.editor;
        if (!editor) {
            this.notify(this.plugin.t.modals.unifiedChat.noEditor);
            return;
        }

        const handler = this.handlers.get('highlight');
        if (!(handler instanceof HighlightModeHandler)) return;

        const selectedPassages = handler.getSelectedPassageTexts();
        if (selectedPassages.length === 0) {
            this.notify(this.plugin.t.modals.unifiedChat.noPassagesSelected);
            return;
        }

        const gen = this.requestGeneration = nextGeneration(this.requestGeneration);
        this.isProcessing = true;
        this.updateInputState();
        this.showThinkingIndicator();

        try {
            const history = this.getActiveHistory()
                .filter(m => m.role === 'user' || m.role === 'assistant')
                .map(m => ({ role: m.role as HighlightChatMessage['role'], content: m.content }));
            const noteTitle = this.options.noteTitle || this.plugin.t.modals.unifiedChat.modeHighlight;

            const prompt = buildInsertSummaryPrompt(selectedPassages, history, noteTitle);
            const response = await summarizeText(pluginContext(this.plugin), prompt);

            if (isStaleGeneration(gen, this.requestGeneration)) return;

            if (response.success && response.content) {
                editor.replaceSelection(response.content);
                ensureNoteStructureIfEnabled(editor, this.plugin.settings);
                this.notify(this.plugin.t.modals.unifiedChat.summaryInserted);
            } else {
                this.notify(this.plugin.t.modals.unifiedChat.responseFailed);
            }
        } catch (error) {
            if (isStaleGeneration(gen, this.requestGeneration)) return;
            this.notify(
                this.plugin.t.modals.unifiedChat.errorOccurred
                    .replace('{error}', (error as Error).message)
            );
        } finally {
            if (!isStaleGeneration(gen, this.requestGeneration)) {
                this.isProcessing = false;
                this.hideThinkingIndicator();
                this.updateInputState();
                this.renderActionsBar();
            }
        }
    }

    private getLastAssistantMessage(): ChatMessage | null {
        const messages = this.getActiveHistory();
        for (let i = messages.length - 1; i >= 0; i -= 1) {
            if (messages[i].role === 'assistant') return messages[i];
        }
        return null;
    }

    private showThinkingIndicator(message?: string): void {
        if (!this.chatContainer) return;
        const text = message || this.plugin.t.modals.unifiedChat.thinking;

        // In-place update — keeps DOM stable so phase-transitions
        // ("Searching web…" → "Extracting sources…" → "Synthesizing…")
        // don't recreate the live region.
        if (this.thinkingEl) {
            const label = this.thinkingEl.querySelector<HTMLElement>('.ai-organiser-chat-thinking-text');
            if (label) {
                label.textContent = text;
                // Clear the split-DOM slide fragment — when caller uses the
                // single-string API they're not in presentation-progress mode.
                this.thinkingSlideEl?.replaceChildren();
                this.thinkingElapsedEl?.replaceChildren();
                this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
                return;
            }
        }

        this.thinkingEl?.remove();
        this.buildThinkingIndicator(text);
        if (this.chatContainer) this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
    }

    /** Build the thinking indicator with the split-DOM layout required by the
     *  presentation progress UX (plan §3 ARIA):
     *    - `.text`   — single-string phase label (used by non-presentation modes)
     *    - `.slide`  — slide-count fragment (role=status, aria-live=polite)
     *    - `.elapsed`— elapsed timer (aria-hidden=true — silent to SR)
     *    - `.cancel` — optional cancel button, mounted via setThinkingCancel() */
    private buildThinkingIndicator(text: string): void {
        if (!this.chatContainer) return;
        this.thinkingEl = this.chatContainer.createDiv({ cls: 'ai-organiser-chat-thinking' });
        const dots = this.thinkingEl.createSpan({ cls: 'ai-organiser-chat-thinking-dots' });
        dots.textContent = '•••';
        this.thinkingEl.createSpan({ cls: 'ai-organiser-chat-thinking-text', text });
        // Slide-count fragment — live region, mutates only on slide change.
        this.thinkingSlideEl = this.thinkingEl.createSpan({ cls: 'ai-organiser-chat-thinking-slide' });
        this.thinkingSlideEl.setAttribute('role', 'status');
        this.thinkingSlideEl.setAttribute('aria-live', 'polite');
        // Elapsed fragment — aria-hidden so SR ignores the 1s ticker.
        this.thinkingElapsedEl = this.thinkingEl.createSpan({ cls: 'ai-organiser-chat-thinking-elapsed' });
        this.thinkingElapsedEl.setAttribute('aria-hidden', 'true');
    }

    /** Split-DOM progress update — writes slide-count and elapsed fragments
     *  into separate spans. Only mutates the slide span when the text
     *  actually changes (prevents WCAG 4.1.3 status-message spam). */
    private updateThinkingProgressSplit(slideFragment: string, elapsedFragment: string): void {
        if (!this.thinkingEl) {
            // First call wins a fresh indicator — build with an empty base text.
            this.buildThinkingIndicator('');
        }
        // Mutate slide fragment ONLY when it actually changes — keeps live
        // region quiet during 1s elapsed ticks.
        if (this.thinkingSlideEl && this.thinkingSlideEl.textContent !== slideFragment) {
            this.thinkingSlideEl.textContent = slideFragment;
        }
        // Elapsed is aria-hidden — free to tick without SR impact.
        if (this.thinkingElapsedEl) {
            this.thinkingElapsedEl.textContent = elapsedFragment;
        }
        if (this.chatContainer) {
            this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
        }
    }

    /** Mount a cancel × button inside the thinking indicator. Idempotent —
     *  replaces any prior handler so we don't stack listeners. */
    private setThinkingCancel(onCancel: () => void): void {
        if (!this.thinkingEl) this.buildThinkingIndicator('');
        if (!this.thinkingEl) return;
        let btn = this.thinkingEl.querySelector<HTMLButtonElement>('.ai-organiser-chat-thinking-cancel');
        const t = this.plugin.t.modals.unifiedChat;
        if (!btn) {
            btn = this.thinkingEl.createEl('button', {
                cls: 'ai-organiser-chat-thinking-cancel',
                attr: { type: 'button', 'aria-label': t.cancelGeneration },
            });
            btn.textContent = '✕';
        }
        // Replace the listener via cloneNode for idempotency.
        const fresh = btn.cloneNode(true) as HTMLButtonElement;
        btn.replaceWith(fresh);
        this.thinkingCancelBtn = fresh;
        fresh.addEventListener('click', () => {
            fresh.disabled = true; // prevent double-click during abort window
            onCancel();
        });
    }

    private hideThinkingIndicator(): void {
        if (!this.thinkingEl) return;
        this.thinkingEl.remove();
        this.thinkingEl = undefined;
        this.thinkingSlideEl = undefined;
        this.thinkingElapsedEl = undefined;
        this.thinkingCancelBtn = undefined;
    }

    // ── Extend-budget card (transient — NOT persisted in historyMap) ────────

    /** Render the inline extend-budget card ABOVE the thinking indicator
     *  (same container, so scroll position stays put). Returns a Promise
     *  that resolves 'extend' / 'cancel'. Plan §4 race protocol:
     *    - source 1 (Extend click) → resolve 'extend'
     *    - source 2 (Cancel click / Escape) → resolve 'cancel'  (modal does NOT abort — handler's onSoftBudget inspects and aborts)
     *    - sources 4/5 (completion / hard cap) → controller calls the
     *      registered cancel hook → resolve 'cancel' idempotently. */
    private renderBudgetExtendCard(opts: {
        elapsedMs: number;
        softBudgetMs: number;
        hardBudgetMs: number;
        /** Optional copy overrides — when omitted, the generic
         *  presentation-era copy (extendBudgetTitle + extendBudgetBody) is
         *  used. Research and Minutes pass their own pre-resolved strings. */
        title?: string;
        body?: string;
        onRegisterCancelHook?: (cancel: () => void) => void;
    }): Promise<'extend' | 'cancel' | 'auto-dismiss'> {
        const { elapsedMs, softBudgetMs, hardBudgetMs, onRegisterCancelHook } = opts;
        const t = this.plugin.t.modals.unifiedChat;
        const container = this.chatContainer;
        if (!container) return Promise.resolve('auto-dismiss');

        // Audit Gemini G2: capture previous focus before stealing so we can
        // restore the user's typing context (often a different editor pane)
        // when the card dismisses — instead of warping focus into the chat.
        const previouslyFocused = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;

        const headingId = `ai-organiser-extend-heading-${Date.now()}`;
        const card = document.createElement('div');
        card.className = 'ai-organiser-chat-budget-extend';
        card.setAttribute('role', 'group');
        card.setAttribute('aria-labelledby', headingId);

        const heading = card.createDiv({ cls: 'ai-organiser-chat-budget-extend-title' });
        heading.id = headingId;
        heading.textContent = opts.title ?? t.extendBudgetTitle;

        // Derive extend minutes from the active budget preset (soft→hard gap)
        // so i18n copy can't drift from the real timers. (Audit R2 L1/M5)
        const extendMinutes = Math.round(
            getExtendDisplayMs({ softBudgetMs, hardBudgetMs }) / 60_000,
        );
        const elapsedLabel = this.formatElapsed(elapsedMs);

        const body = card.createDiv({ cls: 'ai-organiser-chat-budget-extend-body' });
        body.textContent = (opts.body ?? t.extendBudgetBody)
            .replace('{elapsed}', elapsedLabel)
            .replace('{extendMinutes}', String(extendMinutes));

        const actions = card.createDiv({ cls: 'ai-organiser-chat-budget-extend-actions' });
        const extendBtn = actions.createEl('button', {
            text: t.extendBudgetConfirm.replace('{extendMinutes}', String(extendMinutes)),
            cls: 'mod-cta',
        });
        const cancelBtn = actions.createEl('button', { text: t.extendBudgetCancel });

        // Insert ABOVE the thinking indicator so the thinking row remains the
        // bottom-most chat element.
        if (this.thinkingEl) {
            container.insertBefore(card, this.thinkingEl);
        } else {
            container.appendChild(card);
        }

        return new Promise<'extend' | 'cancel' | 'auto-dismiss'>((resolve) => {
            let resolved = false;
            const finish = (choice: 'extend' | 'cancel' | 'auto-dismiss') => {
                if (resolved) return; // idempotent guard
                resolved = true;
                if (keydownListener) card.removeEventListener('keydown', keydownListener);
                // Fade out then remove — respects prefers-reduced-motion via CSS
                card.classList.add('is-dismissing');
                globalThis.setTimeout(() => card.remove(), 200);
                // Audit Gemini G2: restore focus to whatever element had it
                // before the card stole focus, if it's still attached. Falls
                // back to the chat input only if the previous target is gone.
                if (previouslyFocused && previouslyFocused.isConnected) {
                    previouslyFocused.focus();
                } else {
                    this.inputArea?.inputEl?.focus();
                }
                resolve(choice);
            };

            extendBtn.addEventListener('click', () => finish('extend'));
            cancelBtn.addEventListener('click', () => finish('cancel'));

            // Lightweight focus trap: Tab cycles Extend↔Cancel, Escape cancels
            const keydownListener = (e: KeyboardEvent) => {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    finish('cancel');
                    return;
                }
                if (e.key !== 'Tab') return;
                const active = document.activeElement;
                if (!e.shiftKey && active === cancelBtn) {
                    e.preventDefault();
                    extendBtn.focus();
                } else if (e.shiftKey && active === extendBtn) {
                    e.preventDefault();
                    cancelBtn.focus();
                }
            };
            card.addEventListener('keydown', keydownListener);

            // Audit Gemini G1: terminal-state auto-dismiss resolves with a
            // distinct 'auto-dismiss' value (NOT 'cancel') so callers don't
            // emit a spurious "Generation cancelled" notice on the happy path
            // when a run succeeds after the soft budget fired.
            onRegisterCancelHook?.(() => finish('auto-dismiss'));

            // Focus the primary action on mount.
            extendBtn.focus();
        });
    }

    private formatElapsed(ms: number): string {
        const totalSeconds = Math.floor(ms / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return minutes > 0
            ? `${minutes}m ${seconds.toString().padStart(2, '0')}s`
            : `${seconds}s`;
    }

    private renderEmptyState(): void {
        this.contentEl.createDiv({
            cls: 'ai-organiser-chat-empty-state',
            text: this.plugin.t.modals.unifiedChat.emptyState
        });
    }

    private showFallbackNotice(requested: ChatMode): void {
        const t = this.plugin.t.modals.unifiedChat;
        let message = t.noteUnavailable;
        if (requested === 'vault') {
            message = t.vaultFallbackNotice;
        } else if (requested === 'highlight') {
            message = t.highlightFallbackNotice;
        }
        this.notify(message);
    }

    private triggerAutosave(): void {
        if (!this.plugin.settings.enableChatPersistence || !this.persistenceService || !this.activeMode) return;
        const state = this.buildConversationState();
        this.persistenceService.scheduleSave(state);
    }

    private buildConversationState(): ConversationState {
        const mode = this.activeMode!;
        const messages = this.getActiveHistory();
        const now = new Date().toISOString();
        return {
            version: 1,
            mode,
            messages,
            compactionSummary: this.compactionService?.getCachedSummary(mode) ?? '',
            projectId: (mode === 'free' || mode === 'presentation') ? this.activeProjectId : undefined,
            freeState: mode === 'free' ? this.freeChatHandler?.getSerializableState() : undefined,
            presentationSnapshot: mode === 'presentation'
                ? (this.presentationHandler?.getSerializableState() ?? undefined)
                : undefined,
            customTitle: this.customTitle,
            createdAt: this.modeCreatedAt.get(mode) ?? now,
            lastActiveAt: now,
        };
    }

    private processMemoryMarkers(content: string): string {
        const MEMORY_REGEX = /\[MEMORY:\s*(.+?)\]/g;
        const facts: string[] = [];
        let match: RegExpExecArray | null;
        while ((match = MEMORY_REGEX.exec(content)) !== null) {
            facts.push(match[1].trim());
        }
        if (facts.length === 0) return content;

        for (const fact of facts) {
            if (this.activeProjectId && this.projectService) {
                void this.projectService.addMemory(this.activeProjectId, fact).then(() => {
                    this.freeChatHandler?.addProjectMemoryFact(fact);
                    new Notice(this.plugin.t.modals.unifiedChat.memoryAdded.replace('{fact}', fact), 3000);
                });
            } else if (this.globalMemoryService) {
                void this.globalMemoryService.addMemory(fact).then((added) => {
                    if (added) {
                        this.freeChatHandler?.addGlobalMemoryFact(fact);
                        new Notice(this.plugin.t.modals.unifiedChat.memoryAdded.replace('{fact}', fact), 3000);
                    }
                });
            }
        }

        // Strip markers from displayed text
        return content.replace(/\[MEMORY:\s*.+?\]/g, '').trim();
    }

    private async showResumePicker(): Promise<import('./ChatResumePickerModal').ResumePickerResult> {
        if (!this.persistenceService || !this.projectService) return { action: 'new' };

        const [conversations, projects] = await Promise.all([
            this.persistenceService.listRecent(5),
            this.projectService.listProjects(),
        ]);

        if (conversations.length === 0 && projects.length === 0) return { action: 'new' };

        const modal = new ChatResumePickerModal(
            this.app,
            this.persistenceService,
            this.projectService,
            this.plugin.settings,
            this.plugin.t.modals.unifiedChat,
        );
        modal.open();
        return modal.waitForResult();
    }

    private async resumeConversation(filePath: string): Promise<ChatMode | null> {
        if (!this.persistenceService) return null;
        const state = await this.persistenceService.load(filePath);
        if (!state) return null;

        // Restore messages
        const history = this.historyMap.get(state.mode);
        if (history) {
            history.length = 0;
            history.push(...state.messages);
        }

        // Restore compaction summary
        if (state.compactionSummary) {
            this.compactionService?.restore(state.mode, state.compactionSummary);
        }

        // Restore timestamps
        if (state.createdAt) {
            this.modeCreatedAt.set(state.mode, state.createdAt);
        }

        // Restore free chat state
        if (state.freeState && this.freeChatHandler) {
            this.freeChatHandler.restoreState(state.freeState);
        }

        // Restore presentation state
        if (state.presentationSnapshot && this.presentationHandler) {
            this.presentationHandler.restoreState(state.presentationSnapshot);
        }

        // Restore custom title
        if (state.customTitle) {
            this.customTitle = state.customTitle;
            this.titleEl.setText(state.customTitle);
        }

        // Set file for overwrite on next save
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (file instanceof TFile) {
            this.persistenceService.setCurrentFile(state.mode, file);
        }

        // Load project context
        if (state.projectId) {
            await this.loadProjectContext(state.projectId);
        }

        return state.mode;
    }
}
