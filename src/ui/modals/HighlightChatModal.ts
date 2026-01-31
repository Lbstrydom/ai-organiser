/**
 * Highlight Chat Modal
 * Two-phase modal for selecting passages and chatting about them.
 */

import { App, Modal, Notice, TextAreaComponent, ButtonComponent } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import {
    ContentBlock,
    splitIntoBlocks,
    stripHighlightMarkup
} from '../../utils/highlightExtractor';
import {
    buildHighlightChatPrompt,
    buildInsertSummaryPrompt,
    buildInsertAnswerPrompt,
    HighlightChatMessage
} from '../../services/prompts/highlightChatPrompts';
import { summarizeText, pluginContext } from '../../services/llmFacade';

export interface HighlightChatOptions {
    noteContent: string;
    noteTitle: string;
    filePath: string;
    editorSelection?: string;
}

export class HighlightChatModal extends Modal {
    private readonly plugin: AIOrganiserPlugin;
    private readonly options: HighlightChatOptions;
    private phase: 'select' | 'chat' = 'select';
    private blocks: ContentBlock[] = [];
    private readonly selectedIndices = new Set<number>();
    private readonly messages: HighlightChatMessage[] = [];
    private selectedPassageTexts: string[] = [];
    private isProcessing = false;

    private chatContainer?: HTMLElement;
    private inputArea?: TextAreaComponent;
    private sendButton?: ButtonComponent;
    private allowBack = false;

    constructor(app: App, plugin: AIOrganiserPlugin, options: HighlightChatOptions) {
        super(app);
        this.plugin = plugin;
        this.options = options;
    }

    onOpen(): void {
        this.contentEl.empty();
        this.contentEl.addClass('ai-organiser-modal', 'ai-organiser-highlight-chat-modal');

        if (this.options.editorSelection?.trim()) {
            this.selectedPassageTexts = [this.options.editorSelection.trim()];
            this.phase = 'chat';
            this.allowBack = false;
            this.renderChatPhase();
        } else {
            this.blocks = splitIntoBlocks(this.options.noteContent);
            this.preSelectHighlightedBlocks();
            this.phase = 'select';
            this.allowBack = true;
            this.renderSelectionPhase();
        }
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private preSelectHighlightedBlocks(): void {
        this.blocks.forEach((block, index) => {
            if (block.hasHighlight) {
                this.selectedIndices.add(index);
            }
        });
    }

    private renderSelectionPhase(): void {
        const t = this.plugin.t.highlightChat;
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: t?.title || 'Chat About Highlights' });
        contentEl.createEl('p', { text: t?.selectPassages || 'Select passages to discuss:' });

        const listContainer = contentEl.createDiv({ cls: 'ai-organiser-hc-container' });

        this.blocks.forEach((block, index) => {
            const row = listContainer.createDiv({ cls: 'ai-organiser-hc-block' });
            if (block.hasHighlight) {
                row.addClass('ai-organiser-hc-block-highlighted');
            }

            const checkbox = row.createEl('input', { type: 'checkbox' });
            checkbox.checked = this.selectedIndices.has(index);
            checkbox.addEventListener('click', (event) => {
                event.stopPropagation();
            });
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) {
                    this.selectBlock(index);
                } else {
                    this.deselectBlock(index);
                }
                updateSelectionSummary();
            });

            const typeEl = row.createDiv({ cls: 'ai-organiser-hc-block-type' });
            typeEl.setText(block.type);

            const textEl = row.createDiv({ cls: 'ai-organiser-hc-block-text' });
            if (block.type === 'code') {
                textEl.addClass('ai-organiser-hc-block-code');
            }
            textEl.setText(block.displayText || block.text);

            row.addEventListener('click', () => {
                const nextState = !this.selectedIndices.has(index);
                checkbox.checked = nextState;
                if (nextState) {
                    this.selectBlock(index);
                } else {
                    this.deselectBlock(index);
                }
                updateSelectionSummary();
            });
        });

        const summaryEl = contentEl.createDiv({ cls: 'ai-organiser-hc-selection-count' });
        const warningEl = contentEl.createDiv({ cls: 'ai-organiser-hc-selection-warning' });

        const startButton = new ButtonComponent(contentEl)
            .setButtonText(t?.startChat || 'Start Chat')
            .setCta()
            .onClick(() => {
                if (this.selectedIndices.size === 0) {
                    this.showNotice(t?.noPassagesSelected || 'Select at least one passage');
                    return;
                }
                this.selectedPassageTexts = this.getSelectedPassages();
                this.phase = 'chat';
                this.renderChatPhase();
            });

        const updateSelectionSummary = () => {
            const passages = this.getSelectedPassages();
            const chars = passages.reduce((total, passage) => total + passage.length, 0);
            const tokenEstimate = chars / 4 / 1000;
            const tokenLabel = Number.isFinite(tokenEstimate)
                ? tokenEstimate.toFixed(1)
                : '0.0';
            summaryEl.setText(
                (t?.selected || 'Selected: {count} passages (~{tokens}k tokens)')
                    .replace('{count}', String(this.selectedIndices.size))
                    .replace('{tokens}', tokenLabel)
            );

            if (this.selectedIndices.size === 0) {
                startButton.setDisabled(true);
                warningEl.setText(t?.noPassagesSelected || 'Select at least one passage');
            } else {
                startButton.setDisabled(false);
                warningEl.setText('');
            }
        };

        updateSelectionSummary();
    }

    private renderChatPhase(): void {
        const t = this.plugin.t.highlightChat;
        const { contentEl } = this;
        contentEl.empty();

        const header = contentEl.createDiv({ cls: 'ai-organiser-hc-header' });
        header.createEl('h2', { text: t?.title || 'Chat About Highlights' });

        if (this.allowBack) {
            new ButtonComponent(header)
                .setButtonText(t?.back || 'Back to selection')
                .onClick(() => {
                    this.phase = 'select';
                    this.renderSelectionPhase();
                });
        }

        const passageSummary = contentEl.createEl('details', { cls: 'ai-organiser-hc-passage-summary' });
        const summaryLabel = (t?.passagesSummary || '{count} passages selected')
            .replace('{count}', String(this.selectedPassageTexts.length));
        passageSummary.createEl('summary', { text: summaryLabel });

        const passageList = passageSummary.createEl('div', { cls: 'ai-organiser-hc-passage-list' });
        this.selectedPassageTexts.forEach((passage, index) => {
            const entry = passageList.createDiv({ cls: 'ai-organiser-hc-passage-item' });
            entry.createEl('strong', { text: `Passage ${index + 1}` });
            entry.createEl('div', { text: passage });
        });

        this.chatContainer = contentEl.createDiv({ cls: 'ai-organiser-hc-chat-container' });
        this.renderMessages();

        const inputRow = contentEl.createDiv({ cls: 'ai-organiser-hc-input-row' });
        this.inputArea = new TextAreaComponent(inputRow);
        this.inputArea
            .setPlaceholder(t?.placeholder || 'Ask a question about the selected passages...')
            .then(text => {
                text.inputEl.rows = 3;
                text.inputEl.addClass('ai-organiser-hc-input');
                text.inputEl.addEventListener('keydown', (event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        this.handleSend();
                    }
                });
            });

        this.sendButton = new ButtonComponent(inputRow)
            .setButtonText(t?.send || 'Send')
            .setCta()
            .onClick(() => this.handleSend());

        const actionsRow = contentEl.createDiv({ cls: 'ai-organiser-hc-actions' });
        const insertSummaryButton = new ButtonComponent(actionsRow)
            .setButtonText(t?.insertSummary || 'Insert Summary')
            .onClick(() => this.handleInsertSummary());

        const insertAnswerButton = new ButtonComponent(actionsRow)
            .setButtonText(t?.insertAnswer || 'Insert Last Answer')
            .onClick(() => this.handleInsertAnswer());

        if (t?.insertSummaryDesc) {
            insertSummaryButton.setTooltip(t.insertSummaryDesc);
        }
        if (t?.insertAnswerDesc) {
            insertAnswerButton.setTooltip(t.insertAnswerDesc);
        }

        const editor = this.app.workspace.activeEditor?.editor;
        if (!editor) {
            insertSummaryButton.setDisabled(true);
            insertAnswerButton.setDisabled(true);
        }
    }

    private renderMessages(): void {
        if (!this.chatContainer) return;
        this.chatContainer.empty();

        for (const message of this.messages) {
            const messageEl = this.chatContainer.createDiv({
                cls: `ai-organiser-hc-message ai-organiser-hc-message-${message.role}`
            });
            messageEl.createDiv({ text: message.content });
        }

        this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
    }

    private selectBlock(index: number): void {
        this.selectedIndices.add(index);
    }

    private deselectBlock(index: number): void {
        this.selectedIndices.delete(index);
    }

    private getSelectedPassages(): string[] {
        return this.blocks
            .filter((_block, index) => this.selectedIndices.has(index))
            .map(block => this.normalizePassage(block.text))
            .filter(text => text.length > 0);
    }

    private normalizePassage(text: string): string {
        const stripped = stripHighlightMarkup(text).trim();
        return stripped.replaceAll(/\s+\n/g, '\n').trim();
    }

    private async handleSend(): Promise<void> {
        if (this.isProcessing || !this.inputArea || !this.sendButton) return;

        const question = this.inputArea.getValue().trim();
        if (!question) return;

        this.inputArea.setValue('');
        this.addMessage({ role: 'user', content: question });
        this.setProcessing(true);

        try {
            const history = this.messages.slice(0, -1);
            const prompt = buildHighlightChatPrompt(
                question,
                this.selectedPassageTexts,
                this.options.noteTitle,
                history
            );

            const response = await summarizeText(pluginContext(this.plugin), prompt);
            if (response.success && response.content) {
                this.addMessage({ role: 'assistant', content: response.content });
            } else {
                this.addMessage({
                    role: 'assistant',
                    content: this.plugin.t.highlightChat?.errorOccurred
                        ? this.plugin.t.highlightChat.errorOccurred.replace('{error}', 'No response')
                        : 'Error: No response'
                });
            }
        } catch (error) {
            const errorMessage = (error as Error).message || 'Unknown error';
            this.addMessage({
                role: 'assistant',
                content: this.plugin.t.highlightChat?.errorOccurred
                    ? this.plugin.t.highlightChat.errorOccurred.replace('{error}', errorMessage)
                    : `Error: ${errorMessage}`
            });
        } finally {
            this.setProcessing(false);
        }
    }

    private async handleInsertSummary(): Promise<void> {
        if (this.isProcessing) return;

        const editor = this.app.workspace.activeEditor?.editor;
        if (!editor) {
            this.showNotice(this.plugin.t.highlightChat?.noEditor || 'No active editor for insertion');
            return;
        }

        this.setProcessing(true);
        try {
            const prompt = buildInsertSummaryPrompt(
                this.selectedPassageTexts,
                this.messages,
                this.options.noteTitle
            );
            const response = await summarizeText(pluginContext(this.plugin), prompt);
            if (response.success && response.content) {
                editor.replaceSelection(response.content);
                this.showNotice(this.plugin.t.highlightChat?.summaryInserted || 'Summary inserted into note');
            } else {
                this.showNotice(this.plugin.t.highlightChat?.errorOccurred
                    ? this.plugin.t.highlightChat.errorOccurred.replace('{error}', 'No response')
                    : 'Error: No response');
            }
        } catch (error) {
            const errorMessage = (error as Error).message || 'Unknown error';
            this.showNotice(this.plugin.t.highlightChat?.errorOccurred
                ? this.plugin.t.highlightChat.errorOccurred.replace('{error}', errorMessage)
                : `Error: ${errorMessage}`
            );
        } finally {
            this.setProcessing(false);
        }
    }

    private async handleInsertAnswer(): Promise<void> {
        if (this.isProcessing) return;

        const editor = this.app.workspace.activeEditor?.editor;
        if (!editor) {
            this.showNotice(this.plugin.t.highlightChat?.noEditor || 'No active editor for insertion');
            return;
        }

        const lastExchange = this.getLastExchange();
        if (!lastExchange) {
            this.showNotice(this.plugin.t.highlightChat?.noAnswerYet || 'Ask a question first');
            return;
        }

        this.setProcessing(true);
        try {
            const prompt = buildInsertAnswerPrompt(
                lastExchange.question,
                lastExchange.answer,
                this.selectedPassageTexts,
                this.options.noteTitle
            );
            const response = await summarizeText(pluginContext(this.plugin), prompt);
            if (response.success && response.content) {
                editor.replaceSelection(response.content);
                this.showNotice(this.plugin.t.highlightChat?.answerInserted || 'Answer inserted into note');
            } else {
                this.showNotice(this.plugin.t.highlightChat?.errorOccurred
                    ? this.plugin.t.highlightChat.errorOccurred.replace('{error}', 'No response')
                    : 'Error: No response');
            }
        } catch (error) {
            const errorMessage = (error as Error).message || 'Unknown error';
            this.showNotice(this.plugin.t.highlightChat?.errorOccurred
                ? this.plugin.t.highlightChat.errorOccurred.replace('{error}', errorMessage)
                : `Error: ${errorMessage}`
            );
        } finally {
            this.setProcessing(false);
        }
    }

    private getLastExchange(): { question: string; answer: string } | null {
        for (let i = this.messages.length - 1; i >= 1; i -= 1) {
            const message = this.messages[i];
            const previous = this.messages[i - 1];
            if (message.role === 'assistant' && previous.role === 'user') {
                return { question: previous.content, answer: message.content };
            }
        }
        return null;
    }

    private addMessage(message: HighlightChatMessage): void {
        this.messages.push(message);
        this.renderMessages();
    }

    private setProcessing(isProcessing: boolean): void {
        this.isProcessing = isProcessing;
        if (!this.sendButton || !this.inputArea) return;

        if (isProcessing) {
            this.sendButton.setButtonText(this.plugin.t.highlightChat?.thinking || 'Thinking...');
            this.sendButton.setDisabled(true);
            this.inputArea.setDisabled(true);
        } else {
            this.sendButton.setButtonText(this.plugin.t.highlightChat?.send || 'Send');
            this.sendButton.setDisabled(false);
            this.inputArea.setDisabled(false);
        }
    }

    private showNotice(message: string): Notice {
        return new Notice(message);
    }
}
