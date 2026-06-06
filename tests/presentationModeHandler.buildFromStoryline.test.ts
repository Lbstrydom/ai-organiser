/**
 * B3 — buildFromStorylineNote: rebuild a deck from a saved storyline note,
 * decoupled from the in-memory gate (presentation-demo-fixes).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/services/chat/consultantStoryboardPipeline', async (orig) => {
    const actual = await (orig() as Promise<Record<string, unknown>>);
    const { ok } = await import('../src/core/result');
    const { coffeeDeckIr } = await import('./fixtures/coffeeDeckIr');
    return {
        ...actual,
        buildDeckFromStoryline: vi.fn(() => ok({ deck: coffeeDeckIr, grounding: {}, audit: { findings: [] }, comments: [] })),
    };
});
vi.mock('../src/services/chat/presentationHtmlService', async (orig) => {
    const actual = await (orig() as Promise<Record<string, unknown>>);
    const { ok } = await import('../src/core/result');
    return { ...actual, buildHtmlFromDeckIr: vi.fn(() => ok('<deck-html>')) };
});
vi.mock('../src/services/chat/brandThemeService', async (orig) => {
    const actual = await (orig() as Promise<Record<string, unknown>>);
    return { ...actual, resolveTheme: vi.fn(async () => ({ css: '', auditChecklist: [], promptRules: '' })) };
});

import { PresentationModeHandler } from '../src/ui/chat/PresentationModeHandler';
import { buildDeckFromStoryline } from '../src/services/chat/consultantStoryboardPipeline';
import { TFile, mockNotices, clearMockNotices } from './mocks/obsidian';
import { en } from '../src/i18n/en';
import { ok, err } from '../src/core/result';

const buildDeckMock = buildDeckFromStoryline as unknown as ReturnType<typeof vi.fn>;

const STORYLINE_MD = [
    '# Deck',
    '## EMEA — the so-what',
    '<!-- aio-slide:1 eyJpZCI6InMxIn0= -->',
    '- core message',
].join('\n');

function makeCtx(fileContent: string, file: unknown) {
    const settings = { summaryLanguage: 'en', pluginFolder: 'AI-Organiser', presentationOutputFolder: 'Presentations' };
    const app = {
        vault: {
            getAbstractFileByPath: vi.fn(() => file),
            read: vi.fn(async () => fileContent),
        },
        workspace: {},
    };
    const plugin = { t: en, settings };
    return { app, plugin, fullPlugin: { t: en, settings, llmService: { summarizeText: vi.fn() } }, options: {} } as never;
}

function makeFile(path = 'AI-Organiser/Presentations/Deck — storyline.md', basename = 'Deck — storyline') {
    const f = Object.create(TFile.prototype);
    f.path = path; f.basename = basename;
    return f;
}

function makeHandler(): PresentationModeHandler {
    const h = new PresentationModeHandler();
    vi.spyOn(h as never as { runBackgroundQualityScan: (...a: unknown[]) => Promise<void> }, 'runBackgroundQualityScan')
        .mockResolvedValue(undefined);
    vi.spyOn((h as unknown as { themeResolver: { resolve: (...a: unknown[]) => Promise<unknown> } }).themeResolver, 'resolve')
        .mockResolvedValue({});
    return h;
}

beforeEach(() => {
    clearMockNotices();
    buildDeckMock.mockReset();
    buildDeckMock.mockImplementation(async () => undefined);
});

describe('B3 buildFromStorylineNote', () => {
    it('valid storyline → commits a new deck (html set, version pushed, slide reset) + clears the in-memory gate', async () => {
        buildDeckMock.mockReturnValue(ok({ deck: (await import('./fixtures/coffeeDeckIr')).coffeeDeckIr, grounding: {}, audit: { findings: [] }, comments: [] }));
        const h = makeHandler();
        const probe = h as unknown as { deck: { html: string; deckIr: unknown; activeSlideIndex: number; versions: unknown[] }; pendingStoryline: unknown };
        probe.pendingStoryline = { catalog: [], notePath: 'old', deckName: 'A' };
        const file = makeFile();
        await h.buildFromStorylineNote(makeCtx(STORYLINE_MD, file), file.path);
        expect(probe.deck.html).toBe('<deck-html>');
        expect(probe.deck.deckIr).not.toBeNull();
        expect(probe.deck.activeSlideIndex).toBe(0);
        expect(probe.deck.versions.length).toBe(1);
        expect(probe.pendingStoryline).toBeNull();   // Gemini-G2 resync
    });

    it('non-storyline note → notifies + builds nothing', async () => {
        const h = makeHandler();
        const file = makeFile('notes/plain.md', 'plain');
        await h.buildFromStorylineNote(makeCtx('# Just notes\n\n- nothing here', file), file.path);
        expect(mockNotices).toContain(en.modals.unifiedChat.storylineNoteRequired);
        expect(buildDeckMock).not.toHaveBeenCalled();
    });

    it('malformed storyline (parse err) → notifies the parse error', async () => {
        buildDeckMock.mockReturnValue(err('bad anchor'));
        const h = makeHandler();
        const file = makeFile();
        await h.buildFromStorylineNote(makeCtx(STORYLINE_MD, file), file.path);
        expect(mockNotices.some((m) => m.includes('bad anchor'))).toBe(true);
    });

    it('missing file → notifies storyline-required', async () => {
        const h = makeHandler();
        await h.buildFromStorylineNote(makeCtx(STORYLINE_MD, null), 'gone.md');
        expect(mockNotices).toContain(en.modals.unifiedChat.storylineNoteRequired);
    });
});
