/**
 * @vitest-environment happy-dom
 *
 * refineHtmlScoped service-level integration tests.
 * Plan: docs/plans/slide-authoring-editing-backend.md §"Service signatures"
 *
 * Mocks the LLM facade and SlideContextProvider so we exercise the
 * orchestration: context gathering, preflight gate, prompt dispatch,
 * sanitisation, post-validation diff classification.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockSummarizeText = vi.fn();
const mockSummarizeTextStream = vi.fn();

vi.mock('../src/services/llmFacade', () => ({
    summarizeText: (...args: unknown[]) => mockSummarizeText(...args),
    summarizeTextStream: (...args: unknown[]) => mockSummarizeTextStream(...args),
    pluginContext: () => ({ type: 'mock' }),
}));

import { refineHtmlScoped } from '../src/services/chat/presentationHtmlService';
import type { SlideContextProvider } from '../src/services/chat/slideContextProvider';
import type { BrandTheme } from '../src/services/chat/brandThemeService';
import type {
    SelectionScope, EditMode, EditFlags,
} from '../src/services/chat/presentationTypes';
import { HTML_START_MARKER, HTML_END_MARKER } from '../src/services/chat/presentationConstants';

const THEME: BrandTheme = {
    css: '.deck { color: black; }',
    auditChecklist: [],
    promptRules: '',
} as never;

const ORIGINAL_DECK = `<div class="deck">
<section class="slide slide-title"><h1>Q3 Update</h1></section>
<section class="slide slide-content">
<h1>Headline</h1>
<ul><li>Revenue +12%</li><li>Margin held flat</li><li>Capex up 4%</li></ul>
</section>
</div>`;

function makeMockProvider(overrides: Partial<SlideContextProvider> = {}): SlideContextProvider {
    return {
        fetchWebResearch: vi.fn().mockResolvedValue(''),
        readReferences: vi.fn().mockResolvedValue(''),
        readFolder: vi.fn().mockResolvedValue(''),
        ...overrides,
    };
}

function buildLLMResponse(deckHtml: string): string {
    return `${HTML_START_MARKER}\n${deckHtml}\n${HTML_END_MARKER}`;
}

const SLIDE_SCOPE: SelectionScope = { kind: 'slide', slideIndex: 1 };
const FLAGS_OFF: EditFlags = { webSearch: false, references: [] };

describe('refineHtmlScoped — happy path', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns ok with newHtml + scopeDiff for a content edit', async () => {
        const newDeck = ORIGINAL_DECK.replace('Revenue +12%', 'Revenue +14%');
        mockSummarizeText.mockResolvedValueOnce({ success: true, content: buildLLMResponse(newDeck) });

        const result = await refineHtmlScoped({} as never, {
            currentHtml: ORIGINAL_DECK,
            scope: SLIDE_SCOPE,
            mode: 'content',
            userRequest: 'update Q3 figures',
            flags: FLAGS_OFF,
            contextProvider: makeMockProvider(),
            theme: THEME,
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.newHtml).toContain('Revenue +14%');
        expect(result.value.scopeDiff.scope).toEqual(SLIDE_SCOPE);
        expect(result.value.outOfScopeDrift).toEqual([]);
        expect(result.value.structuralIntegrity).toBe('preserved');
    });

    it('skips context gathering for design mode', async () => {
        mockSummarizeText.mockResolvedValueOnce({ success: true, content: buildLLMResponse(ORIGINAL_DECK) });
        const provider = makeMockProvider();

        await refineHtmlScoped({} as never, {
            currentHtml: ORIGINAL_DECK,
            scope: SLIDE_SCOPE,
            mode: 'design',
            userRequest: 'restyle as 2-column',
            flags: { webSearch: true, references: ['x.md'] },  // flags ignored in design mode
            contextProvider: provider,
            theme: THEME,
        });

        expect(provider.fetchWebResearch).not.toHaveBeenCalled();
        expect(provider.readReferences).not.toHaveBeenCalled();
    });

    it('gathers context in parallel for content mode with both flags on', async () => {
        mockSummarizeText.mockResolvedValueOnce({ success: true, content: buildLLMResponse(ORIGINAL_DECK) });
        const provider = makeMockProvider({
            fetchWebResearch: vi.fn().mockResolvedValue('[1] result'),
            readReferences: vi.fn().mockResolvedValue('<reference_note path="x.md">x</reference_note>'),
        });

        const result = await refineHtmlScoped({} as never, {
            currentHtml: ORIGINAL_DECK,
            scope: SLIDE_SCOPE,
            mode: 'content',
            userRequest: 'update',
            flags: { webSearch: true, references: ['x.md'] },
            contextProvider: provider,
            theme: THEME,
        });

        expect(result.ok).toBe(true);
        expect(provider.fetchWebResearch).toHaveBeenCalledTimes(1);
        expect(provider.readReferences).toHaveBeenCalledTimes(1);
    });
});

describe('refineHtmlScoped — failure modes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns Aborted when signal is fired before LLM call', async () => {
        const ac = new AbortController();
        ac.abort();
        const result = await refineHtmlScoped({} as never, {
            currentHtml: ORIGINAL_DECK,
            scope: SLIDE_SCOPE,
            mode: 'content',
            userRequest: 'update',
            flags: FLAGS_OFF,
            contextProvider: makeMockProvider(),
            theme: THEME,
            signal: ac.signal,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toBe('Aborted');
        expect(mockSummarizeText).not.toHaveBeenCalled();
    });

    it('returns err when LLM returns non-extractable HTML', async () => {
        mockSummarizeText.mockResolvedValueOnce({ success: true, content: 'no markers here just text' });
        const result = await refineHtmlScoped({} as never, {
            currentHtml: ORIGINAL_DECK,
            scope: SLIDE_SCOPE,
            mode: 'content',
            userRequest: 'update',
            flags: FLAGS_OFF,
            contextProvider: makeMockProvider(),
            theme: THEME,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/failed to extract html/i);
    });

    it('returns err when LLM call itself fails', async () => {
        mockSummarizeText.mockResolvedValueOnce({ success: false, error: 'rate limited' });
        const result = await refineHtmlScoped({} as never, {
            currentHtml: ORIGINAL_DECK,
            scope: SLIDE_SCOPE,
            mode: 'content',
            userRequest: 'update',
            flags: FLAGS_OFF,
            contextProvider: makeMockProvider(),
            theme: THEME,
        });
        expect(result.ok).toBe(false);
    });

    it('returns err when web search throws (caller can retry without web search)', async () => {
        const provider = makeMockProvider({
            fetchWebResearch: vi.fn().mockRejectedValue(new Error('network down')),
        });
        const result = await refineHtmlScoped({} as never, {
            currentHtml: ORIGINAL_DECK,
            scope: SLIDE_SCOPE,
            mode: 'content',
            userRequest: 'update',
            flags: { webSearch: true, references: [] },
            contextProvider: provider,
            theme: THEME,
        });
        expect(result.ok).toBe(false);
        expect(mockSummarizeText).not.toHaveBeenCalled();
    });

    it('fails closed when scope no longer resolves (R5 HIGH-2 fix)', async () => {
        // Element scope referencing a path that doesn't exist in the deck.
        // Without the fail-closed guard the orchestrator would happily build
        // a prompt with an empty <scoped_fragment> and tell the LLM to
        // "modify the indicated region" — silently widening scope to the
        // whole deck. The orchestrator must detect the empty fragment
        // and return err() BEFORE the LLM is called.
        const result = await refineHtmlScoped({} as never, {
            currentHtml: ORIGINAL_DECK,
            scope: {
                kind: 'element',
                slideIndex: 1,
                elementPath: 'slide-1.figure-99',  // doesn't exist
                elementKind: 'figure',
            },
            mode: 'content',
            userRequest: 'update the chart',
            flags: FLAGS_OFF,
            contextProvider: makeMockProvider(),
            theme: THEME,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/no longer resolves|reselect/i);
        // Critical: the LLM must NOT be called when scope is unresolvable.
        expect(mockSummarizeText).not.toHaveBeenCalled();
    });

    it('fails closed for out-of-bounds slide scope (R5 HIGH-2 fix)', async () => {
        const result = await refineHtmlScoped({} as never, {
            currentHtml: ORIGINAL_DECK,
            scope: { kind: 'slide', slideIndex: 99 },  // only 2 slides exist
            mode: 'content',
            userRequest: 'edit',
            flags: FLAGS_OFF,
            contextProvider: makeMockProvider(),
            theme: THEME,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/no longer resolves|reselect/i);
        expect(mockSummarizeText).not.toHaveBeenCalled();
    });

    it('rejects when prompt would exceed hard limit', async () => {
        // Single-slide deck with massive content — content-mode fragment
        // becomes the slide outerHTML (~130K chars), plus overhead pushes
        // us past the 120K hard limit.
        const huge = `<div class="deck"><section class="slide"><h1>x</h1><p>${'x'.repeat(130_000)}</p></section></div>`;
        const result = await refineHtmlScoped({} as never, {
            currentHtml: huge,
            scope: { kind: 'slide', slideIndex: 0 },
            mode: 'content',
            userRequest: 'edit',
            flags: FLAGS_OFF,
            contextProvider: makeMockProvider(),
            theme: THEME,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/size limit|narrower|polish whole deck/i);
        expect(mockSummarizeText).not.toHaveBeenCalled();
    });
});

describe('refineHtmlScoped — drift detection', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('reports outOfScopeDrift when LLM rewrites adjacent slides', async () => {
        const drifted = ORIGINAL_DECK
            .replace('Revenue +12%', 'Revenue +14%')          // in-scope (slide 1)
            .replace('Q3 Update', 'Q3 Update — REVISED');      // out-of-scope (slide 0)
        mockSummarizeText.mockResolvedValueOnce({ success: true, content: buildLLMResponse(drifted) });

        const result = await refineHtmlScoped({} as never, {
            currentHtml: ORIGINAL_DECK,
            scope: SLIDE_SCOPE,
            mode: 'content',
            userRequest: 'update Q3 figures only',
            flags: FLAGS_OFF,
            contextProvider: makeMockProvider(),
            theme: THEME,
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.outOfScopeDrift).toHaveLength(1);
        expect(result.value.outOfScopeDrift[0].slideIndex).toBe(0);
        expect(result.value.outOfScopeDrift[0].severity).toBe('text');
    });

    it('reports slides-added structural integrity', async () => {
        const grew = ORIGINAL_DECK.replace('</div>', '<section class="slide"><h1>Bonus</h1></section></div>');
        mockSummarizeText.mockResolvedValueOnce({ success: true, content: buildLLMResponse(grew) });

        const result = await refineHtmlScoped({} as never, {
            currentHtml: ORIGINAL_DECK,
            scope: SLIDE_SCOPE,
            mode: 'content',
            userRequest: 'add a slide please',
            flags: FLAGS_OFF,
            contextProvider: makeMockProvider(),
            theme: THEME,
        });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.structuralIntegrity).toBe('slides-added');
    });

    it('strips echoed data-element attributes from the response (defensive)', async () => {
        const echoed = '<div class="deck" data-element="deck"><section class="slide" data-element="slide-0"><h1>x</h1></section></div>';
        mockSummarizeText.mockResolvedValueOnce({ success: true, content: buildLLMResponse(echoed) });

        const result = await refineHtmlScoped({} as never, {
            currentHtml: ORIGINAL_DECK,
            scope: { kind: 'slide', slideIndex: 0 },
            mode: 'design',
            userRequest: 'restyle',
            flags: FLAGS_OFF,
            contextProvider: makeMockProvider(),
            theme: THEME,
        });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.newHtml).not.toContain('data-element');
    });
});
