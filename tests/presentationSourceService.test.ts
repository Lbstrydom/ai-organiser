/**
 * presentationSourceService unit tests.
 * Plan: docs/completed/slide-authoring-followup-implementation.md (Phase H).
 */

import { describe, it, expect } from 'vitest';
import { App, TFile, TFolder, createTFile, createTFolder } from './mocks/obsidian';
import {
    PresentationSourceService,
    validateCreationConfig,
    DEFAULT_CREATION_CONFIG,
    type WebSearchDispatcher,
} from '../src/services/chat/presentationSourceService';
import type { SelectedSource, CreationConfig } from '../src/services/chat/presentationTypes';

function buildApp(files: Map<string, string>, folders: Map<string, TFolder>): App {
    const app = new App();
    app.vault.getAbstractFileByPath = (path: string) => {
        if (folders.has(path)) return folders.get(path)!;
        if (files.has(path)) {
            const f = createTFile(path);
            f.stat = { mtime: 1, ctime: 1, size: files.get(path)!.length };
            return f;
        }
        return null;
    };
    app.vault.read = async (file: TFile) => files.get(file.path) ?? '';
    app.workspace.getActiveFile = () => null;
    return app;
}

describe('PresentationSourceService.detectActiveNote', () => {
    it('returns null when no active file', () => {
        const app = buildApp(new Map(), new Map());
        const svc = new PresentationSourceService(app, null);
        expect(svc.detectActiveNote()).toBeNull();
    });

    it('returns SelectedSource for active md file', () => {
        const app = buildApp(new Map([['notes/a.md', '# Hello']]), new Map());
        const f = createTFile('notes/a.md');
        app.workspace.getActiveFile = () => f;
        const svc = new PresentationSourceService(app, null);
        expect(svc.detectActiveNote()).toEqual({ kind: 'note', ref: 'notes/a.md', autoDetected: true });
    });
});

describe('PresentationSourceService.resolve — note kind', () => {
    it('resolves a vault note into a PromptSource', async () => {
        const app = buildApp(new Map([['a.md', '# Hello world']]), new Map());
        const svc = new PresentationSourceService(app, null);
        const sel: SelectedSource[] = [{ kind: 'note', ref: 'a.md' }];
        const r = await svc.resolve(sel);
        expect(r.usable).toHaveLength(1);
        expect(r.usable[0].content).toBe('# Hello world');
        expect(r.failures).toHaveLength(0);
    });

    it('reports note-not-found for missing path', async () => {
        const app = buildApp(new Map(), new Map());
        const svc = new PresentationSourceService(app, null);
        const sel: SelectedSource[] = [{ kind: 'note', ref: 'missing.md' }];
        const r = await svc.resolve(sel);
        expect(r.usable).toHaveLength(0);
        expect(r.failures[0].code).toBe('note-not-found');
    });

    it('reports note-empty for whitespace-only content', async () => {
        const app = buildApp(new Map([['empty.md', '   \n\n']]), new Map());
        const svc = new PresentationSourceService(app, null);
        const r = await svc.resolve([{ kind: 'note', ref: 'empty.md' }]);
        expect(r.usable).toHaveLength(0);
        expect(r.failures[0].code).toBe('note-empty');
    });
});

describe('PresentationSourceService.resolve — folder kind', () => {
    it('expands folder into per-file PromptSources', async () => {
        const folder = createTFolder('proj');
        const a = createTFile('proj/a.md');
        a.extension = 'md';
        const b = createTFile('proj/b.md');
        b.extension = 'md';
        folder.children = [a, b];
        const files = new Map([
            ['proj/a.md', 'note A'],
            ['proj/b.md', 'note B'],
        ]);
        const app = buildApp(files, new Map([['proj', folder]]));
        const svc = new PresentationSourceService(app, null);
        const r = await svc.resolve([{ kind: 'folder', ref: 'proj' }]);
        expect(r.usable.map(p => p.ref).sort()).toEqual(['proj/a.md', 'proj/b.md']);
        expect(r.usable.every(p => p.fromFolder === 'proj')).toBe(true);
    });

    it('reports folder-not-found for missing folder', async () => {
        const app = buildApp(new Map(), new Map());
        const svc = new PresentationSourceService(app, null);
        const r = await svc.resolve([{ kind: 'folder', ref: 'missing' }]);
        expect(r.usable).toHaveLength(0);
        expect(r.failures[0].code).toBe('folder-not-found');
    });

    it('dedups standalone-note over folder-derived dup', async () => {
        const folder = createTFolder('proj');
        const a = createTFile('proj/a.md');
        a.extension = 'md';
        folder.children = [a];
        const files = new Map([['proj/a.md', 'note content']]);
        const app = buildApp(files, new Map([['proj', folder]]));
        const svc = new PresentationSourceService(app, null);
        const r = await svc.resolve([
            { kind: 'note', ref: 'proj/a.md' },
            { kind: 'folder', ref: 'proj' },
        ]);
        // Only one PromptSource for proj/a.md — the standalone one (no fromFolder).
        const matches = r.usable.filter(p => p.ref === 'proj/a.md');
        expect(matches).toHaveLength(1);
        expect(matches[0].fromFolder).toBeUndefined();
    });
});

describe('PresentationSourceService.resolve — web-search kind', () => {
    it('resolves via dispatcher', async () => {
        const dispatcher: WebSearchDispatcher = {
            search: async () => 'web result content',
        };
        const app = buildApp(new Map(), new Map());
        const svc = new PresentationSourceService(app, dispatcher);
        const r = await svc.resolve([{ kind: 'web-search', ref: 'climate change' }]);
        expect(r.usable).toHaveLength(1);
        expect(r.usable[0].kind).toBe('web-search');
        expect(r.usable[0].content).toContain('web result');
    });

    it('reports web-search-not-configured without dispatcher', async () => {
        // No dispatcher wired → treated as a configuration issue, not a
        // transient search failure. Lets the UI surface actionable guidance
        // (open Settings, pick a research provider).
        const app = buildApp(new Map(), new Map());
        const svc = new PresentationSourceService(app, null);
        const r = await svc.resolve([{ kind: 'web-search', ref: 'q' }]);
        expect(r.usable).toHaveLength(0);
        expect(r.failures[0].code).toBe('web-search-not-configured');
    });

    it('reports web-search-not-configured when dispatcher throws "no provider configured"', async () => {
        // The active provider throws this literal when the user has no
        // research provider set up. Must bucket as the actionable config
        // failure, not the generic search failure.
        const dispatcher: WebSearchDispatcher = {
            search: async () => { throw new Error('No search provider configured'); },
        };
        const app = buildApp(new Map(), new Map());
        const svc = new PresentationSourceService(app, dispatcher);
        const r = await svc.resolve([{ kind: 'web-search', ref: 'q' }]);
        expect(r.usable).toHaveLength(0);
        expect(r.failures[0].code).toBe('web-search-not-configured');
    });

    it('reports web-search-failed for other dispatcher throws (genuine search error)', async () => {
        const dispatcher: WebSearchDispatcher = {
            search: async () => { throw new Error('HTTP 503'); },
        };
        const app = buildApp(new Map(), new Map());
        const svc = new PresentationSourceService(app, dispatcher);
        const r = await svc.resolve([{ kind: 'web-search', ref: 'q' }]);
        expect(r.usable).toHaveLength(0);
        expect(r.failures[0].code).toBe('web-search-failed');
    });

    it('reports web-search-rate-limited when dispatcher throws an adapter-tagged 429', async () => {
        // The adapter tags exhausted rate-limit failures with `rate-limited`.
        const dispatcher: WebSearchDispatcher = {
            search: async () => { throw new Error('Claude Web Search failed: rate-limited: Rate limit of 10000 per 60s exceeded'); },
        };
        const app = buildApp(new Map(), new Map());
        const svc = new PresentationSourceService(app, dispatcher);
        const r = await svc.resolve([{ kind: 'web-search', ref: 'q' }]);
        expect(r.usable).toHaveLength(0);
        expect(r.failures[0].code).toBe('web-search-rate-limited');
    });

    it('reports web-search-rate-limited for a raw provider rate-limit phrasing', async () => {
        const dispatcher: WebSearchDispatcher = {
            search: async () => { throw new Error('429 Too Many Requests'); },
        };
        const app = buildApp(new Map(), new Map());
        const svc = new PresentationSourceService(app, dispatcher);
        const r = await svc.resolve([{ kind: 'web-search', ref: 'q' }]);
        expect(r.failures[0].code).toBe('web-search-rate-limited');
    });

    it('reports web-search-no-results for empty dispatcher response', async () => {
        const dispatcher: WebSearchDispatcher = { search: async () => '   ' };
        const app = buildApp(new Map(), new Map());
        const svc = new PresentationSourceService(app, dispatcher);
        const r = await svc.resolve([{ kind: 'web-search', ref: 'q' }]);
        expect(r.usable).toHaveLength(0);
        expect(r.failures[0].code).toBe('web-search-no-results');
    });
});

describe('PresentationSourceService.resolve — web-search grounding (Option A)', () => {
    it('grounds the query in attached notes + description before dispatch', async () => {
        const searched: string[] = [];
        const dispatcher: WebSearchDispatcher = {
            search: async (q) => { searched.push(q); return `results for ${q}`; },
        };
        const app = buildApp(new Map([['hamina.md', 'Hamina port LNG terminal expansion 2026']]), new Map());
        const svc = new PresentationSourceService(app, dispatcher);
        const groundedCtx: { description?: string; noteExcerpts: string[] }[] = [];
        const r = await svc.resolve(
            [
                { kind: 'note', ref: 'hamina.md' },
                { kind: 'web-search', ref: 'port news' },
            ],
            {
                deckDescription: 'Board update on the port',
                groundWebSearchQuery: async (literal, ctx) => {
                    groundedCtx.push(ctx);
                    return `${literal} Hamina LNG 2026`;
                },
            },
        );
        // Grounder saw the resolved note content + the description.
        expect(groundedCtx).toHaveLength(1);
        expect(groundedCtx[0].description).toBe('Board update on the port');
        expect(groundedCtx[0].noteExcerpts[0]).toContain('Hamina port LNG');
        // Dispatcher was called with the grounded query, not the literal one.
        expect(searched).toEqual(['port news Hamina LNG 2026']);
        // ref stays the literal query (stable identity); grounded query noted in content.
        const ws = r.usable.find(s => s.kind === 'web-search')!;
        expect(ws.ref).toBe('port news');
        expect(ws.content).toContain('grounded search: port news Hamina LNG 2026');
    });

    it('falls back to the literal query when the grounder throws', async () => {
        const searched: string[] = [];
        const dispatcher: WebSearchDispatcher = {
            search: async (q) => { searched.push(q); return `results for ${q}`; },
        };
        const app = buildApp(new Map([['n.md', 'context text']]), new Map());
        const svc = new PresentationSourceService(app, dispatcher);
        const r = await svc.resolve(
            [{ kind: 'note', ref: 'n.md' }, { kind: 'web-search', ref: 'literal q' }],
            { deckDescription: 'desc', groundWebSearchQuery: async () => { throw new Error('LLM down'); } },
        );
        expect(searched).toEqual(['literal q']);
        const ws = r.usable.find(s => s.kind === 'web-search')!;
        expect(ws.content).not.toContain('grounded search');
        expect(r.failures).toHaveLength(0);
    });

    it('falls back to the literal query when the grounder returns empty', async () => {
        const searched: string[] = [];
        const dispatcher: WebSearchDispatcher = {
            search: async (q) => { searched.push(q); return `r ${q}`; },
        };
        const app = buildApp(new Map([['n.md', 'ctx']]), new Map());
        const svc = new PresentationSourceService(app, dispatcher);
        await svc.resolve(
            [{ kind: 'note', ref: 'n.md' }, { kind: 'web-search', ref: 'literal' }],
            { deckDescription: 'd', groundWebSearchQuery: async () => '   ' },
        );
        expect(searched).toEqual(['literal']);
    });

    it('skips the LLM call entirely when there is no note/description context', async () => {
        let grounderCalls = 0;
        const dispatcher: WebSearchDispatcher = { search: async (q) => `r ${q}` };
        const app = buildApp(new Map(), new Map());
        const svc = new PresentationSourceService(app, dispatcher);
        await svc.resolve(
            [{ kind: 'web-search', ref: 'standalone' }],
            { groundWebSearchQuery: async () => { grounderCalls++; return 'x'; } },
        );
        // No description, no notes → groundQuery short-circuits, no LLM spend.
        expect(grounderCalls).toBe(0);
    });

    it('searches the literal query when no grounder is supplied (back-compat)', async () => {
        const searched: string[] = [];
        const dispatcher: WebSearchDispatcher = {
            search: async (q) => { searched.push(q); return `r ${q}`; },
        };
        const app = buildApp(new Map([['n.md', 'ctx']]), new Map());
        const svc = new PresentationSourceService(app, dispatcher);
        await svc.resolve([{ kind: 'note', ref: 'n.md' }, { kind: 'web-search', ref: 'plain' }]);
        expect(searched).toEqual(['plain']);
    });

    it('clamps the grounded query before dispatch (audit M1/M14 defence in depth)', async () => {
        const searched: string[] = [];
        const dispatcher: WebSearchDispatcher = {
            search: async (q) => { searched.push(q); return `r`; },
        };
        const app = buildApp(new Map([['n.md', 'ctx']]), new Map());
        const svc = new PresentationSourceService(app, dispatcher);
        await svc.resolve(
            [{ kind: 'note', ref: 'n.md' }, { kind: 'web-search', ref: 'q' }],
            { deckDescription: 'd', groundWebSearchQuery: async () => 'x'.repeat(5000) },
        );
        expect(searched[0].length).toBeLessThanOrEqual(256);
    });

    it('caps the description fed to the grounder (audit M2/M14)', async () => {
        let seenDescLen = -1;
        const dispatcher: WebSearchDispatcher = { search: async (q) => `r ${q}` };
        const app = buildApp(new Map([['n.md', 'ctx']]), new Map());
        const svc = new PresentationSourceService(app, dispatcher);
        await svc.resolve(
            [{ kind: 'note', ref: 'n.md' }, { kind: 'web-search', ref: 'q' }],
            {
                deckDescription: 'D'.repeat(10_000),
                groundWebSearchQuery: async (_l, ctx) => { seenDescLen = ctx.description!.length; return 'g'; },
            },
        );
        expect(seenDescLen).toBeLessThanOrEqual(2000);
    });

    it('prioritises standalone notes over folder-derived ones for grounding context (Gemini-G1)', async () => {
        let excerpts: string[] = [];
        // 6 folder files + 1 standalone note; cap is 6 — the standalone must survive.
        const files = new Map<string, string>([['standalone.md', 'STANDALONE anchor text']]);
        const folder = createTFolder('big');
        const folderChildren: TFile[] = [];
        for (let i = 0; i < 6; i++) {
            const p = `big/f${i}.md`;
            files.set(p, `folder note ${i}`);
            const tf = createTFile(p);
            tf.stat = { mtime: 1, ctime: 1, size: 10 };
            folderChildren.push(tf);
        }
        folder.children = folderChildren;
        const app = buildApp(files, new Map([['big', folder]]));
        const dispatcher: WebSearchDispatcher = { search: async (q) => `r ${q}` };
        const svc = new PresentationSourceService(app, dispatcher);
        await svc.resolve(
            [
                { kind: 'folder', ref: 'big' },
                { kind: 'note', ref: 'standalone.md' },
                { kind: 'web-search', ref: 'q' },
            ],
            {
                deckDescription: 'd',
                groundWebSearchQuery: async (_l, ctx) => { excerpts = ctx.noteExcerpts; return 'g'; },
            },
        );
        expect(excerpts.length).toBe(6);
        expect(excerpts.some(e => e.includes('STANDALONE'))).toBe(true);
    });

    it('does not abort-guard-bypass: no search dispatched when aborted during grounding (audit H2/H4)', async () => {
        const searched: string[] = [];
        const controller = new AbortController();
        const dispatcher: WebSearchDispatcher = {
            search: async (q) => { searched.push(q); return `r ${q}`; },
        };
        const app = buildApp(new Map([['n.md', 'ctx']]), new Map());
        const svc = new PresentationSourceService(app, dispatcher);
        await svc.resolve(
            [{ kind: 'note', ref: 'n.md' }, { kind: 'web-search', ref: 'q' }],
            {
                signal: controller.signal,
                deckDescription: 'd',
                groundWebSearchQuery: async () => { controller.abort(); return 'grounded'; },
            },
        );
        expect(searched).toHaveLength(0);
    });
});

describe('PresentationSourceService.resolve — note read failure (audit M6)', () => {
    it('records note-read-failed when vault.read rejects', async () => {
        const app = buildApp(new Map([['n.md', 'content']]), new Map());
        app.vault.read = async () => { throw new Error('EIO'); };
        const svc = new PresentationSourceService(app, null);
        const r = await svc.resolve([{ kind: 'note', ref: 'n.md' }]);
        expect(r.usable).toHaveLength(0);
        expect(r.failures[0].code).toBe('note-read-failed');
    });
});

describe('validateCreationConfig', () => {
    const cfg: CreationConfig = { ...DEFAULT_CREATION_CONFIG };

    it('rejects zero sources', () => {
        const r = validateCreationConfig(cfg, []);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe('zero-sources');
    });

    it('rejects zero length', () => {
        const r = validateCreationConfig({ ...cfg, length: 0 }, [{ kind: 'note', ref: 'a.md' }]);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe('zero-length');
    });

    it('rejects length out of range', () => {
        const r = validateCreationConfig({ ...cfg, length: 999 }, [{ kind: 'note', ref: 'a.md' }]);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe('length-out-of-range');
    });

    it('accepts a valid config', () => {
        const r = validateCreationConfig(cfg, [{ kind: 'note', ref: 'a.md' }]);
        expect(r.ok).toBe(true);
    });
});
