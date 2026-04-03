import { App, Notice, TFile } from 'obsidian';
import type { ChatMode, ChatModeHandler, ModalContext, SendResult, ActionDescriptor, ActionCallbacks, FreeChatCallbacks } from './ChatModeHandler';
import type { Translations } from '../../i18n/types';
import type { ProjectConfig, ProjectService } from '../../services/chat/projectService';
import type { IEmbeddingService } from '../../services/embeddings/types';
import { AttachmentIndexService } from '../../services/chat/attachmentIndexService';
import { getMaxContentCharsForModel } from '../../services/tokenLimits';
import { DocumentExtractionService } from '../../services/documentExtractionService';
import { IndexingChoiceModal } from '../modals/IndexingChoiceModal';

export interface AttachmentEntry {
    path: string;
    name: string;
    extractedText: string;
    mtime: number;
    included: boolean;
    charCount: number;
    truncated: boolean;
}

export interface IndexedAttachmentEntry extends AttachmentEntry {
    indexService: AttachmentIndexService | null;
    indexMode: 'none' | 'temporary' | 'project';
    chunkCount: number;
    indexProgress: number;
    indexState: 'pending' | 'indexing' | 'indexed' | 'error';
    projectNotePath?: string;
}

// Budget fractions
const BUDGET_FRACTION_SYSTEM = 0.02;
const BUDGET_FRACTION_PROJECT_INSTRUCTIONS = 0.05;
const BUDGET_FRACTION_PROJECT_MEMORY = 0.03;
const BUDGET_FRACTION_GLOBAL_MEMORY = 0.03;
const BUDGET_FRACTION_HISTORY = 0.30;
const BUDGET_FRACTION_INDEXED_RAG = 0.25;
const BUDGET_FRACTION_FLAT_ATT = 0.20;

export class FreeChatModeHandler implements ChatModeHandler {
    readonly mode: ChatMode = 'free';

    private attachments: (AttachmentEntry | IndexedAttachmentEntry)[] = [];
    private selectedModel = '';
    private globalMemory: string[] = [];
    private projectConfig: ProjectConfig | null = null;
    private embeddingService: IEmbeddingService | null = null;
    private projectService: ProjectService | null = null;

    private documentService: DocumentExtractionService | null = null;

    constructor(
        private readonly app: App,
        private readonly callbacks: FreeChatCallbacks = {},
    ) {}

    setEmbeddingService(service: IEmbeddingService | null): void {
        this.embeddingService = service;
    }

    getEmbeddingService(): IEmbeddingService | null {
        return this.embeddingService;
    }

    setProjectService(svc: ProjectService): void {
        this.projectService = svc;
    }

    setGlobalMemory(items: string[]): void {
        this.globalMemory = items;
    }

    addGlobalMemoryFact(fact: string): void {
        if (!this.globalMemory.includes(fact)) {
            this.globalMemory = [...this.globalMemory, fact];
        }
    }

    addProjectMemoryFact(fact: string): void {
        if (this.projectConfig && !this.projectConfig.memory.includes(fact)) {
            this.projectConfig = { ...this.projectConfig, memory: [...this.projectConfig.memory, fact] };
        }
    }

    setProjectContext(config: ProjectConfig | null): void {
        this.projectConfig = config;
    }

    getProjectName(): string | null {
        return this.projectConfig?.name ?? null;
    }

    clearProjectContext(): void {
        // Dispose and remove all project-mode indexed attachments
        for (const att of this.attachments) {
            const indexed = att as IndexedAttachmentEntry;
            if (indexed.indexMode === 'project' && indexed.indexService) {
                indexed.indexService.dispose();
            }
        }
        this.attachments = this.attachments.filter(
            a => (a as IndexedAttachmentEntry).indexMode !== 'project'
        );
        this.projectConfig = null;
    }

    isAvailable(_ctx: ModalContext): boolean {
        return true;
    }

    unavailableReason(t: Translations): string {
        return t.modals.unifiedChat.freeUnavailable;
    }

    getIntroMessage(t: Translations): string {
        return t.modals.unifiedChat.introFree;
    }

    getPlaceholder(t: Translations): string {
        return t.modals.unifiedChat.placeholderFree;
    }

    getAttachments(): readonly (AttachmentEntry | IndexedAttachmentEntry)[] {
        return this.attachments;
    }

    renderContextPanel(container: HTMLElement, ctx: ModalContext): void {
        container.empty();

        if (this.projectConfig) {
            const projectBadge = container.createDiv({ cls: 'ai-organiser-free-chat-project-badge' });
            const t = ctx.plugin.t.modals.unifiedChat;
            projectBadge.createSpan({ text: t.projectIndicator.replace('{name}', this.projectConfig.name) });
        }

        if (this.attachments.length === 0) return;

        const pillsContainer = container.createDiv({ cls: 'ai-organiser-free-chat-pills' });
        this.renderAttachmentPills(pillsContainer, ctx);
    }

    private renderAttachmentPills(container: HTMLElement, ctx: ModalContext): void {
        container.empty();
        for (const att of this.attachments) {
            const pill = container.createDiv({ cls: 'ai-organiser-free-chat-att-pill' });

            const toggle = pill.createEl('input', { attr: { type: 'checkbox' } }) as HTMLInputElement;
            toggle.checked = att.included;
            toggle.addEventListener('change', () => {
                att.included = toggle.checked;
            });

            pill.createSpan({ text: att.name, cls: 'ai-organiser-free-chat-att-name' });

            const indexed = att as IndexedAttachmentEntry;
            if (indexed.indexState) {
                const t = ctx.plugin.t.modals.unifiedChat;
                const statusEl = pill.createSpan({ cls: 'ai-organiser-free-chat-att-indexed' });
                switch (indexed.indexState) {
                    case 'indexing':
                        statusEl.setText(t.indexingPillProgress.replace('{percent}', String(indexed.indexProgress)));
                        pill.addClass('is-indexing');
                        break;
                    case 'indexed':
                        if (indexed.indexService?.isPartial) {
                            statusEl.setText(t.indexingPillPartial
                                .replace('{actual}', String(indexed.chunkCount))
                                .replace('{total}', String(indexed.indexService?.totalChunks ?? indexed.chunkCount)));
                            statusEl.addClass('is-partial');
                        } else {
                            statusEl.setText(t.indexingPillIndexed.replace('{count}', String(indexed.chunkCount)));
                        }
                        pill.addClass('is-indexed');
                        break;
                    case 'error':
                        statusEl.setText(t.indexingPillFailed);
                        break;
                }
            } else if (att.truncated) {
                pill.createSpan({ cls: 'ai-organiser-free-chat-att-truncated', text: '(truncated)' });
            }

            const removeBtn = pill.createEl('button', { cls: 'ai-organiser-free-chat-att-remove', attr: { 'aria-label': 'Remove' } });
            removeBtn.textContent = '✕';
            removeBtn.addEventListener('click', () => {
                // Dispose index service if present
                if ((att as IndexedAttachmentEntry).indexService) {
                    (att as IndexedAttachmentEntry).indexService!.dispose();
                }
                this.attachments = this.attachments.filter(a => a !== att);
                this.renderAttachmentPills(container, ctx);
            });
        }
    }

    private resolveProviderAndModel(ctx: ModalContext): { provider: string; model: string } {
        const s = ctx.plugin.settings;
        if (s.serviceType === 'local') {
            return { provider: s.localServiceType ?? 'ollama', model: this.selectedModel || s.localModel || '' };
        }
        return { provider: s.cloudServiceType, model: this.selectedModel || s.cloudModel };
    }

    async buildPrompt(query: string, history: string, ctx: ModalContext): Promise<SendResult> {
        const { provider, model } = this.resolveProviderAndModel(ctx);
        const totalBudget = getMaxContentCharsForModel(provider, model);

        const parts: string[] = [];
        let remaining = totalBudget;

        // 1. Auto-memory instruction (emitted whenever memory can be stored)
        if (this.globalMemory.length > 0 || this.projectConfig) {
            const memInstruction = `<auto_memory_instruction>\nWhen you learn an important fact, preference, or decision during this conversation, output a [MEMORY: <fact>] marker on its own line.\n</auto_memory_instruction>`;
            parts.push(memInstruction);
            remaining -= memInstruction.length;
        }

        // Global memory
        if (this.globalMemory.length > 0) {
            const block = `<global_memory>\n${this.globalMemory.map(m => `- ${m}`).join('\n')}\n</global_memory>`;
            parts.push(block);
            remaining -= block.length;
        }

        // 2. Project context
        if (this.projectConfig) {
            if (this.projectConfig.instructions) {
                const instrBudget = Math.floor(totalBudget * BUDGET_FRACTION_PROJECT_INSTRUCTIONS);
                const truncated = this.projectConfig.instructions.slice(0, instrBudget);
                const block = `<project_instructions>\n${truncated}\n</project_instructions>`;
                parts.push(block);
                remaining -= block.length;
            }

            if (this.projectConfig.memory.length > 0) {
                const memBudget = Math.floor(totalBudget * BUDGET_FRACTION_PROJECT_MEMORY);
                let memText = this.projectConfig.memory.map(m => `- ${m}`).join('\n');
                memText = memText.slice(0, memBudget);
                const block = `<project_memory>\n${memText}\n</project_memory>`;
                parts.push(block);
                remaining -= block.length;
            }

            if (this.projectConfig.pinnedFiles.length > 0) {
                const pinnedBudget = Math.floor(totalBudget / 5);
                const pinnedContent = await this.projectService?.readPinnedFiles(this.projectConfig, pinnedBudget) ?? '';
                if (pinnedContent) {
                    const block = `<project_files>\n${pinnedContent}\n</project_files>`;
                    parts.push(block);
                    remaining -= block.length;
                }
            }
        }

        // 3. Conversation history
        const historyBudget = Math.floor(totalBudget * BUDGET_FRACTION_HISTORY);
        if (history) {
            const truncatedHistory = history.slice(0, historyBudget);
            parts.push(`<conversation_history>\n${truncatedHistory}\n</conversation_history>`);
            remaining -= truncatedHistory.length;
        }

        // 4. Indexed attachment RAG
        const indexedAtts = this.attachments.filter(
            a => (a as IndexedAttachmentEntry).indexState === 'indexed' && a.included
        ) as IndexedAttachmentEntry[];

        if (indexedAtts.length > 0 && remaining > 0) {
            const indexedBudget = Math.floor(totalBudget * BUDGET_FRACTION_INDEXED_RAG);
            const perDocBudget = Math.floor(indexedBudget / indexedAtts.length);
            const contexts: string[] = [];
            for (const att of indexedAtts) {
                if (att.indexService?.isReady) {
                    const retrieved = await att.indexService.queryRelevantChunks(query, {
                        topK: 5, maxChars: perDocBudget,
                    });
                    if (retrieved) contexts.push(`--- ${att.name} ---\n${retrieved}`);
                }
            }
            if (contexts.length > 0) {
                const block = `<attachment_context>\n${contexts.join('\n\n')}\n</attachment_context>`;
                parts.push(block);
                remaining -= block.length;
            }
        }

        // 5. Flat attachments (non-indexed, included) — re-extract if text is missing (resumed session)
        const flatAttsAll = this.attachments.filter(
            a => !(a as IndexedAttachmentEntry).indexService && a.included
        );
        for (const att of flatAttsAll) {
            if (!att.extractedText) {
                await this.tryReextractAttachment(att);
            }
        }
        const flatAtts = flatAttsAll.filter(a => a.extractedText);
        if (flatAtts.length > 0 && remaining > 0) {
            const flatBudget = Math.floor(totalBudget * BUDGET_FRACTION_FLAT_ATT);
            const perDocBudget = Math.floor(flatBudget / flatAtts.length);
            const attBlocks = flatAtts.map(a => {
                const text = a.extractedText.slice(0, perDocBudget);
                return `--- ${a.name} ---\n${text}`;
            });
            const block = `<attachments>\n${attBlocks.join('\n\n')}\n</attachments>`;
            parts.push(block);
            remaining -= block.length;
        }

        // 6. The query
        parts.push(`<question>\n${query}\n</question>`);

        const prompt = parts.join('\n\n');
        return { prompt };
    }

    getActionDescriptors(_t: Translations): ActionDescriptor[] {
        return [
            {
                id: 'attach-file',
                labelKey: 'freeAttachPickerPlaceholder',
                tooltipKey: 'freeAttachPickerPlaceholder',
                isEnabled: true,
                requiresEditor: false,
            },
        ];
    }

    async handleAction(actionId: string, ctx: ModalContext, callbacks: ActionCallbacks): Promise<void> {
        if (actionId === 'attach-file') {
            await this.openAttachmentPicker(ctx, callbacks);
        }
    }

    onClear(): void {
        // Dispose all indexed attachment services
        for (const att of this.attachments) {
            if ((att as IndexedAttachmentEntry).indexService) {
                (att as IndexedAttachmentEntry).indexService!.dispose();
            }
        }
        this.attachments = [];
    }

    dispose(): void {
        this.onClear();
    }

    // Serialization for persistence
    getSerializableState() {
        return {
            uiState: 'chat' as const,
            selectedModel: this.selectedModel,
            brandEnabled: false,
            approvedOutline: null,
            attachments: this.attachments.map(a => ({
                path: a.path,
                name: a.name,
                mtime: a.mtime,
                included: a.included,
            })),
        };
    }

    restoreState(state: { selectedModel: string; attachments?: Array<{ path: string; name: string; mtime: number; included: boolean }> }): void {
        this.selectedModel = state.selectedModel || '';
        // Rehydrate attachments with empty extractedText (re-extracted on next use)
        this.attachments = (state.attachments ?? []).map(a => ({
            ...a,
            extractedText: '',
            charCount: 0,
            truncated: false,
        }));
    }

    private async openAttachmentPicker(ctx: ModalContext, callbacks: ActionCallbacks): Promise<void> {
        // Try native file picker first (desktop Electron)
        const nativeFiles = await this.tryNativeFilePicker();
        if (nativeFiles !== null) {
            for (const filePath of nativeFiles) {
                await this.addExternalAttachment(filePath, ctx, callbacks);
            }
            return;
        }

        // Fallback: vault file picker
        this.openVaultFilePicker(ctx, callbacks);
    }

    private async tryNativeFilePicker(): Promise<string[] | null> {
        try {
            // @ts-ignore — available in Electron/desktop Obsidian
            const remote = require('@electron/remote');
            const result = await remote.dialog.showOpenDialog({
                properties: ['openFile', 'multiSelections'],
                filters: [
                    { name: 'Documents', extensions: ['docx', 'xlsx', 'pptx', 'pdf', 'txt', 'rtf', 'md'] },
                    { name: 'All Files', extensions: ['*'] },
                ],
            });
            if (result.canceled) return [];
            return result.filePaths;
        } catch {
            return null; // Electron unavailable (mobile)
        }
    }

    private async addExternalAttachment(filePath: string, ctx: ModalContext, callbacks: ActionCallbacks): Promise<void> {
        const fileName = filePath.split(/[\\/]/).pop() ?? 'unknown';
        try {
            // @ts-ignore
            const fs = require('fs').promises;
            const buffer = await fs.readFile(filePath);

            if (!this.documentService) {
                this.documentService = new DocumentExtractionService(this.app);
            }

            const ext = (filePath.split('.').pop() ?? '').toLowerCase();
            let text: string;
            if (['docx', 'xlsx', 'pptx', 'pdf', 'rtf'].includes(ext)) {
                try {
                    const officeParser = await import('officeparser');
                    const ab: ArrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
                    const result = await officeParser.parseOffice(ab);
                    text = result.toText().slice(0, 200000);
                } catch {
                    text = buffer.toString('utf-8').slice(0, 200000);
                }
            } else {
                text = buffer.toString('utf-8').slice(0, 200000);
            }

            if (!text.trim()) {
                callbacks.notify(ctx.plugin.t.modals.unifiedChat.freeAttachExtractFailed.replace('{name}', fileName));
                return;
            }

            // Dedup check
            if (this.attachments.some(a => a.name === fileName)) return;

            const maxChars = this.getMaxAttachmentChars(ctx);
            if (text.length > maxChars) {
                await this.handleLargeAttachment(fileName, filePath, text, Date.now(), ctx, callbacks);
            } else {
                this.attachments.push({
                    path: filePath, name: fileName,
                    extractedText: text, mtime: Date.now(),
                    included: true, charCount: text.length, truncated: false,
                });
                this.rerenderContext(ctx);
            }
        } catch {
            callbacks.notify(ctx.plugin.t.modals.unifiedChat.freeAttachExternalFailed.replace('{name}', fileName));
        }
    }

    private openVaultFilePicker(ctx: ModalContext, callbacks: ActionCallbacks): void {
        const { FuzzySuggestModal } = require('obsidian');

        const vaultApp = this.app;
        class VaultFilePicker extends FuzzySuggestModal<TFile> {
            constructor(pickerApp: App, private readonly onSelect: (file: TFile) => void) {
                super(pickerApp);
                this.setPlaceholder(ctx.plugin.t.modals.unifiedChat.freeAttachPickerPlaceholder);
            }
            getItems(): TFile[] {
                return vaultApp.vault.getMarkdownFiles().concat(vaultApp.vault.getFiles().filter((f: TFile) => !f.path.endsWith('.md')));
            }
            getItemText(item: TFile): string { return item.path; }
            onChooseItem(item: TFile): void { this.onSelect(item); }
        }

        const picker = new VaultFilePicker(this.app, async (file: TFile) => {
            if (this.attachments.some(a => a.path === file.path)) return;

            if (!this.documentService) {
                this.documentService = new DocumentExtractionService(this.app);
            }

            try {
                let text: string;
                if (file.extension === 'md') {
                    text = await this.app.vault.read(file);
                } else {
                    const result = await this.documentService.extractText(file);
                    text = result.success ? result.text ?? '' : '';
                }

                if (!text.trim()) {
                    callbacks.notify(ctx.plugin.t.modals.unifiedChat.freeAttachExtractFailed.replace('{name}', file.name));
                    return;
                }

                const maxChars = this.getMaxAttachmentChars(ctx);
                if (text.length > maxChars) {
                    await this.handleLargeAttachment(file.name, file.path, text, file.stat.mtime, ctx, callbacks);
                } else {
                    this.attachments.push({
                        path: file.path, name: file.name,
                        extractedText: text, mtime: file.stat.mtime,
                        included: true, charCount: text.length, truncated: false,
                    });
                    this.rerenderContext(ctx);
                }
            } catch {
                callbacks.notify(ctx.plugin.t.modals.unifiedChat.freeAttachExtractFailed.replace('{name}', file.name));
            }
        });
        picker.open();
    }

    /** Try to silently bootstrap local ONNX embeddings when no service is configured. */
    private async tryAutoBootstrapEmbeddings(): Promise<IEmbeddingService | null> {
        try {
            const { LocalOnnxEmbeddingService } = await import('../../services/embeddings/localOnnxEmbeddingService');
            const svc = new LocalOnnxEmbeddingService();
            const test = await svc.generateEmbedding('test');
            if (test.success) {
                this.embeddingService = svc;
                new Notice('Built-in embeddings ready');
                return svc;
            }
        } catch {
            // silent — WASM unavailable or load failed
        }
        return null;
    }

    /** Show IndexingChoiceModal and act on the user's choice. */
    private async handleLargeAttachment(
        name: string,
        path: string,
        text: string,
        mtime: number,
        ctx: ModalContext,
        callbacks: ActionCallbacks,
    ): Promise<void> {
        if (!this.embeddingService) {
            await this.tryAutoBootstrapEmbeddings();
        }

        const maxChars = this.getMaxAttachmentChars(ctx);
        const t = ctx.plugin.t.modals.unifiedChat;

        const modal = new IndexingChoiceModal(
            ctx.app, name, text.length, maxChars,
            this.embeddingService !== null,
            this.projectConfig !== null,
            t,
        );
        modal.open();
        const choice = await modal.waitForChoice();

        if (choice === 'project' || choice === 'temporary') {
            const entry: IndexedAttachmentEntry = {
                path, name,
                extractedText: text.slice(0, maxChars),
                mtime, included: true,
                charCount: text.length,
                truncated: false,
                indexService: null,
                indexMode: choice,
                chunkCount: 0,
                indexProgress: 0,
                indexState: 'pending',
            };
            this.attachments.push(entry);
            this.rerenderContext(ctx);
            await this.indexAttachment(entry, text, ctx, callbacks);
        } else if (choice === 'settings') {
            callbacks.notify(t.indexingNoEmbeddings);
            try {
                // @ts-ignore — Obsidian internal API
                ctx.fullPlugin.app.setting.open();
                // @ts-ignore
                ctx.fullPlugin.app.setting.openTabById(ctx.fullPlugin.manifest.id);
            } catch { /* no-op */ }
            this.attachments.push({
                path, name, extractedText: text.slice(0, maxChars),
                mtime, included: true, charCount: maxChars, truncated: true,
            });
            this.rerenderContext(ctx);
        } else {
            // 'truncate'
            this.attachments.push({
                path, name, extractedText: text.slice(0, maxChars),
                mtime, included: true, charCount: maxChars, truncated: true,
            });
            this.rerenderContext(ctx);
        }
    }

    /** Create an AttachmentIndexService, embed the document, and update pill state. */
    private async indexAttachment(
        entry: IndexedAttachmentEntry,
        fullText: string,
        ctx: ModalContext,
        callbacks: ActionCallbacks,
    ): Promise<void> {
        if (!this.embeddingService) {
            entry.indexState = 'error';
            this.rerenderContext(ctx);
            return;
        }

        const svc = new AttachmentIndexService(this.embeddingService);
        entry.indexService = svc;
        entry.indexState = 'indexing';
        entry.indexProgress = 0;
        this.rerenderContext(ctx);

        const chunkCount = await svc.indexDocument(fullText, entry.name, (percent) => {
            entry.indexProgress = percent;
            this.rerenderContext(ctx);
        });

        if (chunkCount > 0) {
            entry.indexState = 'indexed';
            entry.chunkCount = chunkCount;
            if (svc.isPartial) {
                callbacks.notify(
                    ctx.plugin.t.modals.unifiedChat.indexingPillMobileCapped
                        .replace('{max}', String(chunkCount))
                );
            }
            if (entry.indexMode === 'project') {
                this.callbacks.onProjectIndexRequest?.({
                    fileName: entry.name,
                    extractedText: fullText,
                    chunkCount,
                });
            }
        } else {
            entry.indexState = 'error';
            entry.indexService = null;  // Release so flat-attachment path picks it up
            entry.extractedText = fullText.slice(0, this.getMaxAttachmentChars(ctx));
            entry.truncated = true;
            callbacks.notify(`${entry.name}: indexing failed, using truncated text`);
        }
        this.rerenderContext(ctx);
    }

    /**
     * Re-embed a previously indexed document (used when loading a project with persisted index).
     * Adds the document to the attachment list and kicks off indexing in the background.
     */
    async rehydrateIndexedDocument(
        doc: { name: string; path: string; extractedText: string; chunkCount: number },
        embeddingService: IEmbeddingService,
    ): Promise<void> {
        if (this.attachments.some(a => a.path === doc.path)) return;

        this.embeddingService = this.embeddingService ?? embeddingService;

        const entry: IndexedAttachmentEntry = {
            path: doc.path,
            name: doc.name,
            extractedText: doc.extractedText,
            mtime: 0,
            included: true,
            charCount: doc.extractedText.length,
            truncated: false,
            indexService: null,
            indexMode: 'project',
            chunkCount: 0,
            indexProgress: 0,
            indexState: 'indexing',
        };
        this.attachments.push(entry);

        const svc = new AttachmentIndexService(embeddingService);
        entry.indexService = svc;
        const chunkCount = await svc.indexDocument(doc.extractedText, doc.name, (percent) => {
            entry.indexProgress = percent;
        });
        entry.chunkCount = chunkCount > 0 ? chunkCount : doc.chunkCount;
        entry.indexState = chunkCount > 0 ? 'indexed' : 'error';
    }

    private async tryReextractAttachment(att: AttachmentEntry): Promise<void> {
        try {
            const isAbsolutePath = /^[A-Za-z]:[/\\]/.test(att.path) || att.path.startsWith('/');
            if (!isAbsolutePath) {
                // Vault file
                if (!this.documentService) {
                    this.documentService = new DocumentExtractionService(this.app);
                }
                const file = this.app.vault.getAbstractFileByPath(att.path);
                if (file instanceof TFile) {
                    if (file.extension === 'md') {
                        att.extractedText = await this.app.vault.read(file);
                    } else {
                        const res = await this.documentService.extractText(file);
                        att.extractedText = res.success ? res.text ?? '' : '';
                    }
                    att.charCount = att.extractedText.length;
                }
            } else {
                // External (native-picker) file
                // @ts-ignore
                const fs = require('fs').promises;
                const buffer = await fs.readFile(att.path);
                const ext = (att.path.split('.').pop() ?? '').toLowerCase();
                if (['docx', 'xlsx', 'pptx', 'pdf', 'rtf'].includes(ext)) {
                    try {
                        const officeParser = await import('officeparser');
                        const ab: ArrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
                        const result = await officeParser.parseOffice(ab);
                        att.extractedText = result.toText().slice(0, 200000);
                    } catch {
                        att.extractedText = buffer.toString('utf-8').slice(0, 200000);
                    }
                } else {
                    att.extractedText = buffer.toString('utf-8').slice(0, 200000);
                }
                att.charCount = att.extractedText.length;
            }
        } catch {
            // Re-extraction failed — leave empty, attachment will be silently skipped
        }
    }

    private getMaxAttachmentChars(ctx: ModalContext): number {
        const { provider, model } = this.resolveProviderAndModel(ctx);
        const total = getMaxContentCharsForModel(provider, model);
        return Math.floor(total * BUDGET_FRACTION_FLAT_ATT);
    }

    private rerenderContext(ctx: ModalContext): void {
        // Find the context panel element in the modal and re-render
        const ctxEl = document.querySelector('.ai-organiser-chat-context') as HTMLElement | null;
        if (ctxEl) {
            this.renderContextPanel(ctxEl, ctx);
        }
    }
}
