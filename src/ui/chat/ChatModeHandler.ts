/**
 * Unified Chat Mode Handler Interface
 *
 * Design rule: handlers must remain lightweight and must NOT register long-lived
 * listeners, timers, or side effects outside their own render cycle. Any owned
 * state must be released in dispose().
 */

import type { Translations } from '../../i18n/types';
import type { AIOrganiserSettings } from '../../core/settings';
import type { IEmbeddingService } from '../../services/embeddings/types';
import type { IVectorStore } from '../../services/vector/types';
import type { SummarizableLLMService } from '../../services/types';

export type ChatMode = 'note' | 'vault' | 'highlight';

export interface UnifiedChatOptions {
    noteContent?: string;
    noteTitle?: string;
    editorSelection?: string;
    initialMode?: ChatMode;
}

export interface ChatPluginContext {
    t: Translations;
    settings: AIOrganiserSettings;
    vectorStore?: IVectorStore | null;
    embeddingService?: IEmbeddingService | null;
    llmService: SummarizableLLMService;
}

export interface ModalContext {
    plugin: ChatPluginContext;
    options: UnifiedChatOptions;
    vaultDocCount: number;
    vaultIndexVersion: string;
    hasEmbeddingService: boolean;
    semanticSearchEnabled: boolean;
}

export interface SendResult {
    prompt: string;
    sources?: string[];
    systemNotice?: string;
}

export interface ActionDescriptor {
    id: string;
    labelKey: string;
    tooltipKey: string;
    isEnabled: boolean;
}

export interface ChatModeHandler {
    readonly mode: ChatMode;
    isAvailable(ctx: ModalContext): boolean;
    unavailableReason(t: Translations): string;
    getIntroMessage(t: Translations): string;
    getPlaceholder(t: Translations): string;
    renderContextPanel(container: HTMLElement, ctx: ModalContext): void;
    buildPrompt(query: string, history: string, ctx: ModalContext): Promise<SendResult>;
    getActionDescriptors(t: Translations): ActionDescriptor[];
    dispose(): void;
}
