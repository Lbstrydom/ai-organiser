/**
 * Unified Chat Mode Handler Interface
 *
 * Design rule: handlers must remain lightweight and must NOT register long-lived
 * listeners, timers, or side effects outside their own render cycle. Any owned
 * state must be released in dispose().
 */

import type { App, Editor, TFile } from 'obsidian';
import type { Translations } from '../../i18n/types';
import type { AIOrganiserSettings } from '../../core/settings';
import type { IEmbeddingService } from '../../services/embeddings/types';
import type { IVectorStore } from '../../services/vector/types';
import type { SummarizableLLMService } from '../../services/types';
import type AIOrganiserPlugin from '../../main';

export type ChatMode = 'note' | 'vault' | 'highlight' | 'research' | 'free' | 'presentation';

export interface FreeChatCallbacks {
    onModelChange?: (model: string) => void;
    onProjectIndexRequest?: (req: ProjectIndexRequest) => void;
}

export interface ProjectIndexRequest {
    fileName: string;
    extractedText: string;
    chunkCount: number;
}

export interface UnifiedChatOptions {
    noteContent?: string;
    noteTitle?: string;
    noteFile?: TFile;
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
    app: App;
    plugin: ChatPluginContext;
    fullPlugin: AIOrganiserPlugin;
    options: UnifiedChatOptions;
    vaultDocCount: number;
    vaultIndexVersion: string;
    hasEmbeddingService: boolean;
    semanticSearchEnabled: boolean;
}

/** Callbacks provided by the modal for progressive streaming updates during buildPrompt(). */
export interface StreamingCallbacks {
    updateMessage(content: string): void;
    addSystemNotice(content: string): void;
    /** Optional: update the "Thinking…" placeholder text in place so the
     *  handler can surface phase transitions (e.g. "Searching web…" →
     *  "Extracting from 3 sources…" → "Synthesizing…") during a long run. */
    updateThinking?(message: string): void;
    /** Optional: render an inline cancel button inside the thinking
     *  indicator so long-running operations have an escape hatch without
     *  the user navigating away. Called once when the progress UI becomes
     *  active — repeated calls replace the listener (idempotent). */
    showCancelButton?(onCancel: () => void): void;
    /** Optional: split-DOM slide-count progress for presentation mode.
     *  `slideCountFragment` is announced by screen readers (aria-live polite);
     *  `elapsedFragment` ticks silently (aria-hidden). Split keeps SR
     *  announcements scoped to structural changes — see plan §3 ARIA. */
    updateProgressSplit?(slideCountFragment: string, elapsedFragment: string): void;
    /** Optional: prompt the user to extend the generation budget when the
     *  soft budget fires. Modal renders the inline extend card and resolves
     *  the returned Promise. Handler inspects the resolution:
     *   - 'extend'  → continue generation (hard cap still applies)
     *   - 'cancel'  → HANDLER calls abort() (modal does NOT abort)
     *  When the card is auto-dismissed by a terminal state (completion /
     *  hard cap), it resolves 'cancel' idempotently with no side-effect.
     *
     *  `onRegisterCancelHook` gives the controller a way to force-dismiss
     *  the card on terminal state (see plan §4 race protocol, sources 4-5). */
    requestBudgetExtension?(context: {
        elapsedMs: number;
        softBudgetMs: number;
        /** Hard cap for the active operation. The modal uses
         *  (hardBudgetMs - softBudgetMs) to derive the "+N min" extend
         *  display, keeping i18n copy aligned with the actual budgets
         *  without an independent EXTEND_BUDGET_MS constant. */
        hardBudgetMs: number;
        /** Optional per-handler copy overrides. If omitted, the modal
         *  falls back to the generic presentation-era copy
         *  (extendBudgetTitle + extendBudgetBody). Research and Minutes
         *  pass their own pre-resolved strings to get domain-framed text
         *  without duplicating the card DOM. */
        title?: string;
        body?: string;
        onRegisterCancelHook?: (cancel: () => void) => void;
    }): Promise<'extend' | 'cancel' | 'auto-dismiss'>;
}

/** Result returned by a streaming handler after the stream completes. */
export interface StreamingResult {
    finalContent: string;
    sources?: string[];
}

export interface SendResult {
    prompt: string;
    sources?: string[];
    systemNotice?: string;
    directResponse?: string;
    /** If set, modal creates a placeholder message then calls start() for progressive updates. */
    streamingSetup?: {
        start: (callbacks: StreamingCallbacks) => Promise<StreamingResult>;
    };
}

export interface ActionDescriptor {
    id: string;
    labelKey: string;
    tooltipKey: string;
    isEnabled: boolean;
    requiresEditor?: boolean;
    isDefault?: boolean;
}

export interface ActionCallbacks {
    addAssistantMessage(content: string): void;
    /** Update last assistant message in-place (for streaming). */
    updateAssistantMessage(content: string): void;
    addSystemNotice(content: string): void;
    /** Show the in-chat thinking placeholder. Pass a phase-specific message
     *  (e.g. "Searching web (2/5)…") in place of the default "Thinking…" —
     *  the placeholder updates in place when called repeatedly while visible. */
    showThinking(message?: string): void;
    hideThinking(): void;
    rerenderActions(): void;
    getEditor(): Editor | null;
    notify(message: string): void;
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
    handleAction?(actionId: string, ctx: ModalContext, callbacks: ActionCallbacks): Promise<void>;
    /** Called when the user clears chat history. Reset handler-owned conversational state. */
    onClear?(): void;
    dispose(): void;
}
