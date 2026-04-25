/**
 * @vitest-environment happy-dom
 *
 * PresentationModeHandler — submission dispatch boundary tests.
 * Plan: docs/plans/slide-authoring-editing.md §"Submission contract":
 *   "tests assert that handleSubmit with no selection calls refineHtml,
 *    and with selection calls refineHtmlScoped"
 *
 * Audit R1 MEDIUM-3 fix.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRefineHtml = vi.fn();
const mockRefineHtmlScoped = vi.fn();
const mockGenerateHtmlStream = vi.fn();

vi.mock('../src/services/chat/presentationHtmlService', () => ({
    refineHtml: (...args: unknown[]) => mockRefineHtml(...args),
    refineHtmlScoped: (...args: unknown[]) => mockRefineHtmlScoped(...args),
    generateHtmlStream: (...args: unknown[]) => mockGenerateHtmlStream(...args),
    runBrandAudit: vi.fn(),
}));

vi.mock('../src/services/llmFacade', () => ({
    pluginContext: () => ({ type: 'mock' }),
}));

vi.mock('../src/services/chat/slideContextProvider', () => ({
    DefaultSlideContextProvider: class { },
}));

vi.mock('../src/services/research/researchSearchService', () => ({
    ResearchSearchService: class { },
}));

vi.mock('../src/services/privacyNotice', () => ({
    ensurePrivacyConsent: () => Promise.resolve(true),
}));

vi.mock('../src/services/chat/brandThemeService', () => ({
    isBrandAvailable: () => false,
    resolveTheme: () => Promise.resolve({ css: '', auditChecklist: [], promptRules: '' }),
}));

import { PresentationModeHandler } from '../src/ui/chat/PresentationModeHandler';
import type { SelectionScope } from '../src/services/chat/presentationTypes';

const STUB_DECK = '<div class="deck"><section class="slide"><h1>Q3</h1></section></div>';

function makeHandler(): PresentationModeHandler {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const h = new PresentationModeHandler();
    // Inject canonical HTML so the dispatch enters the html-present branches.
    (h as any).html = STUB_DECK;
    /* eslint-enable @typescript-eslint/no-explicit-any */
    return h;
}

function buildCtx() {
    return {
        app: {} as never,
        plugin: {
            t: { modals: { unifiedChat: {
                presentationBusy: 'busy',
                generationCancelled: 'cancelled',
                phaseGenerating: 'gen',
                phaseRefining: 'ref',
                phaseAuditing: 'aud',
                phaseExporting: 'exp',
                slideEditNoDeck: 'No presentation to edit.',
                slideEditFailed: 'Failed: {error}',
                slideEditApplied: 'Applied. {n} slides{drift}.',
                slideEditDriftSuffix: ' ({n} drift{s})',
                slideEditRejected: 'Rejected.',
                slideRefineNoDeck: 'No presentation to refine.',
                slideRefineFailed: 'Refine failed: {error}',
                slideRefineApplied: 'Updated. {n} slides.',
                slideGenerateFailed: 'Gen failed: {error}',
                slidePreviewEmpty: 'empty',
            } } },
            settings: { summaryLanguage: 'English', cloudServiceType: 'claude' },
        } as never,
        fullPlugin: {
            settings: { summaryLanguage: 'English', cloudServiceType: 'claude' },
        } as never,
        options: { noteContent: '' },
    } as never;
}

describe('PresentationModeHandler — submission dispatch (R1 MEDIUM-3 fix)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockRefineHtml.mockResolvedValue({ ok: true, value: STUB_DECK });
        mockRefineHtmlScoped.mockResolvedValue({
            ok: true,
            value: {
                newHtml: STUB_DECK,
                scopeDiff: { scope: { kind: 'slide', slideIndex: 0 }, oldFragment: '', newFragment: '', textDiff: [] },
                outOfScopeDrift: [],
                structuralIntegrity: 'preserved',
            },
        });
    });

    it('calls refineHtml when no selection is set', async () => {
        const h = makeHandler();
        const result = await h.buildPrompt('make slide 1 bolder', '', buildCtx());

        // Drive the streaming path manually to exercise the dispatch.
        const streamCb = {
            updateMessage: vi.fn(),
            addSystemNotice: vi.fn(),
            updateThinking: vi.fn(),
            showCancelButton: vi.fn(),
        } as never;
        await result.streamingSetup?.start(streamCb);

        expect(mockRefineHtml).toHaveBeenCalledTimes(1);
        expect(mockRefineHtmlScoped).not.toHaveBeenCalled();
    });

    it('calls refineHtmlScoped when a selection is set', async () => {
        const h = makeHandler();
        const scope: SelectionScope = { kind: 'slide', slideIndex: 0 };
        h.setSelectionForTesting(scope);

        const result = await h.buildPrompt('rewrite this', '', buildCtx());

        // refineHtmlScoped path opens a SlideDiffModal — we don't drive
        // the modal in this test (it would require an Obsidian Modal mock
        // with full DOM). Instead we abort right after the LLM call by
        // asserting the call happened. The handler then awaits the modal
        // Promise indefinitely; that's fine — the test ends with the
        // assertion, and vitest's async cleanup tears down the handler.
        const streamCb = {
            updateMessage: vi.fn(),
            addSystemNotice: vi.fn(),
            updateThinking: vi.fn(),
            showCancelButton: vi.fn(),
        } as never;

        // Don't await — let the start() promise hang on the modal Promise.
        // We just need to verify the LLM dispatch routed correctly.
        void result.streamingSetup?.start(streamCb);
        // Microtask flush so the synchronous calls inside start() complete.
        await new Promise((r) => setTimeout(r, 10));

        expect(mockRefineHtmlScoped).toHaveBeenCalledTimes(1);
        expect(mockRefineHtml).not.toHaveBeenCalled();
    });
});
