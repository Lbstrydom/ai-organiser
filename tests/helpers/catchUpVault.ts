/**
 * In-memory vault for the catch-up tests: files, derived folders (with `children`), a metadata
 * cache that mirrors frontmatter, trash/create/modify spies and read counters. Synthetic content
 * only — never a real newsletter.
 */
import { vi } from 'vitest';
import * as yaml from 'js-yaml';
import { createTFile, TFile } from '../mocks/obsidian';
import { observeMetadataIndex, type IndexObserver } from '../../src/utils/metadataIndexState';

export interface CatchUpVault {
    app: {
        vault: {
            getAbstractFileByPath: (p: string) => unknown;
            cachedRead: ReturnType<typeof vi.fn>;
            read: ReturnType<typeof vi.fn>;
            readBinary: ReturnType<typeof vi.fn>;
            create: ReturnType<typeof vi.fn>;
            createBinary: ReturnType<typeof vi.fn>;
            modify: ReturnType<typeof vi.fn>;
            on: ReturnType<typeof vi.fn>;
            offref: ReturnType<typeof vi.fn>;
        };
        fileManager: { trashFile: ReturnType<typeof vi.fn> };
        metadataCache: { getFileCache: ReturnType<typeof vi.fn>; resolved?: boolean; initialized?: boolean; resolvedLinks: Record<string, Record<string, number>>; on: ReturnType<typeof vi.fn>; offref: ReturnType<typeof vi.fn> };
    };
    files: Map<string, string | ArrayBuffer>;
    set(path: string, content: string | ArrayBuffer): void;
    remove(path: string): void;
    exists(path: string): boolean;
    text(path: string): string;
    /** Serve frontmatter from the metadata cache (default) or force a cold cache. */
    cache: { enabled: boolean };
    /** Drive the plugin's index tracker: `changed()` starts indexing, `resolved()` completes it. */
    index: IndexObserver;
    /** Fire a vault event (create/modify/delete/rename) or a metadataCache event (changed/deleted) at the registered listeners. */
    emit(source: 'vault' | 'cache', name: string, ...args: unknown[]): void;
    /** Number of listeners still registered. */
    listeners(): number;
}

function frontmatterOf(content: string): Record<string, unknown> | undefined {
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
    if (!m) return undefined;
    try {
        const v = yaml.load(m[1]);
        return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
    } catch {
        return undefined;
    }
}

export function makeCatchUpVault(initial: Record<string, string | ArrayBuffer> = {}, opts: { ctime?: number; mtime?: number } = {}): CatchUpVault {
    const files = new Map<string, string | ArrayBuffer>(Object.entries(initial));
    const tfiles = new Map<string, TFile>();
    const cache = { enabled: true };

    const tfile = (path: string): TFile => {
        let f = tfiles.get(path);
        if (!f) {
            f = createTFile(path);
            // The shared TFile mock stamps `Date.now()` of the REAL clock. The catch-up tests inject their own clock
            // (fixed instants in 2026-10), and the automatic replace compares file creation time with that clock, so a
            // real-clock stamp made them pass or fail depending on the day they were run. Fixed stamps keep them deterministic.
            f.stat = { ...f.stat, ctime: opts.ctime ?? 1, mtime: opts.mtime ?? 1 };
            tfiles.set(path, f);
        }
        return f;
    };

    const folderAt = (path: string) => {
        const prefix = path.endsWith('/') ? path : `${path}/`;
        const direct = [...files.keys()].filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'));
        const anyBelow = [...files.keys()].some((p) => p.startsWith(prefix));
        if (!anyBelow) return null;
        return { path, name: path.split('/').pop(), children: direct.map(tfile) };
    };

    const handlers = new Map<object, { source: 'vault' | 'cache'; name: string; cb: (...a: unknown[]) => void }>();
    const register = (source: 'vault' | 'cache') => vi.fn((name: string, cb: (...a: unknown[]) => void) => {
        const ref = {};
        handlers.set(ref, { source, name, cb });
        return ref;
    });
    const unregister = vi.fn((ref: object) => { handlers.delete(ref); });

    const app = {
        vault: {
            on: register('vault'),
            offref: unregister,
            getAbstractFileByPath: (p: string) => (files.has(p) ? tfile(p) : folderAt(p)),
            cachedRead: vi.fn(async (f: { path: string }) => {
                const v = files.get(f.path);
                if (typeof v !== 'string') throw new Error(`not text: ${f.path}`);
                return v;
            }),
            read: vi.fn(async (f: { path: string }) => {
                const v = files.get(f.path);
                if (typeof v !== 'string') throw new Error(`not text: ${f.path}`);
                return v;
            }),
            readBinary: vi.fn(async (f: { path: string }) => {
                const v = files.get(f.path);
                if (typeof v === 'string' || v === undefined) throw new Error(`not binary: ${f.path}`);
                return v;
            }),
            create: vi.fn(async (p: string, c: string) => {
                if (files.has(p)) throw new Error(`exists: ${p}`);
                files.set(p, c);
                return tfile(p);
            }),
            createBinary: vi.fn(async (p: string, c: ArrayBuffer) => {
                if (files.has(p)) throw new Error(`exists: ${p}`);
                files.set(p, c);
                return tfile(p);
            }),
            modify: vi.fn(async (f: { path: string }, c: string) => {
                // The real vault cannot modify a file that is not there.
                if (!files.has(f.path)) throw new Error(`modify of a missing file: ${f.path}`);
                files.set(f.path, c);
            }),
        },
        fileManager: {
            trashFile: vi.fn(async (f: { path: string }) => { files.delete(f.path); tfiles.delete(f.path); }),
        },
        metadataCache: {
            // A fully indexed vault by default: the legacy `resolved` hint plus an observed `resolved`
            // event (see below). Tests for the still-indexing case flip or delete the hint, or drive `index`.
            resolved: true,
            resolvedLinks: {} as Record<string, Record<string, number>>,
            on: register('cache'),
            offref: unregister,
            getFileCache: vi.fn((f: { path: string }) => {
                if (!cache.enabled) return null;
                const v = files.get(f.path);
                return typeof v === 'string' ? { frontmatter: frontmatterOf(v) } : null;
            }),
        },
    };

    // The plugin's index tracker, already past a completed resolution: a fully indexed vault.
    const index = observeMetadataIndex(app.metadataCache);
    index.resolved();

    return {
        app,
        files,
        cache,
        index,
        set: (p, c) => { files.set(p, c); },
        remove: (p) => { files.delete(p); tfiles.delete(p); },
        exists: (p) => files.has(p),
        text: (p) => { const v = files.get(p); return typeof v === 'string' ? v : ''; },
        emit: (source, name, ...args) => {
            // The plugin's own tracker hears the documented events the way it does in Obsidian.
            if (source === 'cache' && name === 'changed') index.changed();
            if (source === 'cache' && name === 'resolved') index.resolved();
            for (const h of [...handlers.values()]) if (h.source === source && h.name === name) h.cb(...args);
        },
        listeners: () => handlers.size,
    };
}
