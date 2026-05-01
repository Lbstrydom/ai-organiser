/**
 * creationSourceController unit tests.
 * Plan: docs/completed/slide-authoring-followup-implementation.md (Phase H).
 */

import { describe, it, expect, vi } from 'vitest';
import { App, TFile, TFolder, createTFile } from './mocks/obsidian';
import { CreationSourceController } from '../src/services/chat/creationSourceController';
import {
    PresentationSourceService,
    type WebSearchDispatcher,
} from '../src/services/chat/presentationSourceService';

interface VaultMaps {
    files: Map<string, string>;
    folders: Map<string, TFolder>;
    mtimes: Map<string, number>;
}

function buildApp(maps: VaultMaps): App {
    const app = new App();
    app.vault.getAbstractFileByPath = (path: string): TFile | TFolder | null => {
        if (maps.folders.has(path)) return maps.folders.get(path)!;
        if (maps.files.has(path)) {
            const f = createTFile(path);
            f.stat = { mtime: maps.mtimes.get(path) ?? 1, ctime: 1, size: maps.files.get(path)!.length };
            return f;
        }
        return null;
    };
    app.vault.read = async (file: TFile): Promise<string> => maps.files.get(file.path) ?? '';
    app.workspace.getActiveFile = () => null;
    app.workspace.on = (() => ({ unload: () => {} })) as never;
    app.workspace.offref = (() => {}) as never;
    return app;
}

function buildController(maps: VaultMaps, dispatcher: WebSearchDispatcher | null = null) {
    const app = buildApp(maps);
    const service = new PresentationSourceService(app, dispatcher);
    const controller = new CreationSourceController(app, service);
    return { app, service, controller };
}

describe('CreationSourceController.subscribe', () => {
    it('emits add reason on addSource', () => {
        const { controller } = buildController({
            files: new Map([['a.md', 'hi']]),
            folders: new Map(),
            mtimes: new Map([['a.md', 1]]),
        });
        const reasons: string[] = [];
        controller.subscribe(r => reasons.push(r));
        controller.addSource({ kind: 'note', ref: 'a.md' });
        expect(reasons).toContain('add');
    });

    it('emits remove reason on removeSource', () => {
        const { controller } = buildController({
            files: new Map([['a.md', 'hi']]),
            folders: new Map(),
            mtimes: new Map([['a.md', 1]]),
        });
        controller.addSource({ kind: 'note', ref: 'a.md' });
        const reasons: string[] = [];
        controller.subscribe(r => reasons.push(r));
        controller.removeSource(0);
        expect(reasons).toContain('remove');
    });

    it('emits reset reason on reset', () => {
        const { controller } = buildController({
            files: new Map(),
            folders: new Map(),
            mtimes: new Map(),
        });
        const reasons: string[] = [];
        controller.subscribe(r => reasons.push(r));
        controller.reset();
        expect(reasons).toContain('reset');
    });

    it('unsubscribe stops further notifications', () => {
        const { controller } = buildController({
            files: new Map([['a.md', 'hi']]),
            folders: new Map(),
            mtimes: new Map([['a.md', 1]]),
        });
        const reasons: string[] = [];
        const off = controller.subscribe(r => reasons.push(r));
        off();
        controller.addSource({ kind: 'note', ref: 'a.md' });
        expect(reasons).toHaveLength(0);
    });
});

describe('CreationSourceController.getSnapshot', () => {
    it('returns idle status for newly-added source', () => {
        const { controller } = buildController({
            files: new Map([['a.md', 'hi']]),
            folders: new Map(),
            mtimes: new Map([['a.md', 1]]),
        });
        controller.addSource({ kind: 'note', ref: 'a.md' });
        const snap = controller.getSnapshot();
        expect(snap.states).toHaveLength(1);
        expect(snap.states[0].status).toBe('idle');
    });

    it('returned snapshot is read-only-ish (separate array)', () => {
        const { controller } = buildController({
            files: new Map([['a.md', 'hi']]),
            folders: new Map(),
            mtimes: new Map([['a.md', 1]]),
        });
        controller.addSource({ kind: 'note', ref: 'a.md' });
        const snap1 = controller.getSnapshot();
        controller.addSource({ kind: 'note', ref: 'b.md' });
        // First snapshot's array is unaffected by the later mutation.
        expect(snap1.states).toHaveLength(1);
    });
});

describe('CreationSourceController.preloadAsync', () => {
    it('transitions status idle → loading → resolved on success', async () => {
        const { controller } = buildController({
            files: new Map([['a.md', 'content']]),
            folders: new Map(),
            mtimes: new Map([['a.md', 5]]),
        });
        controller.addSource({ kind: 'note', ref: 'a.md' });
        await controller.preloadAsync(0);
        expect(controller.getSnapshot().states[0].status).toBe('resolved');
    });

    it('transitions to error with failureCode for missing note', async () => {
        const { controller } = buildController({
            files: new Map(),
            folders: new Map(),
            mtimes: new Map(),
        });
        controller.addSource({ kind: 'note', ref: 'missing.md' });
        await controller.preloadAsync(0);
        const s = controller.getSnapshot().states[0];
        expect(s.status).toBe('error');
        expect(s.failureCode).toBe('note-not-found');
    });
});

describe('CreationSourceController.resolveForSubmit', () => {
    it('returns err for zero-selected', async () => {
        const { controller } = buildController({
            files: new Map(),
            folders: new Map(),
            mtimes: new Map(),
        });
        const r = await controller.resolveForSubmit();
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe('zero-selected');
    });

    it('returns err for no-usable-sources when all fail', async () => {
        const { controller } = buildController({
            files: new Map(),
            folders: new Map(),
            mtimes: new Map(),
        });
        controller.addSource({ kind: 'note', ref: 'missing.md' });
        const r = await controller.resolveForSubmit();
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe('no-usable-sources');
    });

    it('reuses cached resolved content when mtime unchanged', async () => {
        const maps: VaultMaps = {
            files: new Map([['a.md', 'content']]),
            folders: new Map(),
            mtimes: new Map([['a.md', 5]]),
        };
        const { controller, service } = buildController(maps);
        const resolveSpy = vi.spyOn(service, 'resolve');
        controller.addSource({ kind: 'note', ref: 'a.md' });
        await controller.preloadAsync(0);
        expect(resolveSpy).toHaveBeenCalledTimes(1);
        // Submit should NOT call resolve again because cache is fresh.
        const r = await controller.resolveForSubmit();
        expect(r.ok).toBe(true);
        expect(resolveSpy).toHaveBeenCalledTimes(1);
    });

    it('invalidates cache when mtime changes', async () => {
        const maps: VaultMaps = {
            files: new Map([['a.md', 'content']]),
            folders: new Map(),
            mtimes: new Map([['a.md', 5]]),
        };
        const { controller, service } = buildController(maps);
        const resolveSpy = vi.spyOn(service, 'resolve');
        controller.addSource({ kind: 'note', ref: 'a.md' });
        await controller.preloadAsync(0);
        // Bump mtime to force invalidation.
        maps.mtimes.set('a.md', 99);
        await controller.resolveForSubmit();
        expect(resolveSpy).toHaveBeenCalledTimes(2);
    });
});

describe('CreationSourceController.reset', () => {
    it('clears all state', () => {
        const { controller } = buildController({
            files: new Map([['a.md', 'hi'], ['b.md', 'hi']]),
            folders: new Map(),
            mtimes: new Map([['a.md', 1], ['b.md', 1]]),
        });
        controller.addSource({ kind: 'note', ref: 'a.md' });
        controller.addSource({ kind: 'note', ref: 'b.md' });
        controller.reset();
        expect(controller.getSnapshot().selected).toHaveLength(0);
    });
});
