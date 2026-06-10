/**
 * Shared fakes for the visual-search lane tests: an in-memory vault adapter and a
 * `VisualStorePort` stand-in (no real Voy WASM).
 */
import type { VisualStorePort } from '../../src/services/visualEmbedding/visualIndexRepository';
import type { VectorDocument } from '../../src/services/vector/types';

export function fakeAdapter() {
    const files = new Map<string, string>();
    const dirs = new Set<string>();
    return {
        files,
        dirs,
        exists: async (p: string) => files.has(p) || dirs.has(p) || [...files.keys()].some((k) => k.startsWith(p + '/')),
        read: async (p: string) => {
            if (!files.has(p)) throw new Error(`not found: ${p}`);
            return files.get(p)!;
        },
        write: async (p: string, d: string) => { files.set(p, d); },
        mkdir: async (p: string) => { dirs.add(p); },
        rmdir: async (p: string) => {
            dirs.delete(p);
            for (const k of [...files.keys()]) if (k === p || k.startsWith(p + '/')) files.delete(k);
        },
    };
}

export function fakeStore(): VisualStorePort & { docs: Map<string, VectorDocument> } {
    const docs = new Map<string, VectorDocument>();
    return {
        docs,
        load: async () => {},
        save: async () => {},
        upsert: async (ds) => { for (const d of ds) docs.set(d.id, d); },
        remove: async (ids) => { for (const id of ids) docs.delete(id); },
        removeFile: async (fp) => { for (const [id, d] of [...docs]) if (d.filePath === fp) docs.delete(id); },
        getDocumentsByFile: async (fp) => [...docs.values()].filter((d) => d.filePath === fp),
        setEmbeddingMetadata: () => {},
    };
}
