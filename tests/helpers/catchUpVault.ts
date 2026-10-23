/**
 * In-memory vault for the catch-up tests: files, derived folders (with `children`), a metadata
 * cache that mirrors frontmatter, trash/create/modify spies and read counters. Synthetic content
 * only — never a real newsletter.
 */
import { vi } from 'vitest';
import * as yaml from 'js-yaml';
import { createTFile, TFile } from '../mocks/obsidian';

export interface CatchUpVault {
    app: {
        vault: {
            getAbstractFileByPath: (p: string) => unknown;
            cachedRead: ReturnType<typeof vi.fn>;
            read: ReturnType<typeof vi.fn>;
            create: ReturnType<typeof vi.fn>;
            createBinary: ReturnType<typeof vi.fn>;
            modify: ReturnType<typeof vi.fn>;
        };
        fileManager: { trashFile: ReturnType<typeof vi.fn> };
        metadataCache: { getFileCache: ReturnType<typeof vi.fn> };
    };
    files: Map<string, string | ArrayBuffer>;
    set(path: string, content: string | ArrayBuffer): void;
    remove(path: string): void;
    exists(path: string): boolean;
    text(path: string): string;
    /** Serve frontmatter from the metadata cache (default) or force a cold cache. */
    cache: { enabled: boolean };
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

export function makeCatchUpVault(initial: Record<string, string | ArrayBuffer> = {}): CatchUpVault {
    const files = new Map<string, string | ArrayBuffer>(Object.entries(initial));
    const tfiles = new Map<string, TFile>();
    const cache = { enabled: true };

    const tfile = (path: string): TFile => {
        let f = tfiles.get(path);
        if (!f) { f = createTFile(path); tfiles.set(path, f); }
        return f;
    };

    const folderAt = (path: string) => {
        const prefix = path.endsWith('/') ? path : `${path}/`;
        const direct = [...files.keys()].filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'));
        const anyBelow = [...files.keys()].some((p) => p.startsWith(prefix));
        if (!anyBelow) return null;
        return { path, name: path.split('/').pop(), children: direct.map(tfile) };
    };

    const app = {
        vault: {
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
            modify: vi.fn(async (f: { path: string }, c: string) => { files.set(f.path, c); }),
        },
        fileManager: {
            trashFile: vi.fn(async (f: { path: string }) => { files.delete(f.path); tfiles.delete(f.path); }),
        },
        metadataCache: {
            getFileCache: vi.fn((f: { path: string }) => {
                if (!cache.enabled) return null;
                const v = files.get(f.path);
                return typeof v === 'string' ? { frontmatter: frontmatterOf(v) } : null;
            }),
        },
    };

    return {
        app,
        files,
        cache,
        set: (p, c) => { files.set(p, c); },
        remove: (p) => { files.delete(p); tfiles.delete(p); },
        exists: (p) => files.has(p),
        text: (p) => { const v = files.get(p); return typeof v === 'string' ? v : ''; },
    };
}
