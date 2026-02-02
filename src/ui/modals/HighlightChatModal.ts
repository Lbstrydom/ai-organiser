/**
 * Highlight Chat Modal
 * Two-phase modal for selecting passages and chatting about them.
 */

import { App, Modal, Notice, TextAreaComponent, ButtonComponent, MarkdownRenderer, Component } from 'obsidian';
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
    editorSelection?: string;
}

export class HighlightChatModal extends Modal {
    private readonly plugin: AIOrganiserPlugin;
    private readonly options: HighlightChatOptions;
    private blocks: ContentBlock[] = [];
    private readonly selectedIndices = new Set<number>();
    private readonly messages: HighlightChatMessage[] = [];
    private selectedPassageTexts: string[] = [];
    private isProcessing = false;
    private showAllBlocks = false;
    private component?: Component;

    private chatContainer?: HTMLElement;
    private inputArea?: TextAreaComponent;
    private sendButton?: ButtonComponent;
    private insertAnswerButton?: ButtonComponent;
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
            this.allowBack = false;
            this.renderChatPhase();
        } else {
            this.blocks = splitIntoBlocks(this.options.noteContent);
            const hasHighlights = this.blocks.some(b => b.hasHighlight);

            if (!hasHighlights) {
                const t = this.plugin.t.highlightChat;
                new Notice(t?.noHighlightsFound || 'No highlights found in this note. Select text first, or add highlights using the Highlight command.');
                this.close();
                return;
            }

            this.preSelectHighlightedBlocks();
            this.allowBack = true;
            this.renderSelectionPhase();
        }
    }

    onClose(): void {
        this.component?.unload();
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

        // Build display blocks with originalIndex tracking
        const displayBlocks = this.showAllBlocks
            ? this.blocks.map((b, i) => ({ block: b, originalIndex: i }))
            : this.blocks
                .map((b, i) => ({ block: b, originalIndex: i }))
                .filter(item => item.block.hasHighlight);

        // Toggle button with count
        const toggleRow = contentEl.createDiv({ cls: 'ai-organiser-hc-toggle-row' });
        new ButtonComponent(toggleRow)
            .setButtonText(this.showAllBlocks
                ? (t?.showHighlightsOnly || 'Show highlights only')
                : (t?.showAllPassages || 'Show all passages'))
            .onClick(() => {
                this.showAllBlocks = !this.showAllBlocks;
                if (!this.showAllBlocks) {
                    // Auto-deselect non-highlighted blocks when filtering back
                    const toRemove = Array.from(this.selectedIndices).filter(idx => !this.blocks[idx].hasHighlight);
                    for (const idx of toRemove) {
                        this.selectedIndices.delete(idx);
                    }
                }
                this.renderSelectionPhase();
            });

        const countLabel = (t?.showingCount || 'Showing {visible} of {total} passages')
            .replace('{visible}', String(displayBlocks.length))
            .replace('{total}', String(this.blocks.length));
        toggleRow.createSpan({ text: countLabel, cls: 'ai-organiser-hc-showing-count' });

        const listContainer = contentEl.createDiv({ cls: 'ai-organiser-hc-container' });

        for (const { block, originalIndex } of displayBlocks) {
            const isSelected = this.selectedIndices.has(originalIndex);
            const row = listContainer.createDiv({ cls: 'ai-organiser-hc-block' });
            if (block.hasHighlight) {
                row.addClass('ai-organiser-hc-block-highlighted');
            }
            if (isSelected) {
                row.addClass('ai-organiser-hc-block-selected');
            }

            const checkbox = row.createEl('input', { type: 'checkbox' });
            checkbox.checked = isSelected;
            checkbox.addEventListener('click', (event) => {
                event.stopPropagation();
            });
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) {
                    this.selectBlock(originalIndex, row);
                } else {
                    this.deselectBlock(originalIndex, row);
                }
                updateSelectionSummary();
            });

            const textEl = row.createDiv({ cls: 'ai-organiser-hc-block-text' });
            if (block.type === 'code') {
                textEl.addClass('ai-organiser-hc-block-code');
            }
            textEl.setText(block.displayText || block.text);

            const typeEl = row.createDiv({ cls: 'ai-organiser-hc-block-type' });
            typeEl.setText(block.type);

            row.addEventListener('click', () => {
                if (this.selectedIndices.has(originalIndex)) {
                    checkbox.checked = false;
                    this.deselectBlock(originalIndex, row);
                } else {
                    checkbox.checked = true;
                    this.selectBlock(originalIndex, row);
                }
                updateSelectionSummary();
            });
        }

        const summaryEl = contentEl.createDiv({ cls: 'ai-organiser-hc-selection-count' });
        const warningEl = contentEl.createDiv({ cls: 'ai-organiser-hc-selection-warning' });

        const startButton = new ButtonComponent(contentEl)
            .setButtonText(t?.startChat || 'Start Chat')
            .setCta()
            .onClick(() => {
                if (this.selectedIndices.size === 0) {
                    this.notify(t?.noPassagesSelected || 'Select at least one passage');
                    return;
                }
                this.selectedPassageTexts = this.getSelectedPassages();
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
            const truncated = passage.length > 200 ? `${passage.slice(0, 200)}…` : passage;
            entry.createEl('div', { text: truncated });
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
            .setTooltip(t?.insertSummaryDesc || 'AI distills the conversation into a clean note section')
            .onClick(() => this.handleInsertSummary());

        this.insertAnswerButton = new ButtonComponent(actionsRow)
            .setButtonText(t?.insertAnswer || 'Insert Last Answer')
            .setTooltip(t?.insertAnswerDesc || 'Insert only the last AI response')
            .onClick(() => this.handleInsertAnswer());

        const editor = this.app.workspace.activeEditor?.editor;
        if (editor) {
            // Disable "Insert Last Answer" until a Q/A exchange exists
            this.updateInsertAnswerState();
        } else {
            const noEditorTip = t?.noEditor || 'No active editor for insertion';
            insertSummaryButton.setDisabled(true);
            insertSummaryButton.setTooltip(noEditorTip);
            this.insertAnswerButton.setDisabled(true);
            this.insertAnswerButton.setTooltip(noEditorTip);
        }
    }

    private renderMessages(): void {
        if (!this.chatContainer) return;

        // Reset Component lifecycle to prevent listener accumulation
        this.component?.unload();
        this.component = new Component();
        this.component.load();

        this.chatContainer.empty();

        if (this.messages.length === 0) {
            const t = this.plugin.t.highlightChat;
            const emptyEl = this.chatContainer.createDiv({ cls: 'ai-organiser-hc-empty-state' });
            emptyEl.setText(t?.placeholder || 'Ask a question about the selected passages...');
            return;
        }

        for (const message of this.messages) {
            const messageEl = this.chatContainer.createDiv({
                cls: `ai-organiser-hc-message ai-organiser-hc-message-${message.role}`
            });
            const roleLabel = message.role === 'user' ? 'You' : 'AI';
            messageEl.createEl('strong', { text: roleLabel, cls: 'ai-organiser-hc-message-role' });
            const contentDiv = messageEl.createDiv({ cls: 'ai-organiser-hc-message-content' });
            if (message.role === 'assistant') {
                MarkdownRenderer.render(this.app, message.content, contentDiv, '', this.component!);
            } else {
                contentDiv.textContent = message.content;
            }
        }

        this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
    }

    private selectBlock(index: number, row: HTMLElement): void {
        this.selectedIndices.add(index);
        row.addClass('ai-organiser-hc-block-selected');
    }

    private deselectBlock(index: number, row: HTMLElement): void {
        this.selectedIndices.delete(index);
        row.removeClass('ai-organiser-hc-block-selected');
    }

    private getSelectedPassages(): string[] {
        return this.blocks
            .filter((_block, index) => this.selectedIndices.has(index))
            .map(block => this.normalizePassage(block))
            .filter(text => text.length > 0);
    }

    private normalizePassage(block: ContentBlock): string {
        const text = block.type === 'code' ? block.text : stripHighlightMarkup(block.text);
        return text.replaceAll(/\s+\n/g, '\n').trim();
    }

    private async handleSend(): Promise<void> {
        if (this.isProcessing || !this.inputArea || !this.sendButton) return;

        const question = this.inputArea.getValue().trim();
        if (!question) return;

        this.inputArea.setValue('');
        this.addMessage({ role: 'user', content: question });
        this.setProcessing(true);

        try {
            // History excludes the just-added user message (sent separately in <question>)
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
                this.addMessage({ role: 'assistant', content: this.formatError('No response') });
            }
        } catch (error) {
            this.addMessage({ role: 'assistant', content: this.formatError((error as Error).message) });
        } finally {
            this.setProcessing(false);
            this.updateInsertAnswerState();
        }
    }

    private async handleInsertSummary(): Promise<void> {
        if (this.isProcessing) return;

        const editor = this.app.workspace.activeEditor?.editor;
        if (!editor) {
            this.notify(this.plugin.t.highlightChat?.noEditor || 'No active editor for insertion');
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
                this.notify(this.plugin.t.highlightChat?.summaryInserted || 'Summary inserted into note');
            } else {
                this.notify(this.formatError('No response'));
            }
        } catch (error) {
            this.notify(this.formatError((error as Error).message));
        } finally {
            this.setProcessing(false);
        }
    }

    private async handleInsertAnswer(): Promise<void> {
        if (this.isProcessing) return;

        const editor = this.app.workspace.activeEditor?.editor;
        if (!editor) {
            this.notify(this.plugin.t.highlightChat?.noEditor || 'No active editor for insertion');
            return;
        }

        const lastExchange = this.getLastExchange();
        if (!lastExchange) {
            this.notify(this.plugin.t.highlightChat?.noAnswerYet || 'Ask a question first');
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
                this.notify(this.plugin.t.highlightChat?.answerInserted || 'Answer inserted into note');
            } else {
                this.notify(this.formatError('No response'));
            }
        } catch (error) {
            this.notify(this.formatError((error as Error).message));
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
            this.insertAnswerButton?.setDisabled(true);
        } else {
            this.sendButton.setButtonText(this.plugin.t.highlightChat?.send || 'Send');
            this.sendButton.setDisabled(false);
            this.inputArea.setDisabled(false);
        }
    }

    private updateInsertAnswerState(): void {
        if (!this.insertAnswerButton) return;
        const hasExchange = this.getLastExchange() !== null;
        const hasEditor = !!this.app.workspace.activeEditor?.editor;
        this.insertAnswerButton.setDisabled(!hasExchange || !hasEditor);
    }

    private formatError(message = 'Unknown error'): string {
        const t = this.plugin.t.highlightChat;
        return t?.errorOccurred
            ? t.errorOccurred.replace('{error}', message)
            : `Error: ${message}`;
    }

    /** Obsidian Notice constructor is fire-and-forget (side effect). */
    private notify(message: string): Notice {
        return new Notice(message);
    }
}
