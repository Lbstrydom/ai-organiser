/**
 * A VectorStoreService wired to in-memory fakes: a vault of named notes, a change tracker, a
 * document store and an embedding service that records every request it receives. Callers must
 * `vi.mock('obsidian', ...)` and the voy store themselves (mocks are hoisted per test file).
 */

import { vi } from 'vitest';
import { VectorStoreService } from '../../src/services/vector/vectorStoreService';
import { DEFAULT_SETTINGS } from '../../src/core/settings';
import { App, createTFile } from '../mocks/obsidian';

export interface Harness {
    service: VectorStoreService;
    /** One entry per embedding request: the exact texts sent. */
    embedded: string[][];
    hashes: Map<string, string>;
    docs: Map<string, { id: string; content: string }[]>;
    store: { remove: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> };
    setNote: (path: string, text: string) => ReturnType<typeof createTFile>;
    setTags: (path: string, tags: string[]) => void;
}

export function makeHarness(settings: Record<string, unknown> = {}): Harness {
    const app = new App();
    const files = new Map<string, string>();
    app.vault.read = async (f: { path: string }) => files.get(f.path) ?? '';
    const tagMap = new Map<string, string[]>();
    app.metadataCache.getFileCache = (f: { path: string }) => (tagMap.has(f.path) ? { frontmatter: { tags: tagMap.get(f.path) } } : null);

    const embedded: string[][] = [];
    const embeddingService = {
        maxBatchSize: 100,
        batchGenerateEmbeddings: vi.fn(async (texts: string[]) => {
            embedded.push([...texts]);
            return { success: true, embeddings: texts.map(() => [0.1, 0.2]), totalTokens: 1 };
        }),
        getModelInfo: () => ({ name: 'm', dimensions: 2, maxTokens: 512 }),
    };

    const hashes = new Map<string, string>();
    const docs = new Map<string, { id: string; content: string }[]>();
    const store = {
        getFileChangeTracker: () => ({
            hasChanged: (p: string, h: string) => hashes.get(p) !== h,
            updateHash: (p: string, h: string) => { hashes.set(p, h); },
            removeHash: (p: string) => { hashes.delete(p); },
            getTrackedFiles: () => hashes,
            clear: () => hashes.clear(),
        }),
        getDocumentsByFile: vi.fn(async (p: string) => docs.get(p) ?? []),
        remove: vi.fn(async (ids: string[]) => {
            for (const [p, list] of docs) docs.set(p, list.filter((d) => !ids.includes(d.id)));
        }),
        upsert: vi.fn(async (list: { id: string; filePath: string; content: string }[]) => {
            for (const d of list) docs.set(d.filePath, [...(docs.get(d.filePath) ?? []), { id: d.id, content: d.content }]);
        }),
    };

    const service = new VectorStoreService(app as never, { ...DEFAULT_SETTINGS, chunkSize: 2000, chunkOverlap: 0, maxChunksPerNote: 50, ...settings } as never, embeddingService as never);
    (service as unknown as { vectorStore: unknown }).vectorStore = store;
    vi.spyOn(service as unknown as { ensureIndexLoaded: () => Promise<void> }, 'ensureIndexLoaded').mockResolvedValue(undefined);

    return {
        service, embedded, hashes, docs, store,
        setNote: (path, text) => { files.set(path, text); return createTFile(path); },
        setTags: (path, tags) => { tagMap.set(path, tags); },
    };
}
