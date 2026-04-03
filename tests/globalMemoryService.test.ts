/**
 * Tests for GlobalMemoryService
 */
import { describe, it, expect } from 'vitest';
import { GlobalMemoryService } from '../src/services/chat/globalMemoryService';
import { getChatRootFullPath } from '../src/core/settings';
// Import from mock file directly — vitest resolves both 'obsidian' and './mocks/obsidian'
// to the same module instance (same canonical path), so instanceof TFile works correctly
import { createTFile } from './mocks/obsidian';

function makeSettings(chatRootFolder = 'AI Chat') {
    return { chatRootFolder, outputRootFolder: '', pluginFolder: 'AI-Organiser' } as any;
}

function makeApp(settings: ReturnType<typeof makeSettings>, initialFiles: Record<string, string> = {}) {
    const files: Record<string, string> = { ...initialFiles };
    return {
        vault: {
            getAbstractFileByPath: (path: string) => {
                if (path in files) return createTFile(path);
                return null;
            },
            read: async (file: any) => files[file.path] ?? '',
            modify: async (file: any, content: string) => { files[file.path] = content; },
            create: async (path: string, content: string) => {
                files[path] = content;
                return createTFile(path);
            },
            createFolder: async (_path: string) => { /* no-op */ },
        },
    } as any;
}

/** Build the correct memory file path for a given settings object */
function memoryPath(settings: ReturnType<typeof makeSettings>): string {
    return `${getChatRootFullPath(settings)}/_global_memory.md`;
}

describe('GlobalMemoryService', () => {
    describe('loadMemory', () => {
        it('returns empty array when file does not exist', async () => {
            const settings = makeSettings();
            const app = makeApp(settings);
            const svc = new GlobalMemoryService(app, settings);
            expect(await svc.loadMemory()).toEqual([]);
        });

        it('parses bullet items from file', async () => {
            const settings = makeSettings();
            const content = '# Global Memory\n\n## Preferences\n- I prefer TypeScript\n- Keep responses short\n';
            const app = makeApp(settings, { [memoryPath(settings)]: content });
            const svc = new GlobalMemoryService(app, settings);
            const items = await svc.loadMemory();
            expect(items).toEqual(['I prefer TypeScript', 'Keep responses short']);
        });

        it('ignores non-bullet lines', async () => {
            const settings = makeSettings();
            const content = '# Global Memory\n\n## Preferences\nSome prose\n- Real item\n';
            const app = makeApp(settings, { [memoryPath(settings)]: content });
            const svc = new GlobalMemoryService(app, settings);
            expect(await svc.loadMemory()).toEqual(['Real item']);
        });

        it('returns empty for placeholder-only file', async () => {
            const settings = makeSettings();
            const content = '# Global Memory\n\n## Preferences\n_No preferences saved yet._\n';
            const app = makeApp(settings, { [memoryPath(settings)]: content });
            const svc = new GlobalMemoryService(app, settings);
            expect(await svc.loadMemory()).toEqual([]);
        });
    });

    describe('addMemory', () => {
        it('adds a new item and returns true', async () => {
            const settings = makeSettings();
            const app = makeApp(settings);
            const svc = new GlobalMemoryService(app, settings);
            const result = await svc.addMemory('I prefer bullet lists');
            expect(result).toBe(true);
            const items = await svc.loadMemory();
            expect(items).toContain('I prefer bullet lists');
        });

        it('returns false for case-insensitive duplicate', async () => {
            const settings = makeSettings();
            const content = '# Global Memory\n\n## Preferences\n- I prefer TypeScript\n';
            const app = makeApp(settings, { [memoryPath(settings)]: content });
            const svc = new GlobalMemoryService(app, settings);
            const result = await svc.addMemory('i prefer typescript');
            expect(result).toBe(false);
        });

        it('returns false when at 50-item capacity', async () => {
            const settings = makeSettings();
            const items = Array.from({ length: 50 }, (_, i) => `- item ${i}`).join('\n');
            const content = `# Global Memory\n\n## Preferences\n${items}\n`;
            const app = makeApp(settings, { [memoryPath(settings)]: content });
            const svc = new GlobalMemoryService(app, settings);
            const result = await svc.addMemory('new item');
            expect(result).toBe(false);
        });
    });

    describe('removeMemory', () => {
        it('removes an item by exact match', async () => {
            const settings = makeSettings();
            const content = '# Global Memory\n\n## Preferences\n- keep me\n- remove me\n';
            const app = makeApp(settings, { [memoryPath(settings)]: content });
            const svc = new GlobalMemoryService(app, settings);
            await svc.removeMemory('remove me');
            const items = await svc.loadMemory();
            expect(items).toContain('keep me');
            expect(items).not.toContain('remove me');
        });

        it('is a no-op for non-existent item', async () => {
            const settings = makeSettings();
            const content = '# Global Memory\n\n## Preferences\n- real item\n';
            const app = makeApp(settings, { [memoryPath(settings)]: content });
            const svc = new GlobalMemoryService(app, settings);
            await svc.removeMemory('non-existent');
            expect(await svc.loadMemory()).toEqual(['real item']);
        });
    });

    describe('saveAll', () => {
        it('creates file when it does not exist', async () => {
            const settings = makeSettings();
            const app = makeApp(settings);
            const svc = new GlobalMemoryService(app, settings);
            await svc.saveAll(['pref A', 'pref B']);
            const items = await svc.loadMemory();
            expect(items).toEqual(['pref A', 'pref B']);
        });

        it('overwrites existing file', async () => {
            const settings = makeSettings();
            const content = '# Global Memory\n\n## Preferences\n- old item\n';
            const app = makeApp(settings, { [memoryPath(settings)]: content });
            const svc = new GlobalMemoryService(app, settings);
            await svc.saveAll(['new item']);
            expect(await svc.loadMemory()).toEqual(['new item']);
        });

        it('writes placeholder when saving empty array', async () => {
            const settings = makeSettings();
            const app = makeApp(settings);
            const svc = new GlobalMemoryService(app, settings);
            await svc.saveAll([]);
            expect(await svc.loadMemory()).toEqual([]);
        });
    });
});
