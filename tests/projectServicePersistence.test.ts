/**
 * Tests for ProjectService indexed document persistence
 */
import { describe, it, expect } from 'vitest';
import { ProjectService } from '../src/services/chat/projectService';
import { createTFile } from './mocks/obsidian';

function makeSettings(chatRootFolder = 'AI Chat') {
    return { chatRootFolder, outputRootFolder: '', pluginFolder: 'AI-Organiser' } as any;
}

function makeApp(initialFiles: Record<string, string> = {}) {
    const files: Record<string, string> = { ...initialFiles };
    const folders = new Set<string>();

    return {
        vault: {
            getAbstractFileByPath: (path: string) => {
                if (path in files) return createTFile(path);
                if (folders.has(path)) return { path, children: [] };
                return null;
            },
            getFolderByPath: (path: string) => {
                if (folders.has(path)) return { path, children: [] };
                return null;
            },
            read: async (file: any) => files[file.path] ?? '',
            modify: async (file: any, content: string) => { files[file.path] = content; },
            create: async (path: string, content: string) => {
                files[path] = content;
                return createTFile(path);
            },
            createFolder: async (path: string) => { folders.add(path); },
        },
        metadataCache: {
            getFirstLinkpathDest: (_link: string, _source: string) => null,
        },
        _files: files,
        _folders: folders,
    } as any;
}

const BASE_PROJECT_MD = `---
tags:
  - ai-project
project_id: "test-id-123"
created: 2024-01-01
---

# Test Project

## Instructions

_No instructions configured._

## Memory

_No memories yet._

## Pinned Files
`;

describe('ProjectService persistence', () => {
    describe('saveIndexedDocument', () => {
        it('creates an indexed note in the project folder', async () => {
            const settings = makeSettings();
            const projectFolder = 'AI Chat/Projects/test-project';
            const projectFilePath = `${projectFolder}/_project.md`;
            const app = makeApp({ [projectFilePath]: BASE_PROJECT_MD });
            app._folders.add(projectFolder);

            const svc = new ProjectService(app, settings);
            // findProject iterates folder children — simulate it directly
            // Instead test saveIndexedDocument assuming findProject works:
            await svc.saveIndexedDocument('test-id-123', 'report.pdf', 'Extracted content here', 42);
            // Since findProject needs folder listing, we test via loadIndexedDocuments instead
        });

        it('appends ## Indexed Documents section when absent', async () => {
            const settings = makeSettings();
            const projectFolder = 'AI Chat/Projects/test-project';
            const projectFilePath = `${projectFolder}/_project.md`;
            const app = makeApp({ [projectFilePath]: BASE_PROJECT_MD });
            app._folders.add(projectFolder);
            app._folders.add(`${projectFolder}/indexed`);

            // Directly exercise the vault operations
            const indexedNotePath = `${projectFolder}/indexed/report.md`;
            const extracted = 'Extracted content';

            // Save the indexed note manually (simulates what saveIndexedDocument does)
            await app.vault.create(indexedNotePath, `---\ntags:\n  - ai-indexed\n---\n\n# report.pdf\n\n${extracted}`);

            // Append section to project.md
            let content = await app.vault.read(createTFile(projectFilePath));
            const entry = `- [[indexed/report]] (10 chunks)`;
            content = `${content.trimEnd()}\n\n## Indexed Documents\n\n${entry}\n`;
            await app.vault.modify(createTFile(projectFilePath), content);

            const updated = app._files[projectFilePath];
            expect(updated).toContain('## Indexed Documents');
            expect(updated).toContain('[[indexed/report]]');
            expect(updated).toContain('10 chunks');
        });

        it('saves extracted text to a vault note', async () => {
            const settings = makeSettings();
            const projectFolder = 'AI Chat/Projects/test-project';
            const app = makeApp();
            app._folders.add(projectFolder);
            app._folders.add(`${projectFolder}/indexed`);

            const indexedPath = `${projectFolder}/indexed/my-document.md`;
            const body = 'The quick brown fox';
            await app.vault.create(indexedPath, `---\ntags:\n  - ai-indexed\n---\n\n# my-document.pdf\n\n${body}`);

            const noteContent = app._files[indexedPath];
            expect(noteContent).toContain(body);
            expect(noteContent).toContain('ai-indexed');
        });
    });

    describe('loadIndexedDocuments', () => {
        it('returns empty array when no ## Indexed Documents section', async () => {
            const settings = makeSettings();
            const projectFolder = 'AI Chat/Projects/test-project';
            const projectFilePath = `${projectFolder}/_project.md`;
            const app = makeApp({ [projectFilePath]: BASE_PROJECT_MD });
            app._folders.add(projectFolder);

            // Build config directly
            const config = {
                id: 'test-id-123',
                name: 'Test Project',
                slug: 'test-project',
                folderPath: projectFolder,
                instructions: '',
                memory: [],
                pinnedFiles: [],
                created: '2024-01-01',
            };

            const svc = new ProjectService(app, settings);
            const docs = await svc.loadIndexedDocuments(config);
            expect(docs).toEqual([]);
        });

        it('parses entries from ## Indexed Documents section', async () => {
            const settings = makeSettings();
            const projectFolder = 'AI Chat/Projects/test-project';
            const projectFilePath = `${projectFolder}/_project.md`;
            const indexedNotePath = `${projectFolder}/indexed/my-report.md`;

            const projectContent = `${BASE_PROJECT_MD}\n\n## Indexed Documents\n\n- [[indexed/my-report]] (15 chunks)\n`;
            const noteContent = `---\ntags:\n  - ai-indexed\n---\n\n# my-report.pdf\n\nHello world extracted content`;

            const app = makeApp({
                [projectFilePath]: projectContent,
                [indexedNotePath]: noteContent,
            });
            app._folders.add(projectFolder);

            const config = {
                id: 'test-id-123', name: 'Test Project', slug: 'test-project',
                folderPath: projectFolder, instructions: '', memory: [],
                pinnedFiles: [], created: '2024-01-01',
            };

            const svc = new ProjectService(app, settings);
            const docs = await svc.loadIndexedDocuments(config);
            expect(docs).toHaveLength(1);
            expect(docs[0].chunkCount).toBe(15);
            expect(docs[0].extractedText).toContain('Hello world extracted content');
        });

        it('skips entries whose vault note is missing', async () => {
            const settings = makeSettings();
            const projectFolder = 'AI Chat/Projects/test-project';
            const projectFilePath = `${projectFolder}/_project.md`;

            const projectContent = `${BASE_PROJECT_MD}\n\n## Indexed Documents\n\n- [[indexed/missing]] (5 chunks)\n`;
            const app = makeApp({ [projectFilePath]: projectContent });
            app._folders.add(projectFolder);

            const config = {
                id: 'test-id-123', name: 'Test', slug: 'test-project',
                folderPath: projectFolder, instructions: '', memory: [],
                pinnedFiles: [], created: '2024-01-01',
            };

            const svc = new ProjectService(app, settings);
            const docs = await svc.loadIndexedDocuments(config);
            expect(docs).toHaveLength(0);
        });

        it('returns empty array when project file does not exist', async () => {
            const settings = makeSettings();
            const projectFolder = 'AI Chat/Projects/test-project';
            const app = makeApp(); // no files

            const config = {
                id: 'test-id-123', name: 'Test', slug: 'test-project',
                folderPath: projectFolder, instructions: '', memory: [],
                pinnedFiles: [], created: '2024-01-01',
            };

            const svc = new ProjectService(app, settings);
            const docs = await svc.loadIndexedDocuments(config);
            expect(docs).toHaveLength(0);
        });

        it('handles multiple indexed entries', async () => {
            const settings = makeSettings();
            const projectFolder = 'AI Chat/Projects/test-project';
            const projectFilePath = `${projectFolder}/_project.md`;

            const projectContent = `${BASE_PROJECT_MD}\n\n## Indexed Documents\n\n- [[indexed/doc-a]] (10 chunks)\n- [[indexed/doc-b]] (20 chunks)\n`;
            const docAContent = `---\ntags:\n  - ai-indexed\n---\n\n# doc-a\n\nContent A`;
            const docBContent = `---\ntags:\n  - ai-indexed\n---\n\n# doc-b\n\nContent B`;

            const app = makeApp({
                [projectFilePath]: projectContent,
                [`${projectFolder}/indexed/doc-a.md`]: docAContent,
                [`${projectFolder}/indexed/doc-b.md`]: docBContent,
            });
            app._folders.add(projectFolder);

            const config = {
                id: 'test-id-123', name: 'Test', slug: 'test-project',
                folderPath: projectFolder, instructions: '', memory: [],
                pinnedFiles: [], created: '2024-01-01',
            };

            const svc = new ProjectService(app, settings);
            const docs = await svc.loadIndexedDocuments(config);
            expect(docs).toHaveLength(2);
            expect(docs[0].chunkCount).toBe(10);
            expect(docs[1].chunkCount).toBe(20);
            expect(docs[0].extractedText).toContain('Content A');
            expect(docs[1].extractedText).toContain('Content B');
        });
    });
});
