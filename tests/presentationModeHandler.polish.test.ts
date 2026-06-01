/**
 * Handler routing seam for per-slide polish (plan §9.1, audit-r1 M6).
 *
 * The modal + service work in isolation while the wiring can still fail
 * (wrong route, bypassed bypass, state mutation on error). This drives
 * `handlePolish` directly with mocked collaborators.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock boundaries ─────────────────────────────────────────────────────────
vi.mock('../src/ui/modals/PolishSelectorModal', () => ({
    PolishSelectorModal: vi.fn(function (this: Record<string, unknown>, _app, deck, findings, t, opts) {
        this.deck = deck;
        this.findings = findings;
        this.t = t;
        this.opts = opts;
        this.open = vi.fn();
        this.close = vi.fn();
    }),
}));

vi.mock('../src/services/chat/refineDeckIrSelective', async (orig) => {
    const actual = await (orig() as Promise<Record<string, unknown>>);
    return { ...actual, refineDeckIrSelective: vi.fn() };
});

vi.mock('../src/services/chat/presentationHtmlService', async (orig) => {
    const actual = await (orig() as Promise<Record<string, unknown>>);
    const { ok } = await import('../src/core/result');
    return { ...actual, buildHtmlFromDeckIr: vi.fn(() => ok('<refined-html>')) };
});

vi.mock('../src/services/progress', async (orig) => {
    const actual = await (orig() as Promise<Record<string, unknown>>);
    return {
        ...actual,
        withProgressResult: vi.fn(async (_opts: unknown, op: (r: unknown) => Promise<unknown>) => op({ setPhase: () => {} })),
    };
});

vi.mock('../src/services/export/exportTheme', () => ({ resolveTheme: vi.fn(() => ({})) }));

import { PresentationModeHandler } from '../src/ui/chat/PresentationModeHandler';
import { PolishSelectorModal } from '../src/ui/modals/PolishSelectorModal';
import { refineDeckIrSelective } from '../src/services/chat/refineDeckIrSelective';
import { App } from './mocks/obsidian';
import { coffeeDeckIr } from './fixtures/coffeeDeckIr';
import { en } from '../src/i18n/en';
import { ok, err } from '../src/core/result';
import { IR_SCHEMA_VERSION, type SlideDeckIr } from '../src/services/presentationIr/slideIr';

const PolishSelectorModalMock = PolishSelectorModal as unknown as ReturnType<typeof vi.fn>;
const refineDeckIrSelectiveMock = refineDeckIrSelective as unknown as ReturnType<typeof vi.fn>;

function makeSettings(extra: Record<string, unknown> = {}) {
    return {
        presentationExportEngine: 'structured-ir',
        summaryLanguage: 'en',
        aichatRefinementPasses: 1,
        exportColorScheme: 'navy-gold',
        exportPrimaryColor: '1A3A5C',
        exportAccentColor: 'F5C842',
        exportFontFace: 'Noto Sans',
        exportFontSize: 14,
        serviceType: 'cloud',
        cloudServiceType: 'claude',
        cloudModel: 'claude-opus-4-8',
        pluginFolder: 'AI-Organiser',
        configFolderPath: 'Config',
        ...extra,
    };
}

function makeCtx(settings = makeSettings()) {
    const llmService = { summarizeText: vi.fn() };
    const plugin = { t: en, settings, llmService };
    const fullPlugin = { t: en, settings, llmService };
    return { app: new App(), plugin, fullPlugin, options: {} } as never;
}

function makeCallbacks() {
    return {
        addAssistantMessage: vi.fn(),
        updateAssistantMessage: vi.fn(),
        addSystemNotice: vi.fn(),
        showThinking: vi.fn(),
        hideThinking: vi.fn(),
        rerenderActions: vi.fn(),
        getEditor: vi.fn(() => null),
        notify: vi.fn(),
    } as never;
}

function makeHandler(state: Record<string, unknown> = {}): PresentationModeHandler {
    const h = new PresentationModeHandler();
    Object.assign(h as unknown as Record<string, unknown>, {
        html: '<deck>',
        deckIr: coffeeDeckIr,
        deckIrStale: false,
        qualityResult: null,
        preview: null,
        brandTheme: { css: '', auditChecklist: [], promptRules: '' },
        brandEnabled: false,
        ...state,
    });
    // The multi-slide Polish path runs an autodetect pre-scan before opening the
    // modal; stub the LLM fast scan so routing tests stay deterministic.
    vi.spyOn(h as any, 'runBackgroundQualityScan').mockResolvedValue(undefined);
    return h;
}

const oneSlideDeck: SlideDeckIr = {
    schemaVersion: IR_SCHEMA_VERSION,
    title: 'Solo',
    slides: [{ id: 's1', type: 'content', title: 'Only slide', blocks: [{ kind: 'paragraph', text: 'hi' }] }],
};

beforeEach(() => {
    PolishSelectorModalMock.mockClear();
    refineDeckIrSelectiveMock.mockReset();
});

describe('handlePolish — routing', () => {
    it('single-slide IR deck bypasses the modal and runs whole-deck polish', async () => {
        const handler = makeHandler({ deckIr: oneSlideDeck });
        const polishSpy = vi.spyOn(handler as any, 'polishDeckIr').mockResolvedValue(undefined);
        await (handler as never as { handlePolish: (c: never, cb: never) => Promise<void> })
            .handlePolish(makeCtx(), makeCallbacks());
        expect(PolishSelectorModalMock).not.toHaveBeenCalled();
        expect(polishSpy).toHaveBeenCalledTimes(1);
    });

    it('legacy (non-IR) deck bypasses the modal', async () => {
        const handler = makeHandler({ deckIr: null });
        await (handler as never as { handlePolish: (c: never, cb: never) => Promise<void> })
            .handlePolish(makeCtx(), makeCallbacks());
        expect(PolishSelectorModalMock).not.toHaveBeenCalled();
        expect((handler as unknown as { deckIr: unknown }).deckIr).toBeNull();
    });

    it('multi-slide IR deck opens the selector modal', async () => {
        const handler = makeHandler();
        await (handler as never as { handlePolish: (c: never, cb: never) => Promise<void> })
            .handlePolish(makeCtx(), makeCallbacks());
        expect(PolishSelectorModalMock).toHaveBeenCalledTimes(1);
        const inst = PolishSelectorModalMock.mock.instances[0] as { open: ReturnType<typeof vi.fn> };
        expect(inst.open).toHaveBeenCalledTimes(1);
    });

    it('null qualityResult → modal opens with empty findings (no mutation)', async () => {
        const handler = makeHandler({ qualityResult: null });
        await (handler as never as { handlePolish: (c: never, cb: never) => Promise<void> })
            .handlePolish(makeCtx(), makeCallbacks());
        const inst = PolishSelectorModalMock.mock.instances[0] as { findings: unknown[] };
        expect(inst.findings).toEqual([]);
        expect((handler as unknown as { qualityResult: unknown }).qualityResult).toBeNull();
    });

    it('single-flight: a second Polish while a modal is open is a no-op', async () => {
        const handler = makeHandler();
        const call = () => (handler as never as { handlePolish: (c: never, cb: never) => Promise<void> })
            .handlePolish(makeCtx(), makeCallbacks());
        await call();
        await call();
        expect(PolishSelectorModalMock).toHaveBeenCalledTimes(1);
    });
});

describe('handlePolish — submit outcomes', () => {
    async function openAndGetOpts(handler: PresentationModeHandler) {
        await (handler as never as { handlePolish: (c: never, cb: never) => Promise<void> })
            .handlePolish(makeCtx(), makeCallbacks());
        const inst = PolishSelectorModalMock.mock.instances[0] as {
            opts: {
                onSubmit: (d: unknown, s: AbortSignal) => Promise<{ ok: true } | { ok: false; error: string }>;
                onClose: () => void;
            };
        };
        return inst.opts;
    }

    it('All slides → existing polishDeckIr, selective service NOT called', async () => {
        const handler = makeHandler();
        const polishSpy = vi.spyOn(handler as any, 'polishDeckIr').mockResolvedValue(undefined);
        const opts = await openAndGetOpts(handler);
        const res = await opts.onSubmit({ kind: 'all' }, new AbortController().signal);
        expect(res).toEqual({ ok: true });
        expect(polishSpy).toHaveBeenCalledTimes(1);
        expect(refineDeckIrSelectiveMock).not.toHaveBeenCalled();
    });

    it('selective success → replaces deck/html, invalidates stale findings, pushes version', async () => {
        const refined: SlideDeckIr = { ...coffeeDeckIr, title: 'Polished deck' };
        refineDeckIrSelectiveMock.mockResolvedValue(ok(refined));
        const handler = makeHandler({
            qualityResult: {
                structureScore: 5, auditScore: 5, totalScore: 50,
                findings: [
                    { slideIndex: 0, issue: 'a', suggestion: 'a2', severity: 'HIGH' },
                    { slideIndex: 2, issue: 'b', suggestion: 'b2', severity: 'MEDIUM' },
                    { slideIndex: 5, issue: 'c', suggestion: 'c2', severity: 'LOW' },
                    { issue: 'deck-wide', suggestion: 'd2', severity: 'LOW' },
                ],
            },
        });
        const opts = await openAndGetOpts(handler);
        const res = await opts.onSubmit(
            { kind: 'selective', selections: [
                { slideIndex: 0, instruction: 'tighten the timeline so it fits the slide' },
                { slideIndex: 2, instruction: 'shorten' },
            ] },
            new AbortController().signal,
        );
        expect(res).toEqual({ ok: true });

        const h = handler as unknown as {
            deckIr: SlideDeckIr; html: string;
            qualityResult: { findings: Array<{ slideIndex?: number }>; totalScore: number };
            versions: Array<{ userPrompt: string }>;
        };
        expect(h.deckIr).toBe(refined);
        expect(h.html).toBe('<refined-html>');
        // Changed-slide findings dropped; deck-wide + untouched (5) kept.
        const idxs = h.qualityResult.findings.map(f => f.slideIndex);
        expect(idxs).not.toContain(0);
        expect(idxs).not.toContain(2);
        expect(idxs).toContain(5);
        expect(idxs).toContain(undefined);
        expect(h.qualityResult.totalScore).toBe(0); // stale scores zeroed
        // Version pushed with 1-based slide numbers.
        expect(h.versions).toHaveLength(1);
        expect(h.versions[0].userPrompt).toMatch(/^Polish slides 1, 3 — '/);
    });

    it('selective error → no state mutation, returns localized error', async () => {
        refineDeckIrSelectiveMock.mockResolvedValue(err('malformed-json: bad output'));
        const handler = makeHandler();
        const opts = await openAndGetOpts(handler);
        const res = await opts.onSubmit(
            { kind: 'selective', selections: [{ slideIndex: 1, instruction: 'x' }] },
            new AbortController().signal,
        );
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.error).toBe(en.modals.polishSelector.errorByCode['malformed-json']);
        }
        const h = handler as unknown as { deckIr: SlideDeckIr; html: string; versions: unknown[] };
        expect(h.deckIr).toBe(coffeeDeckIr); // unchanged
        expect(h.html).toBe('<deck>');       // unchanged
        expect(h.versions).toHaveLength(0);  // no version pushed
    });

    it('cancel (modal onClose) clears the single-flight record, no mutation', async () => {
        const handler = makeHandler();
        const opts = await openAndGetOpts(handler);
        opts.onClose();
        expect((handler as unknown as { activePolish: unknown }).activePolish).toBeNull();
        expect(refineDeckIrSelectiveMock).not.toHaveBeenCalled();
        // A subsequent Polish can open a fresh modal.
        await (handler as never as { handlePolish: (c: never, cb: never) => Promise<void> })
            .handlePolish(makeCtx(), makeCallbacks());
        expect(PolishSelectorModalMock).toHaveBeenCalledTimes(2);
    });
});
