import { ContentBlock, splitIntoBlocks, stripHighlightMarkup } from '../../utils/highlightExtractor';
import { buildHighlightChatPrompt } from '../../services/prompts/highlightChatPrompts';
import type { ChatModeHandler, ModalContext, ActionDescriptor, SendResult } from './ChatModeHandler';
import type { Translations } from '../../i18n/types';

export class HighlightModeHandler implements ChatModeHandler {
    readonly mode = 'highlight' as const;
    private blocks: ContentBlock[] = [];
    private readonly selectedIndices = new Set<number>();
    private selectedPassageTexts: string[] = [];
    private showAllBlocks = false;
    private selectionLocked = false;

    constructor(private readonly onSelectionChange?: () => void) {}

    isAvailable(ctx: ModalContext): boolean {
        if (ctx.options.editorSelection?.trim()) {
            return true;
        }

        const noteContent = ctx.options.noteContent || '';
        if (!noteContent.trim()) return false;

        this.blocks = splitIntoBlocks(noteContent);
        return this.blocks.some(b => b.hasHighlight);
    }

    unavailableReason(t: Translations): string {
        return t.modals.unifiedChat.highlightUnavailable;
    }

    getIntroMessage(t: Translations): string {
        return t.modals.unifiedChat.introHighlight;
    }

    getPlaceholder(t: Translations): string {
        return t.modals.unifiedChat.placeholderHighlight || t.modals.unifiedChat.placeholder;
    }

    renderContextPanel(container: HTMLElement, ctx: ModalContext): void {
        const t = ctx.plugin.t.modals.unifiedChat;
        const selection = ctx.options.editorSelection?.trim();

        if (selection) {
            this.selectionLocked = true;
            this.selectedPassageTexts = [selection];
            this.onSelectionChange?.();

            const summary = container.createEl('details', { cls: 'ai-organiser-chat-context-details' });
            summary.createEl('summary', {
                text: t.passagesSummary.replace('{count}', '1')
            });
            const list = summary.createEl('div', { cls: 'ai-organiser-chat-context-list' });
            const entry = list.createDiv({ cls: 'ai-organiser-chat-passage-block' });
            entry.createDiv({ cls: 'ai-organiser-chat-passage-text', text: selection });
            return;
        }

        const noteContent = ctx.options.noteContent || '';
        if (!noteContent.trim()) {
            container.createDiv({ cls: 'ai-organiser-chat-context-empty', text: t.noHighlightsFound });
            return;
        }

        if (this.blocks.length === 0) {
            this.blocks = splitIntoBlocks(noteContent);
        }

        if (!this.blocks.some(b => b.hasHighlight)) {
            container.createDiv({ cls: 'ai-organiser-chat-context-empty', text: t.noHighlightsFound });
            return;
        }

        if (this.selectedIndices.size === 0) {
            this.blocks.forEach((block, index) => {
                if (block.hasHighlight) this.selectedIndices.add(index);
            });
        }

        container.createDiv({ cls: 'ai-organiser-chat-context-title', text: t.selectPassages });

        const toggleRow = container.createDiv({ cls: 'ai-organiser-chat-context-toggle' });
        const toggleButton = toggleRow.createEl('button', {
            cls: 'mod-cta ai-organiser-chat-context-toggle-button',
            text: this.showAllBlocks ? t.showHighlightsOnly : t.showAll
        });
        toggleButton.addEventListener('click', () => {
            this.showAllBlocks = !this.showAllBlocks;
            if (!this.showAllBlocks) {
                const toRemove = Array.from(this.selectedIndices).filter(idx => !this.blocks[idx].hasHighlight);
                for (const idx of toRemove) {
                    this.selectedIndices.delete(idx);
                }
            }
            container.empty();
            this.renderContextPanel(container, ctx);
            this.updateSelectedPassages();
        });

        const displayBlocks = this.showAllBlocks
            ? this.blocks.map((b, i) => ({ block: b, originalIndex: i }))
            : this.blocks
                .map((b, i) => ({ block: b, originalIndex: i }))
                .filter(item => item.block.hasHighlight);

        const countLabel = t.showingCount
            .replace('{visible}', String(displayBlocks.length))
            .replace('{total}', String(this.blocks.length));
        toggleRow.createSpan({ text: countLabel, cls: 'ai-organiser-chat-context-count' });

        const listContainer = container.createDiv({ cls: 'ai-organiser-chat-passage-list' });

        for (const { block, originalIndex } of displayBlocks) {
            const isSelected = this.selectedIndices.has(originalIndex);
            const row = listContainer.createDiv({ cls: 'ai-organiser-chat-passage-block' });
            if (block.hasHighlight) row.addClass('ai-organiser-chat-passage-highlighted');
            if (isSelected) row.addClass('ai-organiser-chat-passage-selected');

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
                this.updateSelectedPassages();
            });

            const textEl = row.createDiv({ cls: 'ai-organiser-chat-passage-text' });
            if (block.type === 'code') {
                textEl.addClass('ai-organiser-chat-passage-code');
            }
            textEl.setText(block.displayText || block.text);

            const typeEl = row.createDiv({ cls: 'ai-organiser-chat-passage-type' });
            typeEl.setText(block.type);

            row.addEventListener('click', () => {
                if (this.selectedIndices.has(originalIndex)) {
                    checkbox.checked = false;
                    this.deselectBlock(originalIndex, row);
                } else {
                    checkbox.checked = true;
                    this.selectBlock(originalIndex, row);
                }
                this.updateSelectedPassages();
            });
        }

        const summaryEl = container.createDiv({ cls: 'ai-organiser-chat-selection-count' });
        const warningEl = container.createDiv({ cls: 'ai-organiser-chat-selection-warning' });

        const updateSummary = () => {
            const passages = this.getSelectedPassages();
            const chars = passages.reduce((total, passage) => total + passage.length, 0);
            const tokenEstimate = chars / 4 / 1000;
            const tokenLabel = Number.isFinite(tokenEstimate)
                ? tokenEstimate.toFixed(1)
                : '0.0';
            summaryEl.setText(
                t.selected
                    .replace('{count}', String(this.selectedIndices.size))
                    .replace('{tokens}', tokenLabel)
            );

            if (this.selectedIndices.size === 0) {
                warningEl.setText(t.noPassagesSelected);
            } else {
                warningEl.setText('');
            }
        };

        updateSummary();
        this.updateSelectedPassages();
    }

    async buildPrompt(query: string, history: string, ctx: ModalContext): Promise<SendResult> {
        const t = ctx.plugin.t.modals.unifiedChat;
        if (ctx.options.editorSelection?.trim()) {
            this.selectionLocked = true;
            this.selectedPassageTexts = [ctx.options.editorSelection.trim()];
        }

        this.updateSelectedPassages();

        if (this.selectedPassageTexts.length === 0) {
            return {
                prompt: '',
                systemNotice: t.noPassagesSelected
            };
        }

        const noteTitle = ctx.options.noteTitle || t.modeHighlight;
        return {
            prompt: buildHighlightChatPrompt(query, this.selectedPassageTexts, noteTitle, history)
        };
    }

    getActionDescriptors(t: Translations): ActionDescriptor[] {
        return [
            {
                id: 'insert-summary',
                labelKey: 'insertSummary',
                tooltipKey: 'insertSummaryDesc',
                isEnabled: this.selectedPassageTexts.length > 0
            }
        ];
    }

    getSelectedPassageTexts(): string[] {
        return [...this.selectedPassageTexts];
    }

    dispose(): void {
        this.selectedIndices.clear();
        this.selectedPassageTexts = [];
        this.blocks = [];
        this.showAllBlocks = false;
        this.selectionLocked = false;
    }

    private updateSelectedPassages(): void {
        if (this.selectionLocked) return;
        this.selectedPassageTexts = this.getSelectedPassages();
        this.onSelectionChange?.();
    }

    private selectBlock(index: number, row: HTMLElement): void {
        this.selectedIndices.add(index);
        row.addClass('ai-organiser-chat-passage-selected');
    }

    private deselectBlock(index: number, row: HTMLElement): void {
        this.selectedIndices.delete(index);
        row.removeClass('ai-organiser-chat-passage-selected');
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
}
