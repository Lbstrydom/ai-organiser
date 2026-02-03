import { ButtonComponent, Notice } from 'obsidian';
import { RAGService } from '../../services/ragService';
import { INDEX_SCHEMA_VERSION } from '../../services/vector/types';
import { buildVaultFallbackPrompt } from '../../services/prompts';
import { FolderScopePickerModal } from '../modals/FolderScopePickerModal';
import type { ChatModeHandler, ModalContext, SendResult } from './ChatModeHandler';
import type { Translations } from '../../i18n/types';

export class VaultModeHandler implements ChatModeHandler {
    readonly mode = 'vault' as const;
    private ragService: RAGService | null = null;
    private folderScope: string | null = null;
    private scopePinned: boolean = false;
    private contextPanelContainer: HTMLElement | null = null;
    private onContextUpdateCallback?: () => void;

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

    private normalizeFolderPath(folderPath: string | undefined | null): string | null {
        if (!folderPath) return null;
        if (folderPath === '/') return null;
        return folderPath;
    }

    private initializeFolderScope(ctx: ModalContext): void {
        // Initialize folder scope from active note's folder (if not pinned)
        if (!this.scopePinned) {
            const activeFile = ctx.options.noteFile;
            if (activeFile && activeFile.parent) {
                this.folderScope = this.normalizeFolderPath(activeFile.parent.path);
            } else {
                this.folderScope = null;
            }
        }
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

    setContextUpdateCallback(callback: () => void): void {
        this.onContextUpdateCallback = callback;
    }

    renderContextPanel(container: HTMLElement, ctx: ModalContext): void {
        this.contextPanelContainer = container;
        this.initializeFolderScope(ctx);

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

        // Folder scope indicator + picker button
        const scopeRow = container.createEl('div', { 
            cls: 'ai-organiser-chat-context-line ai-organiser-chat-scope-row' 
        });

        const scopeText = scopeRow.createEl('span', {
            cls: 'ai-organiser-chat-scope-text',
            text: this.getScopeDisplayText(ctx)
        });

        new ButtonComponent(scopeRow)
            .setButtonText(this.folderScope 
                ? t.changeScopeButton 
                : t.scopeToFolderButton)
            .setClass('ai-organiser-chat-scope-btn')
            .onClick(() => this.showFolderPicker(ctx));
    }

    private getScopeDisplayText(ctx: ModalContext): string {
        const t = ctx.fullPlugin.t.modals.unifiedChat;
        if (!this.folderScope) {
            return t.scopeEntireVault;
        }
        // Show last folder name for brevity
        const parts = this.folderScope.split('/');
        const folderName = parts[parts.length - 1] || this.folderScope;
        return t.scopeFolder.replace('{folder}', folderName);
    }

    private showFolderPicker(ctx: ModalContext): void {
        const t = ctx.fullPlugin.t.modals.folderScopePicker;
        new FolderScopePickerModal(ctx.app, ctx.fullPlugin, {
            title: t?.title || 'Select Folder Scope',
            description: 'Limit vault search to a specific folder and its subfolders',
            allowSkip: true,
            defaultFolder: this.folderScope || undefined,
            onSelect: (folderPath: string | null) => {
                this.folderScope = folderPath;
                this.scopePinned = true; // User explicitly chose
                this.rerenderContextPanel(ctx);
            }
        }).open();
    }

    private rerenderContextPanel(ctx: ModalContext): void {
        if (!this.contextPanelContainer) return;
        this.contextPanelContainer.empty();
        this.renderContextPanel(this.contextPanelContainer, ctx);
        // Notify parent to update if callback provided
        this.onContextUpdateCallback?.();
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
        
        // Use retrieveContext with folder scope support
        const context = await ragService.retrieveContext(
            query,
            undefined,
            {
                maxChunks: ctx.plugin.settings.ragContextChunks || 5,
                minSimilarity: 0.5,
                folderScope: this.folderScope || undefined
            }
        );
        
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
            const scopeNote = this.folderScope 
                ? ` Results are limited to the "${this.folderScope}/" folder and its subfolders.`
                : '';
            const systemPrompt = `You are a helpful assistant that answers questions based on the user's personal knowledge vault.${scopeNote}${historySection}`;
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
        this.contextPanelContainer = null;
        this.onContextUpdateCallback = undefined;
    }
}
