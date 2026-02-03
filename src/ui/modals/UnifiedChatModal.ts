import { App, ButtonComponent, Component, MarkdownRenderer, Modal, Notice, TextAreaComponent } from 'obsidian';
import { ensureNoteStructureIfEnabled } from '../../utils/noteStructure';
import { formatConversationHistory, formatExportMarkdown } from '../../utils/chatExportUtils';
import { getChatExportFullPath, resolvePluginPath } from '../../core/settings';
import { ensureFolderExists, getAvailableFilePath } from '../../utils/minutesUtils';
import { summarizeText, pluginContext } from '../../services/llmFacade';
import { buildInsertSummaryPrompt, HighlightChatMessage } from '../../services/prompts/highlightChatPrompts';
import { buildChatFileNamePrompt } from '../../services/prompts/chatPrompts';
import { splitIntoBlocks } from '../../utils/highlightExtractor';
import type { ChatMode, ChatModeHandler, ChatPluginContext, ModalContext, UnifiedChatOptions } from '../chat/ChatModeHandler';
import { NoteModeHandler } from '../chat/NoteModeHandler';
import { VaultModeHandler } from '../chat/VaultModeHandler';
import { HighlightModeHandler } from '../chat/HighlightModeHandler';

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
        ['highlight', []]
    ]);
}

export function firstAvailableMode(
    ctx: ModalContext,
    handlers: Map<ChatMode, ChatModeHandler>
): ChatMode | null {
    const order: ChatMode[] = ['note', 'highlight', 'vault'];
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

    return handlers.get('note')?.isAvailable(ctx) ? 'note' : firstAvailableMode(ctx, handlers);
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

    private component?: Component;

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

        this.ctx = await this.buildContext();
        this.handlers = new Map<ChatMode, ChatModeHandler>([
            ['note', new NoteModeHandler()],
            ['vault', new VaultModeHandler()],
            ['highlight', new HighlightModeHandler(() => this.updateInputAndActions())]
        ]);

        const initialMode = selectInitialMode(this.ctx, this.handlers);
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
        this.requestGeneration = nextGeneration(this.requestGeneration);
        this.component?.unload();
        for (const handler of this.handlers.values()) {
            handler.dispose();
        }
        this.contentEl.empty();
    }

    private async buildContext(): Promise<ModalContext> {
        const metadata = await this.plugin.vectorStore?.getMetadata();
        return {
            plugin: this.plugin,
            options: this.options,
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
        this.inputArea.inputEl.rows = 3;
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
            { mode: 'highlight', label: t.modeHighlight }
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
                MarkdownRenderer.render(this.app, message.content, contentEl, '', this.component);
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
                    linkEl.addEventListener('click', async (event) => {
                        event.preventDefault();
                        const file = this.app.vault.getFileByPath(source);
                        if (file) {
                            await this.app.workspace.getLeaf().openFile(file);
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
        const hasEditor = !!this.app.workspace.activeEditor?.editor;
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

            if (!descriptor.isEnabled || !hasEditor || this.isProcessing) {
                button.setDisabled(true);
                button.setTooltip(hasEditor ? tooltip : t.noEditor);
            }
        }

        const exportButton = new ButtonComponent(this.actionsEl)
            .setButtonText(t.export)
            .onClick(() => void this.handleExport());

        if (this.isProcessing) {
            clearButton.setDisabled(true);
            exportButton.setDisabled(true);
        }
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

    private switchMode(mode: ChatMode): void {
        if (this.activeMode === mode) return;

        if (this.isProcessing) {
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

        this.isProcessing = true;
        this.updateInputState();
        this.showThinkingIndicator();

        this.addMessage({
            role: 'user',
            content: query,
            timestamp: Date.now()
        });

        const gen = this.requestGeneration = nextGeneration(this.requestGeneration);
        const history = formatConversationHistory(this.getActiveHistory());

        try {
            const result = await this.getActiveHandler().buildPrompt(query, history, this.ctx);

            if (isStaleGeneration(gen, this.requestGeneration)) return;

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
                this.addMessage({
                    role: 'assistant',
                    content: response.content,
                    timestamp: Date.now(),
                    sources: result.sources
                });
            } else {
                this.addMessage({
                    role: 'assistant',
                    content: this.plugin.t.modals.unifiedChat.responseFailed,
                    timestamp: Date.now()
                });
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
        } finally {
            if (!isStaleGeneration(gen, this.requestGeneration)) {
                this.isProcessing = false;
                this.hideThinkingIndicator();
                this.updateInputState();
            }
        }
    }

    private handleClear(): void {
        if (!this.activeMode) return;
        const history = this.historyMap.get(this.activeMode);
        if (!history) return;
        history.length = 0;
        history.push({
            role: 'system',
            content: this.plugin.t.modals.unifiedChat.chatCleared,
            timestamp: Date.now()
        });
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

        const resolvedFolder = resolvePluginPath(this.plugin.settings, folder, 'Chats');
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
            console.error('Chat export error:', error);
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
                this.plugin as unknown as any,
                {
                    title: t.exportTitle,
                    allowSkip: false,
                    allowNewFolder: true,
                    confirmButtonText: t.export,
                    defaultFolder,
                    resolvePreview: (path) => resolvePluginPath(this.plugin.settings, path, 'Chats'),
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

    private async handleInsertLastAnswer(): Promise<void> {
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

    private showThinkingIndicator(): void {
        if (!this.chatContainer) return;
        this.thinkingEl?.remove();
        this.thinkingEl = this.chatContainer.createDiv({ cls: 'ai-organiser-chat-thinking' });
        const dots = this.thinkingEl.createSpan({ cls: 'ai-organiser-chat-thinking-dots' });
        dots.textContent = '•••';
        this.thinkingEl.createSpan({ text: this.plugin.t.modals.unifiedChat.thinking });
        this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
    }

    private hideThinkingIndicator(): void {
        if (!this.thinkingEl) return;
        this.thinkingEl.remove();
        this.thinkingEl = undefined;
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
}
