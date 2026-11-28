/**
 * Storyline notes honour protected folders; an operation that was cancelled
 * cannot release or commit over the one that replaced it; polish holds the run
 * lock while it works.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    return { ...actual, withProgressResult: vi.fn(async (_o: unknown, op: (r: unknown) => Promise<unknown>) => op({ setPhase: () => {} })) };
});
vi.mock('../src/services/export/exportTheme', () => ({ resolveTheme: vi.fn(() => ({})) }));

import { PresentationModeHandler } from '../src/ui/chat/PresentationModeHandler';
import { PresentationRunController } from '../src/ui/chat/presentation/presentationRunController';
import { refineDeckIrSelective } from '../src/services/chat/refineDeckIrSelective';
import { migrateOldSettings } from '../src/core/settings';
import { App, TFile } from './mocks/obsidian';
import { coffeeDeckIr } from './fixtures/coffeeDeckIr';
import { en } from '../src/i18n/en';
import { ok } from '../src/core/result';

const refine = refineDeckIrSelective as unknown as ReturnType<typeof vi.fn>;
const T = en.modals.unifiedChat;

function deferred<V>() {
    let resolve!: (v: V) => void;
    const promise = new Promise<V>((r) => { resolve = r; });
    return { promise, resolve };
}
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

type Inner = Record<string, any>;
function makeHandler(): Inner {
    const h = new PresentationModeHandler() as unknown as Inner;
    Object.assign(h.deck, { html: '<deck>', deckIr: coffeeDeckIr, phase: 'preview-ready' });
    return h;
}

describe('run ownership', () => {
    it('a cancelled operation\'s late cleanup leaves the new operation locked', () => {
        const run = new PresentationRunController();
        const first = run.begin(() => {}, T);
        run.abort();
        run.end(); // user cancel force-releases
        run.begin(() => {}, T);
        run.end(first);
        expect(run.isLocked()).toBe(true);
    });

    it('the same holds for a plain lock', () => {
        const run = new PresentationRunController();
        const first = run.lock();
        run.end();
        const second = run.lock();
        run.unlock(first);
        expect(run.isLocked()).toBe(true);
        run.unlock(second);
        expect(run.isLocked()).toBe(false);
    });

    it('through the chat: cancel, start again, the first run finishing does not unlock', async () => {
        const h = makeHandler();
        const gates = [deferred<unknown>(), deferred<unknown>()];
        let call = 0;
        Object.assign(h, {
            getLLMContext: () => ({}), getTheme: async () => ({}), truncateNoteContent: () => undefined,
            buildProjectContextPrefix: () => '', runRefine: () => gates[call++].promise,
        });
        h.editScope.getSelection = () => null;
        const ctx = { plugin: { t: en } };
        const start = async () => (await h.buildPrompt('go', '', ctx)).streamingSetup.start({ updateThinking: () => {} });

        const first = start();
        await tick();
        h.cancelActiveOperation();
        const second = start();
        await tick();
        gates[0].resolve({ finalContent: '' });
        await first;
        expect(h.run.isLocked()).toBe(true);
        gates[1].resolve({ finalContent: '' });
        await second;
        expect(h.run.isLocked()).toBe(false);
    });
});

describe('selective polish', () => {
    beforeEach(() => refine.mockReset());
    const ctx = () => {
        const settings = { summaryLanguage: 'en', cloudServiceType: 'claude', cloudModel: 'm', pluginFolder: 'AI-Organiser' };
        const plugin = { t: en, settings };
        return { app: new App(), plugin, fullPlugin: { ...plugin, withForeground: (f: () => unknown) => f() }, options: {} };
    };
    const draft = { kind: 'selected', selections: [{ slideIndex: 0, instruction: 'tighten' }] };
    const submit = (h: Inner, signal = new AbortController().signal) => {
        h.getTheme = async () => ({ css: '' });
        h.themeResolver = { resolve: async () => ({}) };
        h.runBackgroundQualityScan = async () => {};
        return h.runPolishSubmit(ctx(), {}, draft, signal);
    };

    it('holds the run lock while it works and releases it after', async () => {
        const h = makeHandler();
        const gate = deferred<unknown>();
        refine.mockReturnValue(gate.promise);
        const pending = submit(h);
        await tick();
        expect(h.run.isLocked()).toBe(true);
        gate.resolve(ok(coffeeDeckIr));
        await pending;
        expect(h.run.isLocked()).toBe(false);
        expect(h.deck.html).toBe('<refined-html>');
    });

    it('does not start while another operation holds the lock', async () => {
        const h = makeHandler();
        h.run.lock();
        const result = await submit(h);
        expect(result).toEqual({ ok: false, error: T.presentationBusy });
        expect(refine).not.toHaveBeenCalled();
        expect(h.run.isLocked()).toBe(true);
    });

    it('commits nothing once the deck was discarded while it ran', async () => {
        const h = makeHandler();
        const gate = deferred<unknown>();
        refine.mockReturnValue(gate.promise);
        const pending = submit(h);
        await tick();
        h.onClear();
        gate.resolve(ok(coffeeDeckIr));
        expect((await pending).ok).toBe(false);
        expect(h.deck.html).toBeNull();
    });

    it('commits nothing once it was cancelled', async () => {
        const h = makeHandler();
        const abort = new AbortController();
        refine.mockImplementation(async () => { abort.abort(); return ok(coffeeDeckIr); });
        expect((await submit(h, abort.signal)).ok).toBe(false);
        expect(h.deck.html).toBe('<deck>');
    });
});

describe('storyline notes and protected folders', () => {
    function makeCtx(settings: Record<string, unknown>, existing?: string) {
        const writes: string[] = [];
        const file = existing ? Object.assign(new TFile(), { path: existing }) : null;
        const vault = {
            getAbstractFileByPath: (p: string) => (p === existing ? file : null),
            createFolder: vi.fn(async (p: string) => { writes.push(`folder ${p}`); }),
            create: vi.fn(async (p: string) => { writes.push(`create ${p}`); }),
            modify: vi.fn(async () => { writes.push('modify'); }),
        };
        const plugin = { t: en, settings: { pluginFolder: 'AI-Organiser', presentationOutputFolder: 'Presentations', protectedFolders: [], ...settings } };
        return { ctx: { app: { vault }, plugin }, writes };
    }
    const pending = (savedNotePath?: string) => ({ storylineMarkdown: '# s', deckName: 'Deck', savedNotePath });
    const save = (ctx: unknown, p: unknown) => (new PresentationModeHandler() as unknown as Inner).saveStorylineNote(ctx, p);

    it('writes in an unprotected output folder', async () => {
        const { ctx, writes } = makeCtx({});
        await save(ctx, pending());
        expect(writes.some(w => w.startsWith('create AI-Organiser/Presentations/'))).toBe(true);
    });

    it('refuses an output folder that leads into a protected folder', async () => {
        const { ctx, writes } = makeCtx({ presentationOutputFolder: '../Private', protectedFolders: ['Private'] });
        await expect(save(ctx, pending())).rejects.toThrow();
        expect(writes).toEqual([]);
    });

    it('refuses to update a saved note that is now protected', async () => {
        const { ctx, writes } = makeCtx({ protectedFolders: ['Private'] }, 'Private/Deck — storyline.md');
        await expect(save(ctx, pending('Private/Deck — storyline.md'))).rejects.toThrow();
        expect(writes).toEqual([]);
    });

    it('tells the person what to do, not a code', async () => {
        const { ctx } = makeCtx({ presentationOutputFolder: '../Private', protectedFolders: ['Private'] });
        await expect(save(ctx, pending())).rejects.not.toThrow('protected-path');
    });
});

describe('retired Gemini ids', () => {
    for (const inherited of ['constructor', 'toString', '__proto__']) {
        it(`leaves a stored "${inherited}" as it is`, () => {
            expect(migrateOldSettings({ pdfModel: inherited })!.pdfModel).toBe(inherited);
        });
    }

    it('still converts a retired id', () => {
        expect(migrateOldSettings({ pdfModel: 'gemini-3-flash' })!.pdfModel).toBe('latest-flash');
    });
});
