/**
 * @vitest-environment happy-dom
 *
 * PresentationModeHandler — submission dispatch boundary tests.
 *
 * Post legacy-HTML-engine retirement (2026-06): the deck is always IR-backed,
 * so a no-selection refine routes to the IR refine (`refineDeckIr`) and a
 * scoped edit routes to the IR slice-refine (`refineDeckIrSelective`).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRefineDeckIr = vi.fn();
const mockRefineSelective = vi.fn();
const mockBuildHtml = vi.fn();

vi.mock('../src/services/chat/presentationHtmlService', () => ({
    refineDeckIr: (...args: unknown[]) => mockRefineDeckIr(...args),
    buildHtmlFromDeckIr: (...args: unknown[]) => mockBuildHtml(...args),
    refineHtml: vi.fn(),
    runBrandAudit: vi.fn(),
    generateDeckIr: vi.fn(),
}));

vi.mock('../src/services/chat/refineDeckIrSelective', () => ({
    refineDeckIrSelective: (...args: unknown[]) => mockRefineSelective(...args),
    parseRefineErrorCode: () => 'unexpected-exception',
}));

vi.mock('../src/services/export/exportTheme', () => ({ resolveTheme: () => ({}) }));

vi.mock('../src/services/chat/presentationQualityService', () => ({
    runFastScan: () => Promise.resolve({ ok: true, value: { findings: [] } }),
    deduplicateFindings: (a: unknown[]) => a,
}));

vi.mock('../src/services/llmFacade', () => ({
    pluginContext: () => ({ type: 'mock' }),
}));

vi.mock('../src/services/chat/brandThemeService', () => ({
    isBrandAvailable: () => false,
    resolveTheme: () => Promise.resolve({ css: '', auditChecklist: [], promptRules: '' }),
}));

import { PresentationModeHandler } from '../src/ui/chat/PresentationModeHandler';
import type { SelectionScope } from '../src/services/chat/presentationTypes';

const STUB_DECK = '<div class="deck"><section class="slide"><h1>Q3</h1></section></div>';
const STUB_IR = { schemaVersion: 1, slides: [{ id: 's1', type: 'content', blocks: [] }] };

function makeHandler(): PresentationModeHandler {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const h = new PresentationModeHandler();
    // Deck state lives on the PresentationDeckStore (TD-SSR-02 foundation).
    (h as any).deck.html = STUB_DECK;
    (h as any).deck.deckIr = STUB_IR;     // deck is always IR-backed now
    /* eslint-enable @typescript-eslint/no-explicit-any */
    return h;
}

function buildCtx() {
    return {
        app: {} as never,
        plugin: {
            t: { modals: { unifiedChat: {
                presentationBusy: 'busy', generationCancelled: 'cancelled',
                phaseGenerating: 'gen', phaseRefining: 'ref', phaseAuditing: 'aud', phaseExporting: 'exp',
                slideEditNoDeck: 'No presentation to edit.', slideEditFailed: 'Failed: {error}',
                slideEditApplied: 'Applied. {n} slides{drift}.', slideEditDriftSuffix: ' ({n} drift{s})',
                slideEditRejected: 'Rejected.', slideRefineNoDeck: 'No presentation to refine.',
                slideRefineFailed: 'Refine failed: {error}', slideRefineApplied: 'Updated. {n} slides.',
                slideGenerateFailed: 'Gen failed: {error}', slidePreviewEmpty: 'empty',
                presentationProgress: 'Slide {current} of {expected}',
                presentationProgressNoTotal: 'Slide {current}',
                presentationStarting: 'Starting…',
                presentationElapsedSeconds: '· {elapsed}s',
            } } },
            settings: { summaryLanguage: 'English', cloudServiceType: 'claude' },
        } as never,
        fullPlugin: {
            settings: { summaryLanguage: 'English', cloudServiceType: 'claude' },
        } as never,
        options: { noteContent: '' },
    } as never;
}

const streamCb = {
    updateMessage: vi.fn(), addSystemNotice: vi.fn(),
    updateThinking: vi.fn(), showCancelButton: vi.fn(),
} as never;

describe('PresentationModeHandler — IR submission dispatch', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockRefineDeckIr.mockResolvedValue({ ok: true, value: STUB_IR });
        mockRefineSelective.mockResolvedValue({ ok: true, value: STUB_IR });
        mockBuildHtml.mockReturnValue({ ok: true, value: STUB_DECK });
    });

    it('routes a no-selection refine to the IR refine (refineDeckIr)', async () => {
        const h = makeHandler();
        const result = await h.buildPrompt('make slide 1 bolder', '', buildCtx());
        await result.streamingSetup?.start(streamCb);

        expect(mockRefineDeckIr).toHaveBeenCalledTimes(1);
        expect(mockRefineSelective).not.toHaveBeenCalled();
    });

    it('routes a scoped edit to the IR slice-refine (refineDeckIrSelective)', async () => {
        const h = makeHandler();
        const scope: SelectionScope = { kind: 'slide', slideIndex: 0 };
        h.setSelectionForTesting(scope);

        const result = await h.buildPrompt('rewrite this', '', buildCtx());
        await result.streamingSetup?.start(streamCb);

        expect(mockRefineSelective).toHaveBeenCalledTimes(1);
        expect(mockRefineDeckIr).not.toHaveBeenCalled();
    });
});
