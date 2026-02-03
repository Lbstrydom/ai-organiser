import { Notice } from 'obsidian';
import { RAGService } from '../../services/ragService';
import { INDEX_SCHEMA_VERSION } from '../../services/vector/types';
import { buildVaultFallbackPrompt } from '../../services/prompts';
import type { ChatModeHandler, ModalContext, SendResult } from './ChatModeHandler';
import type { Translations } from '../../i18n/types';

export class VaultModeHandler implements ChatModeHandler {
    readonly mode = 'vault' as const;
    private ragService: RAGService | null = null;

    private notify(message: string, duration?: number): Notice {
        return new Notice(message, duration);
    }

    private ensureRagService(ctx: ModalContext): RAGService | null {
        if (!ctx.plugin.vectorStore) return null;
        this.ragService ??= new RAGService(
            ctx.plugin.vectorStore,
            ctx.plugin.settings,
            ctx.plugin.embeddingService
        );
        return this.ragService;
    }

    isAvailable(ctx: ModalContext): boolean {
        return !!ctx.plugin.vectorStore
            && ctx.semanticSearchEnabled
            && ctx.vaultDocCount > 0
            && ctx.hasEmbeddingService;
    }

    unavailableReason(t: Translations): string {
        return t.modals.unifiedChat.vaultUnavailable;
    }

    getIntroMessage(t: Translations): string {
        return t.modals.unifiedChat.introVault;
    }

    getPlaceholder(t: Translations): string {
        return t.modals.unifiedChat.placeholderVault || t.modals.unifiedChat.placeholder;
    }

    renderContextPanel(container: HTMLElement, ctx: ModalContext): void {
        const t = ctx.plugin.t.modals.unifiedChat;
        const status = t.indexStatus
            .replace('{count}', String(ctx.vaultDocCount))
            .replace('{version}', ctx.vaultIndexVersion || 'unknown');
        container.createEl('div', { cls: 'ai-organiser-chat-context-line', text: status });

        if (ctx.vaultDocCount > 0 && ctx.vaultIndexVersion !== INDEX_SCHEMA_VERSION) {
            container.createEl('div', {
                cls: 'ai-organiser-chat-context-warning',
                text: t.indexOutdated
            });
        }
    }

    async buildPrompt(query: string, history: string, ctx: ModalContext): Promise<SendResult> {
        const t = ctx.plugin.t.modals.unifiedChat;

        if (!ctx.plugin.embeddingService) {
            return {
                prompt: buildVaultFallbackPrompt(query, history),
                systemNotice: t.embeddingMissing
            };
        }

        const ragService = this.ensureRagService(ctx);
        if (!ragService) {
            return {
                prompt: buildVaultFallbackPrompt(query, history),
                systemNotice: t.vaultUnavailable
            };
        }

        const metadata = await ctx.plugin.vectorStore?.getMetadata();
        const docCount = metadata?.totalDocuments ?? 0;
        if (docCount === 0) {
            return {
                prompt: buildVaultFallbackPrompt(query, history),
                systemNotice: t.noContextFallback
            };
        }

        const statusNotice = new Notice(t.searchingContext, 0);
        const context = await ragService.retrieveContext(query);
        statusNotice.hide();

        if (context.totalChunks > 0) {
            this.notify(
                t.foundChunks
                    .replace('{count}', String(context.totalChunks))
                    .replace('{sources}', String(context.sources.length)),
                3000
            );
            const historySection = history
                ? `\n<conversation_history>\n${history}\n</conversation_history>\n`
                : '';
            const systemPrompt = `You are a helpful assistant that answers questions based on the user's personal knowledge vault.${historySection}`;
            return {
                prompt: ragService.buildRAGPrompt(query, context, systemPrompt),
                sources: context.sources
            };
        }

        return {
            prompt: buildVaultFallbackPrompt(query, history),
            systemNotice: t.noContextFallback
        };
    }

    getActionDescriptors(_t: Translations): [] {
        return [];
    }

    dispose(): void {
        // No-op
    }
}
