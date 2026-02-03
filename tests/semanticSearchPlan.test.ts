vi.mock('obsidian', async () => await import('./mocks/obsidian'));
vi.mock('../src/services/embeddings', () => ({
    createEmbeddingServiceFromSettings: vi.fn(() => ({
        dispose: vi.fn()
    }))
}));
vi.mock('../src/services/vector/voyVectorStore', () => ({
    VoyVectorStore: class {}
}));

import AIOrganiserPlugin from '../src/main';
import { VectorStoreService, INDEX_SCHEMA_VERSION } from '../src/services/vector/vectorStoreService';
import { INDEX_SCHEMA_VERSION as INDEX_SCHEMA_VERSION_TYPES } from '../src/services/vector/types';
import { SimpleVectorStore } from '../src/services/vector/simpleVectorStore';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { App, TFile } from 'obsidian';
import { clearMockNotices, mockNotices } from './mocks/obsidian';

describe('AIOrganiserPlugin.saveSettings', () => {
    it('does not reinitialize embeddings for non-embedding changes', async () => {
        const app = new App();
        const plugin = new AIOrganiserPlugin(app as any, { id: 'test', version: '1.0.0' });
        plugin.settings = { ...DEFAULT_SETTINGS };
        (plugin as any).lastEmbeddingConfig = {
            provider: plugin.settings.embeddingProvider,
            model: plugin.settings.embeddingModel,
            enabled: plugin.settings.enableSemanticSearch
        };

        plugin.settings.maxTags = plugin.settings.maxTags + 1;

        const clearSpy = vi.fn();
        plugin.vectorStoreService = {
            updateEmbeddingService: vi.fn(async (_svc: any, shouldClear: boolean) => {
                if (shouldClear) clearSpy();
            })
        } as any;

        const initLLMSpy = vi.spyOn(plugin as any, 'initializeLLMService').mockResolvedValue(undefined);
        const initEmbeddingSpy = vi.spyOn(plugin as any, 'initializeEmbeddingService').mockResolvedValue(undefined);

        await plugin.saveSettings();

        expect(initLLMSpy).toHaveBeenCalled();
        expect(initEmbeddingSpy).not.toHaveBeenCalled();
        expect(clearSpy).not.toHaveBeenCalled();
    });

    it('clears index when embedding settings change', async () => {
        const app = new App();
        const plugin = new AIOrganiserPlugin(app as any, { id: 'test', version: '1.0.0' });
        plugin.settings = { ...DEFAULT_SETTINGS, enableSemanticSearch: true };
        (plugin as any).lastEmbeddingConfig = {
            provider: plugin.settings.embeddingProvider,
            model: plugin.settings.embeddingModel,
            enabled: true
        };

        plugin.settings.embeddingProvider = 'voyage';

        const clearSpy = vi.fn();
        const updateEmbeddingService = vi.fn(async (_svc: any, shouldClear: boolean) => {
            if (shouldClear) clearSpy();
        });

        plugin.vectorStoreService = { updateEmbeddingService } as any;

        vi.spyOn(plugin as any, 'initializeLLMService').mockResolvedValue(undefined);
        vi.spyOn(plugin as any, 'resolveEmbeddingApiKey').mockResolvedValue(null);

        await plugin.saveSettings();

        expect(updateEmbeddingService).toHaveBeenCalled();
        expect(clearSpy).toHaveBeenCalled();
    });
});

describe('VectorStoreService metadata prefix', () => {
    it('builds a metadata prefix with title, path, and tags', () => {
        const app = new App();
        const service = new VectorStoreService(app as any, { ...DEFAULT_SETTINGS }, null);
        const prefix = (service as any).buildMetadataPrefix('GROW', 'Coaching', ['model', 'skills']);

        expect(prefix).toContain('Title: GROW');
        expect(prefix).toContain('Path: Coaching');
        expect(prefix).toContain('Tags: model, skills');
        expect(prefix.endsWith('---\n')).toBe(true);
    });

    it('truncates metadata prefix to max length', () => {
        const app = new App();
        const service = new VectorStoreService(app as any, { ...DEFAULT_SETTINGS }, null);
        const longTitle = 'a'.repeat(400);
        const prefix = (service as any).buildMetadataPrefix(longTitle, 'Path', ['tag']);

        expect(prefix.length).toBeLessThanOrEqual(205);
    });
});

describe('VectorStoreService rename behavior', () => {
    beforeEach(() => {
        clearMockNotices();
    });

    it('re-embeds on rename when embedding service is available', async () => {
        const app = new App();
        const service = new VectorStoreService(app as any, { ...DEFAULT_SETTINGS }, {});
        const vectorStore = {
            removeFile: vi.fn(),
            renameFile: vi.fn()
        };

        (service as any).vectorStore = vectorStore;
        (service as any).embeddingService = {};
        vi.spyOn(service as any, 'ensureIndexLoaded').mockResolvedValue(undefined);

        const newFile = new TFile();
        newFile.path = 'new.md';
        app.vault.getFileByPath = vi.fn().mockReturnValue(newFile);

        const indexSpy = vi.spyOn(service, 'indexNote').mockResolvedValue(true);

        await service.renameNote('old.md', 'new.md');

        expect(vectorStore.removeFile).toHaveBeenCalledWith('old.md');
        expect(indexSpy).toHaveBeenCalledWith(newFile);
        expect(vectorStore.renameFile).not.toHaveBeenCalled();
    });

    it('falls back to path rewrite when no embedding service', async () => {
        const app = new App();
        const service = new VectorStoreService(app as any, { ...DEFAULT_SETTINGS }, null);
        const vectorStore = {
            removeFile: vi.fn(),
            renameFile: vi.fn()
        };

        (service as any).vectorStore = vectorStore;
        (service as any).embeddingService = null;
        vi.spyOn(service as any, 'ensureIndexLoaded').mockResolvedValue(undefined);

        const indexSpy = vi.spyOn(service, 'indexNote').mockResolvedValue(true);

        await service.renameNote('old.md', 'new.md');

        expect(vectorStore.renameFile).toHaveBeenCalledWith('old.md', 'new.md');
        expect(indexSpy).not.toHaveBeenCalled();
    });
});

describe('VectorStoreService rename batching', () => {
    beforeEach(() => {
        clearMockNotices();
    });

    it('re-embeds each file for small rename batches', async () => {
        const app = new App();
        const service = new VectorStoreService(app as any, { ...DEFAULT_SETTINGS }, {});
        const vectorStore = {
            renameFile: vi.fn()
        };

        (service as any).vectorStore = vectorStore;
        vi.spyOn(service as any, 'ensureIndexLoaded').mockResolvedValue(undefined);

        const renameSpy = vi.spyOn(service, 'renameNote').mockResolvedValue(undefined);

        (service as any).pendingRenames = [
            { oldPath: 'a.md', newPath: 'a2.md' },
            { oldPath: 'b.md', newPath: 'b2.md' },
            { oldPath: 'c.md', newPath: 'c2.md' }
        ];

        await (service as any).flushRenames();

        expect(renameSpy).toHaveBeenCalledTimes(3);
        expect(vectorStore.renameFile).not.toHaveBeenCalled();
    });

    it('uses lightweight rename for large batches and shows notice', async () => {
        const app = new App();
        const service = new VectorStoreService(app as any, { ...DEFAULT_SETTINGS }, {});
        const vectorStore = {
            renameFile: vi.fn()
        };

        (service as any).vectorStore = vectorStore;
        vi.spyOn(service as any, 'ensureIndexLoaded').mockResolvedValue(undefined);

        const renameSpy = vi.spyOn(service, 'renameNote').mockResolvedValue(undefined);

        (service as any).pendingRenames = Array.from({ length: 11 }, (_, index) => ({
            oldPath: `old-${index}.md`,
            newPath: `new-${index}.md`
        }));

        await (service as any).flushRenames();

        expect(renameSpy).not.toHaveBeenCalled();
        expect(vectorStore.renameFile).toHaveBeenCalledTimes(11);
        expect(mockNotices.some((notice: string) => notice.includes('notes moved'))).toBe(true);
    });
});

// ─── Index Version Persistence Tests ───

describe('INDEX_SCHEMA_VERSION consistency', () => {
    it('types.ts and vectorStoreService.ts export the same value', () => {
        expect(INDEX_SCHEMA_VERSION).toBe(INDEX_SCHEMA_VERSION_TYPES);
    });

    it('equals expected version string', () => {
        expect(INDEX_SCHEMA_VERSION).toBe('2.0.0');
    });
});

describe('SimpleVectorStore upsert stamps version', () => {
    it('updates metadata.version to INDEX_SCHEMA_VERSION after upsert', async () => {
        const store = new SimpleVectorStore();
        // Force an old version to simulate loading a stale index
        (store as any).metadata.version = '1.0.0';

        await store.upsert([{
            id: 'test-0',
            filePath: 'test.md',
            chunkIndex: 0,
            content: 'Hello world',
            embedding: [0.1, 0.2, 0.3],
            metadata: {
                title: 'Test',
                createdTime: Date.now(),
                modifiedTime: Date.now(),
                contentHash: 'abc123',
                wordCount: 2,
                tokens: 2
            }
        }]);

        const metadata = await store.getMetadata();
        expect(metadata.version).toBe(INDEX_SCHEMA_VERSION);
    });
});

describe('VectorStoreService rebuildVault', () => {
    it('clears index then reindexes all files', async () => {
        const app = new App();
        const service = new VectorStoreService(app as any, { ...DEFAULT_SETTINGS }, {});

        const clearFn = vi.fn();
        const vectorStore = {
            clear: clearFn,
            getMetadata: vi.fn().mockResolvedValue({ version: INDEX_SCHEMA_VERSION })
        };

        (service as any).vectorStore = vectorStore;
        (service as any).embeddingService = {};
        (service as any).loadPromise = null;
        (service as any).hasWarnedIndexVersion = false;

        const file1 = new TFile();
        file1.path = 'note1.md';
        const file2 = new TFile();
        file2.path = 'note2.md';
        app.vault.getMarkdownFiles = vi.fn().mockReturnValue([file1, file2]);

        const indexSpy = vi.spyOn(service, 'indexNote').mockResolvedValue(true);

        const result = await service.rebuildVault();

        expect(clearFn).toHaveBeenCalledOnce();
        expect(indexSpy).toHaveBeenCalledTimes(2);
        expect(result).toEqual({ indexed: 2, failed: 0 });
    });

    it('resets hasWarnedIndexVersion after rebuild', async () => {
        const app = new App();
        const service = new VectorStoreService(app as any, { ...DEFAULT_SETTINGS }, {});

        const vectorStore = {
            clear: vi.fn(),
            getMetadata: vi.fn().mockResolvedValue({ version: INDEX_SCHEMA_VERSION })
        };

        (service as any).vectorStore = vectorStore;
        (service as any).embeddingService = {};
        (service as any).loadPromise = null;
        (service as any).hasWarnedIndexVersion = true;

        app.vault.getMarkdownFiles = vi.fn().mockReturnValue([]);

        await service.rebuildVault();

        expect((service as any).hasWarnedIndexVersion).toBe(false);
    });
});

describe('VectorStoreService indexVault does NOT reset warning flag', () => {
    it('keeps hasWarnedIndexVersion true after incremental index', async () => {
        const app = new App();
        const service = new VectorStoreService(app as any, { ...DEFAULT_SETTINGS }, {});

        const vectorStore = {
            getMetadata: vi.fn().mockResolvedValue({ version: INDEX_SCHEMA_VERSION })
        };

        (service as any).vectorStore = vectorStore;
        (service as any).loadPromise = null;
        (service as any).hasWarnedIndexVersion = true;

        app.vault.getMarkdownFiles = vi.fn().mockReturnValue([]);

        await service.indexVault();

        expect((service as any).hasWarnedIndexVersion).toBe(true);
    });
});

// ─── Review Fix Tests ───

describe('SimpleVectorStore version stamp with empty embeddings', () => {
    it('still stamps version when doc has no embedding (SimpleVectorStore has no Voy)', async () => {
        // SimpleVectorStore doesn't use Voy — it always stamps version unconditionally.
        // This is correct because SimpleVectorStore is the fallback in-memory store.
        const store = new SimpleVectorStore();
        (store as any).metadata.version = '1.0.0';

        await store.upsert([{
            id: 'test-0',
            filePath: 'test.md',
            chunkIndex: 0,
            content: 'Hello world',
            embedding: [], // empty embedding
            metadata: {
                title: 'Test',
                createdTime: Date.now(),
                modifiedTime: Date.now(),
                contentHash: 'abc123',
                wordCount: 2,
                tokens: 2
            }
        }]);

        const metadata = await store.getMetadata();
        expect(metadata.version).toBe(INDEX_SCHEMA_VERSION);
    });
});

describe('VectorStoreService rebuildVault awaits load before clear', () => {
    it('resolves loadPromise before calling clear', async () => {
        const app = new App();
        const service = new VectorStoreService(app as any, { ...DEFAULT_SETTINGS }, {});

        const callOrder: string[] = [];
        const loadPromise = new Promise<void>((resolve) => {
            setTimeout(() => {
                callOrder.push('load-resolved');
                resolve();
            }, 10);
        });

        const vectorStore = {
            clear: vi.fn(() => { callOrder.push('clear'); }),
            getMetadata: vi.fn().mockResolvedValue({ version: INDEX_SCHEMA_VERSION })
        };

        (service as any).vectorStore = vectorStore;
        (service as any).embeddingService = {};
        (service as any).loadPromise = loadPromise;
        (service as any).hasWarnedIndexVersion = false;

        app.vault.getMarkdownFiles = vi.fn().mockReturnValue([]);

        await service.rebuildVault();

        expect(callOrder).toEqual(['load-resolved', 'clear']);
    });
});

describe('VectorStoreService rebuildVault clears search cache', () => {
    it('calls searchCache.clear() during rebuild', async () => {
        const app = new App();
        const service = new VectorStoreService(app as any, { ...DEFAULT_SETTINGS }, {});

        const vectorStore = {
            clear: vi.fn(),
            getMetadata: vi.fn().mockResolvedValue({ version: INDEX_SCHEMA_VERSION })
        };

        (service as any).vectorStore = vectorStore;
        (service as any).embeddingService = {};
        (service as any).loadPromise = null;
        (service as any).hasWarnedIndexVersion = false;

        const cacheClearSpy = vi.spyOn((service as any).searchCache, 'clear');

        app.vault.getMarkdownFiles = vi.fn().mockReturnValue([]);

        await service.rebuildVault();

        expect(cacheClearSpy).toHaveBeenCalled();
    });
});

describe('VectorStoreService rebuildVault early-return without embedding service', () => {
    it('returns {0,0} when embeddingService is null', async () => {
        const app = new App();
        const service = new VectorStoreService(app as any, { ...DEFAULT_SETTINGS }, null);

        const vectorStore = { clear: vi.fn() };
        (service as any).vectorStore = vectorStore;
        (service as any).embeddingService = null;

        const result = await service.rebuildVault();

        expect(result).toEqual({ indexed: 0, failed: 0 });
        // clear should NOT have been called — we early-returned
        expect(vectorStore.clear).not.toHaveBeenCalled();
    });
});
