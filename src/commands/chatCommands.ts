/**
 * Chat with Vault Commands
 * Interactive chat using RAG (Retrieval-Augmented Generation)
 */

import { Notice, Modal, App, Setting, TextAreaComponent, ButtonComponent, MarkdownRenderer, Component } from 'obsidian';
import AIOrganiserPlugin from '../main';
import { RAGService, RAGContext } from '../services/ragService';
import { ensureNoteStructureIfEnabled } from '../utils/noteStructure';
import { HighlightChatModal } from '../ui/modals/HighlightChatModal';
import { summarizeText, pluginContext } from '../services/llmFacade';
import { INDEX_SCHEMA_VERSION } from '../services/vector/vectorStoreService';
import { getChatExportFullPath, resolvePluginPath } from '../core/settings';
import { ensureFolderExists, getAvailableFilePath } from '../utils/minutesUtils';
import { formatConversationHistory, formatExportMarkdown } from '../utils/chatExportUtils';

/**
 * Chat message interface
 */
interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: number;
    sources?: string[];
}

/**
 * Chat with Vault Modal
 * Interactive chat interface with RAG context retrieval
 */
class ChatWithVaultModal extends Modal {
    private plugin: AIOrganiserPlugin;
    private ragService: RAGService;
    private messages: ChatMessage[] = [];
    private chatContainer!: HTMLElement;
    private inputArea!: TextAreaComponent;
    private sendButton!: ButtonComponent;
    private isProcessing: boolean = false;
    private component!: Component;

    constructor(app: App, plugin: AIOrganiserPlugin) {
        super(app);
        this.plugin = plugin;

        if (!plugin.vectorStore) {
            throw new Error('Vector store not initialized');
        }

        this.ragService = new RAGService(
            plugin.vectorStore,
            plugin.settings,
            plugin.embeddingService
        );
        this.titleEl.setText(plugin.t.modals.chatWithVault.title);
    }

    async onOpen(): Promise<void> {
        const { contentEl } = this;
        contentEl.empty();
        this.modalEl.addClass('chat-with-vault-modal');

        // Chat container (scrollable) — must be created before addSystemMessage
        this.chatContainer = contentEl.createEl('div', {
            cls: 'chat-container'
        });

        // Add intro message
        this.addSystemMessage(this.plugin.t.modals.chatWithVault.intro);

        // Show diagnostic status
        const hasEmbedding = !!this.plugin.embeddingService;
        const metadata = await this.plugin.vectorStore?.getMetadata();
        const docCount = metadata?.totalDocuments ?? 0;
        const indexVersion = metadata?.version ?? 'unknown';
        const statusParts: string[] = [];
        if (!hasEmbedding) statusParts.push('⚠ Embedding service not initialized');
        statusParts.push(`Index: ${docCount} documents (v${indexVersion})`);
        if (indexVersion !== INDEX_SCHEMA_VERSION && docCount > 0) statusParts.push('⚠ Index outdated — rebuild recommended');
        this.addSystemMessage(statusParts.join(' | '));

        // Input area container
        const inputContainer = contentEl.createEl('div', {
            cls: 'chat-input-container'
        });

        // Text input
        const inputSetting = new Setting(inputContainer)
            .setClass('chat-input-setting');

        this.inputArea = new TextAreaComponent(inputSetting.controlEl);
        this.inputArea
            .setPlaceholder(this.plugin.t.modals.chatWithVault.placeholder)
            .then(text => {
                text.inputEl.rows = 3;
                text.inputEl.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        this.handleSend();
                    }
                });
            });

        // Send button
        const buttonContainer = inputContainer.createEl('div', {
            cls: 'chat-button-container'
        });

        this.sendButton = new ButtonComponent(buttonContainer)
            .setButtonText(this.plugin.t.modals.chatWithVault.sendButton)
            .onClick(() => this.handleSend());

        new ButtonComponent(buttonContainer)
            .setButtonText(this.plugin.t.modals.chatWithVault.clearButton)
            .onClick(() => this.handleClear());

        new ButtonComponent(buttonContainer)
            .setButtonText(this.plugin.t.modals.chatWithVault.exportButton)
            .onClick(() => this.handleExport());
    }

    private formatConversationHistory(): string {
        return formatConversationHistory(this.messages);
    }

    private async handleSend(): Promise<void> {
        if (this.isProcessing) return;

        const query = this.inputArea.getValue().trim();
        if (!query) return;

        // Clear input
        this.inputArea.setValue('');
        this.isProcessing = true;
        this.sendButton.setButtonText(this.plugin.t.modals.chatWithVault.thinkingButton);
        this.sendButton.setDisabled(true);

        // Add user message
        this.addMessage('user', query);

        try {
            // Build conversation history for context
            const conversationHistory = this.formatConversationHistory();
            const historySection = conversationHistory
                ? `\n<conversation_history>\n${conversationHistory}\n</conversation_history>\n`
                : '';

            // Check if embedding service is available for vault search
            const hasEmbeddings = !!this.plugin.embeddingService;
            let context: RAGContext | null = null;

            if (hasEmbeddings) {
                const statusNotice = new Notice(this.plugin.t.messages.searchingVaultContext, 0);
                context = await this.ragService.retrieveContext(query);
                statusNotice.hide();

                // Diagnostic: log raw search results for debugging
                console.log('[Chat with Vault] Query:', query);
                console.log('[Chat with Vault] Results:', context.totalChunks, 'chunks from', context.sources.length, 'sources');
                if (context.chunks.length > 0) {
                    console.log('[Chat with Vault] Top scores:', context.chunks.slice(0, 3).map(c => c.score.toFixed(3)));
                }

                if (context.totalChunks > 0) {
                    new Notice(this.plugin.t.messages.foundRelevantChunks.replace('{count}', String(context.totalChunks)).replace('{sources}', String(context.sources.length)), 3000);
                }
            } else {
                console.warn('[Chat with Vault] Embedding service is null — vault search disabled');
                this.addSystemMessage(this.plugin.t.modals.chatWithVault.embeddingServiceMissing);
            }

            // Build prompt — with vault context if available, general knowledge otherwise
            let prompt: string;
            let sources: string[] = [];

            if (context && context.totalChunks > 0) {
                const systemPrompt = 'You are a helpful assistant that answers questions based on the user\'s personal knowledge vault.' + historySection;
                prompt = this.ragService.buildRAGPrompt(
                    query,
                    context,
                    systemPrompt
                );
                sources = context.sources;
            } else {
                if (hasEmbeddings) {
                    this.addSystemMessage(this.plugin.t.modals.chatWithVault.noVaultContextFallback);
                }
                prompt = `You are a helpful assistant. The user has a personal knowledge vault but no matching content was found for their query. Answer from your general knowledge.${historySection}\n\nUser question: ${query}`;
            }

            // Get response from LLM via centralized facade
            const response = await summarizeText(pluginContext(this.plugin), prompt);

            if (response.success && response.content) {
                this.addMessage('assistant', response.content, sources.length > 0 ? sources : undefined);
            } else {
                this.addMessage('assistant', this.plugin.t.modals.chatWithVault.responseFailed);
            }
        } catch (error) {
            console.error('Chat error:', error);
            const errorMsg = this.plugin.t.modals.chatWithVault.errorOccurred
                .replace('{error}', (error as any).message);
            this.addMessage('assistant', errorMsg);
        } finally {
            this.isProcessing = false;
            this.sendButton.setButtonText(this.plugin.t.modals.chatWithVault.sendButton);
            this.sendButton.setDisabled(false);
        }
    }

    private handleClear(): void {
        this.messages = [];
        this.addSystemMessage(this.plugin.t.modals.chatWithVault.chatCleared);
        this.renderMessages();
    }

    private async handleExport(): Promise<void> {
        const t = this.plugin.t.modals.chatWithVault;
        const nonSystemMessages = this.messages.filter(m => m.role !== 'system');
        if (nonSystemMessages.length === 0) {
            new Notice(t.exportEmpty);
            return;
        }

        const folder = await this.promptExportFolder();
        if (!folder) return;

        // Resolve typed folder through plugin path system so subfolders nest correctly
        const resolvedFolder = resolvePluginPath(this.plugin.settings, folder, 'Chats');

        try {
            await ensureFolderExists(this.app.vault, resolvedFolder);

            const now = new Date();
            const dateStr = now.toISOString().slice(0, 10);
            const timeStr = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
            const fileName = `Chat-${dateStr}-${timeStr}.md`;
            const filePath = await getAvailableFilePath(this.app.vault, resolvedFolder, fileName);

            const markdown = formatExportMarkdown(this.messages);

            await this.app.vault.create(filePath, markdown);
            new Notice(t.exportSuccess.replace('{path}', filePath));
        } catch (error) {
            console.error('Chat export error:', error);
            new Notice(t.exportFailed.replace('{error}', (error as Error).message));
        }
    }

    private promptExportFolder(): Promise<string | null> {
        const t = this.plugin.t.modals.chatWithVault;
        return new Promise((resolve) => {
            const modal = new Modal(this.app);
            modal.titleEl.setText(t.exportTitle);
            let resolved = false;

            let folderValue = getChatExportFullPath(this.plugin.settings);

            new Setting(modal.contentEl)
                .setName(t.exportFolderLabel)
                .addText(text => {
                    text.setValue(folderValue)
                        .onChange(v => { folderValue = v.trim(); });
                    text.inputEl.style.width = '100%';
                });

            new Setting(modal.contentEl)
                .addButton(btn => {
                    btn.setButtonText(t.exportConfirmButton)
                        .setCta()
                        .onClick(() => {
                            resolved = true;
                            modal.close();
                            resolve(folderValue || null);
                        });
                })
                .addButton(btn => {
                    btn.setButtonText(this.plugin.t.modals.cancel)
                        .onClick(() => {
                            resolved = true;
                            modal.close();
                            resolve(null);
                        });
                });

            const origOnClose = modal.onClose.bind(modal);
            modal.onClose = () => {
                origOnClose();
                if (!resolved) resolve(null);
            };

            modal.open();
        });
    }

    private addSystemMessage(content: string): void {
        this.messages.push({
            role: 'system',
            content,
            timestamp: Date.now()
        });
        this.renderMessages();
    }

    private addMessage(role: 'user' | 'assistant', content: string, sources?: string[]): void {
        this.messages.push({
            role,
            content,
            timestamp: Date.now(),
            sources
        });
        this.renderMessages();
    }

    private renderMessages(): void {
        // Reset Component lifecycle to prevent listener accumulation
        this.component?.unload();
        this.component = new Component();
        this.component.load();

        this.chatContainer.empty();

        for (const message of this.messages) {
            const messageEl = this.chatContainer.createEl('div', {
                cls: `chat-message chat-message-${message.role}`
            });

            const contentEl = messageEl.createEl('div', {
                cls: 'chat-message-content'
            });

            if (message.role === 'assistant') {
                MarkdownRenderer.render(this.app, message.content, contentEl, '', this.component);
            } else {
                contentEl.textContent = message.content;
            }

            // Add sources if present
            if (message.sources && message.sources.length > 0) {
                const sourcesEl = messageEl.createEl('div', {
                    cls: 'chat-message-sources'
                });
                sourcesEl.createEl('strong', { text: this.plugin.t.modals.chatWithVault.sourcesLabel });

                const sourcesList = sourcesEl.createEl('ul');
                for (const source of message.sources) {
                    const sourceItem = sourcesList.createEl('li');
                    const sourceLink = sourceItem.createEl('a', {
                        text: source,
                        cls: 'internal-link'
                    });
                    sourceLink.addEventListener('click', async (e) => {
                        e.preventDefault();
                        const file = this.app.vault.getFileByPath(source);
                        if (file) {
                            await this.app.workspace.getLeaf().openFile(file);
                            this.close();
                        }
                    });
                }
            }

            const timeEl = messageEl.createEl('div', {
                cls: 'chat-message-time',
                text: new Date(message.timestamp).toLocaleTimeString()
            });
        }

        // Scroll to bottom
        this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
    }

    onClose(): void {
        this.component?.unload();
        const { contentEl } = this;
        contentEl.empty();
    }
}

/**
 * Register chat with vault commands
 */
export function registerChatCommands(plugin: AIOrganiserPlugin): void {
    // Chat with vault command
    plugin.addCommand({
        id: 'chat-with-vault',
        name: plugin.t.commands.chatWithVault,
        callback: async () => {
            if (!plugin.settings.enableSemanticSearch) {
                new Notice(plugin.t.messages.semanticSearchNotEnabledDetailed);
                return;
            }

            if (!plugin.vectorStore) {
                new Notice(plugin.t.messages.vectorStoreNotInitialized);
                return;
            }

            // Check if index exists
            const metadata = await plugin.vectorStore.getMetadata();
            if (metadata.totalDocuments === 0) {
                new Notice(plugin.t.messages.noDocumentsIndexedYet);
                return;
            }

            const modal = new ChatWithVaultModal(plugin.app, plugin);
            modal.open();
        }
    });

    // Ask about current note
    plugin.addCommand({
        id: 'ask-about-current-note',
        name: plugin.t.commands.askAboutCurrentNote,
        editorCallback: async (editor, view) => {
            if (!plugin.vectorStore || !plugin.settings.enableSemanticSearch) {
                new Notice(plugin.t.messages.semanticSearchNotEnabledDetailed);
                return;
            }

            const file = view.file;
            if (!file) return;

            // Get selection or full content
            const selection = editor.getSelection();
            const content = selection || editor.getValue();

            if (!content.trim()) {
                new Notice(plugin.t.messages.noContentToAnalyzeDetailed);
                return;
            }

            // Prompt for question
            const question = await promptForQuestion(plugin);
            if (!question) return;

            try {
                const ragService = new RAGService(
                    plugin.vectorStore,
                    plugin.settings,
                    plugin.embeddingService
                );

                // Build query from content and question
                const query = `Context: ${content.substring(0, 500)}\n\nQuestion: ${question}`;

                const statusNotice = new Notice(plugin.t.messages.searchingForRelevantInfo, 0);
                const context = await ragService.retrieveContext(query, file, {
                    excludeCurrentFile: false,
                    maxChunks: 3
                });
                statusNotice.hide();

                if (context.totalChunks === 0) {
                    new Notice(plugin.t.messages.noRelevantInformationFound);
                    return;
                }

                // Build RAG prompt
                const ragPrompt = ragService.buildRAGPrompt(
                    question,
                    context,
                    `You are answering a question about a specific note. The user has selected this content:\n\n${content.substring(0, 1000)}`
                );

                // Get response via centralized LLM facade
                const response = await summarizeText(pluginContext(plugin), ragPrompt);

                if (response.success && response.content) {
                    // Insert response at cursor
                    const answer = `\n\n**Q: ${question}**\n\n${response.content}${ragService.formatSources(context.sources)}\n\n`;
                    editor.replaceSelection(answer);
                    ensureNoteStructureIfEnabled(editor, plugin.settings);
                    new Notice(plugin.t.messages.answerInserted);
                } else {
                    new Notice(plugin.t.messages.failedToGenerateAnswer);
                }
            } catch (error) {
                new Notice(plugin.t.messages.semanticSearchDisabled + ': ' + (error as any).message);
            }
        }
    });

    // Chat about highlights
    plugin.addCommand({
        id: 'chat-about-highlights',
        name: plugin.t.commands.chatAboutHighlights || 'Chat about highlights',
        icon: 'message-square-quote',
        editorCallback: (editor, view) => {
            const file = view.file;
            if (!file) return;

            const content = editor.getValue();
            if (!content.trim()) {
                new Notice(plugin.t.highlightChat?.noContent || 'Note is empty');
                return;
            }

            const selection = editor.getSelection();
            const modal = new HighlightChatModal(plugin.app, plugin, {
                noteContent: content,
                noteTitle: file.basename,
                editorSelection: selection || undefined
            });
            modal.open();
        }
    });

    // Find and insert related notes
    plugin.addCommand({
        id: 'insert-related-notes',
        name: plugin.t.commands.insertRelatedNotes,
        editorCallback: async (editor, view) => {
            if (!plugin.vectorStore || !plugin.settings.enableSemanticSearch) {
                new Notice(plugin.t.messages.semanticSearchNotEnabledDetailed);
                return;
            }

            const file = view.file;
            if (!file) return;

            try {
                const content = editor.getValue();
                const ragService = new RAGService(
                    plugin.vectorStore,
                    plugin.settings,
                    plugin.embeddingService
                );

                const statusNotice = new Notice(plugin.t.messages.findingRelatedNotesDetailed, 0);
                const related = await ragService.getRelatedNotes(
                    file,
                    content,
                    plugin.settings.relatedNotesCount || 15
                );
                statusNotice.hide();

                if (related.length === 0) {
                    new Notice(plugin.t.messages.noRelatedNotes);
                    return;
                }

                // Format related notes
                const relatedSection = [
                    '\n\n---\n',
                    '## Related Notes\n',
                    ...related.map(r =>
                        `- [[${r.document.filePath}|${r.document.metadata.title}]] (related)`
                    ),
                    '\n'
                ].join('\n');

                // Insert at cursor or end
                const cursor = editor.getCursor();
                editor.replaceRange(relatedSection, cursor);
                ensureNoteStructureIfEnabled(editor, plugin.settings);
                new Notice(plugin.t.messages.insertedRelatedNotes.replace('{count}', String(related.length)));
            } catch (error) {
                new Notice(plugin.t.messages.semanticSearchDisabled + ': ' + (error as any).message);
            }
        }
    });
}

/**
 * Helper to prompt for a question
 */
async function promptForQuestion(plugin: AIOrganiserPlugin): Promise<string | null> {
    return new Promise((resolve) => {
        const modal = new Modal(plugin.app);
        modal.titleEl.setText(plugin.t.modals.chatWithVault.askQuestion);

        let question = '';

        new Setting(modal.contentEl)
            .setName(plugin.t.modals.chatWithVault.yourQuestion)
            .addText(text => {
                text.setPlaceholder(plugin.t.modals.chatWithVault.questionPlaceholder)
                    .onChange(value => {
                        question = value;
                    });
                text.inputEl.style.width = '100%';
                text.inputEl.focus();
            });

        new Setting(modal.contentEl)
            .addButton(btn => {
                btn.setButtonText(plugin.t.modals.chatWithVault.askButton)
                    .setCta()
                    .onClick(() => {
                        modal.close();
                        resolve(question.trim() || null);
                    });
            })
            .addButton(btn => {
                btn.setButtonText(plugin.t.modals.cancel)
                    .onClick(() => {
                        modal.close();
                        resolve(null);
                    });
            });

        modal.open();
    });
}
