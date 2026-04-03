/**
 * Tests for unified chat helpers and mode handlers.
 */

import type { ChatMode, ChatModeHandler, ModalContext } from '../src/ui/chat/ChatModeHandler';
import { HighlightModeHandler } from '../src/ui/chat/HighlightModeHandler';
import { NoteModeHandler } from '../src/ui/chat/NoteModeHandler';
import { VaultModeHandler } from '../src/ui/chat/VaultModeHandler';
import {
    createHistoryMap,
    selectInitialMode,
    firstAvailableMode,
    nextGeneration,
    isStaleGeneration
} from '../src/ui/modals/UnifiedChatModal';
import type { Translations } from '../src/i18n/types';

function createMockTranslations(): Translations {
    return {
        modals: {
            unifiedChat: {
                title: 'Chat',
                modeNote: 'Note',
                modeVault: 'Vault',
                modeHighlight: 'Highlight',
                noteUnavailable: 'Note unavailable',
                vaultUnavailable: 'Vault unavailable',
                highlightUnavailable: 'Highlight unavailable',
                vaultFallbackNotice: 'Vault fallback',
                highlightFallbackNotice: 'Highlight fallback',
                discussingNote: 'Discussing: {title}',
                indexStatus: 'Index: {count} (v{version})',
                indexOutdated: 'Index outdated',
                passagesSummary: '{count} passages selected',
                placeholder: 'Ask...',
                placeholderNote: 'Ask note...',
                placeholderVault: 'Ask vault...',
                placeholderHighlight: 'Ask highlight...',
                introNote: 'Intro note',
                introVault: 'Intro vault',
                introHighlight: 'Intro highlight',
                send: 'Send',
                thinking: 'Thinking',
                clear: 'Clear',
                export: 'Export',
                insertLastAnswer: 'Insert Last Answer',
                insertSummary: 'Insert Summary',
                insertSummaryDesc: 'Insert summary desc',
                exportTitle: 'Export Chat',
                exportTitleVault: 'Chat with Vault — {date}',
                exportTitleNote: 'Chat about {noteTitle} — {date}',
                exportTitleHighlight: 'Chat about Highlights — {date}',
                exportSuccess: 'Exported {path}',
                exportEmpty: 'Empty',
                exportFailed: 'Failed {error}',
                searchingContext: 'Searching context',
                foundChunks: 'Found {count} chunks from {sources} sources',
                noContextFallback: 'No context',
                embeddingMissing: 'Embedding missing',
                errorOccurred: 'Error {error}',
                responseFailed: 'Response failed',
                chatCleared: 'Chat cleared',
                noEditor: 'No editor',
                noAnswerYet: 'No answer',
                summaryInserted: 'Summary inserted',
                answerInserted: 'Answer inserted',
                sourcesLabel: 'Sources:',
                selectPassages: 'Select passages',
                showAll: 'Show all',
                showHighlightsOnly: 'Show highlights',
                showingCount: 'Showing {visible} of {total}',
                selected: 'Selected: {count} (~{tokens}k)',
                noPassagesSelected: 'Select passages',
                startChat: 'Start chat',
                back: 'Back',
                noHighlightsFound: 'No highlights',
                requestCancelled: 'Cancelled',
                emptyState: 'Empty state'
            }
        }
    } as unknown as Translations;
}

function createMockContext(overrides: Partial<ModalContext> = {}): ModalContext {
    const t = createMockTranslations();
    const mockApp = {} as any;
    const mockFullPlugin = { t } as any;
    return {
        app: mockApp,
        plugin: {
            t,
            settings: { enableSemanticSearch: true },
            vectorStore: {},
            embeddingService: {},
        } as unknown as ModalContext['plugin'],
        fullPlugin: mockFullPlugin,
        options: {},
        vaultDocCount: 1,
        vaultIndexVersion: '2.0.0',
        hasEmbeddingService: true,
        semanticSearchEnabled: true,
        ...overrides
    };
}

function createStubHandler(available: boolean): ChatModeHandler {
    return {
        mode: 'note',
        isAvailable: () => available,
        unavailableReason: () => 'unavailable',
        getIntroMessage: () => 'intro',
        getPlaceholder: () => 'placeholder',
        renderContextPanel: () => {},
        buildPrompt: async () => ({ prompt: 'ok' }),
        getActionDescriptors: () => [],
        dispose: () => {}
    } as ChatModeHandler;
}

describe('unified chat helpers', () => {
    it('selectInitialMode honors requested mode when available', () => {
        const ctx = createMockContext({ options: { initialMode: 'vault' } });
        const handlers = new Map<ChatMode, ChatModeHandler>([
            ['note', createStubHandler(false)],
            ['vault', createStubHandler(true)],
            ['highlight', createStubHandler(false)]
        ]);
        expect(selectInitialMode(ctx, handlers)).toBe('vault');
    });

    it('selectInitialMode prefers highlight when selection exists', () => {
        const ctx = createMockContext({ options: { editorSelection: 'Selected text' } });
        const handlers = new Map<ChatMode, ChatModeHandler>([
            ['note', createStubHandler(true)],
            ['vault', createStubHandler(true)],
            ['highlight', createStubHandler(false)]
        ]);
        expect(selectInitialMode(ctx, handlers)).toBe('highlight');
    });

    it('selectInitialMode chooses highlight when note content has highlights', () => {
        const ctx = createMockContext({ options: { noteContent: 'Some ==highlighted== text' } });
        const handlers = new Map<ChatMode, ChatModeHandler>([
            ['note', createStubHandler(true)],
            ['vault', createStubHandler(true)],
            ['highlight', createStubHandler(false)]
        ]);
        expect(selectInitialMode(ctx, handlers)).toBe('highlight');
    });

    it('selectInitialMode falls back to vault when available', () => {
        const ctx = createMockContext({ options: {} });
        const handlers = new Map<ChatMode, ChatModeHandler>([
            ['note', createStubHandler(false)],
            ['vault', createStubHandler(true)],
            ['highlight', createStubHandler(false)]
        ]);
        expect(selectInitialMode(ctx, handlers)).toBe('vault');
    });

    it('selectInitialMode falls back to note when nothing else available', () => {
        const ctx = createMockContext({ options: { noteContent: 'Note content' } });
        const handlers = new Map<ChatMode, ChatModeHandler>([
            ['note', createStubHandler(true)],
            ['vault', createStubHandler(false)],
            ['highlight', createStubHandler(false)]
        ]);
        expect(selectInitialMode(ctx, handlers)).toBe('note');
    });

    it('firstAvailableMode returns null when no mode is available', () => {
        const ctx = createMockContext();
        const handlers = new Map<ChatMode, ChatModeHandler>([
            ['note', createStubHandler(false)],
            ['vault', createStubHandler(false)],
            ['highlight', createStubHandler(false)]
        ]);
        expect(firstAvailableMode(ctx, handlers)).toBeNull();
    });

    it('request generation helpers detect stale responses', () => {
        let gen = 0;
        gen = nextGeneration(gen);
        const requestGen = gen;
        gen = nextGeneration(gen);
        expect(isStaleGeneration(requestGen, gen)).toBe(true);
    });

    it('history map keeps per-mode histories', () => {
        const history = createHistoryMap();
        history.get('note')?.push({ role: 'user', content: 'Note Q', timestamp: 1 });
        history.get('vault')?.push({ role: 'assistant', content: 'Vault A', timestamp: 2 });
        history.get('note')!.length = 0;
        expect(history.get('note')?.length).toBe(0);
        expect(history.get('vault')?.length).toBe(1);
    });
});

describe('mode handler availability', () => {
    it('NoteModeHandler is available with note content', () => {
        const handler = new NoteModeHandler();
        const ctx = createMockContext({ options: { noteContent: 'Hello' } });
        expect(handler.isAvailable(ctx)).toBe(true);
    });

    it('VaultModeHandler requires semantic search and docs', () => {
        const handler = new VaultModeHandler();
        const ctx = createMockContext({ vaultDocCount: 0 });
        expect(handler.isAvailable(ctx)).toBe(false);
    });

    it('HighlightModeHandler detects highlights in note content', () => {
        const handler = new HighlightModeHandler();
        const ctx = createMockContext({ options: { noteContent: 'This is ==highlighted==.' } });
        expect(handler.isAvailable(ctx)).toBe(true);
    });

    it('HighlightModeHandler exposes insert-summary action when passages selected', async () => {
        const handler = new HighlightModeHandler();
        const ctx = createMockContext({ options: { editorSelection: 'Selected passage', noteTitle: 'Note' } });
        await handler.buildPrompt('Q', '', ctx);
        const actions = handler.getActionDescriptors(createMockTranslations());
        expect(actions[0].id).toBe('insert-summary');
        expect(actions[0].isEnabled).toBe(true);
        handler.dispose();
        const afterDispose = handler.getActionDescriptors(createMockTranslations());
        expect(afterDispose[0].isEnabled).toBe(false);
    });
});
