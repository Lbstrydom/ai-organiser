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

    it('reports web-search-failed without dispatcher', async () => {
        const app = buildApp(new Map(), new Map());
        const svc = new PresentationSourceService(app, null);
        const r = await svc.resolve([{ kind: 'web-search', ref: 'q' }]);
        expect(r.usable).toHaveLength(0);
        expect(r.failures[0].code).toBe('web-search-failed');
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
