import { describe, it, expect, vi, beforeEach } from 'vitest';

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
import { VectorStoreService } from '../src/services/vector/vectorStoreService';
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
