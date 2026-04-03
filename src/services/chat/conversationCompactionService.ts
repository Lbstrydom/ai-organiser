import { getMaxContentCharsForModel } from '../tokenLimits';
import type { ChatExportMessage } from '../../utils/chatExportUtils';
import { buildCompactionPrompt } from '../prompts/chatPrompts';

export const RECENT_KEEP_COUNT = 6;
export const HISTORY_BUDGET_FRACTION = 0.4;

export interface CompactionContext {
    provider: string;
    model: string;
    /** LLM call function — injected to avoid circular dependency */
    summarize: (prompt: string) => Promise<{ success: boolean; content?: string }>;
}

export class ConversationCompactionService {
    private readonly summaryMap = new Map<string, string>();

    constructor(private readonly ctx: CompactionContext) {}

    /** Update model when user changes selection (recalculates budget) */
    updateModel(model: string): void {
        (this.ctx as { model: string }).model = model;
    }

    /** True when rolling history exceeds budget for this provider/model */
    needsCompaction(messages: ChatExportMessage[]): boolean {
        return this.estimateHistoryChars(messages) > this.getHistoryBudget();
    }

    /** Build conversation history string for injection into LLM prompt */
    async formatHistory(mode: string, messages: ChatExportMessage[]): Promise<string> {
        const relevant = messages.filter(m => m.role !== 'system').slice(0, -1);
        if (relevant.length === 0) return '';
        if (!this.needsCompaction(relevant)) return this.formatPlain(relevant);

        const splitIdx = Math.max(0, relevant.length - RECENT_KEEP_COUNT);
        const oldMessages = relevant.slice(0, splitIdx);
        const recentMessages = relevant.slice(splitIdx);

        const summary = await this.compactMessages(mode, oldMessages);
        const parts: string[] = [];
        if (summary) parts.push(`<conversation_summary>\n${summary}\n</conversation_summary>`);
        if (recentMessages.length > 0) {
            const recent = recentMessages
                .map(m => `${m.role.toUpperCase()}: ${m.content}`)
                .join('\n');
            parts.push(`<recent_messages>\n${recent}\n</recent_messages>`);
        }
        return parts.join('\n\n');
    }

    /** Get cached summary for a mode */
    getCachedSummary(mode: string): string { return this.summaryMap.get(mode) ?? ''; }

    /** Reset compaction state for a mode (on conversation clear) */
    reset(mode: string): void { this.summaryMap.delete(mode); }

    /** Clear all mode summaries (modal close) */
    resetAll(): void { this.summaryMap.clear(); }

    /** Restore a previously persisted summary (on resume) */
    restore(mode: string, summary: string): void {
        if (summary) this.summaryMap.set(mode, summary);
    }

    private async compactMessages(mode: string, old: ChatExportMessage[]): Promise<string> {
        const existingSummary = this.summaryMap.get(mode) ?? '';
        const conversationBlock = old.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
        const prompt = buildCompactionPrompt(
            existingSummary ? `<existing_summary>\n${existingSummary}\n</existing_summary>` : '',
            conversationBlock
        );

        try {
            const result = await this.ctx.summarize(prompt);
            if (result.success && result.content) {
                this.summaryMap.set(mode, result.content);
                return result.content;
            }
        } catch { /* fall through to fallback */ }

        if (existingSummary) return existingSummary;
        const budget = this.getHistoryBudget();
        const text = old.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
        return text.length > budget ? '...' + text.slice(text.length - budget) : text;
    }

    private formatPlain(messages: ChatExportMessage[]): string {
        return messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
    }

    private estimateHistoryChars(messages: ChatExportMessage[]): number {
        return messages.reduce((sum, m) => sum + m.content.length + m.role.length + 2, 0);
    }

    private getHistoryBudget(): number {
        const totalBudget = getMaxContentCharsForModel(this.ctx.provider, this.ctx.model);
        return Math.floor(totalBudget * HISTORY_BUDGET_FRACTION);
    }
}
