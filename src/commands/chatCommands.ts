/**
 * Chat with Vault Commands
 * Interactive chat using RAG (Retrieval-Augmented Generation)
 */

import { Notice, Modal, App, Setting, TextAreaComponent, ButtonComponent } from 'obsidian';
import AIOrganiserPlugin from '../main';
import { RAGService, RAGContext } from '../services/ragService';

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

    constructor(app: App, plugin: AIOrganiserPlugin) {
        super(app);
        this.plugin = plugin;
        
        if (!plugin.vectorStore) {
            throw new Error('Vector store not initialized');
        }
        
        this.ragService = new RAGService(plugin.vectorStore, plugin.settings);
        this.titleEl.setText('Chat with Vault');
    }

    async onOpen(): Promise<void> {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('chat-with-vault-modal');

        // Add intro message
        this.addSystemMessage(
            'Ask me anything about your vault! I\'ll search for relevant notes and provide answers based on your content.'
        );

        // Chat container (scrollable)
        this.chatContainer = contentEl.createEl('div', {
            cls: 'chat-container'
        });
        this.renderMessages();

        // Input area container
        const inputContainer = contentEl.createEl('div', {
            cls: 'chat-input-container'
        });

        // Text input
        const inputSetting = new Setting(inputContainer)
            .setClass('chat-input-setting');
        
        this.inputArea = new TextAreaComponent(inputSetting.controlEl);
        this.inputArea
            .setPlaceholder('Ask a question about your vault...')
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
            .setButtonText('Send')
            .onClick(() => this.handleSend());

        new ButtonComponent(buttonContainer)
            .setButtonText('Clear')
            .onClick(() => this.handleClear());
    }

    private async handleSend(): Promise<void> {
        if (this.isProcessing) return;

        const query = this.inputArea.getValue().trim();
        if (!query) return;

        // Clear input
        this.inputArea.setValue('');
        this.isProcessing = true;
        this.sendButton.setButtonText('Thinking...');
        this.sendButton.setDisabled(true);

        // Add user message
        this.addMessage('user', query);

        try {
            // Retrieve context from vector store
            const statusNotice = new Notice('Searching vault...', 0);
            const context = await this.ragService.retrieveContext(query);
            statusNotice.hide();

            if (context.totalChunks === 0) {
                this.addMessage('assistant', 
                    'I couldn\'t find relevant information in your vault to answer this question. Try asking something else or make sure your vault is indexed.'
                );
                return;
            }

            // Show context sources
            new Notice(`Found ${context.totalChunks} relevant chunks from ${context.sources.length} notes`, 3000);

            // Build RAG prompt
            const ragPrompt = this.ragService.buildRAGPrompt(
                query,
                context,
                'You are a helpful assistant that answers questions based on the user\'s personal knowledge vault.'
            );

            // Get response from LLM
            // Use summarizeText which exists on concrete implementations
            const llmService = this.plugin.llmService as any;
            const response = await llmService.summarizeText(ragPrompt);

            if (response.success && response.content) {
                // Add assistant response with sources
                this.addMessage('assistant', response.content, context.sources);
            } else {
                this.addMessage('assistant', 
                    'Sorry, I encountered an error generating a response. Please try again.'
                );
            }
        } catch (error) {
            console.error('Chat error:', error);
            this.addMessage('assistant',
                'Sorry, an error occurred: ' + (error as any).message
            );
        } finally {
            this.isProcessing = false;
            this.sendButton.setButtonText('Send');
            this.sendButton.setDisabled(false);
        }
    }

    private handleClear(): void {
        this.messages = [];
        this.addSystemMessage(
            'Chat cleared. Ask me anything about your vault!'
        );
        this.renderMessages();
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
        this.chatContainer.empty();

        for (const message of this.messages) {
            const messageEl = this.chatContainer.createEl('div', {
                cls: `chat-message chat-message-${message.role}`
            });

            const contentEl = messageEl.createEl('div', {
                cls: 'chat-message-content'
            });
            contentEl.textContent = message.content;

            // Add sources if present
            if (message.sources && message.sources.length > 0) {
                const sourcesEl = messageEl.createEl('div', {
                    cls: 'chat-message-sources'
                });
                sourcesEl.createEl('strong', { text: 'Sources:' });
                
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
        name: 'Chat with Vault (RAG)',
        callback: async () => {
            if (!plugin.settings.enableSemanticSearch) {
                new Notice('Semantic search is not enabled. Enable it in settings.');
                return;
            }

            if (!plugin.vectorStore) {
                new Notice('Vector store not initialized. Please try again in a moment.');
                return;
            }

            // Check if index exists
            const metadata = await plugin.vectorStore.getMetadata();
            if (metadata.totalDocuments === 0) {
                new Notice('No documents indexed yet. Run "Index entire vault" first.');
                return;
            }

            const modal = new ChatWithVaultModal(plugin.app, plugin);
            modal.open();
        }
    });

    // Ask about current note
    plugin.addCommand({
        id: 'ask-about-current-note',
        name: 'Ask Question About Current Note',
        editorCallback: async (editor, view) => {
            if (!plugin.vectorStore || !plugin.settings.enableSemanticSearch) {
                new Notice('Semantic search is not enabled.');
                return;
            }

            const file = view.file;
            if (!file) return;

            // Get selection or full content
            const selection = editor.getSelection();
            const content = selection || editor.getValue();

            if (!content.trim()) {
                new Notice('No content to analyze');
                return;
            }

            // Prompt for question
            const question = await promptForQuestion(plugin);
            if (!question) return;

            try {
                const ragService = new RAGService(plugin.vectorStore, plugin.settings);
                
                // Build query from content and question
                const query = `Context: ${content.substring(0, 500)}\n\nQuestion: ${question}`;
                
                const statusNotice = new Notice('Searching for relevant information...', 0);
                const context = await ragService.retrieveContext(query, file, {
                    excludeCurrentFile: false,
                    maxChunks: 3
                });
                statusNotice.hide();

                if (context.totalChunks === 0) {
                    new Notice('No relevant information found');
                    return;
                }

                // Build RAG prompt
                const ragPrompt = ragService.buildRAGPrompt(
                    question,
                    context,
                    `You are answering a question about a specific note. The user has selected this content:\n\n${content.substring(0, 1000)}`
                );

                // Get response
                // Use summarizeText which exists on concrete implementations
                const llmService = plugin.llmService as any;
                const response = await llmService.summarizeText(ragPrompt);

                if (response.success && response.content) {
                    // Insert response at cursor
                    const answer = `\n\n**Q: ${question}**\n\n${response.content}${ragService.formatSources(context.sources)}\n\n`;
                    editor.replaceSelection(answer);
                    new Notice('Answer inserted');
                } else {
                    new Notice('Failed to generate answer');
                }
            } catch (error) {
                new Notice('Error: ' + (error as any).message);
            }
        }
    });

    // Find and insert related notes
    plugin.addCommand({
        id: 'insert-related-notes',
        name: 'Insert Related Notes',
        editorCallback: async (editor, view) => {
            if (!plugin.vectorStore || !plugin.settings.enableSemanticSearch) {
                new Notice('Semantic search is not enabled.');
                return;
            }

            const file = view.file;
            if (!file) return;

            try {
                const content = editor.getValue();
                const ragService = new RAGService(plugin.vectorStore, plugin.settings);
                
                const statusNotice = new Notice('Finding related notes...', 0);
                const related = await ragService.getRelatedNotes(file, content, 5);
                statusNotice.hide();

                if (related.length === 0) {
                    new Notice('No related notes found');
                    return;
                }

                // Format related notes
                const relatedSection = [
                    '\n\n---\n',
                    '## Related Notes\n',
                    ...related.map(r => 
                        `- [[${r.document.filePath}|${r.document.metadata.title}]] (${(r.score * 100).toFixed(0)}% similar)`
                    ),
                    '\n'
                ].join('\n');

                // Insert at cursor or end
                const cursor = editor.getCursor();
                editor.replaceRange(relatedSection, cursor);
                new Notice(`Inserted ${related.length} related notes`);
            } catch (error) {
                new Notice('Error: ' + (error as any).message);
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
        modal.titleEl.setText('Ask a Question');
        
        let question = '';
        
        new Setting(modal.contentEl)
            .setName('Your Question')
            .addText(text => {
                text.setPlaceholder('What would you like to know?')
                    .onChange(value => {
                        question = value;
                    });
                text.inputEl.style.width = '100%';
                text.inputEl.focus();
            });
        
        new Setting(modal.contentEl)
            .addButton(btn => {
                btn.setButtonText('Ask')
                    .setCta()
                    .onClick(() => {
                        modal.close();
                        resolve(question.trim() || null);
                    });
            })
            .addButton(btn => {
                btn.setButtonText('Cancel')
                    .onClick(() => {
                        modal.close();
                        resolve(null);
                    });
            });
        
        modal.open();
    });
}
